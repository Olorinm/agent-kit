# Agent Environment

[English](README.md) | [简体中文](README.zh-CN.md)

Create and manage execution environments for any agent, through one TypeScript API and CLI.

The package ships two providers. **Cloudflare** is backed by an operator gateway over Cloudflare's
native Durable Object Container API; the gateway source is in [cloudflare/](cloudflare/README.md),
together with independent encrypted recovery backups. **Docker** runs environments as containers on
your own machine, for trying things out without a cloud account; see [Docker (local)](#docker-local).

```text
Your product
        │ choose provider + template; persist the environment ref
Agent Environment
        ├── Cloudflare gateway (cloudflare/)
        │           └── container with your tools and agent runtime
        └── local Docker daemon
                    └── container with your tools and agent runtime
```

## What it does

- Create, inspect, list, resume, pause, extend lifetime, and destroy environments.
- Execute argv commands with streaming stdout/stderr, observed exit status, and cancellation.
- Read and write exact file bytes; recursively list files.
- Return an authenticated HTTP endpoint for a port inside the environment.

Choose the image, CPU, memory and disk in the gateway **template**. Choose Codex, Pi, Claude Code, or another runtime in that image or in your own bootstrap command. This module does not choose an agent kernel.

This is a library and operator CLI. Product login, ownership checks, quotas, durable agent bindings and scheduling belong to the caller. [Mau](https://github.com/Olorinm/mau) is one such caller; see [integration.md](docs/integration.md).

## Try it

Requires Node.js 24+ and a deployed [Cloudflare gateway](cloudflare/README.md), or a local Docker daemon for the [Docker provider](#docker-local).

```sh
npm ci
npm run build
node dist/cli.js --help
```

Copy [the example configuration](examples/providers.json) outside the repository, replace its gateway URL and key-file path, and restrict the key file to mode `0600`. The key is the gateway's control credential, not a Cloudflare account token.

```sh
node dist/cli.js create --config /secure/providers.json --provider cloudflare --template node24 --seconds 600
# Save the returned {"provider":"cloudflare","id":"..."} in your agent binding.
node dist/cli.js exec --config /secure/providers.json --provider cloudflare --id ENVIRONMENT_ID -- node --version
node dist/cli.js pause --config /secure/providers.json --provider cloudflare --id ENVIRONMENT_ID
node dist/cli.js resume --config /secure/providers.json --provider cloudflare --id ENVIRONMENT_ID
node dist/cli.js destroy --config /secure/providers.json --provider cloudflare --id ENVIRONMENT_ID
```

For use from another project, install the archive from a GitHub Release (or run `npm pack` and install the resulting tarball); the package is not published to npm.

```ts
import { loadConfiguration } from '@olorinm/agent-environment';

const environments = await loadConfiguration('/secure/providers.json');
const ref = await environments.create('cloudflare', { template: 'node24', timeoutSeconds: 600 });
// Persist ref before running any work. Resolve its owner in your product first.
const provider = environments.provider(ref.provider);
for await (const chunk of provider.exec(ref.id, ['node', '--version'], {
  onExit: result => console.log('exit', result.exitCode),
})) process.stdout.write(chunk.text);
```

## Docker (local)

Kind `docker` runs each environment as a container on the local Docker daemon, through the `docker` command. It lets
you run a product that uses this package on your own machine, with no Cloudflare account and no key file:

```json
{ "providers": [{ "id": "local", "kind": "docker" }] }
```

```sh
node dist/cli.js create --config providers.json --provider local --template node24
```

Optional fields: `dockerPath` (default `docker`), `maxEnvironments` (default 3, stopped environments included) and
`ports` (default `[37420]`).

**It is for trying things out on a machine you own, not for production:**

- **No egress restrictions.** `modelServices` and `modelAccounts` are accepted and ignored. A local environment
  reaches the whole internet and whatever your machine's network reaches.
- **No isolation beyond Docker's.** Commands run as root inside the container, without CPU or memory limits. Anyone
  who can use the Docker daemon can enter an environment. Values passed as `env` are `docker` arguments: other local
  users can see them in the process list, and `docker inspect` shows those given to `create`.
- **No lifetime.** `capabilities.automaticPause` is `false`: `timeoutSeconds`, `onTimeout` and `setTimeout()` are
  checked and not enforced. An environment runs until it is paused or destroyed.
- No backups and no snapshot recovery.

Everything else follows the Cloudflare gateway, so a caller needs no changes:

- Template `node24` is built on first use from `node:24-trixie-slim` and tagged `agent-environment-node24:<hash>`:
  Debian trixie with Node 24, commands and file transfers as root, and `user` (uid 1001, `/home/user`) for the agent
  runtime. The container waits for `/opt/agent-environment/start.sh` and runs it, so
  [the gateway's start script](cloudflare/examples/start-host.sh) works unchanged.
- `pause()` stops the container and returns when it has stopped. Files are kept, processes are not. `resume()` starts
  it again, which runs the start script again. A container that stopped for another reason (a daemon restart, a
  reboot, a start script that exited) also reads as `paused` and can be resumed.
- `httpEndpoint()` returns `http://127.0.0.1:<port>` with no headers. Only the ports in `ports` are published, on the
  loopback interface. Docker picks the host port at every start: ask again after a resume.
- A command that times out or is cancelled is killed in the container together with its descendants, and reported as
  uncertain. While a command or file transfer is in flight, the same process refuses `pause`, `resume` and `destroy`
  with `environment_busy`.

`AGENT_ENVIRONMENT_DOCKER_TEST=1 npm test` adds a test of the whole lifecycle against the local daemon.

## Semantics that matter

- `pause()` confirms that the request was accepted. Poll `info()` until paused before resuming. Lifetime expiry saves a filesystem snapshot and stops compute; process memory is not resumed.
- Resume reuses an existing ID; a missing environment is never silently replaced.
- `modelAccounts` on `create()`, or as `resume(id, seconds, { modelAccounts })`, holds the environment to its own
  account at a model service, for example `{ openai: ['<ChatGPT account id>'] }`: the gateway then refuses a request
  that carries another account's credential, so the environment cannot hand data to someone else's account at the same
  provider. Omit it to keep what is stored; `{}` removes it. Like the service list, it applies from the next start.
  See the [gateway notes](cloudflare/README.md#managed-secrets-network-restrictions-and-independent-backups).
- `modelServices` on `create()`, or as `resume(id, seconds, { modelServices })`, selects which reviewed model endpoints the environment may reach, for example `['openai', 'anthropic']`. Omit it for the gateway default (`openai`); a resume without it keeps the stored list. A running environment keeps its list until its next start. The rule sets live in the [gateway source](cloudflare/README.md#managed-secrets-network-restrictions-and-independent-backups), and the guest cannot change the selection.
- Network failure is never interpreted as “missing” or successful command completion. A command without an observed exit marks execution uncertain; reconcile before pausing or retrying.
- Serialize lifecycle changes and work per environment in your scheduler. Persist refs in your database, check ownership before passing them here, and retain an operation ID in metadata to reconcile creation after a lost response. Metadata filters help discovery; they are not an authorization boundary.

## Adding a provider

A provider implements `EnvironmentProvider` from [src/types.ts](src/types.ts): lifecycle (`create`, `info`, `list`, `resume`, `pause`, `destroy`, `setTimeout`), command execution (`exec`, with `hasUncertainExecution` / `resetExecutionUncertainty`), files (`readFile`, `writeFile`, `removeFile`, `listFiles`) and `httpEndpoint`. [src/cloudflare.ts](src/cloudflare.ts) is the reference implementation.

1. Add `src/<provider>.ts` exporting `create<Provider>Provider(options)`.
2. Register its `kind` in the `factories` table in [src/config.ts](src/config.ts) so configuration files can select it.
3. Export it from [src/index.ts](src/index.ts) and add tests against a local fixture under `test/`.

Keep credentials in private key files referenced by the configuration, never in metadata or refs.

## Verification

```sh
npm test
npm run test:package
```

The gateway has its own checks: `npm ci && npm run check && npm test` in `cloudflare/`, and `node --test cloudflare/backup/test/*.test.mjs`. These tests use local fixtures and do not create cloud environments.
