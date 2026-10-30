# Standalone HTTP service

## Codex native management and extensions

The Codex 0.165.0 integration adds native metadata, paginated turns/items,
rename, archive/unarchive and explicit adoption through `/v1/native-sessions`.
Read operations can inspect a running thread without resuming it. A fork accepts
either `entryId` (inclusive last native turn) or `beforeEntryId` (exclusive).
An active source can fork. Without an explicit boundary, Codex forks before its
current unfinished turn; the target remains independently locked and bound.
Adoption takes `sessionId`, `nativeSessionId`, stable `instructions` and `tools`;
it validates the native identity/workspace and refuses active threads. The
service owner must choose the correct tool contract for an adopted thread.
It does not copy or rewrite transcripts or discover a user's other machines.

`POST /v1/runs` accepts `requestKey`. Retrying the same normalized request returns
the original run; reusing its key with different input is a conflict. Retrieve it
with `GET /v1/runs/by-request?runtimeId=...&requestKey=...`, including after a
restart with an explicitly unknown interrupted outcome. Check the health
response's `capabilities.runIdempotency` before using this with an older server.
`inputItems` carries native Codex input objects without reducing skills, mentions
or future input variants to text. Other runtimes reject that extension. Mutable
`context` uses Codex `additionalContext` with `kind: "untrusted"`; it is not a new
user authorization or a developer instruction.

Trusted task dispatch can use `toolOutput` with `input: ""` to preserve a native
standalone tool delivery. It cannot be combined with user input items or media;
this is Codex's own protocol constraint. Use the real product namespace and tool
name, not `codex_app` or `codex_tui`. Skills selected in a user turn can use
native `inputItems`; a tool-delivered task can reference installed skills for
native on-demand reading. Never silently convert a delegated message into a
new human instruction to bypass this distinction.

Service owners can explicitly enable the complete native extension in a Codex
profile. This administrative interface has the authority of that native server;
do not expose its bearer token or arbitrary methods as a product's model tool.

```json
{
  "id": "codex",
  "kernel": "codex",
  "cwd": "./workspace",
  "nativeAccess": {
    "methods": ["skills/list", "skills/config/write", "memory/status", "thread/memory/read", "thread/memoryMode/set"],
    "callbackTimeoutMs": 120000
  }
}
```

Use `methods: "all"` only for a trusted native client that requires the full
protocol. Methods remain subject to the installed Codex version, native account,
permissions, feature flags and platform. `notifications` independently controls
client-to-server notifications. Initialization is managed once by Host; an
owner may supply the complete native `initialization` object in the profile.

- `POST /v1/runtimes/native`: `{runtimeId, method, params?}` returns `{result}`;
  add `notification: true` to send a permitted client notification.
- `GET /v1/runtimes/:id/native-events?after=0&limit=200`: original native
  notification envelopes, including timestamps, and request/lifecycle events.
  Persist its `epoch` with its cursor; an epoch change or `historyTruncated`
  requires a fresh native snapshot, never automatic replay of mutations.
- `GET /v1/runtimes/:id/native-requests`: pending native requests with original
  IDs and envelopes. Return exactly one of `result` or `error` to
  `POST /v1/runtimes/:id/native-requests/:requestId/result`.

Native error code/data survive HTTP in `nativeError`. Callbacks have deadlines;
disconnect/restart closes them with an unknown outcome instead of replaying.
Managed turn callbacks take precedence over native fallback handlers. A native
background child that outlives its managed parent is serviced through this
connection-wide extension. Inheriting a managed run's product callbacks requires
both native thread ancestry and the exact child turn's `rootTurnId` matching that
run's current turn. An old child cannot borrow a later parent turn's tool grants.
Missing native lineage evidence leaves the callback on the owner extension.

Profiles may attach to an existing server with
`endpoint: {type: "websocket", url: "ws://127.0.0.1:4500"}` (optional server-owned
headers), or `{type: "unix", path: "/path/to/codex.sock"}`. Closing an attached
connection does not terminate its server. Authentication and endpoint ownership
remain the service owner's responsibility. The default is a Host-owned stdio
process. See the [protocol audit](codex-native-capability-audit.md) for evidence
and verification boundaries.

