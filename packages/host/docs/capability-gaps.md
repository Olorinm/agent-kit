# Gap checklist against the core principles

Reviewed **2026-10-12**, implemented in **0.1.0-alpha.6**, tracked by [issue #16](https://github.com/Olorinm/agent-host/issues/16). This closes the seven integration workstreams from the alpha.4/alpha.5 review. It does not claim that every Kernel has the same native functions or that every provider, media format and operating system has been certified.

The principle remains: **preserve native capabilities, make their use consistent, and keep differences visible**. Native storage, execution, permissions and model loops are not reimplemented by Host.

| Original gap | Implementation | Verification / boundary |
| --- | --- | --- |
| 1. Media beyond byte transport | Native images for all seven paths; Codex audio; Claude PDF blocks; Hermes image/PDF/file attachment APIs; negotiated ACP audio/resources; OpenClaw native media payloads. | Tests assert bytes at the native boundary. Live image probes and explicit media/provider limits are recorded in [native verification](native-verification.md). Audio/video/document understanding remains provider/native-tool dependent. |
| 2. Capability discovery | Shared descriptions plus explicit `/runtimes/discover`, real ACP negotiation, Codex models/account readiness, Claude initialization, Hermes capabilities, OpenClaw version/methods. | Static descriptions, native handshakes and actual model execution are separate evidence. Pi has no read-only server handshake and is labelled accordingly. |
| 3. Too much product-side translation | Typed `onInteraction` covers approvals/scopes, permission grants, questions, forms and URLs; common reasoning/usage/native-tool events; raw native payloads and replies retained. Pi policy and OpenClaw exec approvals are wired. | Common helper, adapter, HTTP and installed-consumer tests cover translation, unknown requests, cancellation and session correlation. Raw escape hatches remain for native forms with no faithful common representation. |
| 4. Controls/settings differ between access modes | Claude streaming steering and receipt-based compaction; OpenClaw native steering/replacement-run tracking; all seven compaction routes; owner-selected settings; typed owner hooks including Pi extensions and ACP config. | Actual native controls are tested separately from transport. Pi native no-op compaction succeeds explicitly; Kimi completion does not require token reduction. HTTP callers cannot supply executable code, credentials or permission policies. |
| 5. Native session management missing | Common native list/history/fork/delete and separate Host binding list in adapters and HTTP. Native forks preserve storage identity; deletes preserve Host tombstones. Hermes live/durable IDs and compaction rotation are tracked. | Fixtures, actual SDK/Pi storage operations and live native session probes. Pi delete stays explicitly unsupported by its pinned API; OpenClaw fork requires a native entry ID. |
| 6. First use too manual | GitHub release archive, source-free [quickstart](quickstart.md), `init`, `doctor`, `run`, interactive terminal handlers and restartable personal sessions. | Independent archive installation, CLI first task and resume tests. Local checks, handshake and opt-in model probe are separate. Native installations/login and OpenClaw Gateway/plugin setup remain explicit prerequisites. |
| 7. Evidence too narrow | Versioned [evidence matrix](native-verification.md), reusable opt-in probe runner, more failure-path tests, installed consumer tests and Linux/macOS/Windows CI. | CI is deterministic. Local live probes are macOS arm64; other platforms and provider/media combinations are not implied by passing fixtures. |

## Native and environment limits that remain visible

- **Pi durable 1.1 has no native delete operation.** Host refuses deletion and keeps the binding. It also has no built-in question/elicitation RPC; product tools and native hooks remain available.
- **OpenCode and Kimi's ACP interfaces do not expose a dedicated active-turn steering operation.** Host does not disguise a new prompt or cancellation/replay as native steering. OpenClaw does have native steering, whose interrupt-and-replace semantics are preserved.
- **Not every Kernel exposes generic forms or URL elicitation.** Hermes's native clarify/approval and OpenClaw's exec approval are supported; unsupported elicitation remains distinct from an unanswered or omitted Host callback.
- **Media transport is not universal media understanding.** A configured OpenCode model must declare its modalities; Hermes may use native image/PDF analysis tools; OpenClaw uses its configured media pipeline. The concrete tested combinations are in the evidence matrix. No Host-owned transcription or video model loop is added.
- **Native readiness is not a promise of account/model access.** `doctor --probe` is an explicit provider request; static checks never pretend to establish access.
- **OpenClaw product-tool callbacks currently require a local Gateway.** Arbitrary remote sandbox networking, workspace placement and provider provisioning are environment integrations, outside the current callback bridge.
- **Distribution is a GitHub release archive.** There is no npm-registry package yet. Installation no longer requires cloning/building source.
- **Live certification remains bounded.** macOS arm64 is exercised locally; Linux/macOS/Windows CI verifies deterministic package contracts, not login or live model execution on all platforms. Optional form types and every native setting are not all model-backed certified.

These are documented native/environment or verification boundaries, not features silently replaced with weaker Host behavior. Additional native ports should be added when upstream provides an applicable interface and the same evidence standard can be met.

## Implementation and evidence

- [Interactions](../src/interactions.ts), [progress](../src/progress.ts), [settings](../src/settings.ts), [native sessions](../src/sessions.ts).
- [Runtime composition](../src/service/native-runtimes.ts), [HTTP operations](http-service.md), [common API](common-api.md).
- [Gap regression tests](../test/gaps.test.mjs), [installed consumer](../scripts/test-gaps-package.mjs), [native probe runner](../scripts/probe-native-http.mjs).
- [Kernel pins](kernel-support.md), [scope](scope.md), [CI](../.github/workflows/ci.yml).
