# Capability evidence — alpha.7

Date: **2026-10-12**. Runtime: **macOS arm64, Node.js 24.18.0**. Kernel pins are unchanged from the [support matrix](kernel-support.md). The alpha.7 follow-up is tracked by [issue #18](https://github.com/Olorinm/agent-host/issues/18). No Kernel version changed.

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
| PDF text extraction | Claude native document blocks, OpenCode's configured native provider, Hermes native PDF rendering/analysis; Kimi native `pdftotext` with a scoped approval; OpenClaw native `pdf` tool and bundled document extractor |
| Video interpretation | OpenClaw native media pipeline with a configured CLI entry invoking the locally authenticated Kimi native media reader |
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
- Actual native records exposed missing common tool projections: Claude assistant/user tool blocks, Pi tool execution events and Hermes `tool.complete`. Their native call IDs and lifecycle now have common events; regressions use the observed native shapes.

## Bounds of the evidence

Simple image/PDF probes are not exhaustive media certification. Hermes generic files, Codex audio, negotiated ACP audio/resources and native image tool-result paths also have byte-level contract coverage. These do not certify every format or provider.

The original Kimi PDF failure was caused by the probe refusing its extraction command. The follow-up accepts only the complete `pdftotext` command for the synthetic attachment, recovered from the matching native tool event. Kimi emits its final structured `rawInput` after asking permission, but already supplies complete JSON tool arguments in the preceding content update. The probe checks those complete arguments; it does not approve from the truncated permission title. PDF extraction then succeeds.

OpenClaw's earlier PDF/video failures were caused by incomplete probe configuration. Enabling its `pdf` tool and bundled `document-extract` plugin produces the expected PDF text. Its video pipeline also succeeds with a native `tools.media.models` CLI entry calling Kimi's `ReadMediaFile` using existing local authentication. This certifies that configured native pipeline, not an unconfigured Gateway or every video provider. No Host transcription/video loop is involved. The earlier substring false positive (`configured` contains `red`) remains a reminder to use whole-word assertions and review actual replies.

Codex's available model list declares `text,image` and contains no audio-capable model. Direct native speech interpretation is therefore not certified with that account. This is a model prerequisite, not an unimplemented Host operation, and no transcript is fabricated to hide it.

### Live interactions and settings

The follow-up uses `scripts/probe-native-scenarios.mjs` through the public HTTP client. A real MCP server (`scripts/probe-elicitation-server.mjs`) requests forms and URLs and records the exact replies received from the native engine. The forms contain a random string, integer, boolean and string array; assertions compare that native receipt, not a model's claim that the operation worked.

| Check | Native result |
| --- | --- |
| Form accept / decline / cancel | Codex and Claude: all three exact replies received by the MCP server |
| URL accept / decline / cancel | Codex and Claude: all three exact replies received; synthetic URL requires no browsing/login |
| Session-scoped MCP approval | Codex: two tool calls in one session require one approval, while both forms still reach the product |
| Native question and returned answer | Claude `AskUserQuestion`, Kimi ACP form elicitation, Hermes `clarify` |
| Pi native tool policy | Accept executes the callback exactly once; decline and cancel execute it zero times |
| OpenClaw native exec approval | Accept creates a synthetic file; decline/cancel leave it absent; requests are correlated to the active native session/run |
| Selected model / turn settings | All seven complete live HTTP turns using owner-whitelisted settings; details below |

Settings exercised: Codex model, low effort and JSON output schema; Claude model, low effort, disabled thinking, turn limit and structured output; Pi model and disabled thinking; Kimi model, low effort and native config selector; OpenCode model; Hermes model, provider and disabled reasoning; OpenClaw model and per-turn disabled thinking. Codex/Claude structured outputs are checked against a random receipt. ACP returns the selected configuration; Pi's native conversation configuration and Hermes's native session-info are inspected. OpenClaw's model selection is checked against native session state; per-turn thinking is not incorrectly asserted to persist as a session setting. This does not claim every possible setting/value/provider combination.

OpenCode and Kimi's pinned **MCP clients** reject generic MCP form/URL elicitation before sending it to Host. This was observed using the real test MCP server. Kimi's own native question tool does emit ACP form elicitation and passes the end-to-end test. These are different native paths; absence of the former is not recorded as an outstanding Host implementation task.

### Host regressions fixed by the follow-up

- Codex can encode MCP tool approval as an elicitation form carrying `_meta.codex_approval_kind`. It is now presented as an approval, with only the native persistence choices. Ordinary forms stay forms; selecting session scope round-trips as native `_meta.persist`.
- Claude's elicitation callback no longer converts `cancel` into `decline`. The actual MCP server receives the original decision.
- OpenClaw connections declare `exec-approvals` as well as approval scope. Without that delivery capability, Gateway rejected commands as headless before Host could receive the prompt.
- OpenClaw approval choices now honor native `allowedDecisions` and `unavailableDecisions`; an unavailable permanent approval is not offered.

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

For document, audio or video checks, pass `--media-cases /absolute/path/cases.json`. The JSON array contains `{name, kernels, file, mediaType, prompt, expectedText}` for each local test file. Each case runs in a fresh native conversation; its answer must contain the complete words/phrase in `expectedText` (case-insensitive, ignoring punctuation/whitespace). Do not include the expected answer in the prompt. Select a case with `--checks media:pdf`, for example. Review answers before making certification claims. Synthetic fixtures and the selected model/media configuration belong to the operator; the runner never installs transcription or video dependencies.

For focused scenarios, the trusted setup module additionally exports `scenarios(profile)`, returning cases with `name`, `input`, optional `settings`, `attachments`, `tools`, `onInteraction`, and a required `verify({run, events, interactions, client, sessionId})` function. Select cases without rerunning unrelated lifecycle prerequisites:

```sh
node scripts/probe-native-scenarios.mjs \
  --profiles /absolute/path/local-scenarios.mjs \
  --out .local/scenarios.json --only codex,claude --cases form-accept,form-cancel
```

Each case gets a new Host/native session. Completion alone is never a pass: verification must assert the expected native receipt or side effect. A failed observer is cancelled before the runner proceeds. The existing HTTP lifecycle runner accepts an optional trusted `setup.onInteraction(request, {profile, events, ...context})` hook for narrowly scoped test approvals; its default remains refusal. These hooks are operator code, never HTTP-supplied permissions. Reports and native receipts remain private; share only reviewed summaries.
