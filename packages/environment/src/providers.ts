import type { ConnectionOpts, SandboxOpts } from "e2b";
import { sdkDriver, isMissingSandbox, isMissingFile, type E2BDriver, type RemoteSandbox, type RemoteInfo } from "./driver.js";
import { execute } from "./exec.js";
import { EnvironmentError, ExecutionAbortedBeforeStart, required, seconds, absolutePath } from "./errors.js";
import type { CreateEnvironment, EnvironmentProvider, EnvironmentInfo, EnvironmentRef, ExecOptions, FileEntry, ProviderCapabilities } from "./types.js";

export interface ProviderOptions {
  id: string;
  apiKey: string;
  domain?: string;
  apiUrl?: string;
  /** Optional fixed data-plane proxy URL (SDK sends E2b-Sandbox-Id/Port). */
  sandboxUrl?: string;
  /** Optional application-port gateway; must preserve application Authorization. */
  serviceUrl?: string;
  requestTimeoutMs?: number;
  /** Explicit opt-in for loopback fixtures or private HTTP gateways. */
  allowHttp?: boolean;
  /** Test/transport integration seam. Never populated from an end-user request. */
  driver?: E2BDriver;
}
export interface AlibabaOptions extends ProviderOptions {
  pausedRetention?: string;
}

export function createAlibabaProvider(options: AlibabaOptions): EnvironmentProvider {
  return new E2BProvider("alibaba", options);
}
export function createVolcengineProvider(options: ProviderOptions): EnvironmentProvider {
  return new E2BProvider("volcengine", options);
}

