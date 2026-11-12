# Connect channels to an Agent

[简体中文](connections.zh-CN.md)

Router owns accounts, agents, channel connections and task delivery. Creating execution environments and starting a Host
belong to the operator or the embedding product.

The routes below are under `/_agent-router/v1` and require the authenticated owner of the agent (see
[Accounts and agents](managed-agents.md)). Responses are sent with `Cache-Control: no-store`.

| Route | Purpose |
| --- | --- |
| `GET /connection-options` | The mail services an owner can choose (`id`, `label`) |
| `GET /agents/:id/configuration` | The agent, its Host (`runtimeId`) and its connections (`id`, `kind`), plus live channel status. No secrets. |
| `POST /agents/:id/connections` | Connect one platform |
| `GET /agents/:id/connection-jobs` | Recent setup jobs |
| `GET /agents/:id/connection-jobs/:job` | One setup job |
| `POST /agents/:id/connection-jobs/:job/pairing` | Supply a Weixin pairing code: `{ "code": "123456" }` |
| `POST /agents/:id/check` | Read-only checks of the Host and every connection; body `{}` |

## Connect a platform

`POST /agents/:id/connections` takes one of these bodies:

```json
{ "kind": "feishu", "domain": "feishu" }
{ "kind": "weixin" }
{ "kind": "telegram", "token": "<bot token>" }
{ "kind": "grove-mail", "serviceId": "mail", "inboxId": "helper@mail.example.test",
  "apiKey": "<inbox API key>", "ownerEmail": "alice@example.test" }
```

An agent has at most one connection of each platform. Connecting a platform that is already configured is refused with
`409 platform_already_connected`; it does not replace the existing connection.

Feishu, Weixin and Telegram answer `202` with a setup job:

```json
{ "id": "<job id>", "kind": "feishu", "state": "starting", "expiresAt": "<ISO time>",
  "url": "https://…", "qr": "<terminal QR code of url>" }
```

Poll `GET /agents/:id/connection-jobs/:job` until `state` is `ready` or `failed`. `url` and `qr` are present while the
owner has something to open or scan. A failed job has `error`.

- **Feishu:** open or scan `url` to create the app through the official app registration page. App consent connects
  messaging through the app's bot. Use `"domain": "lark"` for Lark. Router sends and receives as the bot only; it has no
  tools that act as the owner's personal Feishu account. The app credentials are saved in the agent's connection
  directory (`feishu/credentials.json`, `feishu/app-secret`).
- **Weixin:** scan the QR code in WeChat. When the job state becomes `pairing`, post the code shown by WeChat to the
  pairing route. This is Tencent iLink private chat support.
- **Telegram:** create a bot with BotFather and send its token in the request. Open the one-use link in `url` and press
  Start in a private chat with the bot. Router binds that sender as the owner only after the matching `/start` message.
  The bot must have no webhook and no other polling consumer. A bot already connected to another agent is refused.
- **Email:** `serviceId` selects a Grove Mail service configured by the operator, `inboxId` is an existing inbox and
  `apiKey` its key. Router verifies access to the inbox, stores the key as a private file and answers `200` with the
  agent's configuration; there is no setup job. Arbitrary Gmail or Outlook mailboxes cannot be connected this way.

Bark push notifications and manually created Feishu apps are configured in the agent's channel configuration by the
operator; see [Channels](personal-channels.md).

### Setup jobs

Feishu app consent waits for the expiry reported by the official SDK (`expireIn`), or ten minutes when the SDK reports
none. Weixin and Telegram jobs have a ten-minute deadline. Job history, credentials and channel configuration survive a
Router restart. A consent poll interrupted by a restart is reported as failed with `connection_setup_interrupted`: the
SDK has no durable resume token, so a lost poll cannot be continued.

A failed Feishu job includes a `recovery` object (`action`, optional `appId`, `domain`):

- `retry_binding`: the credentials were saved but binding failed. Post the same request again; the saved credentials
  are reused.
- `authorize_existing_app`: the app was or may have been created, but its credentials were not saved. Post the request
  with the app's id from the developer console, `{ "kind": "feishu", "appId": "cli_…", "domain": "feishu" }`, and
  authorize the same app again. No app secret has to be copied. Router does not create another app while the result of
  a creation is uncertain; do not delete the pending marker to retry.
- `retry`: start again.

Keep the original `domain` when retrying. An app that is already assigned to another agent is rejected.

## Check and chat

`POST /agents/:id/check` returns `{ "checks": [...] }`. Each check has `agentId`, `kind`, `status` (`verified`,
`needs_action` or `not_verified`), `detail` and, for a connection, `connectionId`. The Host check verifies that the Host
service answers and has the configured runtime. Connection checks verify credentials and access, and that the running
connection started without an error. An agent without a Host or without connections is reported explicitly.

Checks do not consume messages, send a test message or run a model. Send a real message on the platform to verify a
complete round trip.

## Host

A Host is not configured over HTTP: owner requests cannot supply Host endpoints or credential paths. The operator writes
`host` into the agent's channel configuration, or an embedding product sets it through `router.connections` and provides
the Host through the package API; see [Embedding Agent Router](../architecture/embedding.md). An agent without a Host
receives and stores messages, but nothing answers them.

## Operator configuration

`AGENT_ROUTER_CONNECTIONS_FILE` (standalone) or the `connections` option of `createRouter` supplies the mail services:

```json
{ "mailServices": [{ "id": "mail", "label": "Team mail", "url": "https://mail.example.test",
    "attachmentOrigins": ["https://mail-files.example.test"] }] }
```

Omit it when no email connection is offered. Router does not load cloud credentials or environment profiles.

Each agent's connections are stored in `connections/agents/<agentId>/channels.json` under the state directory, next to
their credential files. Persist the whole state directory. A configuration change is applied atomically: the previous
consumer is stopped before its replacement starts, and a change is refused while the agent has a running run or a run
with an unknown outcome.

A stored configuration that still lists a connection of kind `matrix` is accepted: that connection is dropped when the
file is read, so it is neither started nor listed.
