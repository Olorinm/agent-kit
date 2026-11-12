# Agent Environment

[English](README.md) | [简体中文](README.zh-CN.md)

Create and manage cloud execution environments for any agent, through one TypeScript API and CLI.

The package ships one provider: **Cloudflare**, backed by an operator gateway over Cloudflare's
native Durable Object Container API. The gateway source is in [cloudflare/](cloudflare/README.md),
together with independent encrypted recovery backups.

```text
Your product
        │ choose provider + template; persist the environment ref
Agent Environment
        └── Cloudflare gateway (cloudflare/)
                    └── container with your tools and agent runtime
```

## What it does

- Create, inspect, list, resume, pause, extend lifetime, and destroy environments.
- Execute argv commands with streaming stdout/stderr, observed exit status, and cancellation.
- Read and write exact file bytes; recursively list files.
- Return an authenticated HTTP endpoint for a port inside the environment.
- Validate artifact paths and infer content types (`@olorinm/agent-environment/workspace`).

Choose the image, CPU, memory and disk in the gateway **template**. Choose Codex, Pi, Claude Code, or another runtime in that image or in your own bootstrap command. This module does not choose an agent kernel.

This is a library and operator CLI. Product login, ownership checks, quotas, durable agent bindings and scheduling belong to the caller. [Mau](https://github.com/Olorinm/mau) is one such caller; see [integration.md](docs/integration.md).

## Try it

Requires Node.js 24+ and a deployed [Cloudflare gateway](cloudflare/README.md).

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

## Semantics that matter

- `pause()` confirms that the request was accepted. Poll `info()` until paused before resuming. Lifetime expiry saves a filesystem snapshot and stops compute; process memory is not resumed.
- Resume reuses an existing ID; a missing environment is never silently replaced.
- Network failure is never interpreted as “missing” or successful command completion. A command without an observed exit marks execution uncertain; reconcile before pausing or retrying.
- Serialize lifecycle changes and work per environment in your scheduler. Persist refs in your database, check ownership before passing them here, and retain an operation ID in metadata to reconcile creation after a lost response. Metadata filters help discovery; they are not an authorization boundary.

## Adding a provider

A provider implements `EnvironmentProvider` from [src/types.ts](src/types.ts): lifecycle (`create`, `info`, `list`, `resume`, `pause`, `destroy`, `setTimeout`), command execution (`exec`, with `hasUncertainExecution` / `resetExecutionUncertainty`), files (`readFile`, `writeFile`, `removeFile`, `listFiles`) and `httpEndpoint`. [src/cloudflare.ts](src/cloudflare.ts) is the reference implementation.

1. Add `src/<provider>.ts` exporting `create<Provider>Provider(options)`.
2. Register its `kind` in the `factories` table in [src/config.ts](src/config.ts) so configuration files can select it.
3. Export it from [src/index.ts](src/index.ts) and add tests against a local fixture server under `test/`.

Keep credentials in private key files referenced by the configuration, never in metadata or refs.

## Verification

```sh
npm test
npm run test:package
# Provisions a billable environment, checks exec/files/pause/resume, and destroys it:
npm run probe -- --config /secure/providers.json --provider cloudflare --template node24 \
  --workspace /home/user/workspace --report state/probe.json
```

The gateway has its own checks: `npm ci && npm run check && npm test` in `cloudflare/`, and `node --test cloudflare/backup/test/*.test.mjs`. Cloud probes write a private report recording the created ID and cleanup result.
