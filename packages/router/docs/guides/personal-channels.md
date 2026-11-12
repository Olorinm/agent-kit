# Channels

Router receives and sends messages on Feishu, Telegram, Weixin and email, pushes notifications through Bark, and keeps
the connection credentials and the mapping from provider threads to sessions. Agent Host runs the agent.

```text
Feishu / Telegram / Weixin / Email / Web
                  ↕
  channel adapter → inbox / sessions / outbox
                  ↕
        the agent's durable work queue
                  ↕
   Host worker → Agent Host runtime
```

The owner's linked private chats share one main session. Each reply uses the channel, chat and message saved for that
turn. Group chats and other contacts use separate sessions.

## Configuration

Owners connect Feishu, Weixin, Telegram and email through the [connection routes](connections.md). The result is the
agent's channel configuration, `connections/agents/<agentId>/channels.json` in the state directory:

```json
{ "agents": [{ "agentId": "<agent uuid>",
    "connections": [{ "id": "feishu", "kind": "feishu", "credentialsFile": "feishu/credentials.json" }],
    "host": { "url": "http://127.0.0.1:37420", "tokenFile": "host-token", "runtimeId": "codex" } }] }
```

Relative file paths are resolved against the directory of the file. Credentials are always files, never inline values.
An operator can edit this file while Router is stopped. Every connection accepts `ownerAddresses`, `peerAddresses` and
`groupIds` in addition to the fields below.

