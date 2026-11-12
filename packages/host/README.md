# Agent Host

[中文](README.zh-CN.md)

Agent Host is an open-source integration layer that makes native coding Agents easier to use in any product or personal workflow. Products supply context, tools and interaction handlers; Agent Host connects to the selected Agent and returns progress and results.

**Seven native integrations, two deployment modes:** Codex, Claude Agent, Pi, OpenCode, Kimi Code, Hermes and OpenClaw. Embed the package in your backend or run a standalone HTTP service. Both modes use the same adapters.

**Status: alpha.** Install the tested archive from [GitHub Releases](https://github.com/Olorinm/agent-host/releases); no source checkout is needed. It is not yet published to npm. See the [tested versions and verification limits](docs/kernel-support.md).

The [2026-10-15 harness refresh](docs/harness-refresh-20261015.md) records the latest stable targets, native feature changes and verification limits.

The HTTP service preserves attachment bytes, supported native image inputs and image tool results. See [media input](docs/http-service.md#media-input) for runtime differences and limits.

## Core principles

**Preserve native Agent capabilities as fully as possible, and make them simple to use through a clear, consistent integration layer.**

1. **Respect the native Kernel.** Keep execution, tools, sessions and permissions under the Kernel's control. Carry supported inputs, outputs and controls through the integration faithfully. Give distinctive native features an explicit extension path, and explain when a capability is unavailable or has not yet been integrated.
2. **Make integration straightforward for products and people.** Provide consistent ways to configure an Agent, start and continue work, receive progress, handle approvals and questions, and cancel execution. Embedded and HTTP access should deliver the same native capability wherever the environment permits it, with differences discoverable before use.

**Unify how Agents are used while keeping their capability differences visible.** Common operations belong in shared interfaces; native features remain accessible through explicit extensions. Support claims need implementation and verification evidence, and the integration must report any loss or limitation clearly.

The [gap checklist](docs/capability-gaps.md) records implementation, verification and remaining native/environment boundaries against these principles.

## What it provides

- Create and continue native sessions; list, read, fork and delete them where the Kernel supports it.
- Handle approvals, questions and elicitation through common callbacks; receive text, reasoning, usage and native tool progress.
- Select owner-approved native settings, steer, compact and cancel work.
- Run personal tasks with `agent-host init`, `doctor` and `run`.
- Connect product tools and route supported native approvals and structured questions to your UI.
- Preserve native model loops, tools, transcripts and permission semantics.
- Expose optional controls such as steering and compaction where supported by each Agent.
- Query shared capability descriptions and select an embedded adapter through `createAgent()`, while retaining its native methods and options.
- Keep storage, runtime configuration and product authorization explicit.

Your product owns its UI, accounts, business permissions, memory strategy and data. Agent Host owns the integration with the native Agent. Capabilities differ by Kernel; the [support matrix](docs/kernel-support.md) records those boundaries.

## Optional React UI

`@olorinm/agent-ui` supplies reusable chat messages, Markdown, a composer, process details, approvals, questions and resources. It is a separate package in [Olorinm/agent-ui](https://github.com/Olorinm/agent-ui); Agent Host itself does not depend on React. Products keep their own data, permissions and file operations.

See the [React UI guide](docs/react-ui.md) and [independent document editor](examples/react-editor/README.md).

## Two ways to integrate

- **Embedded:** install `@olorinm/agent-host` from its archive and call an adapter from your Node.js backend. Your product manages lifecycle and storage.
- **Standalone service:** run `agent-host serve --config host.json` and connect through `@olorinm/agent-host/client`. The service persists tasks and results and routes product-tool and interaction callbacks.

Start with the [quickstart](docs/quickstart.md), [common API](docs/common-api.md) or [HTTP service guide](docs/http-service.md). Native installations and authentication are configured separately.

See [capability discovery](docs/capabilities.md) to distinguish implemented operations, setup requirements, native negotiation and missing integrations before presenting features to users.

## Examples and verification

- [Terminal file editor](examples/file-editor): approve or reject an edit, save a document, cancel work and continue the native conversation after restarting the product.
- [Browser file editor](examples/http-editor/README.md): connect a separate product to the HTTP service and handle edits through its own UI.

The examples consume the public package API. Archive tests install the package outside this repository and exercise all seven adapters. Deterministic tests and live model-backed probes are documented separately in the [support matrix](docs/kernel-support.md).

## Design and scope

See [scope and responsibilities](docs/scope.md) for the boundary between a product, Agent Host and the native Agent. The [Rivet backend evaluation](docs/rivet.md) explains the native-continuation requirements behind the current adapters.

## License

[MIT](LICENSE) for Agent Host's project-owned code. Original source attribution
is retained in [NOTICE](NOTICE). Third-party SDKs and native Agent runtimes retain
their respective licenses.