Agent Host has two entry points over the same native adapters:

- **Embedded:** import an adapter in a product's Node backend. The product supplies its own lifecycle and storage.
- **Service:** run `agent-host serve`. Products connect over HTTP, while the service owns task records, native bindings and pending interactions.

The service manages transport, task storage and callbacks around the shared adapters. Native Agents retain their execution loops and conversations.

## Start a service

Node.js 24+ is required. Install a [GitHub Release archive](quickstart.md), or build one from a checkout with `npm pack`. The current archive is `olorinm-agent-host-0.1.0-alpha.6.tgz`; it is not published to the npm registry.

Create `host.json`:

```json
{
  "stateDirectory": "./host-state",
  "port": 37420,
  "runtimes": [
    {
      "id": "local-codex",
      "kernel": "codex",
      "cwd": "./workspace",
      "thread": { "sandbox": "read-only", "approvalPolicy": "on-request" }
    }
  ]
}
```

Create the workspace directory, authenticate the native Agent, then run:

```sh
npx --no-install agent-host serve --config host.json
```

Relative paths are resolved from the configuration file. The process listens on `127.0.0.1` by default and stays running until stopped. A service manager can supervise this process. SIGINT/SIGTERM request cancellation and close native connections.

Authentication uses `AGENT_HOST_TOKEN`, or a generated private `host-state/token` file. `--token-file` selects an existing token file. Tokens are not printed. Keep service state outside product workspaces. The CLI stores no provider credentials; Agents use native login/configuration and the server's environment.

The token identifies one trusted owner with access to every configured profile, session and task. This is not multi-tenant authorization. Products with different trust boundaries need separate instances/state directories or their own authenticated gateway. Non-loopback deployment needs an appropriately protected network/TLS endpoint. Browser access requires an explicit `allowedOrigins` list; the editor below keeps the owner token in a local companion instead of distributing it to browser code.

## Runtime profiles

HTTP callers select a configured `runtimeId`. They cannot supply executables, environment variables, provider credentials, or arbitrary workspace roots. Profiles are configured by the service owner.

| Kernel             | CLI profile configuration                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`            | Optional `command`, `args`, `env`, `model`, native `thread` and `turn` options. Defaults to `codex` and a read-only native sandbox.                                                                      |
| `claude`           | Optional `command`, `env`, `model`, SDK `native` settings; otherwise uses the bundled Claude SDK engine and native authentication.                                                                                              |
| `opencode`, `kimi` | Optional `command`, `args`, `env`, `model`, `effort`, `config`; native ACP startup and login.                                                                                                                      |
| `pi`               | Required `model` in `provider/model` form, using Pi's built-in model catalog and native provider environment. Optional `thinkingLevel` and `toolApproval`. Its durable storage lives under service state.                                             |
| `hermes`           | Required Gateway `command`, with `args`, optional `env`, `model`, `provider`, `effort`. Configure/authenticate the profile's persistent `HERMES_HOME`; the profile is exclusively owned by this service. |
| `openclaw`         | Required `gatewayUrl`, optional `gatewayTokenEnv` naming a server environment variable, optional `model`. Product tools require the existing [Gateway plugin](api.md#openclaw-product-tools).            |

`GET /v1/runtimes` and `POST /v1/runtimes/inspect` expose profile availability and implemented controls. Inspection checks the configured directory/executable and required model selection. It does not prove login, model access or native execution, and does not scan or install every Agent on the machine. Native request-time failures remain visible in the task outcome.

Each description also includes the shared [capability schema](capabilities.md). It distinguishes adapter support from native negotiation and configuration requirements. Existing `controls.steer` and `controls.compact` flags remain available. Custom runtimes must declare their own capabilities; a custom runtime named `codex` does not automatically inherit the built-in adapter's claims.

For custom Pi providers, Claude SDK settings, native discovery, or additional runtime composition, use the server package from Node:

```ts
import {
  createNativeRuntime,
  startAgentHostServer,
} from "@olorinm/agent-host/server";

