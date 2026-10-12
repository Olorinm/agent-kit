# First task

Use Node.js 24 or later and an installed, authenticated native Kernel. Agent Host keeps that Kernel's login, configuration, tools and model execution. It does not install or log into all seven Kernels for you.

## Install a release without cloning the repository

```sh
mkdir my-agent && cd my-agent
npm init -y
npm install https://github.com/Olorinm/agent-host/releases/download/v0.1.0-alpha.8/olorinm-agent-host-0.1.0-alpha.8.tgz
```

The archive is published on [GitHub Releases](https://github.com/Olorinm/agent-host/releases). The package is not on the npm registry yet. Native binaries other than Claude's SDK engine are separate prerequisites. The release has the same contents tested by the independent archive consumer.

## Run a task yourself

For an existing Codex installation, make sure Git is on `PATH`. Minimal Linux images also need CA certificates; without Git, the tested native Codex engine failed at thread creation with `workspace routing discovery failed`.

Run:

```sh
npx agent-host init --kernel codex --cwd . --config host.json
npx agent-host doctor --config host.json
npx agent-host run --config host.json --session first "Explain the files in this directory"
```

Continue with the same `--session first`. Omit `--session` to create a new one; the CLI prints its ID. Ctrl-C asks the native Kernel to cancel. In a terminal, native approvals and questions are interactive. Noninteractive requests are declined unless your application provides a handler. `--json` produces event records for scripts; terminal prompts and the session ID go to stderr.

`init` never overwrites an existing file. Its configuration and the state directory belong to you. `run` and `serve` share the state's exclusive process lock; stop the service before running the standalone CLI against that directory. Keep native transcript storage as well as `.agent-host` to preserve continuation.

Three diagnostic levels are deliberately separate:

```sh
npx agent-host doctor --config host.json          # Local paths, executable, model selection
npx agent-host doctor --config host.json --native # Native handshake; no test prompt
npx agent-host doctor --config host.json --probe  # Explicit model request; provider usage may apply
```

A handshake can discover capabilities without proving model access. Pi has no separate read-only server handshake; its static description and the opt-in execution probe are distinguished. Native login errors remain native errors. The report includes actionable configuration checks without copying credentials into output.

## Select another Kernel

| Kernel | Initial profile | Prerequisite |
| --- | --- | --- |
| Claude | `init --kernel claude` | SDK engine is bundled; existing native login or provider environment. `--command` can select your existing engine wrapper. |
| Pi | `init --kernel pi --model provider/model` | Pi provider credentials in its native environment; the durable engine is included. |
| OpenCode | `init --kernel opencode --model provider/model` | Existing `opencode` executable, native provider/model configuration and state. |
| Kimi | `init --kernel kimi` | Existing `kimi` executable and native login. |
| Hermes | `init --kernel hermes --command /path/to/python --args '["-m","tui_gateway.entry"]'` | Python environment containing the pinned Hermes TUI Gateway. Configure its native bootstrap/launch arguments for that installation and a dedicated persistent `HERMES_HOME`. |
| OpenClaw | `init --kernel openclaw` | Existing local Gateway at the configured URL. Set `gatewayTokenEnv` to your token environment variable; product tools also need the [bundled plugin](api.md#openclaw-product-tools). |

These are profile templates, not installers. `--command` and `--args` accommodate native installation paths. Owner-controlled `env`, Claude `native` settings and ACP `config` are available in `host.json`; trusted JavaScript hooks use the [programmatic runtime](common-api.md#settings-and-native-extensions). Keep credentials in native configuration or environment variables, not a committed profile.

## Connect a product

```sh
npx agent-host serve --config host.json
```

The service prints its URL and token-file location. Your product uses `AgentHostClient`, or embeds `createAgent()` in its backend. See the [common API](common-api.md), [HTTP guide](http-service.md) and [capabilities](capabilities.md). OpenClaw's current product-tool callback bridge requires a local Gateway. Remote workspace/sandbox provisioning belongs to your deployment environment.
