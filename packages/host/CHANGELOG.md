# Changelog

Notable changes to Agent Host, newest first. Each version has a GitHub Release with the same notes
and the package archive. When releasing, add the new section here in the version-bump commit; the
Release notes are copied from it.

## [0.1.0-alpha.14] - 2026-11-05

- The command relay waits up to five seconds for Codex to report the running command before it
  refuses with `relay_command_not_running`. Codex starts the process before it sends the
  `item/started` notification, so relays were refused in production. The binding is unchanged.

PR: [#39](https://github.com/Olorinm/agent-host/pull/39)

## [0.1.0-alpha.13] - 2026-11-05

- Command relay. `POST /v1/relay` lets a connector CLI started from the Agent's own shell call the
  run's product tools. Each call is bound to the running Codex command (`CODEX_THREAD_ID` /
  `CODEX_TOOL_CALL_ID`) and goes through the run's CallBroker, so the product's grants and
  approvals still apply.
- New `agent-host-relay` bin: the client inside the sandbox, installed under a CLI's name (`gws`,
  `lark-cli`).

PR: [#38](https://github.com/Olorinm/agent-host/pull/38)

## [0.1.0-alpha.12] - 2026-11-05

- Durable native history. Completed Codex items are kept for the whole run. Streaming deltas, and
  their `assistant.delta` / `reasoning.delta` projections (marked `transient`), are live-only and
  dropped when the run finishes, as in Codex rollouts.
- Event pages report `historyTruncated` (durable events lost) separately from the new `liveGap`
  (replaced fragments gone). Adds `durableEventLimit`.
- Pins Codex 0.166.0, after comparing its schema and testing it natively.

PRs: [#34](https://github.com/Olorinm/agent-host/pull/34), [#36](https://github.com/Olorinm/agent-host/pull/36)

## [0.1.0-alpha.11] - 2026-10-30

- Aligned with Codex 0.165.0's native capabilities:
  - an audited inventory of app-server methods and a protocol manifest;
  - native thread management through the common API;
  - attached transports;
  - native error payloads.
- Removed the retired Pi and OpenCode compatibility paths.

PR: [#33](https://github.com/Olorinm/agent-host/pull/33)

## [0.1.0-alpha.10] - 2026-10-21

- Refreshed native harness pins: Claude Agent SDK 0.3.300, Pi 1.2.0, Kimi Code 2.2.0, Codex
  0.162.1, and OpenCode moved to `@opencode/cli` 2.0.29.
- Aligned the seven harness adapters with their native sessions and capabilities: canonical Hermes
  ACP with a stable MCP transport, OpenCode v2 operations, current Claude and Pi contracts, and
  OpenClaw controls. Upstream limits are tracked in issue #29.
- Project code is licensed under MIT.
- Agent UI moved to its own repository, [Olorinm/agent-ui](https://github.com/Olorinm/agent-ui).

PRs: [#28](https://github.com/Olorinm/agent-host/pull/28), [#30](https://github.com/Olorinm/agent-host/pull/30), [#31](https://github.com/Olorinm/agent-host/pull/31), [#32](https://github.com/Olorinm/agent-host/pull/32)

## [0.1.0-alpha.9] - 2026-10-14

- Cloud bootstrap through a ready file, plus the current native Host implementation. The kernel
  behavior is unchanged.

PR: [#26](https://github.com/Olorinm/agent-host/pull/26)

## [0.1.0-alpha.8] - 2026-10-12

- UTF-8 TXT/JSON/CSV resources reach ACP as text instead of unsupported binary media. Binary and
  non-UTF-8 bytes are kept.
- OpenClaw product image results stay outside its text-only catalog wrapper.
- Hermes model, provider and reasoning changes apply through native session settings, without
  losing the conversation.
- Live verification records for all seven kernels on macOS, and for five on Linux arm64 (see
  `docs/native-verification.md`). Reusable synthetic media scenarios.

## [0.1.0-alpha.7] - 2026-10-12

- Codex MCP approvals are recognized as approvals, keeping the native once/session/permanent scope
  choices.
- Claude form and URL elicitation keep cancellation distinct from rejection.
- OpenClaw declares support for exec approval delivery and only offers decisions the native request
  allows.
- Opt-in native HTTP scenarios and a real MCP form/URL probe.

## [0.1.0-alpha.6] - 2026-10-12

- Common approvals, questions, forms, URLs, progress and native tool events.
- Native conversation list, history, fork and deletion where supported, through the embedded and
  HTTP APIs.
- Native settings chosen by the owner, and typed hooks. Compaction on all seven kernels, and
  steering on the five that expose it.
- More native media paths, capability discovery, and `agent-host init` / `doctor` / `run`.
- Install from the release archive without building from source. Archive tests run independently,
  with CI on Linux, macOS and Windows.

PR: [#17](https://github.com/Olorinm/agent-host/pull/17)
