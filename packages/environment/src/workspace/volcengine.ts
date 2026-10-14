import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { KubeConfig, CoreV1Api, CustomObjectsApi } from "@kubernetes/client-node";
import type { ExecOptions, OutputChunk } from "../types.js";
import { TOSArtifactStore, type TOSArtifactStoreOptions } from "./tos.js";
import type { ArtifactStore } from "./artifact-store.js";
import { workspaceObjectPrefix } from "./path.js";
import { assertWorkspaceMountTarget, WorkspaceMountUnavailable, WORKSPACE_ROOT, type WorkspaceMountTarget } from "./mount.js";
import { WORKSPACE_MOUNT_PROBE, WORKSPACE_MOUNT_PROBE_CLEANUP } from "./mount-probe.js";

const bindingKey = "agent-environment-workspace";
const group = "extensions.agents.x-k8s.io", version = "v1alpha1", plural = "sandboxtemplates";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Resource = Record<string, any>;

export interface WorkspaceBinding {
  kind: "volcengine-tos-static";
  target: WorkspaceMountTarget;
  template: string;
  namespace: string;
  volume: string;
  uid: number;
  gid: number;
  metadata: Record<string, string>;
}
export interface WorkspaceExecution {
  info(id: string): Promise<{ state: string; metadata?: Record<string, string> }>;
  exec(id: string, argv: string[], options?: ExecOptions): AsyncIterable<OutputChunk>;
}
export interface WorkspaceBackend {
  readonly store: ArtifactStore;
  prepare(tenantId: string, workspaceId: string, baseTemplate: string): Promise<WorkspaceBinding>;
  verify(provider: WorkspaceExecution, id: string, binding: WorkspaceBinding): Promise<void>;
}
export interface VolcengineWorkspaceOptions {
  kubeconfigFile: string;
  namespace: string;
  secretName: string;
  region: string;
  /** Must match the image's ordinary execution user, not its root entrypoint. */
  uid: number;
  gid: number;
}

/** Static CSI volumes preserve VCI rootfs snapshots. The dynamic TOS recipe
 * explicitly cannot be combined with writable-layer persistence. Each immutable
 * template mounts only one authorized prefix; no bucket credentials enter envd. */