const stateDirectory = "/path/to/host-state";
const runtime = createNativeRuntime(
  {
    id: "codex",
    kernel: "codex",
    cwd: "/path/to/workspace",
    options: { command: "/path/to/codex" },
  },
  stateDirectory,
);
const server = await startAgentHostServer({
  runtimes: [runtime],
  stateDirectory,
  token: process.env.AGENT_HOST_TOKEN!,
});
console.log(server.url);
// On product/service shutdown:
await server.close();
```

Programmatic profiles accept the existing adapter options. A custom `ServiceRuntime` may wrap another implementation while honoring the same turn/tool/interaction contract. Change `configurationRevision` when a programmatic callback's captured configuration changes; serialized function text alone cannot detect changed closures.

## Connect a product

`@olorinm/agent-host/client` uses standard Fetch and has no Node runtime imports. It can run in Node or a browser bundle. It neither starts a server nor discovers local credentials.

```ts
import { AgentHostClient } from "@olorinm/agent-host/client";

const host = await new AgentHostClient({
  baseUrl: "http://127.0.0.1:37420",
  token: process.env.AGENT_HOST_TOKEN,
}).connect();

const session = host.session({
  sessionId: "my-product-document-42",
  runtimeId: "local-codex",
  instructions:
    "Help edit the current document. Use edit_document for changes.",
  tools: [
    {
      name: "edit_document",
      description: "Edit the document after product authorization.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      async execute(input, context) {
        // Validate arguments and business permissions; ask the user if required.
        // Commit the change and a durable receipt keyed by context.callId together.
        // Honor context.signal and context.deadlineAt before starting an effect.
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "Saved" }],
        };
      },
    },
  ],
});
const task = await session.run("Shorten the introduction.", {
  document: "Current contents...",
});
const result = await task.wait({
  onEvent: ({ event }) => {
    if (event.type === "assistant.delta") process.stdout.write(event.text);
  },
  onHistoryGap: () => {}, // Explicitly accept truncated progress; result.answer is stored separately.
  onRequest: async (request, context) => {
    // Native permissions/questions keep their original method and JSON response format.
    // This example declines a Codex command/file approval.
    if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(request.method)
    )
      return { decision: "decline" };
    throw new Error(`No product handler for ${request.method}`);
  },
});
console.log(result.status, result.answer);
```

Native question and permission replies use the formats documented in [the adapter API](api.md#tools-and-interactions). The service does not treat every interaction as a yes/no prompt. A client may instead poll calls and resolve them using its own UI. The HTTP example uses the common `onInteraction` helper for approvals, questions, JSON forms and URL elicitations, with a raw native response escape hatch. It never solicits native sudo secrets. See the [common API](common-api.md).

Session runtime, stable instructions, tool definitions and server configuration are bound on the first task. A mismatch returns `409 session_configuration_conflict`. Mutable product state goes in per-turn `context`. There is one active task per session. Hermes additionally permits one active task per profile. Native sessions and transcript storage stay with the selected adapter/Kernel.

## HTTP operations

Every operation requires `Authorization: Bearer <token>` and JSON bodies for POST.

| Operation                                       | Meaning                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/health`                                | Service protocol version (`1`).                                                                                                |
| `GET /v1/runtimes`                              | Configured profiles and control availability.                                                                                  |
| `POST /v1/runtimes/inspect`                     | Check `{ runtimeId }` without running an Agent.                                                                                |
| `POST /v1/runs`                                 | Submit `{ sessionId, runtimeId, requestKey?, instructions?, input, inputItems?, toolOutput?, attachments?, context?, tools?, settings?, mode?, timeoutMs? }`; returns `202` with a run record. |
| `POST /v1/runtimes/discover` | Explicit native handshake for `{runtimeId}`; static fallback is labelled. |
| `POST /v1/native-sessions` | Native list/bindings/read/history/items/fork/delete/rename/archive/unarchive/adopt. See the native management contract above for boundaries and parameters. |
| `GET /v1/runs/by-request?runtimeId=...&requestKey=...` | Find the original run for an idempotent submission. |
| `GET /v1/sessions`                              | Session configurations.                                                                                                        |
| `GET /v1/runs?sessionId=...`                    | Run records, newest first.                                                                                                     |
| `GET /v1/runs/:id`                              | Status and independently persisted final answer.                                                                               |
| `GET /v1/runs/:id/events?after=0&limit=200`     | Bounded, sequenced progress with truncation indication.                                                                        |
| `POST /v1/runs/:id/cancel`                      | Request cancellation; wait for the reported terminal outcome.                                                                  |
| `POST /v1/runs/:id/steer`                       | Send `{ input }` to an active turn when its adapter supports it.                                                               |
| `GET /v1/runs/:id/calls`                        | Product-tool and native interaction records for this run.                                                                      |
| `POST /v1/runs/:id/calls/:callId/result`        | Resolve a pending call with `{ result }`.                                                                                      |
| `GET /v1/sessions/:id/files?path=...`           | Read a bound workspace file; add `encoding=base64` for binary, when enabled.                                                                                |
| `GET /v1/sessions/:id/files?list=true&path=...` | List one directory, when enabled.                                                                                              |
| `POST /v1/sessions/:id/files`                   | Write `{ path, content, encoding?: "utf8" | "base64", expectedRevision? }`, when enabled.                                                                    |

