import { EnvironmentError, absolutePath, required } from "./errors.js";
import type {
  CreateEnvironment, EnvironmentInfo, EnvironmentProvider, EnvironmentRef,
  ExecOptions, FileEntry, HttpEndpoint, OutputChunk,
} from "./types.js";

export interface CloudflareProviderOptions {
  id: string;
  /** Authenticated operator gateway deployed from cloudflare/. */
  apiUrl: string;
  /** Gateway credential, never a Cloudflare account token. */
  apiKey: string;
  requestTimeoutMs?: number;
  /** Local fixture servers only. */
  allowHttp?: boolean;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function createCloudflareProvider(options: CloudflareProviderOptions): EnvironmentProvider {
  return new CloudflareProvider(options);
}
class CloudflareProvider implements EnvironmentProvider {
  readonly id: string;
  readonly capabilities = Object.freeze({
    automaticPause: true, pause: true, processMemoryResume: false, persistence: "provider-template",
  } as const);
  private readonly base: string;
  private readonly key: string;
  private readonly timeout: number;
  private readonly uncertain = new Set<string>();
  constructor(options: CloudflareProviderOptions) {
    this.id = required(options.id, "id");
    this.key = required(options.apiKey, "apiKey");
    const url = new URL(options.apiUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
      throw new EnvironmentError("invalid_endpoint", "A HTTPS gateway origin is required.");
    this.base = url.origin;
    this.timeout = options.requestTimeoutMs ?? 180000;
  }
  hasUncertainExecution(id: string) { return this.uncertain.has(id); }
  resetExecutionUncertainty(id: string) { this.uncertain.delete(id); }
  private path(id: string, suffix = "") {
    if (!UUID.test(id)) throw new EnvironmentError("invalid_id", "Invalid Cloudflare environment ID.");
    return `/v1/environments/${id}${suffix}`;
  }
  private async request(path: string, method = "GET", data?: unknown, signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(this.base + path, {
        method, redirect: "error", signal: controller.signal,
        headers: { "X-Environment-Control": this.key, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      if (!res.ok) {
        let code = "gateway_error";
        try {
          const error = await res.json() as { error?: string };
          if (typeof error.error === "string" && /^[a-z_]{1,80}$/.test(error.error)) code = error.error;
        } catch { /* Do not expose an upstream HTML page or diagnostic body. */ }
        throw new EnvironmentError(code, `Cloudflare gateway request failed (${res.status}).`, res.status >= 500);
      }
      return res;
    } catch (error) {
      if (error instanceof EnvironmentError) throw error;
      throw new EnvironmentError("transport_error", "Cloudflare request outcome is unknown.", method !== "GET");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  private project(value: any): EnvironmentInfo {
    if (!value || !UUID.test(value.id) || !["running", "paused", "missing", "unknown"].includes(value.state))
      throw new EnvironmentError("invalid_response", "Invalid environment response.");
    return { provider: this.id, id: value.id, state: value.state, template: value.template, metadata: value.metadata ?? {} };
  }
  async create(spec: CreateEnvironment): Promise<EnvironmentRef> {
    const value = this.project(await (await this.request("/v1/environments", "POST", spec)).json());
    return { provider: this.id, id: value.id };
  }
  async info(id: string): Promise<EnvironmentInfo> {
    try { return this.project(await (await this.request(this.path(id))).json()); }
    catch (error) {
      if (error instanceof EnvironmentError && error.code === "environment_missing")
        return { provider: this.id, id, state: "missing", metadata: {} };
      throw error;
    }
  }
  async list(metadata: Record<string, string> = {}): Promise<EnvironmentInfo[]> {
    const values = await (await this.request("/v1/environments")).json();
    if (!Array.isArray(values)) throw new EnvironmentError("invalid_response", "Invalid environment list.");
    return values.map(x => this.project(x)).filter(x => Object.entries(metadata).every(([k, v]) => x.metadata[k] === v));
  }
  async resume(id: string, timeoutSeconds = 600) {
    return this.project(await (await this.request(this.path(id, "/resume"), "POST", { timeoutSeconds })).json());
  }
  async pause(id: string) {
    if (this.hasUncertainExecution(id)) throw new EnvironmentError("execution_uncertain", "Reconcile execution before pausing.");
    await this.request(this.path(id, "/pause"), "POST", {});
  }
  async destroy(id: string) {
    try { await this.request(this.path(id), "DELETE"); }
    catch (error) { if (!(error instanceof EnvironmentError && error.code === "environment_missing")) throw error; }
    if ((await this.info(id)).state !== "missing") throw new EnvironmentError("destroy_unconfirmed", "Environment removal is unconfirmed.", true);
    this.uncertain.delete(id);
  }
  async setTimeout(id: string, seconds: number) {
    await this.request(this.path(id, "/timeout"), "POST", { seconds });
  }
  async httpEndpoint(id: string, port: number): Promise<HttpEndpoint> {
    const value = await (await this.request(this.path(id, "/endpoint"), "POST", { port })).json() as HttpEndpoint;
    if (value.url !== `${this.base}/v1/app/${id}/${port}` ||
        !value.headers || Object.keys(value.headers).length !== 1 ||
        typeof value.headers["X-Environment-Access"] !== "string")
      throw new EnvironmentError("invalid_endpoint_response", "Invalid application capability.");
    return value;
  }
  async *exec(id: string, argv: string[], options: ExecOptions = {}): AsyncIterable<OutputChunk> {
    if (options.signal?.aborted) throw new EnvironmentError("execution_aborted", "Execution was cancelled before starting.");
    let observedExit = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => { void reader?.cancel().catch(() => {}); };
    const decoders = {
      stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
      stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
    };
    try {
      const res = await this.request(this.path(id, "/exec"), "POST", {
        argv, cwd: options.cwd, env: options.env, timeoutSeconds: options.timeoutSeconds,
      }, options.signal);
      if (!res.body) throw new Error("missing_stream");
      reader = res.body.getReader();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      let pending = "", decoder = new TextDecoder();
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        pending += decoder.decode(item.value, { stream: true });
        if (pending.length > 2 * 1024 * 1024) throw new Error("oversized_frame");
        for (;;) {
          const end = pending.indexOf("\n");
          if (end < 0) break;
          const frame = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
          if (frame.error) throw new Error("remote_uncertain");
          if (Number.isInteger(frame.exitCode)) {
            if (observedExit) throw new Error("duplicate_exit");
            for (const stream of ["stdout", "stderr"] as const) {
              const text = decoders[stream].decode();
              if (text) yield { stream, text };
            }
            observedExit = true;
            options.onExit?.({ exitCode: frame.exitCode });
          } else if (!observedExit && ["stdout", "stderr"].includes(frame.stream) && typeof frame.data === "string") {
            const stream = frame.stream as "stdout" | "stderr";
            const bytes = new Uint8Array(Buffer.from(frame.data, "base64"));
            yield { stream, bytes, text: decoders[stream].decode(bytes, { stream: true }) };
          } else throw new Error("invalid_frame");
        }
      }
      if (!observedExit || pending.trim()) throw new Error("missing_exit");
    } catch (error) {
      if (!observedExit) this.uncertain.add(id);
      if (error instanceof EnvironmentError) throw error;
      throw new EnvironmentError("execution_uncertain", "No confirmed command completion; reconcile before retrying.", true);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (!observedExit) { this.uncertain.add(id); await reader?.cancel().catch(() => {}); }
      reader?.releaseLock();
    }
  }
  async readFile(id: string, path: string) {
    const res = await this.request(this.path(id, "/files?path=" + encodeURIComponent(absolutePath(path))));
    return new Uint8Array(await res.arrayBuffer());
  }
  async writeFile(id: string, path: string, data: string | Uint8Array) {
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    if (bytes.length > 16 * 1024 * 1024) throw new EnvironmentError("file_too_large", "Trial gateway transfers up to 16 MiB per file.");
    await this.request(this.path(id, "/files"), "PUT", { path: absolutePath(path), data: bytes.toString("base64") });
  }
  async removeFile(id: string, path: string) {
    await this.request(this.path(id, "/files"), "DELETE", { path: absolutePath(path) });
  }
  async listFiles(id: string, path: string, missingOk = false): Promise<FileEntry[]> {
    return await (await this.request(this.path(id, "/files"), "POST", { path: absolutePath(path), missingOk })).json() as FileEntry[];
  }
}
