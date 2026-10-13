# Integration

## Mau / Agent Host / Router

An upper-level provisioning operation resolves the authenticated user's permitted provider and template, creates an environment, persists `{provider,id}` against the Agent, starts Agent Host inside that environment, then binds its runtime identity to Router. Reconnect uses that persisted ID. Agent Host continues to own native agent execution and sessions.

Do not put cloud keys or all tenants' environment refs inside an agent runtime. Only the trusted provisioning service calls this library. An operator can use the CLI directly; exposing that CLI as a product endpoint requires product authentication and ownership checks.

Images may contain any runtime and shared tools such as lark-cli. Start long-running Host processes using the image's supervisor/entrypoint; `exec` is a command stream, not a distributed supervisor. Put Host state, kernel session files and user workspace data on explicitly durable paths. Bootstrap after a resume must be idempotent because process memory need not survive.

Product orchestration now belongs to [Mau](https://github.com/Olorinm/mau): environment profiles, allocation journals, private Host bootstrap, Agent/environment bindings and lifecycle operations. Router supplies account ownership, channel connections and task delivery through its public embedding API. Environment remains independent of both products' account and database models.

Mau can use `provider.httpEndpoint(id, port)` to reach Host with a separate per-Agent token. Host images wait for a verified private configuration bundle before listening; the image/platform owns process restart supervision. See [Mau environment setup](https://github.com/Olorinm/mau/blob/main/docs/environments.md) for the current product recipe.

The [verification report](verification.md) records the live acceptance of the earlier Router-hosted integration. That historical evidence does not establish deployment of the new Mau composition. [Deployment](deployment.md) describes the independently managed sandbox foundation.

## OMA

This repository supplies a compatibility bridge; OMA itself has not been modified and no upstream integration PR has been submitted. The implementation uses the official E2B SDK and was informed by OMA's interfaces, rather than extracted from OMA source. The package is installed from a built archive and is not yet published to npm.

Keep OMA's `DefaultSandboxManager`, database bindings, idle lifecycle, native filesystem and workspace ownership checks. Replace its low-level `SandboxClient` dependency with `createOmaSandboxClient` from this package's `/oma` export.

The bridge matches OMA at `e04695152219a91c2ecdff41955dfc3fab73b438`. It requires the real native filesystem factory and real storage verifier. This prevents a successful-looking integration that drops native errno or workspace identity verification.

Inside OMA's sandbox package, the wiring is:

```ts
import { createOmaSandboxClient } from '@olorinm/agent-environment/oma';
import { ExecAbortedBeforeStartError } from '@open-managed-agents/adapter-core';
import { createSandboxFileSystem } from './sandbox-file-system.js';
import type { SandboxClient } from './sandbox-client.js';

const client: SandboxClient = createOmaSandboxClient({
  provider,                         // configured by the trusted Host
  defaultTemplate: templateId,
  onTimeout: 'pause',                // Alibaba; Volcengine requires explicit pause
  fileSystem: createSandboxFileSystem,
  abortedBeforeStart: () => new ExecAbortedBeforeStartError(),
  verifyWorkspaceMount: verifyActualWorkspaceMount,
});
```

`verifyActualWorkspaceMount` above is an **integration dependency**, not an exported helper here. Supply OMA's real verification: check control-plane storage authorization, actual mount identity and ordinary-user read/write access, then verify the random probe in the correct object-store prefix and clean it up. Never replace it with a successful no-op.

For an incremental Alibaba integration, keep an existing OMA `E2BSandboxClient` configured with its real `verifyWorkspaceProbe`, and delegate the required hook:

```ts
verifyWorkspaceMount: async (ref, target, trustedMetadata) => {
  if (!await existingOmaClient.reconnect(ref.id, { ...trustedMetadata })) {
    throw new Error('Environment disappeared before mount verification');
  }
  await existingOmaClient.verifyWorkspaceMount(ref.id, target);
}
```

This reuses the actual verifier but opens an additional SDK handle. A later upstream refactor can extract that verifier as a reusable helper. Both create and reconnect pass the original trusted OMA metadata to the hook, independently of provider metadata mapping.

OMA's current mount recipe and idle-timeout behavior are Alibaba-specific. For Volcengine, OMA must provide a VCI template/storage recipe and corresponding verifier, map its trusted creation request with `mapCreate`, and explicitly pause after idleness. Silently dropping Alibaba mount metadata or using `kill` as a substitute for OMA's pause policy loses important behavior. The bridge alone does not complete that upstream migration.

Run the actual compatibility check against a checkout:

```sh
npm run build
npm run test:oma -- /path/to/open-managed-agents
```

It type-checks against OMA's original `SandboxClient`, then executes its unmodified filesystem helper over real local processes. It verifies binary writes/appends, missing-parent errno, symlink stat/lstat and its original cancellation error class. It does not claim a live OSS/TOS storage attestation.
