# Integration

An upper-level provisioning operation resolves the authenticated user's permitted provider and template, creates an environment, persists `{provider,id}` against the Agent, starts Agent Host inside that environment, then binds its runtime identity to Router. Reconnect uses that persisted ID. Agent Host continues to own native agent execution and sessions.

Do not put gateway keys or all tenants' environment refs inside an agent runtime. Only the trusted provisioning service calls this library. An operator can use the CLI directly; exposing that CLI as a product endpoint requires product authentication and ownership checks.

Images may contain any runtime and shared tools. Start long-running Host processes using the image's supervisor/entrypoint; `exec` is a command stream, not a distributed supervisor. Put Host state, kernel session files and user workspace data on durable paths. Bootstrap after a resume must be idempotent because process memory does not survive.

[Mau](https://github.com/Olorinm/mau) is one such caller: it owns environment profiles, allocation journals, private Host bootstrap, Agent/environment bindings and lifecycle operations, and reaches Host through `provider.httpEndpoint(id, port)` with a separate per-Agent token. The [Cloudflare gateway README](../cloudflare/README.md) describes the Host startup files for that gateway.
