# Accounts and agents

An owner account manages several agents. Router stores the agents, their channel connections and their work; it does not
store passwords. This guide covers owner sign-in, the agent API, deletion, rate limits and the state directory.

## Owner accounts

An owner is identified by an account id `@name:<namespace>`. The namespace is the service's `serverName`, set with
`MATRIX_SERVER_NAME` (the variable name is historical). Ids in another namespace and ids starting with `@_ar_` are not
accepted as owners.

### Edge identity

Router verifies the Cloudflare Access application JWT in the `Cf-Access-Jwt-Assertion` request header and maps it to a
configured owner. `AGENT_EDGE_IDENTITY_FILE` points to a JSON file:

```json
{
  "edgeIdentity": {
    "provider": "cloudflare-access",
    "teamDomain": "https://team.example.test",
    "audiences": ["ACCESS_APPLICATION_AUD"],
    "owners": { "alice@example.test": "@alice:agents.example.test" },
    "serviceTokens": { "SERVICE_TOKEN_CLIENT_ID": "@alice:agents.example.test" }
  }
}
```

- `teamDomain` is an HTTPS origin without a path or trailing slash. The signing keys are read from
  `<teamDomain>/cdn-cgi/access/certs`.
- `owners` maps a lowercase email address to an owner id, or to `{ "owner": "...", "sub": "..." }` to also require the
  JWT subject. `serviceTokens` maps the `common_name` of an Access service token to an owner id.
- Every owner id must be in the service's namespace; otherwise the service does not start.
- `clockSkewSeconds` (default 60) is the accepted clock difference.
- `origins` lists the browser origins allowed for requests that change state. The default is the origin of
  `AGENT_SERVICE_URL`; a request whose `Origin` matches its own `Host` is also accepted.
- `bearer` is `allow` (default) or `deny`. With `deny`, a request without an assertion is rejected even when the
  embedding product supplies a bearer authenticator.

Only the signed assertion is read. An email that is not listed in `owners` gets `403 owner_not_configured`. A request
that carries both an assertion and a bearer token must resolve to the same owner.

### Bearer tokens of an embedding product

A product that embeds Router can pass `dependencies.authenticate`, a function that resolves a bearer token to an owner id
or throws (see [Embedding Agent Router](../architecture/embedding.md)). The standalone service has no bearer
authenticator, so it needs the edge identity.

`GET /_agent-router/v1/account` returns the authenticated owner: `owner`, `personId`, `via` (`edge`, `edge-service` or
`bearer`) and, for an edge login, `email`.

## Agents

All routes are under `/_agent-router/v1` and act on the authenticated owner's agents.

| Route | Result |
| --- | --- |
| `POST /agents` with `{ "name": "helper" }` | `201` and the agent. Creating a name that already exists returns the existing agent. |
| `GET /agents` | `{ "data": [agent, …] }` |
| `GET /agents/:id` | The agent, or `404 agent_not_found` when it belongs to another owner |
| `DELETE /agents/:id` | `204` |

A name starts with a lowercase letter and contains up to 48 lowercase letters, digits and hyphens. An owner can have 50
agents; one more is refused with `429 agent_limit_reached`.

An agent object has these fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable UUID |
| `owner` | The owner's account id |
| `name` | The name given at creation |
| `address` | `<owner name>/<agent name>@<namespace>`, for example `alice/helper@agents.example.test` |
| `matrixId` | The agent's runtime identity, `@_ar_<id>:<namespace>`: the identity of its store. The field name is historical. |
| `createdAt` | ISO timestamp |
| `status` | `provisioning`, `active` or `deleting` |

Each agent has its own SQLite store and work queue. Channels and a Host are added through the
[connection routes](connections.md); the work in the queue is taken by the Host worker inside Router.

## Deleting an agent

`DELETE /agents/:id` stops the agent's channels and worker and removes its store, its connection directory (including
saved channel credentials) and its entry in the owner's chat index.

The request is refused with `409` and nothing changes while the agent has a running run or a run with an unknown outcome
(`agent_has_active_or_unknown_run`), or a connection setup job in progress (`connection_setup_running`). Wait for the
run to finish, reconcile or close it, or let the setup job end.

Once removal has started the agent has status `deleting`: it is not started again after a restart, and repeating the
same request finishes the removal. A later agent with the same name gets a new id.

## Rate limits and reverse proxies

Requests under `/_agent-router/v1` are limited before authentication to 1200 per minute per client address; IPv6
addresses are grouped by /56. The web API (`/web`) has an additional limit of 600 per minute per client address, and
the connection routes 600 per minute per owner. A request over the limit gets `429 rate_limit_exceeded`. The counters
are kept in the memory of one process and are empty after a restart.

Forwarded headers are not trusted by default: the client address is the address of the connection. Behind a reverse
proxy, set `AGENT_TRUST_PROXY` to the proxy's addresses or ranges (comma-separated; the named ranges of Express such as
`loopback` and `uniquelocal` are accepted). The proxy must overwrite forwarding headers sent by clients. Do not expose
the service port directly next to a trusted proxy.

## State directory

`AGENT_SERVICE_STATE` (default `state/agent-service`) holds all Router state:

```text
registry.sqlite            agents and identities
agents/<agentId>.sqlite    one agent: messages, sessions, work queue, ledger
owners/<digest>.sqlite     one owner: chat index, groups
connections/agents/<id>/   channel configuration and credential files
blobs/                     attachments (local blob store)
```

Back up the whole directory together. One process uses a state directory at a time: each agent store is protected by a
lease, and a second process cannot take it while the first one runs.