export class VolcengineWorkspaceBackend implements WorkspaceBackend {
  private readonly core: CoreV1Api;
  private readonly custom: CustomObjectsApi;
  constructor(readonly store: TOSArtifactStore, private readonly options: VolcengineWorkspaceOptions) {
    for (const name of [options.namespace, options.secretName])
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("Invalid Kubernetes resource name");
    for (const id of [options.uid, options.gid])
      if (!Number.isSafeInteger(id) || id < 1 || id > 65535) throw new Error("Workspace requires an ordinary uid/gid");
    if (!/^cn-[a-z]+$/.test(options.region)) throw new Error("Invalid TOS region");
    const config = new KubeConfig(); config.loadFromFile(options.kubeconfigFile);
    this.core = config.makeApiClient(CoreV1Api); this.custom = config.makeApiClient(CustomObjectsApi);
  }
  async prepare(tenantId: string, workspaceId: string, baseTemplate: string): Promise<WorkspaceBinding> {
    const { namespace, uid, gid, region, secretName } = this.options;
    const parts = baseTemplate.split("--");
    if (parts.length !== 2 || parts[0] !== namespace || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(parts[1]!))
      throw new Error("Workspace base template must belong to the configured namespace");
    const target = { bucket: this.store.bucket, prefix: workspaceObjectPrefix(tenantId, workspaceId), mountPath: WORKSPACE_ROOT };
    const identity = digest([target, namespace, uid, gid, region, secretName]);
    const volume = `ws-${identity.slice(0, 40)}`;
    const base = await this.custom.getNamespacedCustomObject({ group, version, plural, namespace, name: parts[1]! });
    const spec = structuredClone(base.spec), pod = spec?.podTemplate?.spec;
    if (!pod || pod.containers?.length !== 1 || pod.automountServiceAccountToken !== false ||
        spec.podTemplate.metadata?.annotations?.["vke.volcengine.com/csi-sidecar-inject"] === "true" ||
        pod.containers[0].volumeMounts?.some((m: Resource) => m.mountPath === WORKSPACE_ROOT || m.name === "workspace") ||
        pod.volumes?.some((v: Resource) => v.name === "workspace")) throw new Error("Incompatible Workspace base template");
    const pv = { apiVersion: "v1", kind: "PersistentVolume", metadata: { name: volume, labels: { [bindingKey]: identity.slice(0, 40) } },
      spec: { capacity: { storage: "1Gi" }, accessModes: ["ReadWriteMany"], persistentVolumeReclaimPolicy: "Retain", storageClassName: "",
        claimRef: { name: volume, namespace }, csi: { driver: "tos.csi.volcengine.com", volumeHandle: volume,
          volumeAttributes: { bucket: target.bucket, path: "/" + target.prefix.slice(0, -1), url: `https://tos-s3-${region}.ivolces.com`,
            additional_args: `-ouid=${uid} -ogid=${gid} -oallow_other -oumask=0007 -oattr_timeout=0 -oentry_timeout=0` },
          nodePublishSecretRef: { name: secretName, namespace }, nodeStageSecretRef: { name: secretName, namespace } } } };
    const pvc = { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: volume, namespace },
      spec: { volumeName: volume, storageClassName: "", accessModes: ["ReadWriteMany"], resources: { requests: { storage: "1Gi" } } } };
    pod.volumes = [...pod.volumes ?? [], { name: "workspace", persistentVolumeClaim: { claimName: volume } }];
    pod.containers[0].volumeMounts = [...pod.containers[0].volumeMounts ?? [], { name: "workspace", mountPath: target.mountPath }];
    const templateName = `ws-${digest([spec, identity]).slice(0, 40)}`;
    const template = { apiVersion: `${group}/${version}`, kind: "SandboxTemplate", metadata: { name: templateName, namespace }, spec };
    await ensure(() => this.core.createPersistentVolume({ body: pv }), () => this.core.readPersistentVolume({ name: volume }), pv);
    await ensure(() => this.core.createNamespacedPersistentVolumeClaim({ namespace, body: pvc }),
      () => this.core.readNamespacedPersistentVolumeClaim({ namespace, name: volume }), pvc);
    await ensure(() => this.custom.createNamespacedCustomObject({ group, version, plural, namespace, body: template }),
      () => this.custom.getNamespacedCustomObject({ group, version, plural, namespace, name: templateName }), template);
    return { kind: "volcengine-tos-static", target, template: `${namespace}--${templateName}`, namespace, volume, uid, gid,
      metadata: { [bindingKey]: identity } };
  }
  async verify(provider: WorkspaceExecution, id: string, original: WorkspaceBinding): Promise<void> {
    const b = structuredClone(original);
    try {
      assertWorkspaceMountTarget(b.target);
      if (b.kind !== "volcengine-tos-static" || b.target.bucket !== this.store.bucket || b.target.mountPath !== WORKSPACE_ROOT ||
          b.namespace !== this.options.namespace || b.uid !== this.options.uid || b.gid !== this.options.gid) throw new Error();
      const identity = digest([b.target, b.namespace, b.uid, b.gid, this.options.region, this.options.secretName]);
      if (b.volume !== `ws-${identity.slice(0, 40)}` || b.metadata[bindingKey] !== identity) throw new Error();
      const info = await provider.info(id);
      if (info.state !== "running" || info.metadata?.[bindingKey] !== identity) throw new Error();
      // Attest the actual running pod's claim and immutable PV, not just the template.
      const [namespace, name, extra] = id.split("--");
      if (namespace !== b.namespace || !name || extra) throw new Error();
      const pod = await this.core.readNamespacedPod({ namespace, name });
      const mount = pod.spec?.containers[0]?.volumeMounts?.find(v => v.mountPath === b.target.mountPath);
      if (!mount || mount.readOnly || mount.subPath || mount.subPathExpr ||
          pod.spec?.volumes?.find(v => v.name === mount.name)?.persistentVolumeClaim?.claimName !== b.volume) throw new Error();
      const pvc = await this.core.readNamespacedPersistentVolumeClaim({ namespace, name: b.volume });
      const pv = await this.core.readPersistentVolume({ name: b.volume });
      if (pvc.spec?.volumeName !== b.volume || pv.spec?.csi?.driver !== "tos.csi.volcengine.com" ||
          pv.spec.csi.volumeAttributes?.bucket !== b.target.bucket || pv.spec.csi.volumeAttributes.path !== "/" + b.target.prefix.slice(0, -1)) throw new Error();
      const result = JSON.parse(await run(provider, id, ["python3", "-c", volcengineProbe(b.uid, b.gid), b.target.mountPath, b.target.prefix]));
      if (result.realPath !== b.target.mountPath || !/^[a-f0-9]{32}$/.test(result.probeName) || !/^[a-f0-9]{64}$/.test(result.content)) throw new Error();
      try { await this.store.verifyWorkspaceProbe(b.target.prefix, result.probeName, result.content); }
      finally {
        const cleaned = await run(provider, id, ["python3", "-c", volcengineCleanup, b.target.mountPath, result.probeName]);
        if (cleaned.trim() !== "OMA_WORKSPACE_PROBE_REMOVED") throw new Error();
      }
    } catch { throw new WorkspaceMountUnavailable(); }
  }
}

