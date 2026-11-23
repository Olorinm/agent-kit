# Kernel support

Integration versions were checked against the official release channels on **2026-11-23**. See the verification notes below for test coverage.

| Kernel | Integration version | Shared integration |
| --- | --- | --- |
| Codex | [0.171.0](https://github.com/openai/codex/releases/tag/rust-v0.171.0) | Native app-server, full-duplex native extension, pagination, skills input, subagent callback attribution, attached transports, native controls |
| Claude Agent | [SDK 0.3.330](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.330), engine 2.1.330 | Native SDK lifecycle and options, session operations, MCP tools, full permission context and request cancellation |
| Pi | [1.6.0](https://github.com/earendil-works/pi/releases/tag/v1.6.0) | Native durable conversations, nested/deferred tools, extension hooks, cancellation, fork, steer, compaction |
| OpenCode | [2.4.0](https://www.npmjs.com/package/@opencode/cli/v/2.4.0) | ACP resume/history/fork/delete, model/config controls, MCP tools, native ACP compaction |
| Kimi Code | [2.7.2](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.7.2) | ACP load/fork/delete, native permission and form elicitation, MCP tools, `/compact` receipt |
| Antigravity | CLI 1.5.15 (`agy acp`) | ACP resume/load/list, model, thinking-level and mode config options, native permission requests, MCP tools. No compaction, steering, fork or delete |
| DeepSeek Harness | `@deepseek-ai/dsh@0.2.2-rc.5` (`dsh acp`) | Native session continuation and list, model and reasoning options, permission requests, MCP tools. No history replay, fork, deletion, steering or compaction |
| Hermes | [0.23.3](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.3) | Explicit canonical ACP or TUI stdio transport; native sessions and MCP, with transport-specific settings and controls |
| OpenClaw | [2026.11.7](https://github.com/openclaw/openclaw/releases/tag/v2026.11.7) | Gateway protocol 4, native sessions/approvals/plugin, fast mode, structured errors and interrupting `chat.send` steer |

## What was exercised

`npm test` uses protocol/SDK/provider fixtures to exercise failure boundaries, concurrency, cancellation, event correlation, interactions and controls. `npm run test:package` installs the archive outside the repository and tests the same editor against all nine adapters, including native Pi persistence with deterministic provider output. These tests do not contact a model provider.

The common interaction helper, selectable settings, native session API, CLI, controls and media paths are covered by these deterministic tests and by the independent archive consumer. OpenClaw's native command approvals reach the common callback with session/run correlation; Pi's native policy hook can be enabled by the HTTP owner.

Model-backed runs against real native installations are separate from these tests. They need native credentials, are not part of CI, and their reports and transcripts are not distributed. A passing deterministic test does not certify a provider, model or platform.

## Upgrade boundaries

- **Pi 1.x is a storage/API generation change.** Conversations use `pi-durable` 1.6. The retired Pi 0.85 adapter and its dependencies are no longer shipped. There is no transcript importer. Pi 1.6 has no supported native delete API; deletion fails explicitly instead of deleting only a Host binding and pretending the conversation was deleted.
- **ACP capabilities are negotiated.** Native `session/resume` is preferred when advertised, otherwise supported `session/load` is used. Historical load notifications are not emitted as the current answer. Unsupported additional directories, images or controls fail explicitly. A protocol specification alone does not imply a Kernel implements a feature.
- **DeepSeek Harness runs `dsh acp`.** Install `npm install --global @deepseek-ai/dsh@0.2.2-rc.5` and configure the official provider with `DEEPSEEK_API_KEY`. The default registry release is a release candidate. Select a model using the ACP menu's value (for example `["deepseek-official","deepseek-v4-pro"]`) or its unique display name. The available reasoning levels depend on the selected model. A local probe ran the official CLI with a deterministic provider through the Host service runtime. Two turns from separate Host runtimes resumed the same native ID, switched models and returned the result of a real Host MCP call. DSH uses `session/resume` for persisted conversations and exposes no ACP history replay.
- **Antigravity is `agy acp` through the shared ACP adapter.** `model` takes an ID of the native model selector (`gemini-4-neon`) or the CLI's ID that carries a thinking level (`gemini-4-neon-high`); `effort` is the native `thought_level` option and is refused when the selected model does not offer it; `config.mode` is the native permission mode (`default`, `accept-edits`, `auto`, `plan`). The server ignores `model` in `session/new`, so Host sets these through `session/set_config_option` on every turn. It asks through `session/request_permission` with `allow`/`deny` option IDs. Auto mode approves edits and safe commands and still asks before each tool of an MCP server, which includes Host product tools; only `args: ["acp", "--dangerously-skip-permissions"]` runs those unasked. Its `/compact` command has no completion receipt that Host verifies, so compaction is reported unsupported. Sign-in is the CLI's own (`agy acp --login`, the OS keyring or its file fallback under `~/.gemini`); Host does not manage it.
- **Hermes has two explicit native transports.** The default TUI stdio path needs a product-owned persistent profile, separates live/durable IDs, and verifies compression/steering receipts. `transport: 'acp'` uses the official canonical Gateway viewer; it negotiates list/history/fork/resume/images and preserves frozen MCP configuration, but has no confirmed compact/delete/steer path. Closing this viewer does not stop the shared authority. Native identity is not migrated between transports.
- **OpenClaw product tools use its official plugin API.** They require a local Gateway plus the bundled plugin. The browser-only `toolBindings` route is not impersonated. Product names are arguments to one manifest-declared native tool. Scoped leases, tokens and native invocation guards limit callbacks to the active product turn. A deleted bound native session fails instead of being recreated.
- **Claude remains the native SDK.** Stable instructions and per-turn product context are separate. The complete product JSON Schema reaches MCP; enums, bounds and nested constraints are not flattened into a permissive schema.
- **Codex uses native receipts and native controls.** Compaction may return an empty acknowledgement; completion comes from its correlated events. Early native requests are correlated before the start acknowledgement arrives.

The package does not replace global CLIs, migrate personal login state or provision remote sandboxes. Native installations and authentication remain explicit environment responsibilities. See [API](api.md).

## Media through the HTTP service

The service preserves attachment bytes and workspace paths for all nine runtimes. Codex, Claude, Pi and OpenClaw have native image input paths; ACP negotiates image/audio/resource input; Hermes uses native image/PDF/file attachment operations. Claude also accepts native PDF document blocks, and Codex accepts native audio items. HTTP fixtures verify bytes at these boundaries and image tool results; installed-consumer tests verify image submission and binary file read/write. Whether a model understands a given attachment depends on the configured provider and model.

See [common API](common-api.md) for native list/history/fork/delete, interaction helpers, settings and controls, and [quickstart](quickstart.md) for installation and readiness diagnostics.
