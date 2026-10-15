# ACP harness refresh — 2026-10-15

Tracked in [issue #29](https://github.com/Olorinm/agent-host/issues/29). This review covers OpenCode and Kimi Code and preserves the ACP wire, native sessions, tools, permissions and model loops.

## Upstream targets and sources

| Harness   | Previous pin                   | Upgrade target                 | Official evidence                                                                                                                                                                           |
| --------- | ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode  | `opencode-ai@1.18.35`          | `@opencode/cli@2.0.29`         | [V2 installation](https://dev.opencode.ai/v2/docs/), [npm package](https://www.npmjs.com/package/@opencode/cli/v/2.0.29), [V1 migration guide](https://dev.opencode.ai/v2/docs/migrate-v1/) |
| Kimi Code | `@moonshot-ai/kimi-code@2.1.1` | `@moonshot-ai/kimi-code@2.2.0` | [2.2.0 release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.2.0), [npm package](https://www.npmjs.com/package/@moonshot-ai/kimi-code/v/2.2.0)       |

The npm `latest` tags were queried on 2026-10-15. OpenCode's old `opencode-ai` package and GitHub latest release still select **1.19.0**, while the official V2 package selects **2.0.29**. Updating the old package alone would miss the new integration generation. The package dependency does not replace a user's global CLI or migrate personal data.

Primary protocol/source references inspected at the release tags:

- [OpenCode ACP documentation](https://dev.opencode.ai/v2/docs/cli/acp/), [V2 ACP handlers](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/acp/service.ts), [compaction](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/acp/compaction.ts), [child sessions](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/acp/child.ts), [capability negotiation](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/acp/capabilities.ts), and [prompt context](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/acp/prompt.ts).
- [Kimi ACP lifecycle](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.2.0/packages/acp-server/src/server.ts), [prompt conversion](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.2.0/packages/acp-server/src/convert.ts), [session events](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.2.0/packages/acp-server/src/session.ts), and [native commands](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.2.0/packages/acp-server/src/builtin-commands.ts).

## Adapter changes

- OpenCode 2 history uses native ACP `session/load` in a separate reader process. Delete prefers negotiated `session/delete`. Compaction runs the native `/compact` command in the existing ACP session and requires a matching compaction start/completion receipt; a prompt acknowledgement alone is insufficient. The existing OpenCode 1 HTTP history/delete/summarize bridge remains for that generation.
- `additionalDirectories` is carried on restart resume/load. OpenCode 2 replaces grants on history load and fork, so these operations first obtain the stored grants from the native session list, including pagination. Reading history does not revoke native access grants.
- The client advertises supported ACP compaction updates and OpenCode's child-session event extension. Child updates retain their native session attribution and do not become root assistant text. Legacy child updates with the OpenCode `_meta` marker are also excluded from the root answer.
- OpenCode 2 receives instructions/product context in text blocks annotated for the assistant. Native commands in the user's message remain commands; native context remains separate from visible user text.
- Native setup configuration and command notifications are retained before a session response and between turns. `getInitialization()` exposes native identity/authentication metadata; `getOperationSupport()` reports implemented operation paths; `getSessionCommands()` exposes the native command catalog.
- End-turn ACP usage is projected as `usage` with `scope: "turn"`, retaining the original response and usage object. Context occupancy from `usage_update.used` is not relabeled as input-token usage.
- Kimi rejects blob embedded resources explicitly because its advertised `embeddedContext` only converts text resources and upstream otherwise drops blobs. Image/audio and other capabilities remain negotiated.
- JSON-RPC notification delivery calls every subscriber synchronously before a same-chunk response can settle. Async subscribers still run without blocking response parsing, including subscribers that issue their own RPC. This prevents lost Kimi/OpenCode compaction receipts. A failing synchronous or asynchronous subscriber is isolated and recorded through the existing stderr diagnostics; later subscribers still receive the notification.

## Native boundaries

Kimi 2.2.0 adds experimental progress notifications and Tower-related engine/UI behavior, plus media-resume and fork fixes. The published ACP handlers do not expose a new Host steering or Tower orchestration control; Host does not simulate those features. Native configuration remains available through the owner-supplied native environment and negotiated config options.

Kimi declares `additionalDirectories`, but the tagged implementation only applies them at `session/new`; load/resume/fork warn and ignore the supplied field. Existing directories remain native-owned. Kimi still reports `/compact` completion through its asynchronous command receipt, which Host continues to await.

ACP filesystem/terminal reverse RPC remains unadvertised because Host has no implementation for those client capabilities. Native tools continue running in the harness environment. OpenCode's client-facing commands, retry metadata and child-session notifications are preserved as native events; they do not imply Host owns background child scheduling or can replay interrupted operations. The live turn API does not promise delivery of child events after that Host turn has finished.

OpenCode 2 has a new provider configuration and server/plugin API. The adapter uses ACP for V2 and does not silently migrate personal V1 configuration or databases. Source/version identification selects the legacy HTTP bridge; feature support within ACP is still negotiated.

## Verification

Deterministic checks:

```sh
npm run build
node --test test/acp.test.mjs test/acp-v2.test.mjs test/acp-compaction.test.mjs
```

All **25 ACP tests passed** on macOS arm64 / Node.js 24.18.0. These include the OpenCode 1 HTTP fallback, Kimi asynchronous receipts, native permission/elicitation routing, cancellation, MCP tool calls, restart resume, V2 directory preservation/history/fork/delete, child output, context annotations, turn usage, idle configuration updates, missing/foreign/failed compaction receipts, and wire-order handling with an async subscriber RPC. They use protocol/provider fixtures and do not establish live model support.

Uncredentialed probes ran the actual OpenCode **2.0.29** binary and Kimi **2.2.0** CLI in fresh temporary data/config/workspace directories:

- OpenCode initialize, list, new and delete passed; native configuration returned `model`, `effort` and `mode` selectors. History of an empty persisted session loaded after process restart. Native fork correctly refused an empty session (`Cannot fork empty session`), so this probe does not establish conversational fork/recall.
- Kimi initialize/list passed and a fresh unauthenticated profile correctly refused session creation with `Authentication required`.

Actual CLI + deterministic local provider probes then exercised the full Host HTTP path, using fresh config/data/workspace directories and no personal credentials:

| Check                                                                                    | OpenCode 2.0.29                                                                   | Kimi 2.2.0                                    |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| Model turn, preserved native ID and recall after Host restart                            | Passed                                                                            | Passed                                        |
| Native history/list, fork with recall, delete of fork                                    | Passed                                                                            | Passed                                        |
| Native compaction receipt and recall after another restart                               | Passed                                                                            | Passed                                        |
| Product tool success, denial and cancellation in the first session turn                  | Intermittent missing native tool catalog; failed in the recorded three-case probe | Passed                                        |
| Product tool success, denial and cancellation on a later turn of the same native session | Passed                                                                            | Not required to establish first-turn behavior |

The local provider emits deterministic OpenAI-compatible completions and tool calls. Compaction uses the real native engine; OpenCode's summary must satisfy its native template. An intentionally invalid summary produced a matched `failed` receipt and Host correctly reported `outcomeUnknown: false`; the valid template produced `completed`. These results establish native CLI/ACP/session/MCP execution, not real provider model behavior. The fixture is available for reproduction:

```sh
node scripts/probe-native-http.mjs \
  --profiles test/fixtures/acp-native-local-provider.mjs \
  --out .local/acp-native-local-provider.json --controls
# This additionally exposes the OpenCode first-turn catalog limitation below:
node scripts/probe-native-http.mjs \
  --profiles test/fixtures/acp-native-local-provider.mjs \
  --out .local/acp-native-local-tools.json --interactions
```

This fixture declares `modelProvider: "deterministic"`, so its report is labeled `native-harness-local-provider-fixture`, distinct from `live-native-http`. It runs a real native CLI behind Host HTTP with a synthetic loopback model and must not be cited as a live-provider pass.

### OpenCode dynamic MCP readiness boundary

OpenCode 2.0.29's ACP `session/new`/resume handler [attaches MCP servers with `mcp.add`](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/acp/sessions.ts). [Native MCP registration](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/mcp/index.ts) reloads state and publishes `ToolsChanged` after connecting. The [tool registry](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/tool/mcp.ts) processes subsequent changes asynchronously with a 100 ms debounce; its `flush` waits only for initial registration. ACP provides no tool-catalog-ready barrier. A successful MCP connection therefore does not ensure that a new product tool appears in the immediately following model request.

The probe observed `mcp connected` with one tool while the first request's complete Code Mode catalog omitted it. A normal earlier turn in the same session allowed subsequent success/denial/cancellation callbacks to pass. That earlier turn was an explicit diagnostic comparison, not an adapter workaround. Host adds neither sleeps nor hidden model turns, and `tools.product` remains conditional with this limitation. OpenCode's bridge uses the simple `agent_host` namespace, but changing the name alone **did not fix the race**. Explicitly supplied bridge providers remain owner-controlled.

### Authorized live-provider attempts

After explicit user authorization, separate isolated profiles attempted synthetic prompts using the existing Google API key and Kimi login credentials. Original personal configurations, credentials and sessions were not modified; copied Kimi credentials were removed after each attempt. No business source files or personal sessions were used.

- OpenCode's Google/Gemini 2.5 Flash attempt failed with native `AI.Error: API key not valid. Please pass a valid API key.` The ACP error was `Authentication required: provider authentication required: {}`. Attempts included the V2 provider configuration and the [native Google provider's `GOOGLE_GENERATIVE_AI_API_KEY` path](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/ai/src/providers/google.ts); the latter still failed. Consequently live-provider session, tool and compaction checks could not run.
- Kimi's `kimi-code/k3` attempt with separate copies from both existing native credential locations failed with `OAuthUnauthorizedError: The provided authorization grant is invalid`. Its private diagnostic wire recorded `turn.ended` with `reason: failed` and `code: internal`; ACP emitted only session information and `end_turn`, with no error notification or answer. The marker assertion therefore correctly failed. [Kimi's ACP turn-end handler](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.2.0/packages/acp-server/src/session.ts) translates recognized authentication errors, but this internal OAuth failure was not surfaced as one. Host does not inspect private native session logs to manufacture a transport error.

The remaining real-provider verification requires valid native credentials. No prior version's evidence is relabeled for these targets. Full-repository deterministic and independent archive-consumer results are reported separately by the upgrade integration.
