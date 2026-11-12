# Agent Kit

Building blocks for agent products. Each package lives in its own directory with
its own dependencies and tests. All packages share one version and are released
together.

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

All packages share one version. To release:

```sh
node scripts/set-version.mjs 0.8.0-alpha.2   # every package.json and lockfile
# add a "## [0.8.0-alpha.2]" section to CHANGELOG.md, commit, wait for CI
git tag v0.8.0-alpha.2 && git push origin v0.8.0-alpha.2
```

The [release workflow](.github/workflows/release.yml) builds every package at the
tagged commit on Linux with a pinned Node.js and npm and publishes one GitHub
Release. Its notes are the `CHANGELOG.md` section for that version. The release
carries:

| Asset | Contents |
| --- | --- |
| `olorinm-agent-host-<version>.tgz` | Host npm package |
| `agent-router-server-<version>.tgz` | Router npm package |
| `agent-router_<version>_<os>_<arch>.tar.gz` | Router CLI for macOS and Linux, amd64 and arm64 |
| `olorinm-agent-connectors-<version>.tgz` | Connectors npm package |
| `olorinm-agent-environment-<version>.tgz` | Environment npm package |
| `SHA256SUMS` | Checksums of every archive above |

Install a package straight from a release, for example:

```sh
npm install https://github.com/Olorinm/agent-kit/releases/download/v0.8.0-alpha.1/olorinm-agent-host-0.8.0-alpha.1.tgz
```

A tag may point at any commit whose checks have passed, including a branch that
is still under review, so a product can try a change before it is merged.
Running the workflow manually builds and packs without publishing.

## License

[MIT](LICENSE). Packages may include additional notices in their own directories.