/** Same descriptor-relative probe and cleanup as OMA; only the cloud mount
 * identity and configured ordinary uid/gid differ. */
export function volcengineProbe(uid: number, gid: number): string {
  if (![uid, gid].every(n => Number.isSafeInteger(n) && n > 0 && n <= 65535)) throw new Error("Invalid uid/gid");
  return WORKSPACE_MOUNT_PROBE
    .replace("os.geteuid() != 1000 or os.getegid() != 1000", `os.geteuid() != ${uid} or os.getegid() != ${gid}`)
    .replace("not re.fullmatch(r'/run/csi/mount-root/oss/[a-f0-9]{32}', real_path)", "real_path != mount_path or not os.path.isabs(real_path) or real_path == '/'")
    .replace("volume[0] != 'fuse.ossfs'", "volume[0] not in ('fuse.s3fs', 'fuse.tosfs') or unescape(fields[3]) != '/' + sys.argv[2].rstrip('/')");
}
const volcengineCleanup = WORKSPACE_MOUNT_PROBE_CLEANUP.replace("not re.fullmatch(r'/run/csi/mount-root/oss/[a-f0-9]{32}', real_path)",
  "not os.path.isabs(real_path) or real_path == '/' or os.path.realpath(real_path) != real_path");
async function run(provider: WorkspaceExecution, id: string, argv: string[]) {
  let stdout = "", exit: number | null = null;
  for await (const part of provider.exec(id, argv, { cwd: "/home/user", timeoutSeconds: 30, onExit: e => { exit = e.exitCode; } })) {
    if (part.stream === "stdout") stdout += part.text;
    if (stdout.length > 4096) throw new Error();
  }
  if (exit !== 0) throw new Error();
  return stdout;
}
async function ensure(create: () => Promise<unknown>, read: () => Promise<unknown>, expected: Resource) {
  try { await create(); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 409)) throw error;
    const current = await read();
    if (!contains(current, expected)) throw new Error("Workspace resource conflicts with its trusted binding");
  }
}
function contains(actual: any, expected: any): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (!actual || typeof actual !== "object" || Array.isArray(expected) && (!Array.isArray(actual) || actual.length !== expected.length)) return false;
  return Object.keys(expected).every(k =>
    k === "storageClassName" && expected[k] === "" && actual[k] === undefined || contains(actual[k], expected[k]));
}

export async function loadWorkspaceConfiguration(path: string): Promise<WorkspaceBackend> {
  const options = JSON.parse(await readFile(path, "utf8")) as VolcengineWorkspaceOptions & { credentialsFile: string; bucket: string };
  const base = dirname(resolve(path));
  const credentialsFile = resolve(base, options.credentialsFile), kubeconfigFile = resolve(base, options.kubeconfigFile);
  for (const file of [credentialsFile, kubeconfigFile]) {
    const mode = await stat(file);
    if (!mode.isFile() || process.platform !== "win32" && (mode.mode & 0o077) !== 0) throw new Error("Workspace credentials must be private files");
  }
  const credentials = JSON.parse(await readFile(credentialsFile, "utf8")) as TOSArtifactStoreOptions;
  const store = new TOSArtifactStore({ ...credentials, bucket: options.bucket, region: options.region });
  return new VolcengineWorkspaceBackend(store, { ...options, kubeconfigFile });
}