`session.compact()` submits `mode: 'compact'` through the same task machinery for all seven Kernels. It uses the native binding, including Hermes continuation after restart. OpenCode/Kimi reject custom reasons and use their native summarize/compact operation; OpenClaw's compact API also has no reason parameter. OpenCode 2 uses its ACP operation and completion receipt. Hermes canonical ACP has no confirmed compact/delete/steer path. Acknowledgement alone is not completion. Pi may return a confirmed native no-op. Native uncertainty remains explicit. HTTP steering is implemented for Codex, Claude, Pi, Hermes TUI and OpenClaw; OpenClaw preserves native interrupt-and-replace semantics. Unsupported controls fail explicitly. See [controls](common-api.md#controls) and [native verification](native-verification.md).

Workspace file access is opt-in via `workspaceFiles: true`. Paths stay under the selected profile's workspace; symlinks are rejected. `expectedRevision: null` requires a new file; a prior revision prevents overwriting a change already observed by this process. This is an optimistic check, not a transaction with unrelated filesystem writers or an OS sandbox for native tools. The client exposes `readFile`, `writeFile`, `readBinaryFile`, `writeBinaryFile`, and `listFiles`. Text files are limited to 1 MB; binary files to 30 MiB. Binary content is canonical base64 and revisions hash the decoded bytes.

## Disconnects, restart and duplicate operations

- Disconnecting HTTP or aborting `task.wait()` stops observation, not the native task. Call `task.cancel()` to request cancellation.
- Reattach with `host.task(runId, productTools).wait(...)`. The SDK polls at 250 ms by default and reports network errors to the caller. It does not automatically resubmit a task after a failed request.
- Progress defaults to 2,000 events per run. A history gap requires explicit acknowledgement through `onHistoryGap`; the complete final answer is stored separately.
- Call deadlines default to 120 seconds. Cancellation/deadline aborts pending handlers and rejects late replies. It cannot undo an effect already committed by a product.
- Reposting the same result for a completed call succeeds, including after restart. A different result conflicts. The same SDK task object caches executions across repeated observation; different clients/pages can execute the same pending call. The product must persist a `callId` receipt together with its business change. This is not an exactly-once side-effect guarantee.
- SQLite saves task results/events/call records independently of the product. It holds one process's exclusive state lock, released by the OS on crash. A second service cannot share this state directory concurrently.
- After a crash, unfinished runs become `failed` with `outcomeUnknown: true` and `host_restarted`; pending calls become cancelled. Nothing is replayed automatically. Completed native bindings can be continued by a new, explicitly submitted turn. Preserve both Host state and the Kernel's native storage.

