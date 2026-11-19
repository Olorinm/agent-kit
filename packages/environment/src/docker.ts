import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EnvironmentError, absolutePath, required } from "./errors.js";
import type {
  CreateEnvironment, EnvironmentInfo, EnvironmentProvider, EnvironmentRef, EnvironmentState,
  ExecOptions, FileEntry, HttpEndpoint, OutputChunk,
} from "./types.js";

export interface DockerProviderOptions {
  /** Also part of container names: letters, digits, `_`, `.` and `-`. */
  id: string;
  /** The `docker` executable; found on PATH by default. */
  dockerPath?: string;
  /** Environments this provider may hold, stopped ones included. Default 3. */
  maxEnvironments?: number;
  /** Container ports published on 127.0.0.1 and reachable through `httpEndpoint`. Default `[37420]`. */
  ports?: number[];
  /** Limit for Docker commands other than `exec` streams and the template build. Default 180000. */
  requestTimeoutMs?: number;
}
export function createDockerProvider(options: DockerProviderOptions): EnvironmentProvider {
  return new DockerProvider(options);
}

/** What the Cloudflare `node24` template gives a start script: Debian trixie, Node 24, root commands, `/home/user` for uid 1001. */
const DOCKERFILE = `FROM node:24-trixie-slim
RUN useradd --create-home --uid 1001 user && mkdir /opt/agent-environment
`;
const TEMPLATES: Record<string, { image: string; dockerfile: string }> = {
  node24: { image: "agent-environment-node24:" + createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12), dockerfile: DOCKERFILE },
};
/** The gateway's entrypoint: files are written first, the start script last. A restarted container runs it again. */
const ENTRYPOINT = ["sh", "-c", "while [ ! -f /opt/agent-environment/start.sh ]; do sleep 1; done; exec sh /opt/agent-environment/start.sh"];
const LABEL = { provider: "agent-environment.provider", id: "agent-environment.id", template: "agent-environment.template", metadata: "agent-environment.metadata." };
/** Marks a command and its descendants; `docker exec` alone does not stop the process it started. */
const EXEC_TAG = "AGENT_ENVIRONMENT_EXEC";
const KILL = `for p in /proc/[0-9]*; do grep -qzxF "${EXEC_TAG}=$1" "$p/environ" 2>/dev/null && kill -9 "\${p#/proc/}"; done; true`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FILE_LIMIT = 16 * 1024 * 1024;
/** The gateway's file helper, unchanged: exact bytes through stdin/stdout, never shell interpolation. */
const FILE_HELPER = `
const fs=require('node:fs/promises'),p=require('node:path');
(async()=>{const chunks=[];for await(const c of process.stdin)chunks.push(c);
const b=JSON.parse(Buffer.concat(chunks).toString());const op=process.argv[1];
if(op==='write'){const bytes=Buffer.from(b.data,'base64');if(bytes.length>${FILE_LIMIT})throw Object.assign(Error(),{code:'EFBIG'});
let path=b.path,old;try{path=await fs.realpath(path);old=await fs.stat(path);}catch(e){if(e.code!=='ENOENT')throw e;}
await fs.mkdir(p.dirname(path),{recursive:true});const tmp=path+'.upload-'+require('node:crypto').randomUUID();
try{await fs.writeFile(tmp,bytes,{flag:'wx',mode:old?old.mode&511:438});if(old)await fs.chown(tmp,old.uid,old.gid);await fs.rename(tmp,path);}
finally{await fs.rm(tmp,{force:true});}console.log('{}');}
if(op==='read'){const s=await fs.stat(b.path);if(s.size>${FILE_LIMIT})throw Object.assign(Error(),{code:'EFBIG'});process.stdout.write(await fs.readFile(b.path));}
if(op==='remove'){await fs.rm(b.path,{recursive:true,force:true});console.log('{}');}
if(op==='list'){const out=[];async function walk(path){for(const entry of await fs.readdir(path,{withFileTypes:true})){
const name=p.join(path,entry.name);if(entry.isDirectory())await walk(name);else if(entry.isFile()){const s=await fs.stat(name);out.push({path:name,size:s.size,mtimeMs:s.mtimeMs});}
if(out.length>10000)throw Object.assign(Error(),{code:'EFBIG'});}}
let missing=false;try{await fs.stat(b.path);}catch(e){if(b.missingOk&&e.code==='ENOENT')missing=true;else throw e;}
if(!missing)await walk(b.path);console.log(JSON.stringify(out));}
})().catch(e=>{process.stderr.write(e.code||'file_operation_failed');process.exitCode=1;});`;

