// Adapted from BroZhong/open-managed-agents at e04695152219a91c2ecdff41955dfc3fab73b438.
// Source: server/packages/sandbox/src/e2b-sandbox-client.ts, verifyWorkspaceMount.
// Uses Environment's public execution boundary instead of OMA's private SDK handles.
import type { EnvironmentProvider, EnvironmentRef } from "../types.js";
import { assertWorkspaceMountTarget, WorkspaceMountUnavailable, type WorkspaceMountTarget } from "./mount.js";
import { WORKSPACE_MOUNT_PROBE, WORKSPACE_MOUNT_PROBE_CLEANUP } from "./mount-probe.js";

export interface WorkspaceProbeStore {
  readonly bucket: string;
  verifyWorkspaceProbe(prefix: string, probeName: string, expectedContent: string): Promise<void>;
}

/** Matches OmaClientOptions.verifyWorkspaceMount and also works directly in Mau.
 * The caller persists the trusted creation metadata with the Workspace binding;
 * cloud-returned metadata must never substitute for it on reconnect. */
export function createAlibabaWorkspaceVerifier(options: {
  provider: EnvironmentProvider;
  store: WorkspaceProbeStore;
}): (ref: EnvironmentRef, target: WorkspaceMountTarget, trustedMetadata: Readonly<Record<string, string>>) => Promise<void> {
  const { provider, store } = options;
  return async (ref, target, trustedMetadata) => {
    try {
      const expected = { ...target }, requested = { ...trustedMetadata };
      const id = ref.id;
      assertWorkspaceMountTarget(expected);
      if (ref.provider !== provider.id || expected.bucket !== store.bucket) throw new WorkspaceMountUnavailable();
      const volumes: unknown = JSON.parse(requested["e2b.agents.kruise.io/csi-volume-config"] ?? "null");
      if (!Array.isArray(volumes) || volumes.length !== 1) throw new WorkspaceMountUnavailable();
      const volume = record(volumes[0]), attributes = record(volume.attributes);
      const agent = requested["security.agents.kruise.io/agent-name"];
      if (!resourceName(agent) || !resourceName(volume.pvName) || !resourceName(attributes.credentialProviderName) ||
          volume.mountPath !== expected.mountPath || volume.subPath !== expected.prefix.slice(0, -1)) {
        throw new WorkspaceMountUnavailable();
      }
      const info = await provider.info(id);
      const authorization: unknown = JSON.parse(info.metadata["security.agents.kruise.io/storage-auth"] ?? "null");
      if (info.state !== "running" || info.metadata["security.agents.kruise.io/agent-name"] !== agent ||
          !Array.isArray(authorization) || authorization.length !== 1) throw new WorkspaceMountUnavailable();
      const grant = record(authorization[0]), granted = record(grant.attributes);
      if (grant.credentialProviderName !== attributes.credentialProviderName ||
          granted["bucket-name"] !== expected.bucket || granted["sub-path"] !== expected.prefix.slice(0, -1)) {
        throw new WorkspaceMountUnavailable();
      }
      // The original probe enforces ordinary uid/gid 1000, the real CSI mount,
      // its device identity and descriptor-relative writes, not a local fallback.
      const probe = record(JSON.parse(await runProbe(provider, id, ["python3", "-c", WORKSPACE_MOUNT_PROBE, expected.mountPath])));
      if (typeof probe.probeName !== "string" || !/^[a-f0-9]{32}$/.test(probe.probeName) ||
          typeof probe.content !== "string" || !/^[a-f0-9]{64}$/.test(probe.content) ||
          typeof probe.realPath !== "string" || !/^\/run\/csi\/mount-root\/oss\/[a-f0-9]{32}$/.test(probe.realPath)) {
        throw new WorkspaceMountUnavailable();
      }
      try {
        await store.verifyWorkspaceProbe(expected.prefix, probe.probeName, probe.content);
      } finally {
        const cleaned = await runProbe(provider, id, ["python3", "-c", WORKSPACE_MOUNT_PROBE_CLEANUP, probe.realPath, probe.probeName]);
        if (cleaned.trim() !== "OMA_WORKSPACE_PROBE_REMOVED") throw new WorkspaceMountUnavailable();
      }
    } catch {
      // SDK diagnostics can contain credentials or signed URLs. Expose only the
      // stable failure, and never turn verification errors into permission to run.
      throw new WorkspaceMountUnavailable();
    }
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceMountUnavailable();
  return value as Record<string, unknown>;
}

function resourceName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(value);
}

async function runProbe(provider: EnvironmentProvider, id: string, argv: string[]): Promise<string> {
  let stdout = "", exitCode: number | null = null;
  for await (const chunk of provider.exec(id, argv, {
    cwd: "/home/user", timeoutSeconds: 20, onExit: result => { exitCode = result.exitCode; },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.text;
    if (stdout.length > 4096) throw new WorkspaceMountUnavailable();
  }
  if (exitCode !== 0) throw new WorkspaceMountUnavailable();
  return stdout;
}
