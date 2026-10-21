import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { UUID, equalSecret, signAccess, verifyAccess, createSpec, lifetime, strings } from "./security.mjs";
import { allowEgress } from "./egress.mjs";
import { installAge, archiveAgent } from "./backup";

interface Env {
  SOURCE_REVISION?: string;
  SANDBOXES: DurableObjectNamespace<AgentSandbox>;
  CATALOG: DurableObjectNamespace<Catalog>;
  CONTROL_TOKEN: string;
  ACCESS_SIGNING_KEY: string;
  MAX_ENVIRONMENTS: string;
  BACKUPS: R2Bucket;
  BACKUP_RECIPIENT: string;
  AGE_KEY: string;
  AGE_SHA256: string;
  DAILY_RUNTIME_MINUTES: string;
}
interface RecordData {
  id: string;
  template: string;
  metadata: Record<string, string>;
  env: Record<string, string>;
  status: "creating" | "running" | "paused" | "missing" | "unknown";
  expires: number;
  onTimeout: "pause" | "kill";
  snapshot?: { id: string; size: number; createdAt: number };
}
class ApiError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const fail = (error: unknown) => error instanceof ApiError
  ? json({ error: error.code }, error.status)
  : json({ error: "provider_operation_failed" }, 502);
const info = (r: RecordData, running: boolean) => ({
  id: r.id, template: r.template, metadata: r.metadata,
  state: r.status === "running" ? (running ? "running" : "unknown") :
    r.status === "creating" ? "unknown" : r.status,
});
function bytes64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
async function body(request: Request) {
  if (Number(request.headers.get("Content-Length") ?? 0) > 24 * 1024 * 1024) throw new ApiError("body_too_large", 413);
  const text = await request.text();
  if (text.length > 24 * 1024 * 1024) throw new ApiError("body_too_large", 413);
  try { return JSON.parse(text); } catch { throw new ApiError("invalid_json", 400); }
}

// The gateway is operator-only. Mau remains responsible for end-user ownership,
// per-user quotas and stopping native Agent runs before pause/destroy.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") return json({ service: "agent-environment", provider: "cloudflare", version: 2, revision: env.SOURCE_REVISION ?? null });
      const app = /^\/v1\/app\/([^/]+)\/(\d+)(\/.*)?$/.exec(url.pathname);
      if (app) {
        const [, id, port] = app;
        if (!await verifyAccess(env.ACCESS_SIGNING_KEY, request.headers.get("X-Environment-Access"), id, Number(port)))
          return json({ error: "unauthorized" }, 401);
        return env.SANDBOXES.getByName(id).fetch(request);
      }
      if (!await equalSecret(request.headers.get("X-Environment-Control"), env.CONTROL_TOKEN))
        return json({ error: "unauthorized" }, 401);
      const catalog = env.CATALOG.getByName("environments");
      if (url.pathname === "/v1/environments" && request.method === "POST") {
        let spec;
        try { spec = createSpec(await body(request)); } catch { throw new ApiError("invalid_create", 400); }
        const id = await catalog.reserve(spec.metadata);
        // Reserve before provisioning: a lost response can be reconciled via list.
        const result = await env.SANDBOXES.getByName(id).fetch(new Request("https://internal/create", {
          method: "POST", body: JSON.stringify({ ...spec, id }),
        }));
        return result;
      }
      if (url.pathname === "/v1/environments" && request.method === "GET") {
        const ids = await catalog.ids();
        const entries = await Promise.all(ids.map(async id => {
          const res = await env.SANDBOXES.getByName(id).fetch(new Request("https://internal/info"));
          if (!res.ok) throw new ApiError("list_incomplete", 502);
          return res.json();
        }));
        return json(entries);
      }
      const match = /^\/v1\/environments\/([^/]+)(?:\/(info|pause|resume|timeout|exec|files|endpoint|security|backup))?$/.exec(url.pathname);
      if (!match || !UUID.test(match[1])) return json({ error: "not_found" }, 404);
      const [, id, action = "info"] = match;
      if (!await catalog.contains(id)) return json({ error: "environment_missing" }, 404);
      if (action === "endpoint" && request.method === "POST") {
        const { port } = await body(request);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError("invalid_port", 400);
        return json({
          url: `${url.origin}/v1/app/${id}/${port}`,
          headers: { "X-Environment-Access": await signAccess(env.ACCESS_SIGNING_KEY, id, port, Date.now() + 300000) },
        });
      }
      const path = request.method === "DELETE" && action === "info" ? "/destroy" : `/${action}`;
      const internal = new URL(path, "https://internal");
      internal.search = url.search;
      const forward = new Request(internal, request);
      forward.headers.delete("X-Environment-Control");
      const response = await env.SANDBOXES.getByName(id).fetch(forward);
      if (path === "/destroy" && response.ok) await catalog.remove(id);
      return response;
    } catch (error) { return fail(error); }
  },
  async scheduled(_event: ScheduledController, env: Env) {
    const ids = await env.CATALOG.getByName("environments").ids();
    for (const id of ids) {
      const result = await env.SANDBOXES.getByName(id).fetch(new Request("https://internal/maintenance", {method:"POST"}));
      console.log(JSON.stringify({event:"agent_backup_check",environment:id,ok:result.ok}));
    }
  },
} satisfies ExportedHandler<Env>;

