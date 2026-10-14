import type { EnvironmentProvider, CreateEnvironment, EnvironmentRef, ExecOptions } from "./types.js";
import { EnvironmentError } from "./errors.js";
import { ExecAbortedBeforeStartError as ExecutionAbortedBeforeStart } from "./contracts/tool-executor.js";
import type { WorkspaceMountTarget } from "./workspace/mount.js";

/** Structural boundary matching OMA; OMA owns the actual native filesystem type. */
export type OmaWorkspaceTarget = WorkspaceMountTarget;
export interface OmaFsBackend {
  exec(argv: string[], options?: ExecOptions): ReturnType<EnvironmentProvider["exec"]>;
  writeFileBytes(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}
export interface OmaClientOptions<Filesystem> {
  provider: EnvironmentProvider;
  defaultTemplate: string;
  /** Reuse OMA's createSandboxFileSystem, preserving native Pi filesystem semantics. */
  fileSystem: (backend: OmaFsBackend) => Filesystem;
  /** Supply createAlibabaWorkspaceVerifier or another actual storage verifier. Never a no-op. */
  verifyWorkspaceMount: (ref: EnvironmentRef, target: OmaWorkspaceTarget, metadata: Readonly<Record<string, string>>) => Promise<void>;
  /** Map trusted OMA mount metadata to the selected provider before creation. */
  mapCreate?: (request: CreateEnvironment) => CreateEnvironment;
  /** Preserve OMA's instanceof check for commands aborted before dispatch. */
  abortedBeforeStart?: () => Error;
  runningSeconds?: number;
  onTimeout?: "kill" | "pause";
}

/**
 * Implements OMA's SandboxClient boundary without importing its business stores.
 * Keep OMA's DefaultSandboxManager, bindings, projections and lifecycle coordinator.
 */
export function createOmaSandboxClient<Filesystem>(options: OmaClientOptions<Filesystem>) {
  const provider = options.provider;
  const metadata = new Map<string, Record<string, string>>();
  const filesystems = new Map<string, Filesystem>();
  if (typeof options.verifyWorkspaceMount !== "function" || typeof options.fileSystem !== "function")
    throw new EnvironmentError("oma_hooks_required", "OMA workspace verifier and native filesystem factory are required.");
  const ref = (id: string): EnvironmentRef => ({ provider: provider.id, id });
  async function* exec(id: string, argv: string[], opts?: ExecOptions) {
    try { yield* provider.exec(id, argv, opts); }
    catch (error) {
      if (error instanceof ExecutionAbortedBeforeStart && options.abortedBeforeStart)
        throw options.abortedBeforeStart();
      throw error;
    }
  }
  return {
    async create(input: { image?: string; env?: Record<string, string>; metadata?: Record<string, string>; timeoutSeconds?: number } = {}) {
      const initial: CreateEnvironment = {
        template: input.image ?? options.defaultTemplate, env: input.env, metadata: input.metadata,
        timeoutSeconds: input.timeoutSeconds ?? options.runningSeconds ?? 86400,
        onTimeout: options.onTimeout ?? "kill",
      };
      const request = options.mapCreate ? options.mapCreate(initial) : initial;
      const result = await provider.create(request);
      // Attestation always receives the same trusted OMA coordinates on create
      // and reconnect; provider metadata projection is a separate concern.
      metadata.set(result.id, { ...input.metadata });
      return { id: result.id };
    },
    async reconnect(id: string, trustedMetadata: Record<string, string>) {
      if ((await provider.info(id)).state === "missing") return false;
      const info = await provider.resume(id, options.runningSeconds ?? 86400);
      if (info.state !== "running") throw new EnvironmentError("resume_pending", "Environment is not yet running.");
      metadata.set(id, { ...trustedMetadata });
      return true;
    },
    async state(id: string): Promise<"running" | "paused" | "missing"> {
      const state = (await provider.info(id)).state;
      if (state === "unknown") throw new EnvironmentError("status_unknown", "Environment state is unknown.");
      return state;
    },
    setTimeout: (id: string, seconds: number) => provider.setTimeout(id, seconds),
    async verifyWorkspaceMount(id: string, target: OmaWorkspaceTarget) {
      const coordinates = metadata.get(id);
      if (!coordinates) throw new EnvironmentError("unbound_environment", "Create or reconnect the OMA binding first.");
      return options.verifyWorkspaceMount(ref(id), target, coordinates);
    },
    fileSystem(id: string): Filesystem {
      let fs = filesystems.get(id);
      if (!fs) {
        fs = options.fileSystem({
          exec: (argv, opts) => exec(id, argv, opts),
          writeFileBytes: (path, bytes) => provider.writeFile(id, path, bytes),
          remove: path => provider.removeFile(id, path),
        });
        filesystems.set(id, fs);
      }
      return fs;
    },
    exec,
    readFile: async (id: string, path: string) => new TextDecoder().decode(await provider.readFile(id, path)),
    readFileBytes: (id: string, path: string) => provider.readFile(id, path),
    writeFile: (id: string, path: string, text: string) => provider.writeFile(id, path, text),
    writeFileBytes: (id: string, path: string, bytes: Uint8Array) => provider.writeFile(id, path, bytes),
    remove: (id: string, path: string) => provider.removeFile(id, path),
    list: (id: string, path: string, opts?: { missingOk?: boolean }) => provider.listFiles(id, path, opts?.missingOk),
    hasUncertainExecution: (id: string) => provider.hasUncertainExecution(id),
    resetExecutionUncertainty: (id: string) => provider.resetExecutionUncertainty(id),
    async destroy(id: string) {
      await provider.destroy(id);
      metadata.delete(id); filesystems.delete(id);
    },
  };
}
