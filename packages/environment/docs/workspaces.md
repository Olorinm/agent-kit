# Shared persistent workspaces

`@olorinm/agent-environment/workspace` brings OMA's OSS file store, trusted
Workspace prefix, Alibaba CSI mount recipe and real mount probe into this
component. Volcengine uses the same contract with the official TOS SDK and static
VKE/VCI CSI volumes; Alibaba uses the official `ali-oss` SDK. The source revision and original
file hashes are recorded in [the source manifest](oma-workspace-source.json);
see [NOTICE](../NOTICE) for attribution.

This is a reusable storage/execution boundary, not an account system or a new
scheduler. Mau or OMA resolves ownership, persists Workspace identities and
environment bindings, and decides which Agents may share a Workspace. Mau's
Matrix owner ID must be mapped to a stable storage identity: the inherited OMA
prefix contract permits 1–128 ASCII letters, digits, underscores and hyphens,
not a raw Matrix address. Resolve that mapping before calling this library.

## Storage behavior

- `OSSArtifactStore` implements OMA's `ArtifactStore`: binary writes/reads,
  metadata, existence, recursive paginated lists, deletion and signed GET URLs.
- Objects use `<tenantId>/<workspaceId>/`. Different environments assigned the
  same authorized prefix share files. A second store/client sees the same data.
- Only the mounted Workspace persists in OSS. HOME, native login/session
  directories and caches are separate; configure their persistence separately.
- Destroying an environment does not delete its Workspace objects. Workspace
  deletion is a separate owner-authorized operation in the product.
- Saved files persist when writes have completed and files have closed. This is
  an object-backed mount, not a transactional filesystem: caches can delay
  visibility and concurrent writes to one path can overwrite each other.
- Literal Unicode, spaces, percent signs and hidden file names are preserved.
  Traversal, control characters and the reserved `.oma-workspace-checks` area
  are rejected by business file operations.
- Signed read URLs expire after 1–900 seconds. The product checks ownership and
  existence before signing. URLs go to the public regional endpoint or an
  explicitly configured bucket-bound HTTPS domain, never the private endpoint.
- Missing objects are distinct from missing buckets, permissions and network
  failures. SDK diagnostics can contain sensitive request information; sanitize
  errors at the product API boundary. Mount-verification errors are already
  sanitized to `workspace_mount_unavailable`.

## Alibaba integration

