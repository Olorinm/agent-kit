// Adapted from BroZhong/open-managed-agents at e04695152219a91c2ecdff41955dfc3fab73b438.
// Source: server/packages/sandbox/src/workspace-mount.ts. See NOTICE for provenance.
import { workspaceObjectPrefix } from "./path.js";
import { posix } from "node:path";

export const WORKSPACE_ROOT = "/home/user/workspace";

/** Host-owned infrastructure recipe; never populated from browser mount paths. */
export interface WorkspaceMountSpec {
  bucket: string;
  /** Canonical object prefix, including the trailing slash. */
  prefix: string;
  agentName: string;
  pvName: string;
  credentialProviderName: string;
}

/** Expected mounted filesystem identity, checked by the sandbox backend. */
export interface WorkspaceMountTarget {
  mountPath: string;
  bucket: string;
  prefix: string;
}

export class WorkspaceMountUnavailable extends Error {
  readonly code = "workspace_mount_unavailable";
  constructor() {
    super(
      "Workspace storage is unavailable or its mount could not be verified. Saved files remain in storage; retry after storage recovers.",
    );
    this.name = "WorkspaceMountUnavailable";
  }
}

export function assertWorkspaceMountSpec(
  spec: WorkspaceMountSpec,
  tenantId: string,
  workspaceId: string,
): void {
  if (!spec || spec.prefix !== workspaceObjectPrefix(tenantId, workspaceId)) {
    throw new Error(
      "Workspace mount prefix does not match its Tenant and Workspace",
    );
  }
  if (
    ![
      spec.bucket,
      spec.agentName,
      spec.pvName,
      spec.credentialProviderName,
    ].every(
      (value) =>
        typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(value),
    )
  ) {
    throw new Error(
      "Workspace mount requires valid bucket and identity resource names",
    );
  }
}

/** Public callers must supply canonical server-owned coordinates. */
export function assertWorkspaceMountTarget(target: WorkspaceMountTarget): void {
  const parts = target.prefix.split("/");
  if (parts.length !== 3 || target.prefix !== workspaceObjectPrefix(parts[0]!, parts[1]!) ||
      !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(target.bucket) ||
      typeof target.mountPath !== "string" || !target.mountPath.startsWith("/") ||
      target.mountPath === "/" || target.mountPath.includes("\0") ||
      posix.normalize(target.mountPath) !== target.mountPath) {
    throw new Error("Invalid Workspace mount target");
  }
}

/** Exact CSI metadata protocol verified by the deployed E2B gateway. */
export function workspaceMountMetadata(
  spec: WorkspaceMountSpec,
  mountPath: string,
): Record<string, string> {
  assertWorkspaceMountTarget({ ...spec, mountPath });
  const [tenantId, workspaceId] = spec.prefix.split("/");
  assertWorkspaceMountSpec(spec, tenantId!, workspaceId!);
  return {
    "security.agents.kruise.io/agent-name": spec.agentName,
    "e2b.agents.kruise.io/csi-volume-config": JSON.stringify([
      {
        pvName: spec.pvName,
        mountPath,
        subPath: spec.prefix.slice(0, -1),
        attributes: { credentialProviderName: spec.credentialProviderName },
      },
    ]),
  };
}
