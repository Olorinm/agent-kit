# Implementation gaps against the core principles

Reviewed on **2026-10-12**, against `main` commit `270cff8d4e6d546d1387a6ac93ed001bf70a34f5` (`0.1.0-alpha.4`). This is a source review of the existing integrations, not an exhaustive audit of the latest upstream releases. No additional live model probes were run for this review. Existing evidence and tested versions are in the [support matrix](kernel-support.md).

The [core principles](../README.md#core-principles) set two expectations: preserve native capabilities as fully as possible, and make them straightforward for products and people to use. The items below are gaps and proposed acceptance criteria, not claims that these features are already implemented.

## What is already in place

Seven adapters preserve native execution and conversation identity. Products can submit context and tools, observe progress, cancel work and continue a native conversation through embedded adapters or the HTTP service. Native notifications and several extension hooks remain accessible. Failures to resume, unconfirmed cancellation and uncertain outcomes are reported explicitly.

This is a useful foundation. The remaining work is to preserve more information across each boundary and reduce the differences that every consuming product currently has to handle.

## 1. Media transport and image bridges are implemented; native certification remains

**Updated behavior:** HTTP turns accept bounded base64 attachments, including attachment-only input. The workspace file API supports binary reads/writes. Codex, Claude, Pi 1.1 and OpenClaw receive native image inputs; ACP negotiates its image capability, while Hermes receives workspace files. Native model/tool interpretation remains distinct from file delivery. [Issue #11](https://github.com/Olorinm/agent-host/issues/11) tracks this implementation.

Inline product `inputImage` results retain native image content in Pi (including the explicit 0.85 compatibility adapter), Claude and the shared MCP bridge used by ACP, Hermes and OpenClaw. Remote URLs remain MCP resource links where applicable; Pi reports that it requires inline data instead of converting a URL to text. Model-backed vision, speech and video probes have not been added.

**Evidence:** HTTP fixture tests verify actual media at the native interfaces, not just an HTTP acknowledgement. Independent archive-consumer tests verify image submission and binary read/write. Format and capability errors are explicit; limits and native differences are documented in [media input](http-service.md#media-input). Remaining work is native model-backed certification and any further media types supported by specific Kernels.

Sources: [HTTP contracts](../src/service/protocol.ts), [workspace files](../src/service/files.ts), [runtime composition](../src/service/native-runtimes.ts), [Pi](../src/pi/session.ts), [Claude](../src/claude/session.ts), [shared tool bridge](../src/product-tool-bridge.ts), [HTTP tests](../test/service.test.mjs), [installed HTTP consumer](../scripts/test-http-package.mjs).

## 2. Products cannot query a complete capability description

**Current behavior:** HTTP runtime descriptions advertise availability, `steer` / `compact` and an attachment/image input descriptor. They still do not provide a complete description of native model interpretation, output content, interactions, session operations or extension settings. ACP performs useful native negotiation internally, but that information does not become a complete shared capability description.

**Acceptance:** products can discover supported operations, relevant configuration or environment requirements, and the reason an operation is unavailable before presenting it to a user. Distinguish a missing Host integration from a native limitation or a configuration problem. Record verification evidence separately: an unverified path is not automatically an unsupported path. Embedded and HTTP consumers should use the same descriptions.

Evidence: [RuntimeDescription](../src/service/protocol.ts), [runtime inspection](../src/service/native-runtimes.ts), [ACP negotiation](../src/acp/session.ts).

## 3. Shared usage still requires adapter-specific glue

**Current behavior:** adapters share tool/event types, but the embedded example imports separate Agent classes and selects constructors and settings itself. `createNativeRuntime` already centralizes seven-Kernel composition for the service; the ordinary embedded guide still teaches an adapter-specific entry point. HTTP has a common client, while approvals and questions retain raw native method names and response formats. The browser example handles some forms and declines or leaves others unanswered.

Shared events cover lifecycle, text and tool events, but do not define common usage or reasoning event types. Further details remain in native notifications and require native-specific interpretation by the product.

**Acceptance:** provide a small documented common entry point for routine embedded use, reusing existing composition where appropriate. Supply typed helpers for common progress events, approvals and questions, including choices, scope and cancellation. Preserve native event/request details and an explicit extension path for forms that cannot be represented faithfully. A product should not need its own seven-Kernel constructor switch or protocol translator for basic use.

OpenClaw native command approvals and questions are not currently exposed as common callbacks. Pi uses an embedded `onBeforeTool` hook instead of the common `onRequest` path; the standard HTTP runtime does not wire that hook. These require explicit capability reporting and adapter-specific implementation review, rather than assuming every Kernel has the same permission model.

Evidence: [shared types](../src/agent.ts), [embedded example](../examples/file-editor/editor.mjs), [runtime composition](../src/service/native-runtimes.ts), [HTTP client](../src/service/client.ts), [browser interaction handlers](../examples/http-editor/app.js), [Pi](../src/pi/session.ts), [OpenClaw](../src/openclaw/session.ts).

## 4. HTTP exposes fewer controls and native settings

**Current behavior:** HTTP steering is wired for Codex, Pi and Hermes; compaction is wired for Codex, Pi, Hermes and OpenClaw. Embedded OpenCode/Kimi compaction helpers exist but are not connected to HTTP. Claude has a lower-level native Query entry point, but no dedicated steering or compaction operation in the common adapter/service.

Native extension access also varies. Codex has `thread`/`turn` settings, Claude has native SDK options, Pi has per-run extensions and hooks, and ACP has per-run configuration. Some options are available in programmatic service profiles, but the CLI configuration and common HTTP request expose only a subset. For example, Pi's per-run extensions and thinking level are not forwarded by the standard service runtime.

**Acceptance:** carry already implemented controls into both deployment modes when their lifecycle requirements can be satisfied. Provide explicit, typed native settings under a consistent configuration structure, with runtime capabilities describing what is allowed. Review native APIs before promising additional controls. Execution credentials, commands and trusted extension code remain service-owner configuration; callers may select only options the owner exposes.

Evidence: [service runtime composition](../src/service/native-runtimes.ts), [CLI profiles](../src/service/cli.ts), [ACP compaction helpers](../src/acp/compaction.ts), [Claude Query access](../src/claude/query.ts), [Pi run options](../src/pi/session.ts).

## 5. Native session management is only partly exposed

**Current behavior:** continuing a bound native conversation works. HTTP lists Host session configurations and run records; it has no shared native transcript, fork or delete API. Pi exposes an embedded fork operation, and its `listSessions()` lists Host bindings. Its delete method explicitly fails because the pinned native API has no supported delete operation.

**Acceptance:** expose supported native history and session operations through a common, capability-aware interface. Keep Host records, native transcripts and native deletion distinct. A fork must use the native operation; deleting a Host binding must not be presented as deleting a native conversation. Differences in what Kernels expose remain visible.

Evidence: [HTTP routes](../src/service/server.ts), [binding store](../src/agent.ts), [Pi session operations](../src/pi/session.ts), [documented native limits](kernel-support.md#upgrade-boundaries).

## 6. First use still requires substantial manual setup

**Current behavior:** installation starts from a source checkout and a built archive; the package is not published to npm. Users configure native installation, authentication and runtime profiles separately. `inspect()` checks the workspace, executable and basic model selection, but not login, model access or successful native execution. The packaged CLI starts the service; direct interactive use is demonstrated by an example editor rather than a general task CLI.

**Acceptance:** provide a documented short path from installation to a first task and actionable setup diagnostics. Separate local configuration checks from explicit, opt-in checks that execute a native Agent or contact a provider. Offer a simple personal-use entry point if the existing native CLI and examples do not cover the workflow. Preserve users' native authentication and configuration instead of replacing them.

OpenClaw product tools additionally require a local Gateway and the bundled plugin. The existing callback bridge does not provide remote sandbox connectivity. Surface this requirement during setup; broader remote execution needs its own environment implementation and verification.

Evidence: [installation guide](api.md#install-and-run-the-example), [CLI](../src/service/cli.ts), [inspection](../src/service/native-runtimes.ts), [OpenClaw tool setup](api.md#openclaw-product-tools).

## 7. Verification does not yet cover the whole promise

**Current evidence:** all seven Kernels have live embedded editor probes for reject, approve/save and native continuation. All seven HTTP profiles have deterministic fixture coverage; only Codex has the recorded full live HTTP consumer probe. Many optional controls and interaction forms have protocol coverage only. Native probes ran on macOS arm64; Linux CI covers deterministic tests, and Windows native execution is not certified.

**Acceptance:** maintain a versioned capability/evidence matrix across embedded and HTTP access. For each feature, distinguish protocol fixtures, independent installed-consumer tests and live native probes. Add native coverage for newly exposed media, interactions and controls, including failure and cancellation. Broaden platform claims only when the corresponding execution paths have been verified.

Evidence: [support matrix](kernel-support.md#what-was-exercised), [HTTP verification](http-service.md#example-and-verification), [CI](../.github/workflows/ci.yml).

## Proposed order

1. Extend capability descriptions and native media verification beyond the implemented attachment and image transport paths.
2. Reduce routine integration work: common entry points and interaction helpers, then carry existing native controls/settings across embedded and HTTP access.
3. Expand supported session operations and improve installation and diagnostics.

Verification accompanies every step. These priorities do not add product accounts, billing, business permissions, long-term memory strategy or multi-tenant scheduling to Agent Host. Those remain the responsibilities defined in [scope](scope.md).
