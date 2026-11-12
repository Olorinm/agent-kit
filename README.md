# Agent Kit

Building blocks for agent products. Each package lives in its own directory,
has its own dependencies, changelog and tests, and is released on its own.

| Package | Directory | npm name |
| --- | --- | --- |
| Host | [`packages/host`](packages/host) | `@olorinm/agent-host` |
| Router | [`packages/router`](packages/router) | `@agent-router/server` |
| Connectors | [`packages/connectors`](packages/connectors) | `@olorinm/agent-connectors` |
| Environment | [`packages/environment`](packages/environment) | `@olorinm/agent-environment` |

## Host

Runs native agent harnesses (Codex, Claude Agent, Pi, OpenCode, Kimi Code,
Hermes, OpenClaw) behind one interface. Embed it in a backend or run it as an
HTTP service; native sessions, tools and approvals are kept as the harness
defines them. See [packages/host/README.md](packages/host/README.md).

## Router

A message router for agents: it receives messages from chat channels and other
agents, delivers them to a running agent and sends the replies back to the same
channel. Includes a Go CLI and a TypeScript SDK. See
[packages/router/README.md](packages/router/README.md).

## Connectors

Service connectors (Google Workspace, GitHub, Notion, Feishu, browser) exposed
to agents as tools. Credentials and write approvals stay outside the agent's
environment. See [packages/connectors/README.md](packages/connectors/README.md).

## Environment

Creates, pauses, resumes and removes cloud execution environments for agents
through one TypeScript API and CLI. See
[packages/environment/README.md](packages/environment/README.md).

## Development

There is no root workspace. Install, test and build inside a package directory,
for example:

```sh
cd packages/host
npm ci
npm test
```

Continuous integration runs one workflow per package (`.github/workflows/ci-<package>.yml`)
when that package changes.

## Releases

Each package is released from a tag `<package>-v<version>`, for example
`host-v0.1.0-alpha.15`. The [release workflow](.github/workflows/release.yml)
checks that the tag matches the package version and that `CHANGELOG.md` has a
`## [<version>]` section, which becomes the release notes. It builds on Linux
with a pinned Node.js and npm, so a release archive can be reproduced from its
source revision. Running the workflow manually builds and packs a package
without publishing and prints the archive integrities.

## License

[MIT](LICENSE). Packages may include additional notices in their own directories.