class E2BProvider implements EnvironmentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly connection: ConnectionOpts;
  private readonly driver: E2BDriver;
  private readonly handles = new Map<string, RemoteSandbox>();
  private readonly attaching = new Map<string, Promise<RemoteSandbox>>();
  private readonly uncertain = new Set<string>();
  constructor(private readonly kind: "alibaba" | "volcengine", private readonly options: AlibabaOptions) {
    this.id = required(options.id, "provider id");
    required(options.apiKey, "api key");
    if (!options.domain && !options.apiUrl) throw new EnvironmentError("endpoint_required", "An explicit cloud endpoint is required.");
    if (options.domain && !/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(options.domain))
      throw new EnvironmentError("invalid_endpoint", "Domain must be a hostname, optionally with a port.");
    for (const endpoint of [options.apiUrl, options.sandboxUrl, options.serviceUrl]) if (endpoint) {
      const url = new URL(endpoint);
      if (url.username || url.password || url.search || url.hash || !["https:", ...(options.allowHttp ? ["http:"] : [])].includes(url.protocol))
        throw new EnvironmentError("invalid_endpoint", "Use an HTTPS endpoint without embedded credentials, query or fragment.");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 185_000;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300_000)
      throw new EnvironmentError("invalid_timeout", "Request timeout must be 1–300000 milliseconds.");
    this.connection = {
      apiKey: options.apiKey,
      domain: options.domain ?? new URL(options.apiUrl!).hostname,
      apiUrl: options.apiUrl ?? `https://${kind === "alibaba" ? "api." : ""}${options.domain}`,
      sandboxUrl: options.sandboxUrl,
      requestTimeoutMs,
    };
    this.driver = options.driver ?? sdkDriver;
    this.capabilities = Object.freeze({
      automaticPause: kind === "alibaba", pause: true, processMemoryResume: false, persistence: "provider-template",
    });
  }
  async create(request: CreateEnvironment): Promise<EnvironmentRef> {
    required(request.template, "template");
    for (const [label, record] of [["metadata", request.metadata], ["env", request.env]] as const) {
      if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record) ||
        Object.entries(record).some(([key, value]) => !key || key.includes("\0") || typeof value !== "string" || value.includes("\0"))))
        throw new EnvironmentError("invalid_argument", label + " must contain string values without NUL.");
    }
    seconds(request.timeoutSeconds ?? 3600);
    if (request.onTimeout && !["kill", "pause"].includes(request.onTimeout))
      throw new EnvironmentError("invalid_lifecycle", "Unknown timeout policy.");
    if (request.onTimeout === "pause" && !this.capabilities.automaticPause)
      throw new EnvironmentError("unsupported_capability", "Volcengine does not support automatic pause on create. Use explicit pause.");
    if (this.kind === "volcengine" && Object.keys(request.metadata ?? {}).some(key => key.includes(".kruise.io/")))
      throw new EnvironmentError("foreign_metadata", "Alibaba-specific mount/lifecycle metadata must be adapted before use on Volcengine.");
    const metadata = { ...request.metadata };
    if (this.kind === "alibaba" && request.onTimeout === "pause" && this.options.pausedRetention)
      metadata["e2b.agents.kruise.io/reserve-paused-sandbox-duration"] = this.options.pausedRetention;
    const options: SandboxOpts = {
      ...this.connection, secure: true, timeoutMs: (request.timeoutSeconds ?? 3600) * 1000,
      envs: request.env, metadata,
      ...(this.kind === "alibaba" && request.onTimeout === "pause"
        ? { lifecycle: { onTimeout: "pause", autoResume: false } } : {}),
    };
    let handle: RemoteSandbox;
    try { handle = await this.driver.create(request.template, options); }
    catch { throw new EnvironmentError("create_unknown", "Creation failed or its outcome is unknown. Inspect provider resources before retrying.", true); }
    this.handles.set(handle.sandboxId, handle);
    return { provider: this.id, id: handle.sandboxId };
  }
  private describe(info: RemoteInfo): EnvironmentInfo {
    return {
      provider: this.id, id: info.sandboxId, template: info.templateId,
      state: info.state === "running" || info.state === "paused" ? info.state : "unknown",
      metadata: { ...info.metadata },
    };
  }
  async info(id: string): Promise<EnvironmentInfo> {
    required(id, "environment id");
    try { return this.describe(await this.driver.info(id, this.connection)); }
    catch (error) {
      if (isMissingSandbox(error, this.kind === "volcengine" ? id : undefined)) {
        this.handles.delete(id);
        return { provider: this.id, id, state: "missing", metadata: {} };
      }
      throw new EnvironmentError("status_unavailable", "Environment status could not be read.");
    }
  }
  async list(metadata: Record<string, string> = {}): Promise<EnvironmentInfo[]> {
    try {
      // Enforce filtering locally too; a gateway may ignore its metadata query.
      return (await this.driver.list(this.connection, metadata))
        .filter(item => Object.entries(metadata).every(([key, value]) => item.metadata[key] === value))
        .map(item => this.describe(item));
    } catch { throw new EnvironmentError("list_unavailable", "Environment listing failed."); }
  }
  async resume(id: string, timeoutSeconds = 3600): Promise<EnvironmentInfo> {
    required(id, "environment id"); seconds(timeoutSeconds);
    let handle: RemoteSandbox;
    try {
      handle = await this.driver.connect(id, { ...this.connection, timeoutMs: timeoutSeconds * 1000 });
      // A running VCI sandbox ignores connect's timeout. Explicitly apply the
      // requested lifetime so reconnect cannot silently expire an active host.
      await this.driver.setTimeout(id, timeoutSeconds * 1000, this.connection);
    }
    catch (error) {
      if (isMissingSandbox(error, this.kind === "volcengine" ? id : undefined)) throw new EnvironmentError("environment_missing", "Environment was deleted; explicit creation is required.");
      throw new EnvironmentError("resume_unknown", "Resume outcome is unknown; query status before retrying.", true);
    }
    this.handles.set(id, handle);
    return this.info(id);
  }
  async pause(id: string): Promise<void> {
    required(id, "environment id");
    if (this.kind === "volcengine") {
      const state = (await this.info(id)).state;
      if (state === "paused") { this.handles.delete(id); return; }
      if (state !== "running") throw new EnvironmentError("environment_not_running", "Only a running environment can be paused.");
      // VCI snapshots disk state, not process memory. Flush completed writes
      // before requesting the snapshot; the caller must stop concurrent writers.
      let code: number | null = null;
      for await (const _ of this.exec(id, ["sync"], { timeoutSeconds: 30, onExit: exit => { code = exit.exitCode; } })) { /* drain */ }
      if (code !== 0) throw new EnvironmentError("pause_flush_failed", "Disk flush failed; pause was not requested.");
    }
    try { await this.driver.pause(id, this.connection); }
    catch { throw new EnvironmentError("pause_unknown", "Pause was not confirmed; inspect provider state.", true); }
    finally { this.handles.delete(id); }
  }
  async destroy(id: string): Promise<void> {
    required(id, "environment id");
    try { await this.driver.kill(id, this.connection); }
    catch (error) {
      if (!isMissingSandbox(error, this.kind === "volcengine" ? id : undefined)) throw new EnvironmentError("delete_unknown", "Deletion was not confirmed; inspect provider state.", true);
    } finally { this.handles.delete(id); }
    let state: EnvironmentInfo["state"];
    try { state = (await this.info(id)).state; }
    catch { throw new EnvironmentError("delete_unknown", "Deletion was accepted but its result could not be verified.", true); }
    if (state !== "missing")
      throw new EnvironmentError("delete_pending", "Deletion is not yet observed.", true);
    this.uncertain.delete(id);
  }
  async setTimeout(id: string, value: number): Promise<void> {
    required(id, "environment id"); seconds(value);
    try { await this.driver.setTimeout(id, value * 1000, this.connection); }
    catch { throw new EnvironmentError("timeout_unknown", "Timeout update was not confirmed.", true); }
  }
  private async live(id: string): Promise<RemoteSandbox> {
    required(id, "environment id");
    const existing = this.handles.get(id);
    if (existing) return existing;
    const inFlight = this.attaching.get(id);
    if (inFlight) return inFlight;
    const pending = (async () => {
      if ((await this.info(id)).state !== "running")
        throw new EnvironmentError("environment_not_running", "Resume the environment explicitly before executing.");
      // SDK connect reattaches a persisted ID. It never creates a replacement.
      let handle: RemoteSandbox;
      try { handle = await this.driver.connect(id, this.connection); }
      catch { throw new EnvironmentError("attach_unknown", "Reattachment failed; query status before retrying.", true); }
      this.handles.set(id, handle);
      return handle;
    })();
    this.attaching.set(id, pending);
    try { return await pending; }
    finally { this.attaching.delete(id); }
  }
  async *exec(id: string, argv: string[], options: ExecOptions = {}) {
    let observed = false;
    if (options.signal?.aborted) throw new ExecutionAbortedBeforeStart();
    const handle = await this.live(id);
    try {
      yield* execute(handle, argv, { ...options, onExit: exit => {
        observed = true; options.onExit?.(exit);
      } });
    } catch (error) {
      if (error instanceof ExecutionAbortedBeforeStart || error instanceof EnvironmentError && ["invalid_command", "invalid_argument", "invalid_path", "invalid_timeout"].includes(error.code)) observed = true;
      throw error;
    } finally { if (!observed) this.uncertain.add(id); }
  }
  private async io<T>(id: string, operation: (handle: RemoteSandbox) => Promise<T>): Promise<T> {
    const handle = await this.live(id);
    try { return await operation(handle); }
    catch (error) {
      if (isMissingFile(error)) throw error;
      this.uncertain.add(id);
      throw new EnvironmentError("file_operation_unknown", "File operation failed; inspect environment state before retrying a write.", true);
    }
  }
  async httpEndpoint(id: string, port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new EnvironmentError("invalid_port", "Service port must be 1–65535.");
    const handle = await this.live(id);
    const headers: Record<string, string> = {};
    // envd's X-Access-Token and the cloud API key never authenticate applications.
    if (handle.trafficAccessToken) headers["e2b-traffic-access-token"] = handle.trafficAccessToken;
    if (this.options.serviceUrl) {
      headers["E2b-Sandbox-Id"] = id;
      headers["E2b-Sandbox-Port"] = String(port);
    }
    const url = this.options.serviceUrl ?? `https://${handle.getHost(port)}`;
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      !["https:", ...(this.options.allowHttp ? ["http:"] : [])].includes(parsed.protocol))
      throw new EnvironmentError("invalid_endpoint", "Invalid application endpoint.");
    return { url, headers };
  }
  readFile(id: string, path: string): Promise<Uint8Array> {
    absolutePath(path);
    return this.io(id, handle => handle.files.read(path, { format: "bytes" }));
  }
  async writeFile(id: string, path: string, data: string | Uint8Array): Promise<void> {
    absolutePath(path);
    const payload = typeof data === "string" ? data : new Uint8Array(data).buffer;
    await this.io(id, handle => handle.files.write(path, payload));
  }
  async removeFile(id: string, path: string): Promise<void> {
    absolutePath(path);
    try { await this.io(id, handle => handle.files.remove(path)); }
    catch (error) { if (!isMissingFile(error)) throw error; }
  }
  async listFiles(id: string, path: string, missingOk = false): Promise<FileEntry[]> {
    absolutePath(path);
    const handle = await this.live(id);
    const result: FileEntry[] = [];
    const visited = new Set<string>();
    const walk = async (directory: string, depth = 0) => {
      if (visited.has(directory) || depth > 128 || visited.size > 100_000)
        throw new EnvironmentError("file_list_limit", "File traversal exceeded its limit.");
      visited.add(directory);
      let entries;
      try { entries = await handle.files.list(directory); }
      catch (error) {
        if (directory === path && missingOk && isMissingFile(error)) return;
        if (isMissingFile(error)) throw error;
        throw new EnvironmentError("file_list_unavailable", "File listing failed.");
      }
      for (const file of entries) {
        if (file.type === "dir" && !file.symlinkTarget) await walk(file.path, depth + 1);
        else if (file.type === "file") {
          if (!file.modifiedTime || !Number.isFinite(file.modifiedTime.getTime()))
            throw new EnvironmentError("file_metadata_unavailable", "Gateway did not provide file modification time.");
          result.push({ path: file.path, size: file.size, mtimeMs: file.modifiedTime.getTime() });
        }
      }
    };
    await walk(path);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  hasUncertainExecution(id: string): boolean { return this.uncertain.has(id); }
  resetExecutionUncertainty(id: string): void { this.uncertain.delete(id); }
}
