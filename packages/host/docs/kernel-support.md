# Kernel support

**Codex update, 2026-10-29:** the current Codex integration pin is **0.165.0**.
The [complete native protocol audit](codex-native-capability-audit.md) separates
full-duplex wire coverage from isolated native tests using a deterministic local
provider, and from features requiring real accounts, platforms or services.
The 2026-10-15 evidence below remains the baseline for the other kernels.

Stable targets checked on **2026-10-15**. These are explicit integration pins, not a promise that future releases are compatible. The [refresh evidence](harness-refresh-20261015.md) separates current macOS arm64 / Node.js 24 native probes from deterministic tests and historical evidence. OpenCode/Kimi's current real-provider probes are blocked by invalid existing credentials; actual native CLI tests with a local deterministic provider are separate. Earlier Linux and three-platform CI results in [native verification](native-verification.md) retain their original versions and dates.

| Kernel | Tested version | Shared integration |
| --- | --- | --- |
| Codex | [0.165.0](https://github.com/openai/codex/releases/tag/rust-v0.165.0) | Native app-server, full-duplex native extension, pagination, skills input, subagent callback attribution, attached transports, native controls |
| Claude Agent | [SDK 0.3.300](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.300), engine 2.1.300 | Native SDK lifecycle and options, session operations, MCP tools, full permission context and request cancellation |
| Pi | [1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0) | Native durable conversations, nested/deferred tools, extension hooks, cancellation, fork, steer, compaction |
| OpenCode | [2.0.29](https://www.npmjs.com/package/@opencode/cli/v/2.0.29) | ACP resume/history/fork/delete, model/config controls, MCP tools, native ACP compaction |
| Kimi Code | [2.2.0](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.2.0) | ACP load/fork/delete, native permission and form elicitation, MCP tools, `/compact` receipt |
| Hermes | [0.22.1](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.1) | Explicit canonical ACP or TUI stdio transport; native sessions and MCP, with transport-specific settings and controls |
| OpenClaw | [2026.10.3](https://github.com/openclaw/openclaw/releases/tag/v2026.10.3) | Gateway protocol 4, native sessions/approvals/plugin, fast mode, structured errors and interrupting `chat.send` steer |

## What was exercised

The earlier alpha.6/alpha.8 independent editor probes passed for all seven Kernels at their previous pins. Those results are historical; they are not relabeled as evidence for this refresh. Current per-harness results and limits are in [refresh evidence](harness-refresh-20261015.md). Credentials and transcripts are not distributed.

`npm test` uses protocol/SDK/provider fixtures to exercise failure boundaries, concurrency, cancellation, event correlation, interactions and controls. `npm run test:package` installs the archive outside the repository and tests the same editor against all seven adapters, including native Pi persistence with deterministic provider output. These tests do not contact a model provider.

Alpha.6 adds live HTTP coverage for all seven Kernels: text, native identity and recall after Host restart, native history/list, receipt-based compaction and image input. Native fork/delete and product-tool/control results are itemized in the [versioned evidence matrix](native-verification.md). The exact native operation and failure receipt are preserved; these results do not certify every provider or model.

The common interaction helper, selectable settings, native session API, new CLI, controls and additional media paths have deterministic regression tests and independent archive-consumer checks. These are separate from native execution. OpenClaw's native command approvals now reach the common callback with session/run correlation; Pi's native policy hook can be enabled by the HTTP owner. Alpha.8 additionally verifies 76 macOS media/setting cases and 23 Linux continuation/media cases, including every selectable setting key and setting changes within all seven native sessions; values and limits are recorded in the evidence matrix. Every provider/format/value combination is not implied.

## Upgrade boundaries

- **Pi 1.x is a storage/API generation change.** Conversations use `pi-durable` 1.2. The retired Pi 0.85 adapter and its dependencies are no longer shipped. There is no transcript importer. Pi 1.2 has no supported native delete API; deletion fails explicitly instead of deleting only a Host binding and pretending the conversation was deleted.
- **ACP capabilities are negotiated.** Native `session/resume` is preferred when advertised, otherwise supported `session/load` is used. Historical load notifications are not emitted as the current answer. Unsupported additional directories, images or controls fail explicitly. A protocol specification alone does not imply a Kernel implements a feature.
- **Hermes has two explicit native transports.** The default TUI stdio path needs a product-owned persistent profile, separates live/durable IDs, and verifies compression/steering receipts. `transport: 'acp'` uses the official canonical Gateway viewer; it negotiates list/history/fork/resume/images and preserves frozen MCP configuration, but has no confirmed compact/delete/steer path. Closing this viewer does not stop the shared authority. Native identity is not migrated between transports.
- **OpenClaw product tools use its official plugin API.** They require a local Gateway plus the bundled plugin. The browser-only `toolBindings` route is not impersonated. Product names are arguments to one manifest-declared native tool. Scoped leases, tokens and native invocation guards limit callbacks to the active product turn. A deleted bound native session fails instead of being recreated.
- **Claude remains the native SDK.** Stable instructions and per-turn product context are separate. The complete product JSON Schema reaches MCP; enums, bounds and nested constraints are not flattened into a permissive schema.
- **Codex uses native receipts and native controls.** Compaction may return an empty acknowledgement; completion comes from its correlated events. Early native requests are correlated before the start acknowledgement arrives.

The package does not replace global CLIs, migrate personal login state or provision remote sandboxes. Native installations and authentication remain explicit environment responsibilities. See [API](api.md) and [Rivet backend decision](rivet.md).

## Media through the HTTP service

The service preserves attachment bytes and workspace paths for all seven runtimes. Codex, Claude, Pi and OpenClaw have native image input paths; ACP negotiates image/audio/resource input; Hermes uses native image/PDF/file attachment operations. Claude also accepts native PDF document blocks, and Codex accepts native audio items. HTTP fixtures verify bytes at these boundaries and image tool results; installed-consumer tests verify image submission and binary file read/write. Native image probes and other media verification limits are recorded separately in [native verification](native-verification.md).

See [common API](common-api.md) for native list/history/fork/delete, interaction helpers, settings and controls, and [quickstart](quickstart.md) for installation and readiness diagnostics.
