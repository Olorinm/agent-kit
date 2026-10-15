# Claude and Pi upgrade review — 2026-10-15

Tracked in [issue #29](https://github.com/Olorinm/agent-host/issues/29). The target versions were checked against each project's official release and npm `latest` metadata on 2026-10-15. The shared integration remains a native SDK/harness adapter; it does not implement a model loop, transcript importer, or alternate permission system.

## Claude Agent SDK 0.3.295 → 0.3.300

Target engine: Claude Code 2.1.300. Official release notes: [0.3.296](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.296), [0.3.299](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.299), [0.3.300](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.300). The published `sdk.d.ts` and SDK implementation were compared with 0.3.295.

- Discovery includes `claude_code_version` from the native initialization receipt when present. It does not infer an engine version from the SDK package version or expose account details.
- `AgentDefinition.autoCompactWindow`, native sandbox/settings merge behavior, and model-dependent adaptive thinking remain SDK-owned and pass through `native: Options`. Native hooks, budgets, subagents and settings are not reconstructed by Host. The HTTP owner supplies these through `options.native` or `runOptions.native`.
- Permission requests preserve the SDK's display text, decision reason, blocked path, suggestions, request/subagent IDs and ask-rule metadata. Native replies retain permission updates, classification and deny/interrupt semantics. Common approval choices remain limited; a consumer can supply an explicit native answer or an owner-supplied SDK callback.
- A withdrawn native permission or elicitation request now cancels its pending product callback without cancelling a different turn. Host and native request signals are combined. Elicitation retains its native request ID.
- Only a product tool reported by the SDK as originating from the in-process `agent_host` server is automatically allowed as that registered product tool. A same-named project/user MCP tool follows the normal permission route.

The 0.3.299 wire protocol adds elicitation `property_order`, but the **0.3.300 public `onElicitation` callback does not expose or forward it**. Inspection of both the published type and conversion implementation confirms this. Host does not bypass the SDK to claim this wire-only capability. Form schemas and native display metadata still reach consumers. Native background subagent ordering, transcript import fixes, hook-input validation, and thinking behavior are supplied by the updated engine; they are not separately certified by Host's fixture tests.

## Pi 1.1.0 → 1.2.0

Targets: `pi-durable`, `pi-ai`, `pi-agent-core` and `chord` 1.2.0. Existing `compat/pi085` packages stay pinned to 0.85.1 for their native storage generation. Sources: [release](https://github.com/earendil-works/pi/releases/tag/v1.2.0), [durable changelog](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/CHANGELOG.md), [AI changelog](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/CHANGELOG.md), [durable package](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/package.json). The CLI's removal of its Chord dependency does not apply to `pi-durable`, which still depends on Chord.

- Required compatibility repair: product tools return native `output`, replacing 1.1's `content`. A failed product result returns `isError` with its complete text/image output instead of throwing away non-text content.
- Native nested tool calls end with a `result`, whereas model-issued calls end with a transcript `entry`. Both are projected correctly. Native task IDs, parent call/task IDs, structured output, diagnostics, duration and other receipt fields remain intact in native notifications. The common tool result reports the actual success/failure and projects available output.
- Native `beforeTool` hooks receive the complete `ToolHookCall`, including parent identity. Argument replacements survive product approval and are validated/executed by Pi. The approval request displays the arguments selected by that native policy hook.
- `ProductTool.deferLoading` maps to Pi's native `deferred`. The owner selects the official `createToolSearchExtension()` when deferred tools should be found by the model, or controls `modelTools` through `beforeTurn`. Host does not implement a search tool.
- Official codemode, tools-only registrations, structured output, image processing and provider catalog features remain explicit native extensions/catalog configuration. Embedded callers use `extensions`, `beforeTurn`, `options.models` and `options.settings`; HTTP owners have the same `runOptions` and runtime `options` paths. These are not untrusted per-request executable options.
- Fatal native storage failures fail the session and later calls. Host does not retry work or reopen it silently. A fresh adapter/storage instance is an explicit owner recovery action. Pi's new native task-version migration and replay policies remain authoritative.

Pi still provides no supported native conversation deletion API through this integration. Codemode restart replay, every storage implementation, all OpenRouter catalog/account combinations, and every image processor are outside the verification below.

## Verification

`npm run build` and `node --test test/claude.test.mjs test/pi-durable.test.mjs` passed: 18 tests. Claude uses SDK/protocol seam fixtures. Pi tests run the actual 1.2.0 durable harness with deterministic provider output: persistence/restart, tools/policy, nested identity and receipts, failure image output, structured native output, deferred tool search, native argument repair, fatal storage behavior, and cancellation. This is distinct from model-backed evidence.

Model-backed HTTP probes used macOS arm64, Node.js 24.18.0, isolated workspaces/profiles and an owner-configured Anthropic-compatible route (`cd-opus-5.5`). Pi used the native model compatibility flags disabling mid-conversation system messages, tool changes and effort for that provider. An initial request without those provider flags was rejected with HTTP 400; Host does not force those settings on other providers.

Both Claude SDK 0.3.300 / engine 2.1.300 and Pi 1.2.0 passed all eight HTTP checks: discovery, a model turn, recall after Host restart with unchanged native identity, history, list, native fork with recall, compaction receipt, and recall after compaction/restart. Claude also passed three native HTTP interaction cases: allow and deny a Bash operation forced through native ask policy, retaining request/tool IDs, and accept an MCP form with string, integer, boolean and string-array fields, retaining the native request ID and exact MCP response.

Three additional Pi model-backed cases passed: a native nested call invokes the product exactly once with parent identity; rejecting the nested child prevents product execution; the official codemode extension calls the product inside its native sandbox and returns the receipt. The deferred-search model-backed case was rejected by the provider's content policy before any tool event; its native harness/provider-fixture test passes, but model-backed verification remains incomplete. Raw reports, authentication references and transcripts stay in ignored `.local/harness-refresh-20261015/`.

Reproduction (trusted owner profiles supply authentication and provider configuration):

```sh
node scripts/probe-native-http.mjs --profiles /absolute/path/claude-pi-profiles.mjs --out /absolute/path/report.json --only claude,pi --controls --checks history,list,fork,compact,resume-after-compact
node scripts/probe-native-scenarios.mjs --profiles /absolute/path/pi-scenarios.mjs --out /absolute/path/scenarios.json --only pi
```

The full repository and independent archive-consumer gates are reported in the consolidated upgrade evidence.
