# Integration

## Mau / Agent Host / Router

An upper-level provisioning operation resolves the authenticated user's permitted provider and template, creates an environment, persists `{provider,id}` against the Agent, starts Agent Host inside that environment, then binds its runtime identity to Router. Reconnect uses that persisted ID. Agent Host continues to own native agent execution and sessions.

Do not put cloud keys or all tenants' environment refs inside an agent runtime. Only the trusted provisioning service calls this library. An operator can use the CLI directly; exposing that CLI as a product endpoint requires product authentication and ownership checks.

Images may contain any runtime and shared tools such as lark-cli. Start long-running Host processes using the image's supervisor/entrypoint; `exec` is a command stream, not a distributed supervisor. Put Host state, kernel session files and user workspace data on explicitly durable paths. Bootstrap after a resume must be idempotent because process memory need not survive.

Product orchestration now belongs to [Mau](https://github.com/Olorinm/mau): environment profiles, allocation journals, private Host bootstrap, Agent/environment bindings and lifecycle operations. Router supplies account ownership, channel connections and task delivery through its public embedding API. Environment remains independent of both products' account and database models.

Mau can use `provider.httpEndpoint(id, port)` to reach Host with a separate per-Agent token. Host images wait for a verified private configuration bundle before listening; the image/platform owns process restart supervision. See [Mau environment setup](https://github.com/Olorinm/mau/blob/main/docs/environments.md) for the current product recipe.

The [verification report](verification.md) records the live acceptance of the earlier Router-hosted integration. That historical evidence does not establish deployment of the new Mau composition. [Deployment](deployment.md) describes the independently managed sandbox foundation.

## OMA

`@olorinm/agent-environment/sandbox` is the extracted OMA implementation:
E2BSandboxClient, DefaultSandboxManager, native filesystem, workspace mount
attestation and Skill provisioning. The implementation and all six original
sandbox suites come from the pinned revision in `upstream.json`.

OMA imports this package directly and supplies its existing store, binding locks
and OSS readback verifier. Mau uses the provider API, which delegates execution,
file bytes and uncertainty to the same E2BSandboxClient. Mau retains its persistent
Host lifecycle; OMA retains per-Turn preparation and event-driven idle handling.

`/contracts` contains the extracted ToolExecutor contracts and the one shared
ExecAbortedBeforeStartError class. `/sdk` exposes the OMA-patched E2B runtime for
transport integrations; use its error classes when injecting a driver.
There is no `/oma` reverse bridge or second command execution implementation.

Run `npm test` for the original suites plus provider tests, and
`npm run test:package` for a separate installation with install scripts disabled.
See [upstream.md](upstream.md) for provenance, update procedure and distribution status.
