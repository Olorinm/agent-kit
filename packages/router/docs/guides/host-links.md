# Host links

An agent's Host normally has an address Router can call. A host link is for the other case: an Agent Host on a machine
without a public address connects to Router, keeps the connection open, and Router sends its Host requests through
it. The machine's side is described in the Host package (`docs/host-link.md`).

A linked Host takes messages only. Router sends it no instructions, tools, native input items, tool output or
attachments, and the Host refuses them. Router cannot read or write its files, manage its native sessions or call its
native extension.

## Flow

1. The owner creates a pairing code for one agent. It works once, for one hour, and replaces the agent's earlier
   unused code.
2. The machine exchanges the code for a device credential (`agent-host link --url <router> --code <code>`). Router
   stores a hash of the credential. An agent has one link: pairing again revokes the earlier machine.
3. The machine opens the link socket with that credential and stays connected.
4. The agent's Host configuration names the link as its binding: `host: { binding: "link:<linkId>", runtimeId }`.
   Router resolves `link:` bindings itself; the product's `HostBindingProvider` is not asked about them.

Step 4 is the product's: Router does not change an agent's Host configuration when a machine enrolls. An agent may
have no Host configuration before that.

## HTTP

| Route | Authentication | Purpose |
| --- | --- | --- |
| `POST /_agent-router/v1/host-links/pairing-codes` `{ agentId }` | Owner | `201 { agentId, code, expiresAt }`; `404 agent_not_found` |
| `GET /_agent-router/v1/host-links` | Owner | `{ data: HostLink[] }` |
| `DELETE /_agent-router/v1/host-links/:linkId` | Owner | `204`; `404 host_link_not_found` |
| `POST /_agent-router/v1/host-links/enroll` | Pairing code | `201 { linkId, agentId, credential }` |
| `GET /_agent-router/v1/host-links/socket` (WebSocket upgrade) | Device credential | The link |

```ts
interface HostLink {
  id: string; agentId: string; deviceName: string; platform: string;
  runtime: { id: string; kernel: string };   // the one runtime Router reaches
  online: boolean; createdAt: string;
  lastOnlineAt: string | null;               // last connect or disconnect; null before the first connection
}
```

Enrollment takes `{ code, deviceName, platform, runtime: { id, kernel } }` and no other credential. A wrong, used or
expired code answers `401 host_link_code_invalid`. Five wrong codes from one client address within an hour answer
`429 host_link_enroll_locked` for an hour, also for a correct code. The route allows 20 requests a minute per client
address. Client addresses follow `trustedProxies`; behind a reverse proxy that is not listed there, every machine
shares the proxy's address and its lockout.

The socket is opened with `Authorization: Bearer <credential>`; an unknown or revoked credential answers `401` to the
upgrade. A device credential (`ahl_...`) is never accepted as an owner token. These two routes are the only ones a
machine can reach without an owner: a deployment that puts an identity-aware proxy in front of Router must let them
through unauthenticated.

## The link socket

Text frames of JSON, at most 16 MiB each.

| From | Frame |
| --- | --- |
| Router | `{ "type": "hello", "linkId", "agentId", "heartbeatMs" }` once, after the upgrade |
| Router | `{ "type": "request", "id", "method": "GET" \| "POST", "path", "body"? }` |
| Host | `{ "type": "response", "id", "status", "body" }` |

`path` and `body` are those of the Host's HTTP v1 contract, and `status` and `body` are what that request returns.
Router pings every `heartbeatMs` (20 seconds) and closes a connection that did not answer the previous ping. A request
without a response within 30 seconds fails with `504 host_link_timeout`.

One connection per link: a newer connection replaces the older one, which is closed with code `4001`. Revocation closes
with `4003`, a Router shutdown with `1012`.

## In a product

`createRouter(...)` returns `hostLinks` (also `router.service.hostLinks`), a `HostLinks`:

```ts
hostLinks.createCode(owner: string, agentId: string): { code: string; expiresAt: string }
hostLinks.list(owner: string): HostLink[]
hostLinks.get(agentId: string): HostLink | undefined
hostLinks.online(agentId: string): boolean
hostLinks.revoke(owner: string, linkId: string): void            // 404 host_link_not_found
hostLinks.remove(agentId: string): void                          // Router calls this when it deletes an agent
hostLinks.subscribe(listener: (event: HostLinkEvent) => unknown): () => void
// HostBindingProvider, for bindings "link:<linkId>":
hostLinks.assertReady(agentId: string, binding: string): void    // 404 host_link_not_found, 503 host_offline
hostLinks.host(agentId: string, binding: string): HostPort
hostLinks.http(agentId: string, binding: string): HostTransport
HostLinks.binding(linkId: string): string                        // "link:<linkId>"
HostLinks.isBinding(binding: string): boolean

interface HostLinkEvent {
  type: "enrolled" | "online" | "offline" | "revoked";
  owner: string; link: HostLink; binding: string;
}
```

A listener may return a promise; its errors are ignored. `revoked` is also sent for the earlier link when an agent is
paired again and when its agent is deleted. A typical product writes the Host configuration when a machine enrolls:

```ts
router.hostLinks.subscribe((event) => {
  if (event.type !== "enrolled") return;
  const host = { binding: event.binding, runtimeId: event.link.runtime.id, instanceName: "channel-host", instructions: "" };
  return router.connections.edit(event.owner, event.link.agentId, (config) => { config.host = host; });
});
```

A new pairing has a new `linkId`, so a new binding. An agent that already has runs with another Host needs
`connections.replaceHost(owner, agentId, host)`, which starts fresh execution sessions.

## Offline machines and lost connections

- While the machine is not connected, the agent's worker claims nothing. Work stays `submitted` in the queue and the
  worker's status reports `host_offline`. It is delivered when the machine connects.
- A submission that could not be handed to the socket returns to the queue.
- A turn that is running when the connection drops keeps running on the machine. After the reconnect Router reads it
  again by its run id.
- A submission whose answer was lost becomes `unknown`, as with any Host. After the reconnect Router looks it up by
  its `requestKey` and binds the run if the Host has it. It is never sent a second time. If the Host does not have
  it, the turn stays `unknown` until the owner closes it.
- A message with attachments fails with a notice: a linked Host accepts text.
- Input that no person wrote (delegated or scheduled work) reaches a linked Host as text with the fixed delivery
  notice, never as a native tool output.
- `context` of a linked run is `{ agentId, conversationId, source }`, where `source` names the channel sender or the
  admission that produced the input.

## Verification

`npm test` covers pairing, the socket, the routes and the worker against a scripted machine. For both packages
together, install separate Router and Host tarballs into an empty consumer directory, then run:

```sh
node scripts/verify-host-link.mjs /absolute/path/to/consumer
```

It imports only the installed packages' public exports and runs a Router and an Agent Host in one process, joined
only by a host link: pairing over HTTP, work queued while the machine is offline, the outbound connection, a turn with
its events, an approval answered from Router, the operations a link refuses, a Router restart in the middle of a turn
that completes once, and revocation. The runtime is a scripted fixture: this is protocol evidence, not a live-model
check.
