import { SandboxNotFoundError, type ConnectionOpts } from "e2b";
import { sdkDriver, isMissingSandbox, isMissingFile, type E2BDriver, type RemoteSandbox, type RemoteInfo } from "./driver.js";
import { E2BSandboxClient } from "./sandbox/index.js";
import { ExecAbortedBeforeStartError } from "./contracts/tool-executor.js";
import { EnvironmentError, required, seconds, absolutePath } from "./errors.js";
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

// These two operations expose the original client's connection cache only to
// the provider adapter. Execution, I/O and uncertainty remain in OMA's client.
class ProviderClient extends E2BSandboxClient {
  cached(id: string) { return this.sandboxes.get(id) as RemoteSandbox | undefined; }
  detach(id: string) { this.sandboxes.delete(id); }
}
class E2BProvider implements EnvironmentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly connection: ConnectionOpts;
  private readonly driver: E2BDriver;
  private readonly client: ProviderClient;
  private readonly attaching = new Map<string, Promise<RemoteSandbox>>();

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
    const normalize = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); }
      catch (error) {
        if (isMissingSandbox(error, kind === "volcengine" ? id : undefined)) throw new SandboxNotFoundError("Sandbox is missing");
        throw error;
      }
    };
    this.client = new ProviderClient({
      domain: this.connection.domain!, apiKey: options.apiKey, requestTimeoutMs,
      verifyWorkspaceProbe: async () => { throw new Error("Workspace verification requires an OMA SandboxClient with an OSS readback verifier"); },
      createSandbox: async (template, opts) => {
        const metadata = { ...opts.metadata };
        if (kind === "volcengine") {
          // Strip only defaults added by OMA; foreign caller metadata was
          // rejected before create. VCI has an explicit snapshot/pause policy.
          for (const key of Object.keys(metadata)) if (key.startsWith("e2b.agents.kruise.io/")) delete metadata[key];
        } else if (options.pausedRetention) metadata["e2b.agents.kruise.io/reserve-paused-sandbox-duration"] = options.pausedRetention;
        return this.driver.create(template, {
          ...opts, ...this.connection, secure: true, metadata,
          lifecycle: kind === "alibaba" ? opts.lifecycle : { onTimeout: "kill", autoResume: false },
        });
      },
      connectSandbox: (id, opts) => normalize(id, () => this.driver.connect(id, { ...opts, ...this.connection })),
      getSandboxInfo: id => normalize(id, () => this.driver.info(id, this.connection)),
      killSandbox: id => normalize(id, () => this.driver.kill(id, this.connection)),
      setSandboxTimeout: (id, ms) => this.driver.setTimeout(id, ms, this.connection),
    });
  }
  async create(request: CreateEnvironment): Promise<EnvironmentRef> {
    required(request.template, "template");
    // The product API takes an explicit template ID. Do not allow OMA's
    // legacy image-name fallback to silently choose its default template.
    if (/[/:]/.test(request.template)) throw new EnvironmentError("invalid_template", "Use a template ID, not a container image reference.");
    for (const [label, record] of [["metadata", request.metadata], ["env", request.env]] as const) {
      if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record) ||
        Object.entries(record).some(([key, value]) => !key || key.includes("\0") || typeof value !== "string" || value.includes("\0"))))
        throw new EnvironmentError("invalid_argument", label + " must contain string values without NUL.");
    }
    seconds(request.timeoutSeconds ?? 86400);
    if (request.onTimeout && !["kill", "pause"].includes(request.onTimeout))
      throw new EnvironmentError("invalid_lifecycle", "Unknown timeout policy.");
    if (request.onTimeout === "pause" && !this.capabilities.automaticPause)
      throw new EnvironmentError("unsupported_capability", "Volcengine does not support automatic pause on create. Use explicit pause.");
    if (this.kind === "volcengine" && Object.keys(request.metadata ?? {}).some(key => key.includes(".kruise.io/")))
      throw new EnvironmentError("foreign_metadata", "Alibaba-specific mount/lifecycle metadata must be adapted before use on Volcengine.");
    try {
      const ref = await this.client.create({ image: request.template, env: request.env, metadata: request.metadata,
        timeoutSeconds: request.timeoutSeconds, onTimeout: request.onTimeout ?? (this.kind === "alibaba" ? "pause" : "kill") });
      return { provider: this.id, id: ref.id };
    } catch { throw new EnvironmentError("create_unknown", "Creation failed or its outcome is unknown. Inspect provider resources before retrying.", true); }
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
        this.client.detach(id);
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
  async resume(id: string, timeoutSeconds = 86400): Promise<EnvironmentInfo> {
    required(id, "environment id"); seconds(timeoutSeconds);
    try {
      if (!await this.client.reconnect(id, {}, { timeoutSeconds }))
        throw new EnvironmentError("environment_missing", "Environment was deleted; explicit creation is required.");
      // VCI ignores connect's timeout for an already-running environment.
      await this.client.setTimeout(id, timeoutSeconds);
    } catch (error) {
      if (error instanceof EnvironmentError) throw error;
      throw new EnvironmentError("resume_unknown", "Resume outcome is unknown; query status before retrying.", true);
    }
    return this.info(id);
  }
  async pause(id: string): Promise<void> {
    required(id, "environment id");
    if (this.kind === "volcengine") {
      const state = (await this.info(id)).state;
      if (state === "paused") { this.client.detach(id); return; }
      if (state !== "running") throw new EnvironmentError("environment_not_running", "Only a running environment can be paused.");
      // VCI snapshots disk state, not process memory. Flush completed writes
      // before requesting the snapshot; the caller must stop concurrent writers.
      let code: number | null = null;
      for await (const _ of this.exec(id, ["sync"], { timeoutSeconds: 30, onExit: exit => { code = exit.exitCode; } })) { /* drain */ }
      if (code !== 0) throw new EnvironmentError("pause_flush_failed", "Disk flush failed; pause was not requested.");
    }
    try { await this.driver.pause(id, this.connection); }
    catch { throw new EnvironmentError("pause_unknown", "Pause was not confirmed; inspect provider state.", true); }
    finally { this.client.detach(id); }
  }
  async destroy(id: string): Promise<void> {
    required(id, "environment id");
    try { await this.client.destroy(id); }
    catch { throw new EnvironmentError("delete_unknown", "Deletion was not confirmed; inspect provider state.", true); }
  }
  async setTimeout(id: string, value: number): Promise<void> {
    required(id, "environment id"); seconds(value);
    try { await this.client.setTimeout(id, value); }
    catch { throw new EnvironmentError("timeout_unknown", "Timeout update was not confirmed.", true); }
  }
  private async live(id: string): Promise<RemoteSandbox> {
    required(id, "environment id");
    const existing = this.client.cached(id);
    if (existing) return existing;
    const inFlight = this.attaching.get(id);
    if (inFlight) return inFlight;
    const pending = (async () => {
      if ((await this.info(id)).state !== "running")
        throw new EnvironmentError("environment_not_running", "Resume the environment explicitly before executing.");
      // SDK connect reattaches a persisted ID. It never creates a replacement.
      try {
        if (!await this.client.reconnect(id, {})) throw new Error("missing");
      } catch { throw new EnvironmentError("attach_unknown", "Reattachment failed; query status before retrying.", true); }
      return this.client.cached(id)!;
    })();
    this.attaching.set(id, pending);
    try { return await pending; }
    finally { this.attaching.delete(id); }
  }
  async *exec(id: string, argv: string[], options: ExecOptions = {}) {
    if (options.signal?.aborted) throw new ExecAbortedBeforeStartError();
    if (!argv.length || argv.some(value => typeof value !== "string" || value.includes("\0")))
      throw new EnvironmentError("invalid_command", "Command argv must contain strings without NUL.");
    if (options.cwd) absolutePath(options.cwd);
    if (options.timeoutSeconds !== undefined) seconds(options.timeoutSeconds, true);
    await this.live(id);
    try { yield* this.client.exec(id, argv, options); }
    catch (error) {
      if (error instanceof ExecAbortedBeforeStartError || error instanceof Error && error.name === "AbortError") throw error;
      throw new EnvironmentError("execution_unknown", "Command outcome is unknown; inspect the environment before retrying.", true);
    }
  }
  private async io<T>(id: string, operation: () => Promise<T>): Promise<T> {
    await this.live(id);
    try { return await operation(); }
    catch (error) {
      if (isMissingFile(error)) throw error;
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
    return this.io(id, () => this.client.readFileBytes(id, path));
  }
  async writeFile(id: string, path: string, data: string | Uint8Array): Promise<void> {
    absolutePath(path);
    await this.io(id, () => typeof data === "string" ? this.client.writeFile(id, path, data) : this.client.writeFileBytes(id, path, data));
  }
  async removeFile(id: string, path: string): Promise<void> {
    absolutePath(path);
    try { await this.io(id, () => this.client.remove(id, path)); }
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
  hasUncertainExecution(id: string): boolean { return this.client.hasUncertainExecution(id); }
  resetExecutionUncertainty(id: string): void { this.client.resetExecutionUncertainty(id); }
}
