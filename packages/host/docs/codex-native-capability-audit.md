# Codex native capability audit

Audited on **2026-10-29**. This is a follow-up to [the native integration scope in issue #2](https://github.com/Olorinm/agent-host/issues/2); [issue #29](https://github.com/Olorinm/agent-host/issues/29) is the earlier upgrade baseline. The implementation pin is now **Codex 0.165.0**. This document distinguishes source inventory, protocol transport coverage, actual local Kernel execution and external-service acceptance. Passing one level does not imply passing the next.

## Versioned evidence

| Reference | Immutable commit | Status at audit |
| --- | --- | --- |
| Previous Host pin, 0.162.1 | [`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`](https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d) | Historical baseline; its executable schema was compared |
| Current Host pin, 0.165.0 | [`360319d8dee62d87e2d59fc0c21805d79519cfed`](https://github.com/openai/codex/tree/360319d8dee62d87e2d59fc0c21805d79519cfed) | [Latest non-prerelease release](https://github.com/openai/codex/releases/tag/rust-v0.165.0), published 2026-10-27; isolated executable and Host probes passed |
| Upstream main snapshot | [`a29c7b97e88367044ae84c28c85451ec3e72af9f`](https://github.com/openai/codex/tree/a29c7b97e88367044ae84c28c85451ec3e72af9f) | Source inspection only; not a released or locally executed Kernel |

The [protocol manifest](codex-native-protocol-manifest.json) enumerates all method names in the four declaration macros of upstream [`app-server-protocol/src/protocol/common.rs`](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/src/protocol/common.rs). Each entry identifies its source line, native parameter/response type where applicable, deprecation/internal markers and experimental-method marker. `experimentalFieldsInspected` records upstream's `inspect_params` flag; it does not mean every nested schema field was individually exercised. Comments mentioning experimental fields are recorded separately from method-level gating.

| Inventory | Client requests | Server requests | Server notifications | Client notifications |
| --- | ---: | ---: | ---: | ---: |
| 0.162.1 source declarations | 173 | 11 | 86 | 1 |
| 0.162.1 generated schema, experimental included | 170 | 11 | 84 | 1 |
| 0.165.0 source declarations | 179 | 11 | 87 | 1 |
| 0.165.0 generated schema, experimental included | 176 | 11 | 85 | 1 |
| 0.165.0 generated schema, experimental excluded | 106 | 10 | 85 | 1 |
| Main source declarations | 182 | 11 | 87 | 1 |

The executable schemas are produced by `codex app-server generate-json-schema --out DIRECTORY`, with `--experimental` for the inclusive export. The manifest's `exportedInExperimentalSchema` and `exportedInStableSchema` fields record observed inclusion. Missing flags, including main's flags, mean the corresponding schema was not generated. Generated-schema inclusion is not a guarantee that a particular account, configuration or platform can use a method.

The source inventory intentionally includes more than the exported public schema. `getConversationSummary`, `gitDiffToRemote` and `getAuthStatus` are deprecated declarations omitted from both 0.165.0 exports. `rawResponseItem/completed` and `rawResponse/completed` are marked internal-only and are also omitted. They remain in the wire-preservation regression inventory so Host cannot accidentally discard an observed message. **This does not declare those five interfaces publicly supported by Codex.** `mock/experimentalMethod` likewise remains a source declaration, not a product capability.

Between 0.162.1 and 0.165.0, the declaration additions are `thread/sample`, `thread/sample/cancel`, `thread/memory/read`, `thread/readState/update`, `thread/items/read`, `feedback/save` and the notification `thread/readState/changed`. Main additionally declares `account/gcp/setup`, `accountSession/list` and `accountSession/switch`. No method removals were found in these four inventories. The main-only methods are covered by generic Host transport tests, not accepted as working operations in the pinned 0.165.0 executable.

## How Host retains the native surface

Host keeps common product operations convenient and exposes the full native protocol through an explicit service-owner extension. It does not implement a replacement Codex model loop, memory engine, tool runner, OAuth system or subagent scheduler. Parameter objects and native results cross the extension without projection into a smaller common schema.

```js
import { createNativeRuntime } from "@olorinm/agent-host/server";

const runtime = createNativeRuntime({
  id: "codex",
  kernel: "codex",
  cwd: workspace,
  nativeAccess: { methods: "all", notifications: "all" },
  options: {
    command: codexExecutable,
    initialization: {
      clientInfo: { name: "my_host", title: "My Host", version: "1.0" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    },
  },
}, stateDirectory);
```

For an `AgentHostClient`, the extension consists of `nativeRequest(runtimeId, method, params)`, `nativeNotify`, `nativeEvents`, `nativeRequests` and `resolveNativeRequest`. `nativeRequest` returns the native result. Native error codes and data are retained in the client's `nativeError`; transport failures and unknown outcomes must not be treated as successful native operations. The extension can restrict methods/notifications to named allowlists and is disabled by default. Its authority is that of the authenticated Host service owner; it must not be exposed as an unrestricted tool to an Agent or an arbitrary product end user.

Host owns one `initialize` request and `initialized` notification per connection. Configuration supplies native initialization parameters before connection; repeating the handshake through the raw extension fails explicitly. The default negotiates experimental API access and opts out of no notification methods. Opting in only permits requesting experimental features; upstream still enforces its own feature gates and authorization. The raw bridge attaches before initialization to receive startup callbacks/notifications, so the first `connected` event may precede the initialization result. Read `discover(runtimeId).native.initialize` for the completed handshake evidence.

The raw event feed retains notification envelopes, including `emittedAtMs` and unknown future fields. Server requests retain their native ID, method, parameters and envelope; a separate Host request ID identifies the response transaction. Identical repeated resolutions are idempotent, conflicting responses fail, and errors can be returned with native code/message/data. Scoped managed-run handlers take precedence; requests they do not handle reach the owner bridge. This includes authentication refresh, attestation and future server requests that do not fit the common approval/question abstraction.

The native feed is a bounded in-memory connection feed, not a durable transcript replacement. Consumers must retain the returned epoch/cursor, check `historyTruncated`, and re-read native durable state when needed. Pending callbacks expire after the configured deadline and close when the native connection closes. Host does not silently replay an unresolved side-effecting operation after reconnection. Use native thread history for durable conversation state and product storage for delivery/idempotency records.

### Execution and connection ownership

Embedded consumers can use `CodexAppServerClient.attach(transport)` with `send`, `onMessage`, `onClose` and `close`. Built-in `options.endpoint` supports `{ type: "websocket", url, headers? }` and `{ type: "unix", path }`. The 0.165.0 CLI's help confirms native `--listen` values `stdio://`, `unix://`, `unix://PATH`, `ws://IP:PORT` and `off`, plus WebSocket authentication configuration. Host's WebSocket/Unix adapters were exercised against local protocol fixtures, including closing one client and connecting again to the still-running server.

Closing an attached connection disconnects that client; it does not terminate the external server. In contrast, Host owns the app-server process it launches over stdio and closes that process on shutdown. This provides a reusable path to an existing local or remotely hosted app-server. It does not itself provision a cloud environment, discover a user's Desktop/cloud accounts, transfer credentials, or reproduce private Desktop task routing. No remote cloud-session or production service acceptance was performed in this audit.

## Capability groups and integration boundary

The manifest is the exhaustive name inventory. This table groups the integration paths; representative names are not intended as a second partial allowlist.

| Native concern | Host path and preservation | Verified scope / external dependency |
| --- | --- | --- |
| Thread lifecycle and identity | Common read/adopt/list/history/items/fork/rename/archive/unarchive/delete; raw start/resume/settings/metadata/search/read-state/attachments/sections and all other thread methods | Native 0.165.0 local start/resume/read/list/history/items/fork/rename/archive/unarchive passed, including a fork while the source tool was pending. Adoption and conflicts have protocol tests. Native eligibility remains authoritative. |
| Turn lifecycle and rich input | Common typed `inputItems`, standalone `toolOutput`; native `thread`/`turn` options; raw start/steer/interrupt/sample/review/realtime | Actual skill input and untrusted context passed. Raw paths retain `toolOutput`, `additionalContext`, model/permission options, `outputSchema`, environments and future fields. Audio, realtime and every input variant were not newly executed in this audit. |
| Native subagents | Native spawn remains in Codex; Host verifies descendant provenance and preserves child thread/turn IDs for scoped callbacks | Real V2 spawn, inherited product tool, and a child callback after the parent's managed run completed passed. Details below. |
| Approvals, tools and questions | Existing common interaction/product-tool handlers; owner fallback for every native server request | All 11 declared server request methods retain payload and responses in transport tests. Real child dynamic-tool callback passed. Not all approval policies or real account callbacks were executed. |
| Skills, hooks and plugins | Native filesystem/configuration plus `skills/*`, `hooks/list`, `plugin/*`, `marketplace/*`; typed native skill selection | Real local skill catalog and selected skill contents reaching model input passed. Marketplace distribution/sharing/installation is transport-covered, not externally accepted. |
| Memory | `memory/status`, `memory/reset`, `thread/memoryMode/set`, `thread/memory/read` remain native | Actual `memory/status` response passed. Generation, consolidation, quality, synchronization and reset semantics were not exercised; the test disables background memories. |
| MCP, apps and connectors | `mcpServer/*`, `config/mcpServer/reload`, `app/*`, native config and product dynamic tools | Full wire paths retained. Actual service authorization, OAuth and permission grants require separate provider acceptance. Host does not add account authority by passing a tool definition. |
| Model/provider/account | `model/*`, `modelProvider/*`, `account/*`, config and feature/profile discovery | Native initialization and structured error receipts passed. Quota, login, billing and remote provider behavior were not exercised. Main-only account session/GCP methods remain source-only. |
| Workspace/process/filesystem | `fs/*`, `command/*`, `process/*`, environment, sandbox, background-terminal and review methods | Raw paths retained. Platform and permission restrictions are decided by Codex; no broad filesystem/process access is implied by a transport test. |
| Projects, remote control and diagnostics | `project/*`, `threadSection/*`, `remoteControl/*`, fuzzy search, diagnostics, feedback and import methods | Full inventory transported. Remote pairing, Desktop-specific data and external import semantics were not executed. |

### Subagent provenance and callback lifetime

Do not infer a child authorization relationship from a shared session tree or ordinary fork. Upstream distinguishes `sessionId` (tree identity), `forkedFromId` (fork source) and `parentThreadId` (subagent parent) in [`thread_data.rs`](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs). The actual 0.165.0 `thread/read` response also exposes the native spawn provenance:

```json
{
  "source": {
    "subAgent": {
      "thread_spawn": {
        "parent_thread_id": "native-parent-thread-id",
        "depth": 1,
        "agent_path": "/root/audit_child"
      }
    }
  }
}
```

The casing is native and must not be normalized into a fabricated relationship. Host checks the native spawn ancestry and the callback's exact child turn before letting it inherit the active root run's product callbacks. `thread/turns/list` with `itemsView: "notLoaded"` exposes that turn's native `rootTurnId`, including while a tool is pending; it must match the active parent's turn ID. Thread ancestry alone would incorrectly let an old child borrow a later parent run's grants. Unrelated native threads, ordinary forks, and child turns whose origin cannot be proven remain outside the managed run. Native callback requests retain the child's own `threadId` and `turnId`.

Upstream fresh-child dynamic-tool inheritance is gated by V2 multi-agent mode and the `multi_agent_v2_dynamic_tools` feature in [`agent/control/spawn.rs`](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/core/src/agent/control/spawn.rs). The isolated test enables both `multi_agent_v2` and `multi_agent_v2_dynamic_tools`; it does not claim every default configuration inherits these tools.

Managed product callbacks are scoped to an active Host run. A native child may continue after that parent run finishes. With owner native access enabled, its later request remains accessible through `nativeRequests` and can be answered through `resolveNativeRequest`; an ended product scope is not silently reactivated. The probe completes parent run A, starts run B on the same parent thread and holds B in a tool, then releases A's child's native response. It verifies that the child's `rootTurnId` still identifies A, B's callback does not execute the child's tool, the raw callback can be answered, and both the child and B finish. This proves the independent native path without borrowing a later run's grants. Caller-supplied turn chains that do not prove the current managed root likewise use the owner extension.

Unrelated session callbacks are filtered by thread ancestry before waiting for a pending `turn/start` acknowledgement. A deterministic regression holds session A's acknowledgement, requires session B's native tool to complete, and only then releases A; this prevents one initializing run from blocking another run's callbacks.

An ordinary native fork is separately available while the source Host run is active. For Codex, the common session manager allows this operation instead of applying its general mutation lock to the source. When no explicit fork boundary is supplied, Host uses the active unfinished `beforeTurnId`; conflicting `entryId`/`beforeTurnId` selections fail. The real probe blocks the source in a product tool, creates the fork through the common HTTP API, releases and completes the source, then resumes the fork with the same native identity. The source tool executes once. This exercises native fork semantics without inventing a subagent authorization relationship or replaying the source's pending operation.

### Memory, skills, connectors and scheduled work

Keep Codex's own memory implementation available through the native methods and profile configuration. Product memory remains product-owned: select relevant facts and pass them with their actual authority and provenance. The native `additionalContext` kinds are **`untrusted` and `application`**, not `trusted`. Upstream [`additional_context.rs`](https://github.com/openai/codex/blob/a29c7b97e88367044ae84c28c85451ec3e72af9f/codex-rs/core/src/state/additional_context.rs) renders application context with developer authority and untrusted context as user/tool material. Host's mutable product `context` uses `untrusted`; external documents, connector results and recalled user data must not be promoted to `application` merely to make injection convenient.

Skills should be loaded by Codex's native skill loader. Discover their canonical paths through `skills/list`, then use typed skill input when selecting them explicitly. The real macOS probe found that a syntactically similar `/var` versus `/private/var` path was not equivalent for native selected-skill matching; the test now uses the path returned by the catalog and verifies the actual skill contents in the model request. Discovering a skill name alone would not have been enough evidence.

For connectors, preserve both native MCP/apps/plugin paths and product-owned dynamic tools. Authorization, account choice, tool scopes and secret storage belong to the consuming product/provider. Tool names and protocol availability are not grants. Native callback handling preserves permission decisions instead of inventing an unconditional approval.

No generic product cron or heartbeat service was found in the public app-server method inventory. Native thread queues, goals and tool-loop state do not establish a timer service. A product can persist a scheduled trigger, select an existing native session and submit through the common Host API with a stable `requestKey`, or use the owner native protocol. `turnTrigger`, `parentTurnId` and `rootTurnId` preserve native attribution when used; they are not authorization grants. Trigger persistence, retries, delivery deduplication, account/employee scope and environment wakeup remain responsibilities of the product/Router/Environment. This audit adds no scheduler to Host and does not claim to reproduce Codex Desktop's private automation service.

For delivery originating from an application tool, the common HTTP input also supports native `toolOutput` with its `namespace`, `name`, `output` and optional `retain`. Submit `input: ""` without `inputItems` or attachments. Codex's standalone tool output and ordinary user input are mutually exclusive native turn inputs; rejecting a mixed submission preserves that native rule and does not remove the separate skill-input path. The isolated probe checks that delivery reaches the model as native `function_call_output` carrying `namespace: "mau"` and `name: "send_to_session"`, without rewriting its content as a user message. This standalone native item does not require a preceding fabricated function call.

## Acceptance levels and reproduction

| Level | Required evidence | Result in this audit |
| --- | --- | --- |
| 1. Exhaustive source inventory | Immutable source commit; all four declaration macros; explicit experimental, internal and deprecated layers | Manifest has all declarations at the three snapshots and stable executable schema comparisons. |
| 2. Protocol preservation | Every named method can traverse Host without field projection; every native notification/request reaches a consumer; responses/errors retain identity and data | Five tests in [`codex-native-coverage.test.mjs`](../test/codex-native-coverage.test.mjs), plus managed integration tests. Main's 182 request names include one Host-owned handshake, 87 notification names and all 11 callback names. Unknown future payload/envelope fields and a future method are also exercised. |
| 3. Distribution | An archive installed outside this checkout; callers import only exported package paths | The new exhaustive wire test is copied to an independent consumer by [`test-package.mjs`](../scripts/test-package.mjs). The optional actual Kernel probe is run from that consumer too. |
| 4. Actual local Kernel behavior | Exact native executable, isolated home/workspace, native receipts and specified provider | 19 checks in [`probe-codex-native-coverage.mjs`](../scripts/probe-codex-native-coverage.mjs), with Codex 0.165.0, macOS arm64, Node.js 24 and a deterministic loopback Responses API provider. |
| 5. External-service/product acceptance | Real authorized provider/account, remote environment and end-to-end user workflow | Not performed in this audit. Source or fixture coverage must not be reported as this level. |

The actual Kernel probe uses synthetic instructions, a synthetic skill and no personal login/session files. It creates fresh `HOME`, `CODEX_HOME` and workspace directories and removes them after the run. Its loopback provider deterministically emits a real native spawn and tool call. This exercises the installed Kernel's parsing, persistence, skill loader, native subagent implementation and Host integration; it does not evaluate model quality or a real provider's tool-use choices. Memory generation, real OAuth, cloud handoff, real-time voice, billing and all platform/provider combinations remain unverified.

Run repository regression and independent archive verification:

```sh
npm test
npm run test:package
```

Run the isolated actual Kernel probe explicitly, with the selected executable:

```sh
node scripts/probe-codex-native-coverage.mjs \
  --command node_modules/.bin/codex \
  --out .local/codex-native-coverage.json

AGENT_HOST_NATIVE_COVERAGE=1 npm run test:package
```

Set `AGENT_HOST_CODEX` to an absolute executable path to use a different isolated installation. `AGENT_HOST_NATIVE_COVERAGE` selects this deterministic local-provider probe; the older `AGENT_HOST_NATIVE_PROBE`/`AGENT_HOST_HTTP_NATIVE` paths have separate purposes and can use real accounts. Do not interchange their evidence. Local JSON reports and synthetic diagnostics belong in ignored `.local`, not the distributable repository.

On each Codex upgrade, regenerate the stable and experimental schemas, compare all four inventories and field schemas, review source-only/main-only changes, rerun every preservation test and the relevant actual Kernel probes, then update the versioned evidence. A version bump, generic pass-through path or advertised method must never be the sole basis for marking a native business capability verified.