Prepare the Alibaba Agent Sandbox/Agent Identity CSI infrastructure described
by [OMA's deployment recipe](https://github.com/BroZhong/open-managed-agents/blob/e04695152219a91c2ecdff41955dfc3fab73b438/deploy/oss-workspace/README.md).
The library does not provision buckets, RAM roles, CSI drivers, PVs or templates.
Supply credentials from private server configuration, never from an Agent or
an arbitrary browser mount request.

```ts
import {
  OSSArtifactStore, WORKSPACE_ROOT, workspaceObjectPrefix,
  workspaceMountMetadata, createAlibabaWorkspaceVerifier,
} from '@olorinm/agent-environment/workspace';

// provider is an authorized EnvironmentProvider for Alibaba. The product has
// already verified this owner's access to workspaceId and resolved storageOwnerId.
const store = new OSSArtifactStore(privateOssOptions);
const target = {
  mountPath: WORKSPACE_ROOT,
  bucket: store.bucket,
  prefix: workspaceObjectPrefix(storageOwnerId, workspaceId),
};
const metadata = workspaceMountMetadata({
  bucket: target.bucket, prefix: target.prefix,
  agentName: configuredAgentIdentity,
  pvName: configuredPersistentVolume,
  credentialProviderName: configuredCredentialProvider,
}, target.mountPath);
const verify = createAlibabaWorkspaceVerifier({ provider, store });

const ref = await provider.create({ template, metadata, onTimeout: 'pause' });
// Persist ref, target and trusted metadata BEFORE verification or Agent startup.
await persistBinding({ ref, target, metadata });
await verify(ref, target, metadata);
// Start native work only after verification succeeds; repeat after reconnect.

await store.put({ tenantId: storageOwnerId, workspaceId, path: 'brief.md', body: '# Goal' });
const files = await store.list(storageOwnerId, workspaceId);
```

The caller retains the environment reference when verification fails, for
explicit recovery or cleanup. Do not blindly create a replacement. On resume,
load the original binding, resume its existing ref, then call `verify` with its
trusted target and metadata before allowing work. Do not use cloud-returned
metadata as the expected owner/Workspace identity.

Verification checks gateway storage authorization, bucket and subpath, the
ordinary uid/gid, the actual `fuse.ossfs` mount/device, and a random closed-file
probe independently read through the OSS SDK. Descriptor-relative operations
avoid silently accepting an unmounted local directory. The probe is removed
after readback succeeds or fails; cleanup failure also fails verification.
Interrupted or unconfirmed commands can leave a probe in the reserved subtree.

OMA can use the same verifier directly without reopening a second SDK handle:

```ts
import { createOmaSandboxClient } from '@olorinm/agent-environment/oma';

const client = createOmaSandboxClient({
  provider, defaultTemplate: template, onTimeout: 'pause',
  fileSystem: createSandboxFileSystem, // OMA's original native filesystem
  abortedBeforeStart: () => new ExecAbortedBeforeStartError(),
  verifyWorkspaceMount: createAlibabaWorkspaceVerifier({ provider, store }),
});
```

Keep OMA's manager, trusted bindings and lifecycle. This repository does not
modify upstream OMA or import its database, API routes or product orchestration.

## Volcengine integration

`VolcengineWorkspaceBackend` prepares a static TOS PV/PVC for the trusted
`<tenant>/<workspace>/` prefix and an immutable derived SandboxTemplate for each
workspace/base-template combination. Multiple containers can use that claim.
The PV uses `Retain`; destroying a sandbox never deletes objects. VCI dynamic
TOS injection is incompatible with writable-layer persistence, so this adapter
uses static CSI volumes and preserves the base template's snapshot settings.
See the [official TOS guide](https://docs.volcengine.com/docs/6460/2668077).

Prepare a private bucket, TOS CSI driver and Kubernetes Secret containing `akId`
and `akSecret`. Give the service identity bucket-scoped object read/write/delete,
list and head access. The runtime Kubernetes identity needs only get/create PVs,
get/create PVCs and SandboxTemplates in its namespace, and get Pods. It does not
need secret read access, exec or delete. Use a dedicated namespace for deployments
with a stronger tenant control-plane boundary. Configuration is operator-owned;
products must never accept arbitrary templates or mount coordinates from users.

The base template must have one application container, disable service-account
token automounting and leave `/home/user/workspace` available. Its image must have
Python 3 and a non-root execution user matching the configured uid/gid. The
bundled Host image uses uid/gid 1001. Native credentials and sessions stay outside
the workspace, in the container's private snapshot.

```json
{
  "kubeconfigFile": "runtime-kubeconfig",
  "credentialsFile": "tos.json",
  "bucket": "your-private-workspaces",
  "namespace": "default",
  "secretName": "workspace-tos",
  "region": "cn-shanghai",
  "uid": 1001,
  "gid": 1001
}
```

`tos.json` contains `accessKeyId`, `accessKeySecret` and optionally `stsToken` and
an approved regional `endpoint`. Paths resolve relative to the config file;
credentials and kubeconfig must be mode 0600. The TOS endpoint must be reachable
from the product server. Signed downloads always use the public regional host.

```ts
import { loadWorkspaceConfiguration } from '@olorinm/agent-environment/workspace';
const backend = await loadWorkspaceConfiguration('/secure/workspace.json');
const binding = await backend.prepare(storageOwnerId, workspaceId, baseTemplate);
await persistBinding(binding);
const ref = await provider.create({ template: binding.template, metadata: binding.metadata });
await persistEnvironment(ref);
await backend.verify(provider, ref.id, binding);
// Only now inject credentials and start Host. Reverify after resume/reconnect.
```

Verification checks actual Pod → PVC → PV coordinates, ordinary uid/gid, the
FUSE mount root/device and a random closed-file probe read independently through
TOS. Missing or mismatched mounts fail closed. Buckets, IAM policies and CSI
installation remain operator responsibilities; this library creates only the
workspace PV/PVC/template resources. Retained templates, volumes, object data
and cloud snapshots need an explicit product retention/cleanup policy.

## Verification

`npm test` covers paths, independent storage reads, owner prefixes, signed URLs,
authorization failures, static resource reconciliation and probe cleanup. The
original OMA sandbox suites remain unchanged. `npm run test:workspace:oma --
CHECKOUT` verifies the upstream source hashes and ArtifactStore/SandboxClient
compatibility, and runs the official OSS client against OMA's original HTTP
fixture. `npm run test:package` installs a separately built archive.

For live acceptance (creates two billable sandboxes and removes them in finally):

```sh
node scripts/probe-workspace.mjs --config /secure/providers.json \
  --workspaceConfig /secure/workspace.json --provider volc \
  --template default--your-host-template --report state/workspace-probe.json
```

The private report immediately records returned IDs. The probe checks both
mounts, cross-container binary files, owner isolation, signed public downloads,
same-ID pause/resume and storage survival after destroying both environments.
It does not remove retained PV/PVC/templates or snapshots. If creation has an
uncertain outcome, reconcile using its `workspace-probe` metadata before retrying.