interface Container {
  State?: { Status?: string };
  Config?: { Labels?: Record<string, string> | null };
  NetworkSettings?: { Ports?: Record<string, Array<{ HostPort?: string }> | null> | null };
}
interface Output { code: number | null; stdout: Buffer; stderr: string }
const port = (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
const reason = (output: Output) => output.stderr.trim().split("\n").at(-1)?.slice(0, 200) || "no output";
function lifetime(value: number, code = "invalid_lifetime") {
  if (!Number.isInteger(value) || value < 60 || value > 86400)
    throw new EnvironmentError(code, "Lifetime must be between 60 and 86400 whole seconds.");
}
function strings(value: Record<string, string> = {}, code: string): Array<[string, string]> {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : undefined;
  if (!entries || entries.length > 64 || entries.some(([k, v]) => typeof v !== "string" || !k || k.length > 256 || v.length > 8192 || /[=\0]/.test(k) || v.includes("\0")))
    throw new EnvironmentError(code, "Expected at most 64 string entries whose names have no '='.");
  return entries;
}

class DockerProvider implements EnvironmentProvider {
  readonly id: string;
  /** Nothing stops a local environment on its own; lifetimes are accepted and not enforced. */
  readonly capabilities = Object.freeze({
    automaticPause: false, pause: true, processMemoryResume: false, persistence: "provider-template",
  } as const);
  private readonly docker: string;
  private readonly max: number;
  private readonly ports: number[];
  private readonly timeout: number;
  private readonly uncertain = new Set<string>();
  private readonly busy = new Map<string, number>();
  private readonly changing = new Set<string>();
  private readonly images = new Map<string, Promise<void>>();
  private creating: Promise<unknown> = Promise.resolve();
  constructor(options: DockerProviderOptions) {
    this.id = required(options.id, "id");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(this.id))
      throw new EnvironmentError("invalid_argument", "A Docker provider id uses letters, digits, '_', '.' and '-'.");
    this.docker = required(options.dockerPath ?? "docker", "dockerPath");
    this.max = options.maxEnvironments ?? 3;
    this.ports = [...new Set(options.ports ?? [37420])];
    this.timeout = options.requestTimeoutMs ?? 180000;
    if (!Number.isInteger(this.max) || this.max < 1 || !this.ports.every(port))
      throw new EnvironmentError("invalid_argument", "maxEnvironments must be a positive integer and ports must be TCP ports.");
  }
  hasUncertainExecution(id: string) { return this.uncertain.has(id); }
  resetExecutionUncertainty(id: string) { this.uncertain.delete(id); }
  private name(id: string) {
    if (!UUID.test(id)) throw new EnvironmentError("invalid_id", "Invalid Docker environment ID.");
    return `agent-environment-${this.id}-${id}`;
  }
  /** Runs one Docker command to completion. A nonzero exit is returned, not thrown. */
  private run(args: string[], input?: string, timeout = this.timeout): Promise<Output> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.docker, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.stdout!.on("data", chunk => stdout.push(chunk));
      child.stderr!.on("data", chunk => stderr.push(chunk));
      child.once("error", () => { clearTimeout(timer); reject(new EnvironmentError("docker_unavailable", "The docker command could not be started.")); });
      child.once("close", code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }); });
      // A command that exits without reading its input is reported through its exit status.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }
  private async must(args: string[], unknown = false, input?: string, timeout?: number) {
    const output = await this.run(args, input, timeout);
    if (output.code !== 0) throw new EnvironmentError("docker_failed", `docker ${args[0]} failed: ${reason(output)}`, unknown);
    return output;
  }
  private project(container: Container): EnvironmentInfo {
    const labels = container.Config?.Labels ?? {}, status = container.State?.Status;
    const id = labels[LABEL.id];
    if (labels[LABEL.provider] !== this.id || typeof id !== "string" || !UUID.test(id))
      throw new EnvironmentError("invalid_response", "Invalid environment container.");
    // A stopped container keeps its filesystem, whether this provider, the daemon or a reboot stopped it.
    const state: EnvironmentState = status === "running" ? "running" : status === "exited" ? "paused" : "unknown";
    const metadata = Object.fromEntries(Object.entries(labels)
      .filter(([key]) => key.startsWith(LABEL.metadata)).map(([key, value]) => [key.slice(LABEL.metadata.length), value]));
    return { provider: this.id, id, state, template: labels[LABEL.template], metadata };
  }
  private async inspect(id: string): Promise<Container | undefined> {
    const output = await this.run(["inspect", "--type", "container", this.name(id)]);
    if (output.code === 0) return (JSON.parse(output.stdout.toString()) as Container[])[0];
    if (/no such (container|object)/i.test(output.stderr)) return undefined;
    throw new EnvironmentError("docker_failed", "docker inspect failed: " + reason(output));
  }
  private async existing(id: string) {
    const container = await this.inspect(id);
    if (!container) throw new EnvironmentError("environment_missing", "Environment does not exist.");
    return { container, info: this.project(container) };
  }
  /** Claims the environment for command or file I/O; lifecycle changes wait for the claim to be released. */
  private async enter(id: string) {
    const name = this.name(id);
    if (this.changing.has(id)) throw new EnvironmentError("environment_not_running", "Environment is changing state.");
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
    try {
      if ((await this.existing(id)).info.state !== "running") throw new EnvironmentError("environment_not_running", "Environment is not running.");
    } catch (error) { this.leave(id); throw error; }
    return name;
  }
  private leave(id: string) {
    const count = (this.busy.get(id) ?? 1) - 1;
    if (count) this.busy.set(id, count); else this.busy.delete(id);
  }
  private async change<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.changing.has(id) || this.busy.has(id)) throw new EnvironmentError("environment_busy", "Environment has work in progress.");
    this.changing.add(id);
    try { return await fn(); } finally { this.changing.delete(id); }
  }
  private image(template: string) {
    const { image, dockerfile } = TEMPLATES[template]!;
    let ready = this.images.get(image);
    if (!ready) {
      ready = (async () => {
        if ((await this.run(["image", "inspect", image])).code !== 0)
          await this.must(["build", "--tag", image, "-"], false, dockerfile, 1800000);
      })();
      this.images.set(image, ready);
      ready.catch(() => this.images.delete(image));
    }
    return ready.then(() => image);
  }
  private async ids(metadata: Record<string, string> = {}) {
    const filters = [`${LABEL.provider}=${this.id}`, ...Object.entries(metadata).map(([k, v]) => `${LABEL.metadata}${k}=${v}`)];
    const output = await this.must(["ps", "--all", "--quiet", "--no-trunc", ...filters.flatMap(filter => ["--filter", "label=" + filter])]);
    return output.stdout.toString().split("\n").filter(Boolean);
  }
  create(spec: CreateEnvironment): Promise<EnvironmentRef> {
    // One at a time, so the capacity check and the container it admits cannot interleave.
    const created = this.creating.then(() => this.createOne(spec));
    this.creating = created.catch(() => {});
    return created;
  }
  private async createOne(spec: CreateEnvironment): Promise<EnvironmentRef> {
    if (!Object.hasOwn(TEMPLATES, spec.template) || spec.onTimeout !== undefined && !["kill", "pause"].includes(spec.onTimeout))
      throw new EnvironmentError("invalid_create", "Unknown template or timeout policy.");
    if (spec.timeoutSeconds !== undefined) lifetime(spec.timeoutSeconds, "invalid_create");
    const env = strings(spec.env, "invalid_create"), metadata = strings(spec.metadata, "invalid_create");
    if ((await this.ids()).length >= this.max) throw new EnvironmentError("trial_capacity_reached", "This provider holds its maximum number of environments.");
    const image = await this.image(spec.template), id = randomUUID(), name = this.name(id);
    const labels = [[LABEL.provider, this.id], [LABEL.id, id], [LABEL.template, spec.template], ...metadata.map(([k, v]) => [LABEL.metadata + k, v])];
    await this.must(["create", "--name", name, "--init",
      ...labels.flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      ...this.ports.flatMap(p => ["--publish", `127.0.0.1::${p}`]),
      ...env.flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      image, ...ENTRYPOINT], true);
    try { await this.must(["start", name], true); }
    catch (error) { await this.run(["rm", "--force", "--volumes", name]); throw error; }
    return { provider: this.id, id };
  }
  async info(id: string): Promise<EnvironmentInfo> {
    const container = await this.inspect(id);
    return container ? this.project(container) : { provider: this.id, id, state: "missing", metadata: {} };
  }
  async list(metadata: Record<string, string> = {}): Promise<EnvironmentInfo[]> {
    const ids = await this.ids(metadata);
    if (!ids.length) return [];
    const containers = JSON.parse((await this.must(["inspect", "--type", "container", ...ids])).stdout.toString()) as Container[];
    // Docker narrows by label; the exact comparison is made here.
    return containers.map(x => this.project(x)).filter(x => Object.entries(metadata).every(([k, v]) => x.metadata[k] === v));
  }
  async resume(id: string, timeoutSeconds = 600) {
    lifetime(timeoutSeconds);
    return this.change(id, async () => {
      const { info } = await this.existing(id);
      if (info.state === "running") return info;
      if (info.state !== "paused") throw new EnvironmentError("resume_requires_paused", "Only a paused environment can be resumed.");
      await this.must(["start", this.name(id)], true);
      return (await this.existing(id)).info;
    });
  }
  async pause(id: string) {
    if (this.hasUncertainExecution(id)) throw new EnvironmentError("execution_uncertain", "Reconcile execution before pausing.");
    await this.change(id, async () => {
      const { info } = await this.existing(id);
      if (info.state === "paused") return;
      if (info.state !== "running") throw new EnvironmentError("environment_not_running", "Environment is not running.");
      await this.must(["stop", this.name(id)], true);
    });
  }
  async destroy(id: string) {
    await this.change(id, async () => {
      const output = await this.run(["rm", "--force", "--volumes", this.name(id)]);
      if (output.code !== 0 && !/no such container/i.test(output.stderr)) throw new EnvironmentError("docker_failed", "docker rm failed: " + reason(output), true);
      if (await this.inspect(id)) throw new EnvironmentError("destroy_unconfirmed", "Environment removal is unconfirmed.", true);
    });
    this.uncertain.delete(id);
  }
  async setTimeout(id: string, seconds: number) {
    lifetime(seconds);
    await this.existing(id);
  }
  async httpEndpoint(id: string, target: number): Promise<HttpEndpoint> {
    if (!port(target)) throw new EnvironmentError("invalid_port", "A TCP port is required.");
    if (!this.ports.includes(target)) throw new EnvironmentError("port_not_published", "Add this port to the provider's ports to reach it.");
    const { container, info } = await this.existing(id);
    // Docker assigns the host port at every start, so the address is read each time.
    const published = container.NetworkSettings?.Ports?.[`${target}/tcp`]?.[0]?.HostPort;
    if (info.state !== "running" || !published) throw new EnvironmentError("environment_not_running", "Environment is not running.");
    return { url: `http://127.0.0.1:${published}`, headers: {} };
  }
  async *exec(id: string, argv: string[], options: ExecOptions = {}): AsyncIterable<OutputChunk> {
    if (options.signal?.aborted) throw new EnvironmentError("execution_aborted", "Execution was cancelled before starting.");
    if (!Array.isArray(argv) || !argv.length || argv.some(x => typeof x !== "string" || x.includes("\0")))
      throw new EnvironmentError("invalid_argv", "A command is a nonempty array of strings.");
    const seconds = options.timeoutSeconds ?? 60;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new EnvironmentError("invalid_exec_timeout", "Command timeout must be between 0 and 86400 seconds.");
    const env = strings(options.env, "invalid_argument");
    if (options.cwd !== undefined) absolutePath(options.cwd);
    const name = await this.enter(id), tag = randomUUID();
    let observedExit = false, closed: { code: number | null } | undefined, cancelled = false, wake = () => {};
    const queue: OutputChunk[] = [];
    const decoders = {
      stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
      stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
    };
    const child = spawn(this.docker, ["exec", ...(options.cwd ? ["--workdir", options.cwd] : []),
      ...[[EXEC_TAG, tag], ...env].flatMap(([k, v]) => ["--env", `${k}=${v}`]), name, ...argv], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    for (const stream of ["stdout", "stderr"] as const) child[stream].on("data", (bytes: Buffer) => {
      queue.push({ stream, bytes: new Uint8Array(bytes), text: decoders[stream].decode(bytes, { stream: true }) }); wake();
    });
    child.once("error", () => { closed ??= { code: null }; wake(); });
    child.once("close", code => { closed ??= { code }; wake(); });
    // Stops the command inside the container, then the client that was attached to it.
    const cancel = () => {
      if (cancelled || closed) return;
      cancelled = true;
      void this.run(["exec", name, "sh", "-c", KILL, "sh", tag]).catch(() => {}).then(() => child.kill("SIGKILL"));
    };
    const timer = seconds ? setTimeout(cancel, seconds * 1000) : undefined;
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) break;
        await new Promise<void>(resolve => { wake = resolve; });
      }
      // A cancelled or timed out command, or a client that died, leaves no exit status to trust.
      if (cancelled || closed.code === null) throw new EnvironmentError("execution_uncertain", "No confirmed command completion; reconcile before retrying.", true);
      for (const stream of ["stdout", "stderr"] as const) {
        const text = decoders[stream].decode();
        if (text) yield { stream, text };
      }
      observedExit = true;
      options.onExit?.({ exitCode: closed.code });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (!observedExit) { this.uncertain.add(id); cancel(); }
      this.leave(id);
    }
  }
  private async file(id: string, op: "read" | "write" | "remove" | "list", body: Record<string, unknown>) {
    const name = await this.enter(id);
    try {
      const output = await this.run(["exec", "--interactive", name, "node", "-e", FILE_HELPER, op], JSON.stringify(body));
      if (output.code === 0) return output.stdout;
      if (output.stderr === "ENOENT") throw new EnvironmentError("file_not_found", "No such file in the environment.");
      throw new EnvironmentError("file_operation_failed", "File operation failed in the environment.", op !== "read" && op !== "list");
    } finally { this.leave(id); }
  }
  async readFile(id: string, path: string) {
    return new Uint8Array(await this.file(id, "read", { path: absolutePath(path) }));
  }
  async writeFile(id: string, path: string, data: string | Uint8Array) {
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    if (bytes.length > FILE_LIMIT) throw new EnvironmentError("file_too_large", "Transfers are limited to 16 MiB per file.");
    await this.file(id, "write", { path: absolutePath(path), data: bytes.toString("base64") });
  }
  async removeFile(id: string, path: string) {
    await this.file(id, "remove", { path: absolutePath(path) });
  }
  async listFiles(id: string, path: string, missingOk = false): Promise<FileEntry[]> {
    return JSON.parse((await this.file(id, "list", { path: absolutePath(path), missingOk })).toString()) as FileEntry[];
  }
}