| Channel | Implementation | Required fields | Capabilities |
| --- | --- | --- | --- |
| Feishu | [Official Channel](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md), SDK 1.74.0 | `credentialsFile` | Text, images, files, audio and video, replies, streaming cards, buttons, reactions and document comments |
| Telegram | [grammY](https://grammy.dev/) 1.46.0 | `botTokenFile` | Text, images, files, audio and video, stickers, replies, native draft streaming, buttons and reactions; private chats and group topics; one polling process per bot |
| Weixin | Protocol and QR login code from the [Tencent plugin](https://github.com/Tencent/openclaw-weixin) 2.4.9 | `credentialsFile` | iLink private chats: text, media, provided voice transcripts, replies and typing state; no groups, buttons or streaming edits |
| Email | A Grove Mail service | `url`, `inboxId`, `apiKeyFile` | Durable receipt, text and HTML, attachments, replies to the original mail; no automatic reply-all |
| Bark | [Bark](https://github.com/Finb/Bark) push API | `server`, `deviceKeyFile` | Send only: owner notifications |

`host` selects the Agent Host: `runtimeId` and either `url` with `tokenFile`, or a `binding` resolved by an embedding
product (see [Embedding Agent Router](../architecture/embedding.md)). Optional `instructions` are the stable
instructions of the agent's sessions.

### Feishu

The connection route registers the app through the official QR flow. The same registration is available on the machine
that runs Router:

```sh
npm run feishu:setup -- /absolute/private/path/feishu
```

It creates the app with the bot, messaging, card, reaction and comment permissions Router uses, and prints
`status: ready` with a connection entry to add to the agent's `connections`:

```json
{ "id": "feishu", "kind": "feishu", "credentialsFile": "/absolute/private/path/feishu/credentials.json" }
```

Use `--domain lark` for Lark. The directory holds `credentials.json` (`appId`, `appSecretFile`, `domain`,
`ownerOpenId`) and `app-secret`, written with mode 0600. The owner is the account that scanned the code.

Router sends and receives as the app's bot only. It has no tools that read the owner's calendar, documents or other
personal resources. A `personalTools` field in a stored configuration is accepted and ignored.

A manually created bot can be configured with `appId`, `appSecretFile`, `domain` and `ownerAddresses` instead of
`credentialsFile`; the two forms are mutually exclusive. Such an app needs the bot feature, long-connection event
subscription and the receive and send permissions of the chats it serves.

### Telegram

Create a bot with [BotFather](https://core.telegram.org/bots/features#botfather) and store its token in a private file.
At start Router checks `getWebhookInfo`; an existing webhook is reported as an error and is not removed. No other
process may poll the same bot. Group messages are subject to the bot's privacy mode and group permissions.
`ownerAddresses` holds numeric user ids, not usernames. This is a Bot API connection, not a login to a personal
Telegram account.

### Weixin

```sh
npm run weixin:login -- /absolute/path/weixin.json
```

The terminal shows the QR code. After login the credentials are written with mode 0600 and the token is not printed.
The `userId` returned by the scan is the owner unless `ownerAddresses` is set. Use a new connection id for a different
Weixin account. When the login of the same account expires, scan again and overwrite the credential file; the
connection retries with backoff and reads the file again. The Tencent protocol code is kept in
`src/channels/weixin/vendor/` with its license, version and source file hashes.

This is Tencent iLink bot pairing. It does not read the history, contacts or groups of a personal Weixin account, and
it serves private chats only.

### Email

An existing Grove Mail inbox and its API key are used as they are. Only `message.received` events that arrive after
the connection was created are consumed; sent events and earlier history are skipped, and the cursor is stored per
inbox. When the service answers `410` the connection stops receiving and reports the error; the cursor is not reset.
To choose a new starting point, confirm a valid cursor with the mail service and configure a new connection id with
`initialCursor`; the stored cursor of an existing connection takes precedence over that value. When the service's
attachment URLs use another origin than the API, list it in `attachmentOrigins`; attachment downloads never carry the
inbox API key. Personal Gmail or Outlook accounts (OAuth, IMAP) are not supported.

### Bark push (send only)

A Bark connection receives nothing. It notifies the owner on iOS through the [Bark](https://github.com/Finb/Bark) app
of what would otherwise reach them only on the web; replies in Feishu, Telegram and the other channels are already
announced by their own apps. The rules are the `notify` policy and are evaluated by the channel core:

- A turn in the owner's web chat ended and took at least `replyAfterSeconds` (default 30): the answer is pushed.
  Cancelled turns are not.
- A question for the owner (approval, choice) appeared in the owner's web chat: it is pushed with level
  `timeSensitive`.
- A scheduled reminder reached only the web, or its session has no connected channel: it is pushed.
- Nothing is pushed while a browser has that chat open, and nothing for other contacts or group chats.

```json
{ "id": "bark", "kind": "bark", "server": "https://bark.example.test", "deviceKeyFile": "bark/device-key",
  "encryptionKeyFile": "bark/encryption-key", "basicAuthFile": "bark/basic-auth", "title": "Agent",
  "openUrl": "https://console.example.test/", "notify": { "replyAfterSeconds": 30 } }
```

- `server` must be HTTPS; plain HTTP is accepted only for a loopback address. Running your own
  [bark-server](https://github.com/Finb/bark-server) keeps notifications off the public server. Register the device
  with that server in the app and store its device key in the file.
- `encryptionKeyFile`: choose AES-CBC under push encryption in the Bark app, with a key of 16, 24 or 32 characters.
  Each push uses a random IV. Title, body and link are encrypted; `level` and `group` stay in clear text so the system
  can prioritise and group notifications.
- `basicAuthFile` contains `user:password` for a server with Basic Auth. With `preview: false` the body is a generic
  notice without content. `maxLength` limits the body (default 300 characters).
- `notify` can switch off `replies`, `questions` and `schedules` separately. Owner, peer and group addresses do not
  apply and are rejected with `bark_is_send_only`.
- A send the server rejects (4xx) is recorded as failed. 429, 5xx and requests that were never sent are retried. A
  request that may have arrived without an answer is `uncertain` and is not sent again, because Bark does not
  deduplicate. Pushes are not written to the chat history; their state is in the outbox of the channel status.
- `channels:check` only requests `/ping`. Send a test notification to confirm that the device receives pushes.

## Addresses, groups and status

`ownerAddresses` links the owner's identities on each platform; other contacts go into `peerAddresses`. The values
come from real platform events, never from what a message says about its sender. Weixin and a Feishu credentials
directory default to the identity that scanned the code; other channels need the field.

When a Feishu or Telegram user id is not yet known, leave `ownerAddresses` empty, send the bot a private message, read
`inbox[].sender` from the status below, verify the identity, then write it into the configuration and restart. A
message from an unbound identity is stored as `ignored`: it does not start a model, and it is not run later when the
binding changes.

With `AGENT_LEDGER_IDENTITY=1` the owner can create a pairing code through the web API and send `/link <code>` to the
agent in a private chat on a new channel to link that account. Email is excluded unless the connection has
`pairing: true` and the mail service marks the sender as verified.

Feishu: once the bot is in a group, any member can talk to it by mentioning it; no group or sender has to be listed.
`groupIds` and `peerAddresses` do not restrict Feishu group chats. A group or topic never shares the private main
session. An ordinary quoted reply (only `root_id` / `parent_id`) stays in the group's session. A message with a
`thread_id` enters a topic, which is routed by that id. Before its first run the topic forks the group's native context
through the Host and then continues on its own; the fork does not grant the tools of the private session. A topic
without a group context, or after `/reset`, starts empty. If the fork fails or its outcome is unknown the turn stops
with an error instead of starting empty; an unconfirmed entry in `channel_session_forks` must be checked against the
Host before it is resumed.

Feishu: when a task starts, Router adds one reaction to the original message, chosen at random from the official emoji
list. The choice is stored, so retries and restarts do not draw again. The reaction stays whether the turn completes,
fails, is cancelled or waits for input. A failing reaction request does not block the answer. Run
`node scripts/update-feishu-emojis.mjs` to refresh the list.

Feishu document comments are shared threads as well. To handle the comments of one document, add
`document:<document token>` to `groupIds` and have an allowed sender mention the bot in a comment. The reply goes to
the same document as text; cards and streaming are not available there.

Group chats on other channels need both the group in `groupIds` and the sender in `ownerAddresses` or `peerAddresses`.
An email with several To/CC recipients is a group thread and runs only when that thread is configured; the reply still
goes to the original mail only.

Status, with the owner authentication of every other route:

```text
GET /_agent-router/v1/agents/{agentId}/communication
```

It returns each connection's start state and error, the latest 100 inbox and outbox records, the Host runs and pending
native questions. It returns no platform tokens. `started` means the adapter started; read `error` for the current
state. A connection that fails to start is retried with a backoff of up to 60 seconds and reads its credentials again,
so repairing the credential file is enough. Changing identity bindings or connection configuration requires a restart.

## Access check

A read-only check that receives nothing, sends nothing and runs no model:

```sh
npm run channels:check -- /absolute/path/channels.json
# Also compare with a running Router. The token is a bearer token accepted by that Router.
npm run channels:check -- /absolute/path/channels.json \
  --node https://router.example.test --owner-token-file /absolute/private/path/owner-token
```

Each item is `verified`, `needs_action` or `not_verified`. The Host check covers the service and the runtime; Feishu
the bot; Telegram the bot and a webhook conflict; email the inbox; Bark the server. Weixin does not start a second
consumer: the credential file is validated and the login is confirmed through the status of the running Router.
`verified` means only that the described check passed; a real message and its reply prove the round trip. The process
exits with 1 when an item is `needs_action`.

## Questions and control

A question raised by the agent appears in the original chat: Feishu and Telegram use native buttons, other channels
list the choices as text. A single question can be answered with the choice name, its number or free text. Several
questions are answered as JSON with the shown fields, or by replying to each question. Router converts the answer into
the kernel's native response for the same run. Products and operators can answer over HTTP:

```text
POST /_agent-router/v1/agents/{agentId}/communication/calls/{callId}/result
{ "result": <the JSON the native agent expects> }
```

Passwords and other sensitive input stay with the Host's native interaction and are not requested in a chat.

`/cancel`, `/stop` or "停止" cancels the current task. `/steer <text>` passes text to the running turn on kernels that
support steering. An answer to a waiting question continues that task instead of creating a new one. In a group only
the sender of the turn can answer or control it.

## Recovery and delivery

Router stores received messages, their reply route, execution bindings and send records. After a restart it observes
the existing Host runs and does not submit them again. Continuing a session requires the Router state, the Host
service state and the native agent's session storage. A change of runtime, stable instructions, tool definitions or
Host address needs an explicit Host replacement or a new agent; an existing context is not attached to another
execution environment.

Tool calls are stored by Host run and call id. A completed call returns its stored result; an interrupted write is not
executed a second time.

When the response to a run submission is lost or the outcome of a run is unknown, the run becomes `unknown` and the
agent stops taking work until someone decides:

- After finding the run in the Host by its session id, call `POST …/communication/runs/{claimId}/reconcile` with
  `{ "runId": "<verified run id>" }` to keep observing it.
- After confirming that execution stopped, call `POST …/communication/runs/{claimId}/close` with `{}`. This ends the
  Router work record. Without a known run id it does not replace stopping the run in the Host.

In a send record `accepted` means the platform accepted the message, not that it was read. Email sends carry a stable
idempotency key and can be resumed. Feishu, Telegram and Weixin store a receipt per chunk; a confirmed chunk is not
sent again, and a chunk whose acceptance is unknown becomes `uncertain` and is not resent.

The official Feishu Channel dispatches messages asynchronously and acknowledges them to the platform itself, so a
processing error cannot request redelivery. Router persists every message that reaches its callback and reports
`feishu_receipt_failed`, but end-to-end lossless receipt is not guaranteed across a disk failure. Telegram, email and
Weixin advance their cursor only after the message is stored.

## Media and native capabilities

A message that contains only attachments enters the conversation like any other. Router downloads the bytes through
the platform's resource API and passes them to the Host as attachments: at most 30 MiB per turn, within the platform's
own limits. The Host stores them as files in the workspace under `.agent-host/attachments/`.

Whether a model understands images, audio or video depends on the selected runtime and its tools; transporting media
does not add ASR, TTS or video understanding. Voice transcripts provided by Weixin are kept.

The agent gets a `channel` tool: `capabilities` returns what the current channel can receive and send, `message` the
original message, `send` sends text, supported HTML or cards, or a file from the Host workspace, `delivery` reports a
send, and `native` calls a declared native operation (reaction, edit, typing state). Sends go only to the reply route
saved for the current conversation. Only `accepted` means the platform accepted a send; `queued` and `uncertain` do
not. Sending workspace files requires `workspaceFiles: true` in the Host configuration.

Feishu shows progress and the final result in a streaming card, Telegram in a native draft. Email and Weixin send the
finished reply. A message edit is stored as an event and does not run the model again. Text input over 24 KB is
answered with a notice to shorten it and does not block later messages.

## Verification

`npm test` runs the channel core, the adapters and the Host worker against fixtures. It does not use a real model or
real accounts: platform credentials, app permissions and network access have to be verified with a live message.
