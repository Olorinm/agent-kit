export type EnvironmentState = "running" | "paused" | "missing" | "unknown";
/** Safe to persist. Credentials and SDK connection handles are deliberately absent. */
export interface EnvironmentRef { provider: string; id: string }
export interface EnvironmentInfo extends EnvironmentRef {
  state: EnvironmentState;
  template?: string;
  metadata: Record<string, string>;
}
export interface CreateEnvironment {
  /** A provider template ID; resource limits, image and volumes live in that template. */
  template: string;
  timeoutSeconds?: number;
  onTimeout?: "kill" | "pause";
  env?: Record<string, string>;
  metadata?: Record<string, string>;
}
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** 0 disables the command timeout; omission uses the SDK default. */
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onExit?: (result: { exitCode: number | null; signal?: string }) => void;
}
export interface OutputChunk { stream: "stdout" | "stderr"; text: string; bytes?: Uint8Array }
/** Ephemeral server-side connection details. Never return headers to end users. */
export interface HttpEndpoint { url: string; headers: Record<string, string> }
export interface FileEntry { path: string; size: number; mtimeMs: number }
export interface ProviderCapabilities {
  automaticPause: boolean;
  pause: true;
  /** Restart processes after resume. This API makes no memory-resume promise. */
  processMemoryResume: false;
  persistence: "provider-template";
}
export interface EnvironmentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  create(request: CreateEnvironment): Promise<EnvironmentRef>;
  info(id: string): Promise<EnvironmentInfo>;
  list(metadata?: Record<string, string>): Promise<EnvironmentInfo[]>;
  resume(id: string, timeoutSeconds?: number): Promise<EnvironmentInfo>;
  pause(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  setTimeout(id: string, seconds: number): Promise<void>;
  exec(id: string, argv: string[], options?: ExecOptions): AsyncIterable<OutputChunk>;
  httpEndpoint(id: string, port: number): Promise<HttpEndpoint>;
  readFile(id: string, path: string): Promise<Uint8Array>;
  writeFile(id: string, path: string, data: string | Uint8Array): Promise<void>;
  removeFile(id: string, path: string): Promise<void>;
  listFiles(id: string, path: string, missingOk?: boolean): Promise<FileEntry[]>;
  hasUncertainExecution(id: string): boolean;
  resetExecutionUncertainty(id: string): void;
}
