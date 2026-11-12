# Embedding Agent Router

The package exports `@agent-router/server`. Products import that public entry point, never `src/` or `dist/`
implementation paths. The standalone Router (`src/service/main.ts`) uses the same `createRouter` factory.

```ts
import { createRouter, loadServiceConfig } from "@agent-router/server";

const router = createRouter(loadServiceConfig(), {
  connections: {},
  dependencies: { authenticate: async (token) => ownerIdOf(token) },
});
const server = router.app.listen(8790, "127.0.0.1");
server.on("upgrade", (req, socket, head) => { if (!router.upgrade(req, socket, head)) socket.destroy(); });
await router.start();
// On shutdown: stop accepting requests, then await router.close().
```

`createRouter(config, options)` returns `{ service, connections, app, upgrade, start, close }`. `app` is the Express
application with every route under `/_agent-router/v1`. `upgrade` handles the event socket of the web API and returns
`false` for any other upgrade request.

## Configuration

`config` is a `ServiceConfig`: `serverName` (the account namespace of owner ids `@name:<serverName>`), `publicUrl`,
`stateDir`, and the optional `trustedProxies`, `edgeIdentity`, ledger flags (`ledgerRead`, `ledgerSend`, `ledgerCards`,
`ledgerControl`, `ledgerGroups`, `ledgerIdentity`, `ledgerAttachments`), `blobStore` and `attachmentQuotaBytes`.
`ledgerRead` requires `ledgerSend`. `loadServiceConfig()` builds the same object from the operator environment
variables listed in the [README](../../README.md#run-standalone).

`connections` accepts a JSON file path or an object containing `mailServices`. Router does not load cloud providers or
create execution environments.

## Authentication

Owner requests are authenticated by the edge identity (`config.edgeIdentity`, a Cloudflare Access JWT) and, when the
product passes `dependencies.authenticate`, by bearer token. `authenticate(token)` resolves a token to an owner id in
the service's namespace or throws. Without it only the edge identity signs owners in. Trusted application code can call
`router.service.authenticateRequest(request)` for the same decision outside the Router routes.

## Agents and runtimes

`router.service` is the `ManagedService` (`src/service/managed.ts`): `create(owner, name)`, `agents(owner)`,
`owned(id, owner)`, `delete(owner, id)` and `runtime(id)`.

`service.runtime(id)` resolves to the agent's `AgentRuntime` (`src/agents/runtime.ts`):

| Member | Meaning |
| --- | --- |
| `store` | The agent's durable SQLite store |
| `work` | The agent's work queue |
| `extension` | The channel runtime built from the agent's configuration: `communication`, `sessions`, `observation`, `web`, `control`, `room`. It is `undefined` for an agent without a channel configuration, and `sessions` and `observation` exist only with a Host. |

The runtime holds a lease on the store, so a second process cannot open the same agent. See
[Native sessions](../guides/native-sessions.md) for `extension.sessions`.

Channels are per-agent connections (see the [connection guide](../guides/connections.md)). `router.start()` starts
them once and `router.close()` stops and drains them. The product needs no polling loop of its own.

## Host bindings

Trusted application code uses `router.connections` (`ConnectionConfiguration`) for atomic connection and Host edits:
`edit(owner, agentId, update)` and `replaceHost(owner, agentId, host)`. HTTP callers cannot supply Host endpoints or
local credential paths.

A Host configuration specifies a `runtimeId`, `instanceName`, `instructions`, and either `url` + `tokenFile` or a
product-owned opaque `binding`. For opaque bindings the product passes `hosts` to `createRouter`, a
`HostBindingProvider` with `assertReady`, `host` and `http` (and optionally `wake`). These resolve execution access
without exposing environment ids or providers to Router. `HttpAgentHost` and `ServiceHttp` implement the public Host
HTTP protocol. Bindings are execution identities: they must not silently target a replacement runtime or discard native
sessions.

`connections.withStoppedRuntime(owner, agentId, operation, rollback)` serializes runtime replacement, stops delivery
workers and refuses running or unknown runs before invoking a product lifecycle operation. Both successful and failed
operations rebuild the channel runtime through its factory. The product owns its operation journal, recovery and
readiness guard.

## Deletion

`service.delete(owner, agentId)` (also `DELETE /_agent-router/v1/agents/:agentId`) calls the `beforeDelete` dependency
first, while the agent still exists, so the product can destroy its execution environment; a failure there leaves the
agent untouched. Router then marks the agent `deleting`, stops its runtime, removes its Router state and finally calls
`afterDelete` for product state. Repeating the call finishes a deletion that stopped after the agent became `deleting`.

## Boundaries

Dependencies point from the product to Router, Host and Environment; none of these packages import the product. A
product and Router can share a process while keeping separate HTTP namespaces and state directories.
