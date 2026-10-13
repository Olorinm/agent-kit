# Agent Environment

[English](README.md) | [简体中文](README.zh-CN.md)

Create and manage cloud execution environments for any agent, through one TypeScript API and CLI.

Alibaba Cloud Agent Sandbox and Volcengine VCI Agent Sandbox adapters share the official E2B SDK. Agent Host and OMA can use the same environment interface without adopting each other's agent loop, accounts, or database.

```text
Your product / OMA
        │ choose provider + template; persist the environment ref
Agent Environment
        ├── Alibaba Cloud Agent Sandbox
        └── Volcengine VCI Agent Sandbox
                    └── your image, tools, and agent runtime
```

## What it does

- Create, inspect, list, resume, pause, extend lifetime, and destroy environments.
- Execute argv commands with streaming stdout/stderr, observed exit status, and cancellation.
- Read and write exact file bytes; recursively list files.
- Adapt to OMA's `SandboxClient`, retaining its native filesystem and workspace verification.

Choose the image, CPU, memory, network and durable mounts in the cloud **template**. Choose Codex, Pi, Claude Code, or another runtime in that image or in your own bootstrap command. This module does not choose an agent kernel.

This is a library and operator CLI. Product login, ownership checks, quotas, durable agent bindings and scheduling belong to the caller. It does not provision the cloud's VKE/ACS foundation. [Mau](https://github.com/Olorinm/mau) owns the product onboarding and Host startup integration described in [integration.md](docs/integration.md).

## Try it

Requires Node.js 24+ and an existing cloud sandbox endpoint, API key and template.

```sh
npm ci
npm run build
node dist/cli.js --help
```

Copy [the example configuration](examples/providers.json) outside the repository, replace its endpoint and key-file paths, and restrict each key file to mode `0600`. These are **sandbox service keys**, not cloud account AK/SK.

```sh
node dist/cli.js create --config /secure/providers.json --provider volc --template node-tools --seconds 600
# Save the returned {"provider":"volc","id":"..."} in your agent binding.
node dist/cli.js exec --config /secure/providers.json --provider volc --id SANDBOX_ID -- node --version
node dist/cli.js pause --config /secure/providers.json --provider volc --id SANDBOX_ID
node dist/cli.js resume --config /secure/providers.json --provider volc --id SANDBOX_ID
node dist/cli.js destroy --config /secure/providers.json --provider volc --id SANDBOX_ID
```

For use from another project, run `npm pack` and install the resulting tarball; the package is not yet published to npm.

```ts
import { loadConfiguration } from '@olorinm/agent-environment';

const environments = await loadConfiguration('/secure/providers.json');
const ref = await environments.create('volc', { template: 'node-tools', timeoutSeconds: 600 });
// Persist ref before running any work. Resolve its owner in your product first.
const provider = environments.provider(ref.provider);
for await (const chunk of provider.exec(ref.id, ['node', '--version'], {
  onExit: result => console.log('exit', result.exitCode),
})) process.stdout.write(chunk.text);
```

## Semantics that matter

| Behavior | Alibaba | Volcengine |
| --- | --- | --- |
| Explicit pause/resume | Supported by adapter | Supported by adapter |
| Pause automatically on lifetime expiry | `onTimeout: 'pause'` | Rejected; use explicit pause |
| Resume process memory | No promise | No promise |
| Durable workspace | Configure template and verify mount | Configure template and verify mount |

`pause()` confirms that the request was accepted; the Volcengine adapter flushes disk writes first. Poll `info()` until paused before resuming. Resume reuses an existing ID; a missing environment is never silently replaced. Network failure is never interpreted as “missing” or successful command completion. Cancel requests kill, then waits up to ten seconds for an observed exit; an unconfirmed exit marks execution uncertain. SDK request handshakes have their own timeout.

Serialize lifecycle changes and work per environment in your scheduler. Persist refs in your database, check ownership before passing them here, and retain an operation ID in metadata to reconcile creation after a lost response. The module does not automatically retry creation or provide distributed locking. Metadata filters help discovery; they are not an authorization boundary.

## Integration and verification

- [OMA and Agent Host integration](docs/integration.md)
- [Provider setup and differences](docs/providers.md)
- [Verification status](docs/verification.md)
- [Deployment recipe](docs/deployment.md)

```sh
npm test
npm run test:package
npm run test:oma -- /path/to/open-managed-agents
# Provisions a billable sandbox, checks exec/files/pause/resume, and destroys it:
npm run probe -- --config /secure/providers.json --provider volc --template node-tools \
  --workspace /home/user/workspace --report state/probe.json
```

The OMA check reads its checkout without changing it. Cloud probes use a private report recording the created ID and cleanup result. Source references and reuse boundaries are recorded in [NOTICE](NOTICE).
