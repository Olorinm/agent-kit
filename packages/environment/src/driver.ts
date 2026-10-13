import { Sandbox, SandboxError, SandboxNotFoundError, FileNotFoundError, CommandExitError,
  type SandboxOpts, type SandboxConnectOpts, type SandboxApiOpts } from "e2b";
import { EnvironmentError } from "./errors.js";

// E2B 2.24 uses `option || environment`, even for debug=false. Refuse ambient
// transport overrides instead of letting one provider's calls reach another.
function explicit<T>(options: T): T {
  if (["E2B_DEBUG", "E2B_SANDBOX_URL", "E2B_ACCESS_TOKEN"].some(key =>
    key === "E2B_DEBUG" ? process.env[key]?.toLowerCase() === "true" : !!process.env[key]))
    throw new EnvironmentError("ambient_sdk_config", "Unset E2B_DEBUG, E2B_SANDBOX_URL and E2B_ACCESS_TOKEN for isolated provider connections.");
  return options;
}

/** Small SDK seam used by contract tests; the default driver calls the real SDK. */
export interface RemoteProcess {
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<boolean>;
  disconnect(): Promise<void>;
}
export interface RemoteSandbox {
  sandboxId: string;
  getHost(port: number): string;
  trafficAccessToken?: string;
  commands: {
    run(command: string, options: {
      background: true; cwd?: string; envs?: Record<string, string>;
      timeoutMs?: number; onStdout(data: string): void; onStderr(data: string): void;
    }): Promise<RemoteProcess>;
  };
  files: {
    read(path: string, options: { format: "bytes" }): Promise<Uint8Array>;
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    remove(path: string): Promise<void>;
    list(path: string): Promise<Array<{
      path: string; type?: string; size: number; modifiedTime?: Date; symlinkTarget?: string;
    }>>;
  };
}
export interface RemoteInfo {
  sandboxId: string; state: string; templateId?: string; metadata: Record<string, string>;
}
export interface E2BDriver {
  create(template: string, options: SandboxOpts): Promise<RemoteSandbox>;
  connect(id: string, options: SandboxConnectOpts): Promise<RemoteSandbox>;
  info(id: string, options: SandboxApiOpts): Promise<RemoteInfo>;
  list(options: SandboxApiOpts, metadata: Record<string, string>): Promise<RemoteInfo[]>;
  pause(id: string, options: SandboxApiOpts): Promise<unknown>;
  kill(id: string, options: SandboxApiOpts): Promise<unknown>;
  setTimeout(id: string, ms: number, options: SandboxApiOpts): Promise<void>;
}
export const sdkDriver: E2BDriver = {
  create: (template, options) => Sandbox.create(template, explicit(options)),
  connect: (id, options) => Sandbox.connect(id, explicit(options)),
  info: (id, options) => Sandbox.getInfo(id, explicit(options)),
  list: async (options, metadata) => {
    const pages = Sandbox.list({ ...explicit(options), query: { metadata } });
    const all: RemoteInfo[] = [];
    while (pages.hasNext) all.push(...await pages.nextItems());
    return all;
  },
  pause: (id, options) => Sandbox.pause(id, explicit(options)),
  kill: (id, options) => Sandbox.kill(id, explicit(options)),
  setTimeout: (id, ms, options) => Sandbox.setTimeout(id, ms, explicit(options)),
};
export const isMissingSandbox = (error: unknown, volcengineId?: string): boolean =>
  error instanceof SandboxNotFoundError ||
  // VCI returns HTTP 404 with code:"NOT_FOUND". E2B 2.24 only recognizes
  // numeric 404 and otherwise builds a generic SandboxError. Match the
  // observed resource-specific response exactly, never every HTTP 404.
  volcengineId !== undefined && error instanceof SandboxError &&
    error.message === `404: Sandbox owner not found: ${volcengineId}`;
export const isMissingFile = (error: unknown): boolean => error instanceof FileNotFoundError;
export function commandExit(error: unknown): number | undefined {
  return error instanceof CommandExitError ? error.exitCode : undefined;
}
