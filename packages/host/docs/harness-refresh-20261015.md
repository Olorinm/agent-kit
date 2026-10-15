# Native harness refresh — 2026-10-15

Tracked by [issue #29](https://github.com/Olorinm/agent-host/issues/29). Stable release/package metadata was checked on 2026-10-15. The Host keeps a shared turn, product-tool, interaction, progress and session boundary while preserving each harness's native execution loop, storage, approvals and extension mechanisms.

## Targets and integration changes

| Harness | Target | Integration work |
| --- | --- | --- |
| Codex | 0.162.1 | Refresh the native CLI pin and verify the unchanged app-server integration. |
| Claude | SDK 0.3.300 / engine 2.1.300 | Preserve native permission metadata, callback cancellation, source identity and initialization version. Native SDK options remain available. |
| Pi | 1.2.0 | Adapt the native `output` result contract, nested tool receipts, deferred tool registration, native argument repair and storage failure semantics. Keep the explicit 0.85 compatibility adapter. |
| OpenCode | `@opencode/cli` 2.0.29 | Replace the V1 development CLI package; use V2 ACP compaction/history/delete, preserve directory grants and child events, and retain an explicit V1 HTTP fallback. |
| Kimi | 2.2.0 | Preserve native ACP commands/configuration, ordered compression receipts and effective capabilities; reject unsupported binary resources explicitly. |
| Hermes | 0.22.1 | Add the official canonical ACP viewer alongside TUI stdio, stable product MCP configuration, transport-specific capabilities, TUI fast mode and whole-history branch. |
| OpenClaw | 2026.10.3 | Preserve protocol negotiation and structured errors, native fast mode and interrupting `chat.send`; treat advertised methods as positive evidence rather than an exhaustive catalog. |

Claude and Pi are pinned runtime dependencies. Codex, OpenCode and Kimi are pinned development CLIs for opt-in verification; consumer installations remain environment-owned. Hermes and OpenClaw are external native installations. This source refresh does not replace global CLIs, migrate personal configuration, publish a release or replace running cloud images.

Codex's [0.162.1 release](https://github.com/openai/codex/releases/tag/rust-v0.162.1) repairs multiline asynchronous TUI questions and daemon/CLI feature compatibility. The tagged comparison with 0.162.0 changes no app-server protocol surface requiring a new Host abstraction. Existing native thread/turn options, tools, approvals, steering and compaction remain the integration path.

Detailed upstream source review and per-case limits:

- [Claude and Pi](upgrade-claude-pi-20261015.md)
- [OpenCode and Kimi ACP](upgrade-acp-20261015.md)
- [Hermes and OpenClaw](upgrade-gateways-20261015.md)

## Shared boundary

OpenCode, Kimi and Hermes canonical ACP reuse one service transport implementation. Discovery retains native initialization and supported operations, including owner-disabled resume. It does not equate the protocol specification with actual harness support. Session context occupancy remains distinct from turn token usage; non-USD cost is not labeled USD. Child-native output stays separate from the parent answer.

Hermes selects `transport: 'acp'` explicitly. The service's private connection-file bridge keeps its native MCP descriptor stable while rotating the active local endpoint/token after Host restart. Embedded consumers can inject the same caller-owned provider. No frozen native configuration is bypassed. Native forks retain the original configuration identity. The native authority and its admissions stay in Hermes; closing a viewer does not stop the daemon.

Native extensions remain available through typed adapter options and trusted service-owner configuration. Claude subagents/hooks, Pi codemode/tool-search/structured output, ACP commands and OpenClaw plugins are not reimplemented or exposed as arbitrary executable HTTP input. Common capabilities represent implemented operations; native-only behavior remains native.

## Verification and limits

Current native probes ran on **macOS arm64 / Node.js 24.18.0** in isolated synthetic workspaces. They did not use business source or personal conversation contents. Authentication and raw logs remain in ignored local state. Historical alpha.6/alpha.8 Linux and cross-platform evidence remains separately dated in [native verification](native-verification.md).

| Native target | Current evidence |
| --- | --- |
| Codex 0.162.1 | Model-backed namespaced product tool, native identity/recall after adapter restart and correlated compaction receipt passed. All eight HTTP lifecycle checks also passed: discovery, turn, restart/recall, history, list, fork/recall, compaction and recall after compaction/restart. |
| Claude 0.3.300 / 2.1.300 | Eight model-backed HTTP lifecycle checks plus native Bash allow/deny and typed MCP form: 11 passed. |
| Pi 1.2.0 | Eight model-backed HTTP lifecycle checks plus nested product call, denied child and official codemode: 11 passed. Live deferred-tool search was blocked by provider content policy; its actual-harness deterministic-provider test passed. |
| OpenCode 2.0.29 | Actual CLI with local deterministic provider passed turn, restart/recall, history/list, fork/recall, delete, compact and continuation after compact. Real Google provider refused the existing API key; live-provider behavior remains unverified. Newly attached product tools can be missing from the first Code Mode catalog due to an upstream refresh race; later-turn success/denial/cancellation passed. See the ACP review. |
| Kimi 2.2.0 | Actual CLI with local deterministic provider passed the same lifecycle checks. Existing native login refresh grants were invalid, so real-provider checks could not pass. First-turn product tool success/denial/cancellation also passed with that provider. Its ACP transport can emit empty `end_turn` while the native wire records an internal provider failure; Host does not infer private-wire errors. |
| Hermes 0.22.1 TUI | Model-backed product tool, fast mode, restart/recall, list/history and whole-history native fork passed. |
| Hermes 0.22.1 canonical ACP | Model-backed product tools before/after Host replacement and after native fork, unchanged native identity/recall and history passed. Native list omits freshly created canonical `source=local` rows; Host returns its result unchanged. ACP lacks a verifiable compaction receipt and common delete/steer. |
| OpenClaw 2026.10.3 | Model-backed product plugin, protocol 4 negotiation, native fast-mode forwarding, restart/recall, history and native interrupt steering passed. |

These results do not certify every model, provider, native extension or operating system. A native operation is reported complete only from its transport's receipt. Unsupported operations fail explicitly without replacing the native conversation.

Local deterministic validation passed **162/162** tests with the standard `npm test` command. Independent Host archive consumption passed, including the public TypeScript transport/provider contracts. The separate Agent UI consumer gate also passed. Commands:

```sh
npm test
npm run test:package
npm run test:ui:package
```

The package gate installs an archive into a separate consumer and tests all seven adapters, CLI/HTTP flows, TypeScript contracts, Hermes canonical exports and OpenCode 2 session operations. The UI gate installs the separate pinned Agent UI release alongside this Host archive and exercises browser approval/tool/cancel/media behavior. These gates use deterministic fixtures and are separate from native model-backed probes.