## Media input

A turn accepts up to 30 `attachments`, with a combined decoded size of 30 MiB. Each item is `{ name, mediaType, data }`, where `data` is canonical base64. An attachment-only turn may use `input: ""`. The client supports `session.run(input, context, attachments)`.

The service saves immutable, content-addressed files under the configured workspace's `.agent-host/attachments/` and supplies their paths to the runtime. Files use private permissions and the directory has a `.gitignore`. This is private runtime state; retention is controlled by the service owner. Attachment transfer does not require enabling the additional workspace file API.

Custom runtimes must explicitly enable attachment delivery through `inputs.attachments`; otherwise requests fail before task creation or file writes. Compaction rejects attachments. Inline tool-result image data is validated before MCP delivery, and an invalid image produces a failed tool result rather than a successful result containing an unusable link.

| Runtime | Image input | Other attachments |
| --- | --- | --- |
| Codex | Native image input items | Native audio input items; other files keep workspace paths |
| Claude | Native SDK image blocks (PNG/JPEG/GIF/WebP) | Native PDF document blocks; other files keep workspace paths |
| Pi 1.2 | Native image content | Workspace file paths |
| OpenCode / Kimi ACP | Image blocks, subject to negotiated capability | Negotiated audio and embedded text resources; OpenCode also accepts embedded blobs, while Kimi 2.2 explicitly rejects them. Original files remain in the workspace |
| Hermes TUI | Native `image.attach_bytes` | Native `pdf.attach` and `file.attach`, plus workspace files |
| Hermes canonical ACP | Negotiated native image blocks | Workspace file paths; no audio/embedded-resource prompt capability |
| OpenClaw | Native Gateway attachment payload | Workspace file paths and Gateway payload |

`runtimes` / `runtimes/inspect` include `inputs.attachments` and `inputs.images` (`native`, `negotiated`, or `workspace`). This describes the adapter path, not the selected model's vision, audio, video or speech capabilities. Those remain native runtime/model/tool capabilities. Unsupported image formats or negotiated capabilities fail explicitly. Product `inputImage` results retain image content through Codex, Claude, Pi and the MCP bridges; inline `data:image/...;base64,...` avoids an additional fetch. Pi requires an inline image, since its native tool results do not accept remote image URLs.

## Example and verification

See the [HTTP editor](../examples/http-editor/README.md). It starts a separate product companion and browser UI, connects to the service, asks before saving, and persists business receipts atomically with its document. It uses the public client API and the Agent runtime managed by the service.

```sh
npm test
npm run test:package
# Optional model-backed Codex validation of the installed HTTP service and editor:
AGENT_HOST_HTTP_NATIVE=1 npm run test:package
```

Tests distinguish deterministic Agent/provider fixtures from native model-backed probes. The HTTP fixture matrix covers all seven existing adapters, approve/reject and native binding continuation across Host restart. Additional tests cover native interaction response shapes, observation disconnects, deadlines, duplicate results, authentication, file revisions and hard-process-crash recovery. The package test installs the archive in an independent consumer, starts its CLI and exercises the copied product example. Existing embedded consumer tests remain required.

Products own their domain models, workflows, knowledge management, accounts and application distribution. These are not runtime dependencies of the service. Skills and MCP integrations remain native capabilities; the opt-in native extension carries their original administration protocol while the product retains authorization and distribution policy.


Native session management, selectable settings, trusted hooks and receipt-based controls are documented in [common API](common-api.md). `allowedSettings` is configured by the owner, included in the runtime description and checked before side effects. Native session deletion retains a Host tombstone; it never silently turns continuation into a fresh conversation. The [native verification matrix](native-verification.md) records the separate model-backed HTTP results.