/** This policy executes outside the guest. Guest root cannot change it. */
export class AgentEgress extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    if (!allowEgress(request.url, request.method)) return json({error:"destination_not_allowed"},403);
    return fetch(request, {redirect:"manual"});
  }
}

export class Catalog extends DurableObject<Env> {
  async reserve(metadata: Record<string, string>): Promise<string> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const entries = await this.ctx.storage.list({ prefix: "id:" });
      const max = Number(this.env.MAX_ENVIRONMENTS ?? 3);
      if (entries.size >= max) throw new ApiError("trial_capacity_reached");
      const id = crypto.randomUUID();
      await this.ctx.storage.put(`id:${id}`, metadata);
      return id;
    });
  }
  async contains(id: string) { return await this.ctx.storage.get(`id:${id}`) !== undefined; }
  async ids() { return [...(await this.ctx.storage.list({ prefix: "id:" })).keys()].map(k => k.slice(3)); }
  async remove(id: string) { await this.ctx.storage.delete(`id:${id}`); }
}

export class AgentSandbox extends DurableObject<Env> {
  private busy = 0;
  private changing = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (ctx.container?.running) ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(6 * 3600000));
  }
  private get container() {
    if (!this.ctx.container) throw new ApiError("container_unavailable", 503);
    return this.ctx.container;
  }
  private async record() {
    const r = await this.ctx.storage.get<RecordData>("record");
    if (!r || r.status === "missing") throw new ApiError("environment_missing", 404);
    return r;
  }
  private async enter() {
    const r = await this.record();
    // Check and claim without an intervening await, so a lifecycle operation
    // cannot start between checking the record and starting guest I/O.
    if (this.changing || r.status !== "running" || !this.container.running)
      throw new ApiError("environment_not_running");
    this.busy++;
    return r;
  }
  private async change<T>(fn: () => Promise<T>, allowBusy = false): Promise<T> {
    if (this.changing || this.busy && !allowBusy) throw new ApiError("environment_busy");
    this.changing = true;
    try { return await fn(); } finally { this.changing = false; }
  }
  private async start(r: RecordData, restore: boolean) {
    if (restore && !r.snapshot) throw new ApiError("snapshot_missing");
    const usage = await this.runtimeUsage();
    if (usage.usedMs >= Number(this.env.DAILY_RUNTIME_MINUTES) * 60000) throw new ApiError("daily_runtime_limit",429);
    const readyFile = "/run/mau-network-ready-" + crypto.randomUUID();
    // No image fallback on an expired or missing snapshot.
    this.container.start({
      ...(restore ? { containerSnapshot: { id: r.snapshot!.id } } : { image: "cloudflare/debian-trixie" }),
      entrypoint: ["sh", "-c", `while [ ! -f ${readyFile} ] || [ ! -f /opt/agent-environment/start.sh ]; do sleep 1; done; exec sh /opt/agent-environment/start.sh`],
      enableInternet: false,
      instance: { vcpu: 2, memoryMib: 6144, diskMb: 10000 },
      env: {...r.env, NODE_EXTRA_CA_CERTS:"/etc/cloudflare/certs/cloudflare-containers-ca.crt"},
    });
    const egress = this.ctx.exports.AgentEgress({props:{}});
    await this.container.interceptAllOutboundHttp(egress);
    await this.container.interceptOutboundHttps("*",egress);
    await this.container.setInactivityTimeout(6 * 3600000);
    const ready = await (await this.container.exec(["node", "--version"])).output();
    if (ready.exitCode !== 0) throw new ApiError("container_not_ready", 502);
    if(!restore) {
      const ca=await(await this.container.exec(["sh","-c","apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates"],{signal:AbortSignal.timeout(120000)})).output();
      if(ca.exitCode!==0)throw new ApiError("bootstrap_trust_failed",502);
    }
    await installAge(this.container,this.env.BACKUPS,this.env.AGE_KEY,this.env.AGE_SHA256);
    const trust=await(await this.container.exec(["sh","-c",`cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/mau-cloudflare.crt && update-ca-certificates >/dev/null 2>&1 && touch ${readyFile}`])).output();
    if(trust.exitCode!==0)throw new ApiError("network_trust_failed",502);
    await this.ctx.storage.put("runtime", {...usage,startedAt:Date.now()});
    r.status = "running";
    await this.ctx.storage.put("record", r);
    await this.ctx.storage.setAlarm(Math.min(r.expires, Date.now() + 60000));
    return info(r, true);
  }
  private async pause(r: RecordData) {
    if (r.status === "paused") return info(r, false);
    if (r.status !== "running" || !this.container.running) throw new ApiError("environment_not_running");
    const sync = await (await this.container.exec(["sync"])).output();
    if (sync.exitCode !== 0) throw new ApiError("snapshot_flush_failed", 502);
    const snapshot = await this.container.snapshotContainer({ name: "agent-environment" });
    // Commit the recoverable snapshot before destroying the running instance.
    r.snapshot = { id: snapshot.id, size: snapshot.size, createdAt: Date.now() };
    await this.ctx.storage.put(`snapshot:${snapshot.id}`, r.snapshot);
    await this.ctx.storage.put("record", r);
    const usage=await this.runtimeUsage();await this.ctx.storage.put("runtime",{...usage,startedAt:0});
    await this.container.destroy();
    r.status = "paused";
    await this.ctx.storage.put("record", r);
    await this.ctx.storage.deleteAlarm();
    // Export from a stopped snapshot: native Host databases can hold exclusive locks.
    // The durable snapshot is already committed, so an export failure does not undo pause.
    try { await this.backup(r); } catch { console.error(JSON.stringify({event:"agent_backup_failed",environment:r.id,ok:false})); }
    return info(r, false);
  }
  private async runtimeUsage() {
    const now=Date.now(),day=new Date(now).toISOString().slice(0,10);
    const old=await this.ctx.storage.get<{day:string;usedMs:number;startedAt:number}>("runtime");
    const usage={day,usedMs:old?.day===day?old.usedMs:0,startedAt:this.container.running?now:0};
    if(old?.startedAt&&this.container.running)usage.usedMs+=now-Math.max(old.startedAt,Date.parse(day+"T00:00:00Z"));
    await this.ctx.storage.put("runtime",usage);return usage;
  }
  private async backup(r: RecordData) {
    const last=await this.ctx.storage.get<{createdAt:number;version?:number}>("backup");
    if(last?.version===2&&new Date(last.createdAt).toISOString().slice(0,10)===new Date().toISOString().slice(0,10))return;
    if(r.status!=="paused"||!r.snapshot||this.container.running)throw new ApiError("backup_requires_paused");
    this.container.start({containerSnapshot:{id:r.snapshot.id},entrypoint:["sh","-c","exec sleep infinity"],enableInternet:false,instance:{vcpu:2,memoryMib:6144,diskMb:10000}});
    await this.container.setInactivityTimeout(300000);
    try {
      await installAge(this.container,this.env.BACKUPS,this.env.AGE_KEY,this.env.AGE_SHA256);
      const saved=await archiveAgent(this.container,this.env.BACKUPS,r.id,this.env.BACKUP_RECIPIENT);
      await this.ctx.storage.put("backup",saved);
      console.log(JSON.stringify({event:"agent_backup_complete",environment:r.id,bytes:saved.bytes}));
    } finally {await this.container.destroy();}
  }

  async alarm() {
    try {
      const r = await this.record();
      if (r.status !== "running" || !this.container.running) return;
      const usage=await this.runtimeUsage();
      if(usage.usedMs>=Number(this.env.DAILY_RUNTIME_MINUTES)*60000)r.expires=Date.now();
      if (Date.now() < r.expires || this.busy || this.changing) {
        await this.ctx.storage.setAlarm(Date.now() + 60000);
        return;
      }
      await this.change(async () => {
        if (r.onTimeout === "pause") await this.pause(r);
        else {
          await this.container.destroy();
          r.status = "missing";
          await this.ctx.storage.put("record", r);
          await this.env.CATALOG.getByName("environments").remove(r.id);
        }
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "environment_missing") return;
      // A failed save must not be mistaken for a successful pause.
      console.error(JSON.stringify({event:"environment_alarm_failed",ok:false}));
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    }
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const app = /^\/v1\/app\/[^/]+\/(\d+)(\/.*)?$/.exec(url.pathname);
      if (app) {
        await this.enter();
        const target = new URL(app[2] ?? "/", "http://container");
        target.search = url.search;
        const forwarded = new Request(target, request);
        forwarded.headers.delete("X-Environment-Access");
        forwarded.headers.delete("X-Environment-Control");
        // Host Authorization survives; provider control credentials never enter the guest.
        try {
          const response = await this.container.getTcpPort(Number(app[1])).fetch(forwarded);
          if (!response.body) { this.busy--; return response; }
          const reader = response.body.getReader();
          let finished = false;
          const release = () => { if (!finished) { finished = true; this.busy--; } };
          const stream = new ReadableStream({
            pull: async controller => {
              try {
                const next = await reader.read();
                if (next.done) { release(); controller.close(); }
                else controller.enqueue(next.value);
              } catch (error) { release(); controller.error(error); }
            },
            cancel: async reason => { release(); await reader.cancel(reason); },
          });
          return new Response(stream, response);
        } catch (error) { this.busy--; throw error; }
      }
      if (url.pathname === "/create" && request.method === "POST") {
        return await this.change(async () => {
          if (await this.ctx.storage.get("record")) throw new ApiError("already_created");
          const b = await body(request), spec = createSpec(b);
          if (!UUID.test(b.id)) throw new ApiError("invalid_id", 400);
          const r: RecordData = { ...spec, id: b.id, status: "creating", expires: Date.now() + spec.timeoutSeconds * 1000 };
          await this.ctx.storage.put("record", r);
          return json(await this.start(r, false));
        });
      }
      if (url.pathname === "/info" && request.method === "GET") {
        const r = await this.ctx.storage.get<RecordData>("record");
        return r ? json(info(r, this.container.running)) : json({ error: "environment_missing" }, 404);
      }
      if(url.pathname==="/security"&&request.method==="GET")return json({version:2,egress:"model-and-package-allowlist",runtime:await this.runtimeUsage(),backup:await this.ctx.storage.get("backup")??null});
      if(url.pathname==="/backup"&&request.method==="POST")return this.change(async()=>{const r=await this.record();await this.backup(r);return json({ok:true});});
      if(url.pathname==="/maintenance"&&request.method==="POST")return this.change(async()=>{
        const r=await this.record();if(r.status!=="paused")return json({skipped:true});
        const last=await this.ctx.storage.get<{createdAt:number;version?:number}>("backup");
        if(last?.version===2&&Date.now()-last.createdAt<20*3600000)return json({skipped:true});
        await this.backup(r);return json({ok:true});
      });
      if (url.pathname === "/destroy" && request.method === "DELETE") {
        return await this.change(async () => {
          const r = await this.ctx.storage.get<RecordData>("record");
          if (this.container.running) await this.container.destroy();
          if (r) { r.status = "missing"; r.env = {}; await this.ctx.storage.put("record", r); }
          await this.ctx.storage.deleteAlarm();
          return json({ state: "missing" });
        });
      }
      if (url.pathname === "/pause" && request.method === "POST")
        return await this.change(async () => json(await this.pause(await this.record())));
      if (url.pathname === "/resume" && request.method === "POST") {
        return await this.change(async () => {
          const r = await this.record(), b = await body(request);
          r.expires = Date.now() + lifetime(b.timeoutSeconds ?? 600) * 1000;
          if (r.status === "running" && this.container.running) {
            await this.ctx.storage.put("record", r);
            return json(info(r, true));
          }
          if (r.status !== "paused") throw new ApiError("resume_requires_paused");
          return json(await this.start(r, true));
        });
      }
      if (url.pathname === "/timeout" && request.method === "POST") {
        const b = await body(request);
        return await this.change(async () => {
          const r = await this.record();
          r.expires = Date.now() + lifetime(b.seconds) * 1000;
          await this.ctx.storage.put("record", r);
          if (r.status === "running") await this.ctx.storage.setAlarm(Math.min(r.expires, Date.now() + 60000));
          return json({ ok: true });
        }, true);
      }
      if (url.pathname === "/exec" && request.method === "POST") return await this.execute(request);
      if (url.pathname === "/files") return await this.files(request, url);
      return json({ error: "not_found" }, 404);
    } catch (error) { return fail(error); }
  }
  private async execute(request: Request): Promise<Response> {
    const b = await body(request);
    if (!Array.isArray(b.argv) || b.argv.length === 0 || b.argv.some((s: unknown) => typeof s !== "string" || s.includes("\0")))
      throw new ApiError("invalid_argv", 400);
    const seconds = b.timeoutSeconds ?? 60;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new ApiError("invalid_exec_timeout", 400);
    const extra = strings(b.env);
    const abort = new AbortController();
    let live = true, disconnected = false;
    const cancel = () => { if (live) abort.abort(); };
    if (request.signal.aborted) throw new ApiError("execution_aborted", 409);
    request.signal.addEventListener("abort", cancel, { once: true });
    const timer = seconds ? setTimeout(cancel, seconds * 1000) : null;
    let r: RecordData;
    try { r = await this.enter(); }
    catch (error) { clearTimeout(timer); request.signal.removeEventListener("abort", cancel); throw error; }
    let process;
    try {
      process = await this.container.exec(b.argv, {
        cwd: b.cwd, env: { ...r.env, ...extra }, signal: abort.signal,
      });
    } catch (error) {
      this.busy--; live = false; clearTimeout(timer); request.signal.removeEventListener("abort", cancel);
      throw error;
    }
    const cleanup = () => { live = false; clearTimeout(timer); request.signal.removeEventListener("abort", cancel); };
    const exit = process.exitCode;
    void exit.then(cleanup, cleanup);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        const emit = (value: unknown) => { if (!disconnected) controller.enqueue(encoder.encode(JSON.stringify(value) + "\n")); };
        const pump = async (source: ReadableStream | null | undefined, channel: string) => {
          if (!source) return;
          const reader = source.getReader();
          try { for (;;) { const part = await reader.read(); if (part.done) break; emit({ stream: channel, data: bytes64(part.value) }); } }
          finally { reader.releaseLock(); }
        };
        const run = async () => {
          try {
            await Promise.all([pump(process.stdout, "stdout"), pump(process.stderr, "stderr")]);
            emit({ exitCode: await exit });
          } catch { emit({ error: "execution_uncertain" }); }
          finally {
            cleanup(); this.busy--;
            if (!disconnected) controller.close();
          }
        };
        this.ctx.waitUntil(run());
      },
      cancel: () => { disconnected = true; cancel(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  }
  private async files(request: Request, url: URL) {
    const op = request.method === "GET" ? "read" : request.method === "PUT" ? "write" :
      request.method === "DELETE" ? "remove" : request.method === "POST" ? "list" : "";
    if (!op) throw new ApiError("method_not_allowed", 405);
    const b = op === "read" ? { path: url.searchParams.get("path") } : await body(request);
    if (typeof b.path !== "string" || !b.path.startsWith("/") || b.path.includes("\0")) throw new ApiError("invalid_path", 400);
    // Node is in the official base image. Exact bytes go through stdin/stdout,
    // never shell interpolation; this small helper has no cloud credentials.
    const helper = `
const fs=require('node:fs/promises'),p=require('node:path');
(async()=>{const chunks=[];for await(const c of process.stdin)chunks.push(c);
const b=JSON.parse(Buffer.concat(chunks).toString());const op=process.argv[1];
if(op==='write'){const bytes=Buffer.from(b.data,'base64');if(bytes.length>16777216)throw Object.assign(Error(),{code:'EFBIG'});
let path=b.path,old;try{path=await fs.realpath(path);old=await fs.stat(path);}catch(e){if(e.code!=='ENOENT')throw e;}
await fs.mkdir(p.dirname(path),{recursive:true});const tmp=path+'.upload-'+require('node:crypto').randomUUID();
try{await fs.writeFile(tmp,bytes,{flag:'wx',mode:old?old.mode&511:438});if(old)await fs.chown(tmp,old.uid,old.gid);await fs.rename(tmp,path);}
finally{await fs.rm(tmp,{force:true});}console.log('{}');}
if(op==='read'){const s=await fs.stat(b.path);if(s.size>16777216)throw Object.assign(Error(),{code:'EFBIG'});process.stdout.write(await fs.readFile(b.path));}
if(op==='remove'){await fs.rm(b.path,{recursive:true,force:true});console.log('{}');}
if(op==='list'){const out=[];async function walk(path){for(const entry of await fs.readdir(path,{withFileTypes:true})){
const name=p.join(path,entry.name);if(entry.isDirectory())await walk(name);else if(entry.isFile()){const s=await fs.stat(name);out.push({path:name,size:s.size,mtimeMs:s.mtimeMs});}
if(out.length>10000)throw Object.assign(Error(),{code:'EFBIG'});}}
let missing=false;try{await fs.stat(b.path);}catch(e){if(b.missingOk&&e.code==='ENOENT')missing=true;else throw e;}
if(!missing)await walk(b.path);console.log(JSON.stringify(out));}
})().catch(e=>{process.stderr.write(e.code||'file_operation_failed');process.exitCode=1;});`;
    await this.enter();
    try {
      const input = new Blob([JSON.stringify(b)]).stream();
      const output = await (await this.container.exec(["node", "-e", helper, op], { stdin: input })).output();
      if (output.exitCode) {
        const error = new TextDecoder().decode(output.stderr);
        throw new ApiError(error === "ENOENT" ? "file_not_found" : "file_operation_failed", error === "ENOENT" ? 404 : 502);
      }
      return new Response(output.stdout, { headers: {
        "Content-Type": op === "read" ? "application/octet-stream" : "application/json",
        "Cache-Control": "no-store",
      } });
    } finally { this.busy--; }
  }
}
