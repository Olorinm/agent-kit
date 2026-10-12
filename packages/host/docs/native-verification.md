# Capability evidence — alpha.8

Date: **2026-10-12**. Runtimes: **macOS arm64 / Node.js 24.18.0** and **Debian 12 Linux arm64 / Node.js 24.21.0**; platform scope is recorded per matrix. Kernel pins are unchanged from the [support matrix](kernel-support.md). The alpha.7 follow-up is tracked by [issue #18](https://github.com/Olorinm/agent-host/issues/18). The alpha.8 attachment/settings matrix is tracked by [issue #20](https://github.com/Olorinm/agent-host/issues/20). No Kernel version changed.

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

## Additional media and setting combinations — alpha.8

**76 distinct model-backed HTTP cases passed on macOS arm64:** 27 media cases, 42 setting/limit cases and seven same-session setting changes. The [reviewed case list](evidence/alpha8-live-matrix.json) contains only kernel, case and verdict; private profiles, native IDs and transcripts are excluded. This matrix exercises all currently caller-selectable setting **keys**, using the configured models and the values below. It does not enumerate the Cartesian product of every provider/model/value.

| Media check | Live result |
| --- | --- |
| Product tool returns an image; model identifies its color | All seven; native callback invoked exactly once |
| Two images in one input; distinguish their colors in order | All seven |
| TXT, JSON and CSV files with Chinese contents and filenames containing spaces | Hermes, OpenCode, Kimi; exact random receipt and UTF-8 text recovered |
| PDF and image in the same input | Claude, OpenCode, Hermes, OpenClaw; exact PDF receipt and correct image color |

Synthetic media is generated by [native-media-scenarios.mjs](../scripts/native-media-scenarios.mjs). Expected receipts/colors are absent from the prompt and filenames. In Codex native code execution, the single image-only dynamic-tool result is exposed as a data-URL string and must be emitted through the native image helper. Hermes uses its native vision tool to inspect image results stored in its cache. Tests allow those native operations. Kimi explicitly approves only the synthetic product-image tool once.

| Kernel | Additional native settings/limits exercised |
| --- | --- |
| Codex | `gpt-6.1-sol` at low/medium/high/xhigh/max/ultra; a second model (`gpt-6-luna`); `serviceTier: null` and `fast`; JSON output schema with exact random receipt and Chinese value |
| Claude | low/medium/high/xhigh/max effort; adaptive, fixed-budget (2048 tokens) and disabled thinking; structured JSON; successful turn/budget limits; actual `error_max_turns` and `error_max_budget_usd` termination |
| Pi | off/minimal/low/medium/high/xhigh/max thinking with a reasoning-capable configured model; native durable agent configuration inspected |
| OpenCode | Model plus low/high native variants; build/plan modes and config selectors; native configuration receipts inspected |
| Kimi | K3 low/high/max; plan/default modes; config thinking selector; K3-256k as a second model; native configuration receipts inspected |
| Hermes | Model/provider and none/low/medium/high/xhigh reasoning; actual session-info inspected |
| OpenClaw | Model and off/minimal/low/medium/high per-turn thinking; model flagged reasoning-capable in native configuration; actual native request and session model inspected |

All seven also complete a second turn with changed settings in the **same native session**, preserving its identity. Codex/Kimi switch models; the other profiles change a thinking/effort setting. Structured output is checked as parsed JSON, limits by native error subtype, ACP by selected config receipts, Pi by its durable agent configuration, Hermes by session-info and OpenClaw by native request/session state. A completed turn without the expected receipt does not pass.

Three integration regressions were found and fixed:

- **ACP text files:** sending JSON/CSV as binary resources made OpenCode's provider reject them as unsupported media. Valid UTF-8 text now uses native text resources with URI/MIME retained. Binary files, invalid UTF-8 and explicitly different encodings keep their original bytes. Regression tests include BOM, CRLF, Unicode and binary preservation.
- **OpenClaw image tool results:** the native compact tool catalog serialized the dispatcher result as JSON text. The plugin now declares the dispatcher `catalogMode: "direct-only"`, the native port for tools whose structured media must remain model-visible. Actual image interpretation passes with default catalog configuration; permissions and invocation guards remain native.
- **Hermes setting changes:** model/provider/effort were included in the immutable binding fingerprint, rejecting a second turn with a new setting. They now use native session-scoped `config.set` with receipts. Product instructions/tools still cannot change silently. Older alpha bindings migrate on their first resume with the original settings; later setting changes preserve the native identity. Native errors/confirmation requirements stop the turn explicitly.

The initial OpenClaw thinking failures were a test-profile error: the configured model had been declared non-reasoning. Correcting that native model flag made all five applicable levels pass. No Host reasoning loop or native permission bypass was added.

## Linux native follow-up — alpha.8

**23 distinct model-backed HTTP cases passed on Debian 12 arm64**, using the installed archive in an isolated Linux container. The [reviewed Linux case list](evidence/alpha8-linux-live-matrix.json) is separate from macOS evidence and deterministic CI.

| Kernel | Live Linux cases |
| --- | --- |
| Codex | Same-session continuation/recall, image tool result, two input images (3) |
| Claude | Same-session continuation/recall, image tool result, two input images, PDF + image (4) |
| Pi | Same-session continuation/recall, image tool result, two input images (3) |
| OpenCode | Same-session continuation/recall, image tool result, two input images, TXT/JSON/CSV, PDF + image (7) |
| Kimi | Same-session continuation/recall, image tool result, two input images, TXT/JSON/CSV (6) |

Continuation checks preserve the native session ID and recover an exact random receipt on the next turn. This particular Linux matrix does not test process-restart recovery or repeat the macOS parameter matrix. Media checks use the same synthetic scenarios and assertions as macOS.

The minimal Linux image initially lacked Git: all three Codex cases stopped at native `thread/start` with `workspace routing discovery failed`. Installing Git and CA certificates allowed all three to pass; this is a native environment prerequisite, not a Host adapter change. Hermes/OpenClaw native execution on Linux and native execution on Windows remain unverified. Three-platform CI covers deterministic contracts and independent archive consumption separately.

## Bounds of the evidence

The alpha.8 matrix now includes live generic-file, ACP text-resource and image tool-result checks. Codex direct audio still lacks a capable model on the tested account. The actual pinned OpenCode/Kimi handshakes do not advertise audio input; negotiated ACP audio has contract coverage for a future/other capable server, not a missing live test for these pins. Media probes do not certify every format or provider.

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

Linux/macOS/Windows CI runs deterministic tests and independent archive installation. The separate Linux native matrix above covers five kernels; CI itself does not establish native login/model access, and Windows native execution remains unverified. Pi's discovery response is a static description, not a native server handshake. A live marker probe is what establishes model access for its configured provider.

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

For focused scenarios, the trusted setup module additionally exports `scenarios(profile)`, returning cases with `name`, `input`, optional `settings`, `attachments`, `tools`, `onInteraction`, and a required `verify({run, events, interactions, client, sessionId})` function. `expectedStatus` defaults to `completed`; use `failed` for an intentional native-limit test and assert the exact native failure receipt in `verify`. Select cases without rerunning unrelated lifecycle prerequisites:

```sh
node scripts/probe-native-scenarios.mjs \
  --profiles /absolute/path/local-scenarios.mjs \
  --out .local/scenarios.json --only codex,claude --cases form-accept,form-cancel
```

Each case gets a new Host/native session. Completion alone is never a pass: verification must assert the expected native receipt or side effect. A failed observer is cancelled before the runner proceeds. The existing HTTP lifecycle runner accepts an optional trusted `setup.onInteraction(request, {profile, events, ...context})` hook for narrowly scoped test approvals; its default remains refusal. These hooks are operator code, never HTTP-supplied permissions. Reports and native receipts remain private; share only reviewed summaries.
