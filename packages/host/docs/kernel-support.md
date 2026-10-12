# Kernel support

Native versions pinned on **2026-10-09**, with integration probes repeated on **2026-10-12**. These are tested pins, not a promise that future releases are compatible. Native probes ran on macOS arm64 / Node.js 24; CI is configured for deterministic contract and archive-consumer tests on Linux, macOS and Windows. Native execution on Linux/Windows has not been certified.

| Kernel | Tested version | Shared integration |
| --- | --- | --- |
| Codex | [0.162.0](https://github.com/openai/codex/releases/tag/rust-v0.162.0) | Native app-server, tool groups, permissions/questions, cancellation, steer, compaction |
| Claude Agent | [SDK 0.3.295](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.295), engine 2.1.295 | SDK query lifecycle, native resume/history/fork/delete, MCP tools, common interactions, streaming steer and native compaction |
| Pi | [1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0) | Native durable conversations, model/tool extension hooks, cancellation, fork, steer, compaction |
| OpenCode | [1.18.35](https://github.com/anomalyco/opencode/releases/tag/v1.18.35) | ACP initialization, native resume, model/config controls, MCP tools, native summarize bridge |
| Kimi Code | [2.1.1](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.1.1) | ACP, native load, native permission and form elicitation, MCP tools, `/compact` receipt |
| Hermes | [0.21.6](https://github.com/NousResearch/hermes-agent/releases/tag/v0.21.6) | Native TUI Gateway, durable/live ID separation, MCP tools, modern approval/questions, compression and steering receipts |
| OpenClaw | [2026.9.9](https://github.com/openclaw/openclaw/releases/tag/v2026.9.9) | Gateway protocol 4, canonical session bindings, correlated streams, cancellation, model selection, compaction, optional product-tool plugin, native exec approvals and interrupting steer |

## What was exercised

The independent editor's **native model-backed probes passed for all seven Kernels**: rejected edits preserve the file, approved edits save it, and a newly constructed adapter resumes the native conversation and recalls the earlier decision. Codex uses an existing native login; Claude, Pi, Hermes and OpenClaw were tested with an Anthropic-compatible route; OpenCode with configured model routes; Kimi with its native authenticated configuration. Credentials and transcripts are not distributed.

`npm test` uses protocol/SDK/provider fixtures to exercise failure boundaries, concurrency, cancellation, event correlation, interactions and controls. `npm run test:package` installs the archive outside the repository and tests the same editor against all seven adapters, including native Pi persistence with deterministic provider output. These tests do not contact a model provider.

Alpha.6 adds live HTTP coverage for all seven Kernels: text, native identity and recall after Host restart, native history/list, receipt-based compaction and image input. Native fork/delete and product-tool/control results are itemized in the [versioned evidence matrix](native-verification.md). The exact native operation and failure receipt are preserved; these results do not certify every provider or model.

The common interaction helper, selectable settings, native session API, new CLI, controls and additional media paths have deterministic regression tests and independent archive-consumer checks. These are separate from native execution. OpenClaw's native command approvals now reach the common callback with session/run correlation; Pi's native policy hook can be enabled by the HTTP owner. Alpha.8 additionally verifies 76 media/setting cases, including every selectable setting key and setting changes within all seven native sessions; values and limits are recorded in the evidence matrix. Every provider/format/value combination is not implied.

## Upgrade boundaries

- **Pi 1.1 is a storage/API generation change.** New conversations use `pi-durable`. Existing Pi 0.85 JSONL conversations keep the explicit `compat/pi085` adapter and pinned old native engine. There is no invented transcript importer. Remove this compatibility path only after an upstream-supported migration or deliberate retirement of those conversations. Pi 1.1 has no supported native delete API; deletion fails explicitly instead of deleting only a Host binding and pretending the conversation was deleted.
- **ACP capabilities are negotiated.** Native `session/resume` is preferred when advertised, otherwise supported `session/load` is used. Historical load notifications are not emitted as the current answer. Unsupported additional directories, images or controls fail explicitly. A protocol specification alone does not imply a Kernel implements a feature.
- **Hermes uses a product-owned persistent profile.** `session_id` is a live handle; durable storage IDs are saved for restart. Reloading product MCP tools is allowed only in an exclusive profile. Interrupted sessions with pending native work are not silently replayed. Native `compressed` is required before reporting compaction success; `pending` is not success.
- **OpenClaw product tools use its official plugin API.** They require a local Gateway plus the bundled plugin. The browser-only `toolBindings` route is not impersonated. Product names are arguments to one manifest-declared native tool. Scoped leases, tokens and native invocation guards limit callbacks to the active product turn. A deleted bound native session fails instead of being recreated.
- **Claude remains the native SDK.** Stable instructions and per-turn product context are separate. The complete product JSON Schema reaches MCP; enums, bounds and nested constraints are not flattened into a permissive schema.
- **Codex uses native receipts and native controls.** Compaction may return an empty acknowledgement; completion comes from its correlated events. Early native requests are correlated before the start acknowledgement arrives.

The package does not replace global CLIs, migrate personal login state or provision remote sandboxes. Native installations and authentication remain explicit environment responsibilities. See [API](api.md) and [Rivet backend decision](rivet.md).

## Media through the HTTP service

The service preserves attachment bytes and workspace paths for all seven runtimes. Codex, Claude, Pi and OpenClaw have native image input paths; ACP negotiates image/audio/resource input; Hermes uses native image/PDF/file attachment operations. Claude also accepts native PDF document blocks, and Codex accepts native audio items. HTTP fixtures verify bytes at these boundaries and image tool results; installed-consumer tests verify image submission and binary file read/write. Native image probes and other media verification limits are recorded separately in [native verification](native-verification.md).

See [common API](common-api.md) for native list/history/fork/delete, interaction helpers, settings and controls, and [quickstart](quickstart.md) for installation and readiness diagnostics.
