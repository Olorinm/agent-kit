# Capability evidence — alpha.6

Date: **2026-10-12**. Runtime: **macOS arm64, Node.js 24.18.0**. Kernel pins are unchanged from the [support matrix](kernel-support.md). This is an integration update, not another upstream upgrade.

## Evidence levels

1. `npm test`: deterministic native-protocol/SDK seams, real Pi durable storage with a deterministic provider, actual Claude SDK session-store operations, HTTP lifecycle and failure boundaries.
2. `npm run test:package`: packs an archive, installs it outside the repository, compiles a TypeScript consumer and exercises all seven adapters plus CLI/browser HTTP consumption. New checks cover common interactions, discovery, selected settings, history/fork/delete and personal CLI.
3. `scripts/probe-native-http.mjs`: opt-in actual native processes, authenticated local profiles, model requests and public HTTP client. No mock provider. Reports, native IDs, credentials and transcripts remain local. Results below are distinct from fixture/CI evidence.

## Live HTTP checks

The probe creates isolated Host state and test sessions, asks the model to retain a random marker, restarts Host, and verifies native identity and recall. It reads native history/list results, forks natively and verifies child recall. Supported child sessions are natively deleted; Pi deliberately skips deletion. Image verification asks for the dominant color of a generated image. Product-tool callbacks return test receipts without modifying external systems.

| Capability | Native coverage |
| --- | --- |
| Text, native identity, Host restart and recall | Codex, Claude, Pi, OpenCode, Kimi, Hermes, OpenClaw |
| Native list/history | All seven |
| Native fork and child recall | All seven; OpenClaw uses a selected native user-message entry ID |
| Native delete of the test child | Codex, Claude, OpenCode, Kimi, Hermes, OpenClaw; Pi has no native delete API |
| Native compaction completion | All seven, including Pi's confirmed no-op result |
| Image bytes and model answer | All seven, with the configured native model or native media tools |
| Product callback accept/reject/cancel | Codex, Claude, Pi, OpenCode, Kimi, Hermes and OpenClaw |
| Active-turn steer | Codex, Claude, Pi, Hermes and OpenClaw |

Codex uses its existing native login. Kimi uses its native authenticated configuration. Claude/Pi/Hermes/OpenClaw use an existing local Anthropic-compatible route; OpenCode uses a configured native provider. OpenCode's test profile has its own native database and explicit model modalities. Hermes uses a dedicated native home; OpenClaw uses a dedicated local Gateway with the bundled product-tool plugin. No personal configuration or global installation is modified by the probe.

## Failures found and corrected by these probes

- Pi's native compaction can settle successfully with no summary to place. This is now a successful no-op, not `compaction_not_confirmed`.
- Kimi reports completed compaction even when a small transcript's summary is larger. The actual native receipt now determines completion, not an assumed token decrease.
- Hermes history requires the live handle for a durable session. Host now resolves/resumes that handle. Compaction rotation also updates the saved durable binding.
- An existing OpenCode database was incompatible with the tested executable. Isolated native test state resolved the environment conflict; this was not hidden as an adapter fix. Custom model image capability also needs native model configuration.
- OpenClaw has native `sessions.steer` with interrupt-and-replace semantics. Host tracks the replacement run and buffers events that arrive before its acknowledgement.
- OpenClaw forks change native storage identity without changing the source configuration. Bindings now retain the original configuration identity, including after restart and nested forks. Continued native turns still reject genuine configuration changes.

## Bounds of the evidence

Simple image probes are not exhaustive vision certification. Claude PDF, Hermes PDF/file, Codex audio, negotiated ACP audio/resource and native image tool-result paths have byte-level contract coverage; this does not certify every format or provider's speech/video/document interpretation. Common native approval scopes, permission grants, multi-question replies, JSON forms/URLs and OpenClaw correlated exec approval have deterministic tests. They are not all independently forced through every live model.

Linux/macOS/Windows CI runs deterministic tests and independent archive installation. That is not native login/model certification on Linux or Windows. Pi's discovery response is a static description, not a native server handshake. A live marker probe is what establishes model access for its configured provider.

## Repeat the opt-in probe

Create a private trusted JS module exporting an async setup function that returns `{profiles, close?}`. Profiles use `NativeRuntimeConfig`; `close` stops any dedicated Gateway you started. Keep credentials in existing native configuration or environment variables.

```sh
npm run build
node scripts/probe-native-http.mjs \
  --profiles /absolute/path/local-profiles.mjs \
  --out .local/native-report.json \
  --media /absolute/path/test-red.png --controls --interactions
```

`--only codex,claude` limits the selected profiles. `--checks history,fork,compact` selects additional checks while retaining the initial turn/restart prerequisites. The report distinguishes static discovery from native handshake, retains capability descriptions and records checks independently. It stores short errors, not native transcripts or credentials. Inspect/redact reports before sharing them; do not commit machine-local logs. For a single explicit readiness check use `agent-host doctor --config host.json --probe`.

For document, audio or video checks, pass `--media-cases /absolute/path/cases.json`. The JSON array contains `{name, kernels, file, mediaType, prompt, expectedText}` for each local test file. Each case runs in a fresh native conversation; its answer must contain `expectedText` (case-insensitive). Do not include the expected answer in the prompt. Select a case with `--checks media:pdf`, for example. Synthetic fixtures and the selected model/media configuration belong to the operator; the runner never installs transcription or video dependencies.
