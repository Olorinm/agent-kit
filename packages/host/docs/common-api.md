# Common usage with native details preserved

Codex now exposes native metadata, turn/item pages, rename, archive/unarchive
and explicit session adoption. `agent.sessions.history()` uses the native page
contract and accepts `cursor`, `limit`, `sortDirection` and `itemsView`. Native
snapshots do not require the thread to be idle. Codex can fork an active source;
without an explicit boundary it excludes the current unfinished turn. The target
and other mutations retain per-session locking. `agent.adoptSession(nativeId, requestConfiguration)` is an explicit
owner action, not automatic discovery or transcript import.

The embedded `agent.connect()` retains complete native JSON-RPC requests,
notifications, error code/data and server requests. Register `options.onClient`
to subscribe before initialization. `CodexAppServerClient.attach(transport)` and
`connectCodexTransport(endpoint)` support externally owned transports; close
disconnects without shutting down the native server. Complete owner-selected
handshake fields can be supplied through `options.initialization`.

For process-separated consumers, `AgentHostClient.nativeRequest`,
`nativeEvents`, `nativeRequests` and `resolveNativeRequest` provide the same
extension when enabled by the service owner. See
[the HTTP contract](http-service.md#codex-native-management-and-extensions).
Keep product authorization outside these administrative native APIs; successful
transport coverage does not imply account, platform or model availability.

Use `createAgent({kernel, options})` for a typed embedded adapter. Use `createNativeRuntime(profile, stateDirectory)` to embed the same runtime composition used by the HTTP service, including profile settings and attachment routing. Use `AgentHostClient` for another process or a browser. All three retain native execution and durable identity.

## Approvals, questions and progress

```ts
import { createAgent } from '@olorinm/agent-host/adapters';
import type { InteractionHandler } from '@olorinm/agent-host/interactions';

const onInteraction: InteractionHandler = async (request, context) => {
  context.signal.throwIfAborted();
  // Display request.title, choices/questions/schema/permissions/url in your UI.
  // Your UI returns an exact choice ID, answers keyed by question ID,
  // an elicitation action, or an explicit native response.
  return { action: 'cancel' }; // Safe example; replace with your UI's decision.
};
const agent = createAgent({ kernel: 'codex' });
try {
  for await (const event of agent.run({
    sessionId: 'document-1', cwd: process.cwd(),
    instructions: 'Help edit the document.', input: 'Suggest a title.',
    onInteraction,
  })) {
    if (event.type === 'assistant.delta') process.stdout.write(event.text);
    if (event.type === 'usage') console.log(event.scope, event.inputTokens);
  }
} finally { await agent.close(); }
```

For HTTP, pass the same `onInteraction` to `task.wait({onInteraction})`. No seven-way constructor or response-format switch is needed for ordinary interactions. The terminal CLI and browser editor both use these helpers.

| Request kind | Product reply | Preserved detail |
| --- | --- | --- |
| `approval` | `{choice: exactChoiceId}` or `{action:'cancel'}` | Native choices and once/turn/session/always scope; Codex permission grants include the requested permission object. |
| `questions` | `{answers:{questionId:'value'}}` (arrays for multiple answers) | Question IDs, choices, descriptions, multiple-answer and secret hints. |
| `form` | `{action:'accept',content:{...}}`, decline or cancel | Native JSON Schema and structured content. |
| `url` | Accept only after completion, or cancel | Native URL and message; Host does not open it or infer completion. |
| `native` | `{native: nativeResponse}` | Original method and parameters when no faithful common representation exists. |

Every request includes `native`. `onRequest` remains available for direct native replies. If both handlers exist, recognized requests use `onInteraction`, and unknown requests use `onRequest`. Complex Codex rule amendments can use an explicit native answer. A missing or cancelled handler never becomes approval. Native permissions and product business authorization are separate decisions.

Pi's callback is the native `beforeTool` policy hook; HTTP owners enable it with `toolApproval: true`. This is not a claim that Pi implements a built-in permission dialog. OpenClaw native command approvals are correlated to the active session/run and require Gateway approval scope. Its pinned Gateway has no structured native question RPC; a product tool can still ask its own questions.

Common progress adds `reasoning.delta`, `usage` and `native.tool` alongside lifecycle, text and product-tool events. Original `native.notification` payloads are also emitted. `usage.scope` distinguishes response, turn, session and unspecified native accounting; do not sum cumulative session counts. Missing fields stay missing. Reasoning events contain only information the native Kernel emits; no hidden reasoning is reconstructed. Product tool events and native tool events remain distinguishable.

## Native conversations

```ts
await agent.sessions.list({ cwd: process.cwd(), limit: 50 });
await agent.sessions.history('document-1', { cwd: process.cwd() });
await agent.sessions.fork('document-1', 'document-1-copy', { cwd: process.cwd() });
await agent.sessions.delete('document-1-copy', { cwd: process.cwd() });
await agent.sessions.bindings();
```

HTTP equivalents are under `client.nativeSessions(runtimeId)`. `fork(source,target,entryId?)` and `history(hostSessionId)` take Host IDs for known bindings. `list()` returns native sessions, including ones that may not be bound to a Host session. `bindings()` explicitly lists Host-to-native references. Neither is confused with `client.sessions()` and the Host's run log.

`SessionPage` has `source:'native'`, raw `items`, optional `native` metadata and optional `cursor`. The native shapes differ: Codex turns, Claude SDK messages, Pi durable entries, ACP replay updates or server messages, Hermes display transcript, and OpenClaw chat history. Pagination is native-specific; use a returned cursor, not an invented offset. `limit` is a native hint where the operation supports it; some native history APIs return the full transcript.

- OpenClaw fork requires a native user-message `entryId`, obtainable from transcript metadata (`__openclaw.id` in the tested Gateway). Other adapters default to a full current fork. Codex/Claude/Pi also accept their supported native cut-point IDs.
- ACP list/fork/delete depend on the actual handshake. OpenCode 2 and Kimi use negotiated ACP operations; history uses a separate native `session/load` reader. Replay never enters the current model turn.
- Hermes history resolves the durable ID to a live handle, then calls the native history API. Native compression can rotate its durable storage; native history handles the lineage.
- Claude uses SDK session helpers, with the same native configuration directory or configured session store. A store without native deletion support fails explicitly.
- Pi 1.2 has no supported native delete API. A failed/unsupported delete leaves the Host binding intact.

Operations that mutate a conversation are serialized with active turns in the same adapter/service. The application remains responsible for one owner of native storage across independent processes. Native deletion happens before binding removal. HTTP keeps a tombstone so reuse of a deleted Host ID cannot silently create a new conversation. A fork uses native storage, never a Host replay of old dialogue.

Custom `BindingStore` implementations must round-trip the complete `SessionBinding`, including optional `configurationSessionId`. Native forks inherit this configuration identity while receiving their own native storage ID. This lets OpenClaw continue a fork after restart without treating the new Host ID as a configuration change; genuine instruction/tool/profile changes still fail validation.

## Settings and native extensions

The service owner chooses exactly which values callers may select:

```ts
const profile = {
  id: 'work', kernel: 'codex' as const, cwd: process.cwd(),
  allowedSettings: {
    effort: { values: ['low', 'high'], description: 'Reasoning effort' },
  },
};
// createNativeRuntime(profile, '.agent-host') in your host.
// From a connected client:
const task = await client.session({
  runtimeId: 'work', sessionId: 'doc-1', settings: { effort: 'high' },
}).run('Review this change');
```

The runtime description returns `allowedSettings`. Unknown keys, unexposed values, commands, environments and permission-policy overrides are rejected before creating a task or saving attachments. These choices are native options, not invented equivalent behavior across models. Native setting validation remains authoritative. Hermes TUI settings use session-scoped mutation receipts; Hermes canonical ACP exposes model selection only.

Selectable keys: Codex `model`, `effort`, `serviceTier`, `outputSchema`; Claude `model`, `effort`, `thinking`, `maxTurns`, `maxBudgetUsd`, `outputFormat`; Pi `model`, `thinkingLevel`; ACP `model`, `effort`, `config`; Hermes TUI `model`, `provider`, `reasoningEffort`, `fastMode`; Hermes canonical ACP `model`; OpenClaw `model`, `thinking`, `fastMode`. Model IDs and allowed values are selected by the owner based on the native installation. Host does not guarantee provider access from a model name.

Trusted programmatic `runOptions` retain Codex thread/turn/beforeTurn; Claude SDK options; Pi extensions, thinking level, model/tool/event hooks; ACP configuration, MCP servers, directories and beforeTurn; and Hermes/OpenClaw beforeTurn. Executable hooks belong to the service owner and are never deserialized from HTTP. Native adapter construction options remain available under `options`.

## Controls

HTTP `task.steer(text)` is wired for Codex, Claude, Pi, Hermes TUI and OpenClaw. Hermes canonical ACP has no equivalent advertised control. Native scheduling still applies: acceptance does not mean the current tool stops immediately. OpenClaw uses native `chat.send` with `queueMode: "interrupt"`, which interrupts and replaces the native run; Host follows the returned run ID and buffers early events. No Host transcript replay is involved.

`client.session(...).compact()` is wired for all seven Kernels through their supported transport; Hermes canonical ACP lacks a verifiable completion receipt and reports unsupported. Native completion is required: Codex correlated events, Claude `compact_boundary`, Pi settled durable task/submission, OpenCode 2 ACP compaction receipt, Kimi completion receipt, Hermes compressed result, OpenClaw compacted result. Pi can explicitly finish with nothing to compact; the `control.result` reports `compacted:false` and the operation completes successfully. Kimi completion remains valid if the summary happens to grow. Missing receipts and uncertain cancellations remain failures with native uncertainty, not false success.

See [native evidence](native-verification.md) for what has actually been executed and [remaining boundaries](capability-gaps.md) for upstream/environment limits.
