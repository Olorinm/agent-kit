# Agent Router

**English** | [简体中文](README.zh-CN.md)

Agent Router is a message router for agents. It receives messages from chat channels and the web, delivers them to a running agent through Agent Host, and sends the replies back to the conversation each message came from. A product embeds it through the package root (`@agent-router/server`), or it runs as a standalone HTTP service.

```text
Feishu / Weixin / Telegram / Email / Web
                  ↕
   Agent Router: accounts, connections, ledger, work queue
                  ↕
   Agent Host: models, tools and workspace
```

## What it does

- **Accounts and agents.** An owner is identified by an account id `@name:<namespace>`. Each owner creates up to 50 agents; every agent has its own SQLite store and work queue.
- **Channel connections.** Each agent can connect Feishu, Weixin (WeChat), Telegram, email through a Grove Mail service, and Bark push notifications. The owner's linked private chats share one main session; group chats and other contacts get separate sessions. Every reply returns to the channel that received that turn.
- **Owner ledger.** Conversation history, cards, attachments, groups and linked identities are stored by Router and served to a web client under `/_agent-router/v1/web`. See [ADR 0005](docs/architecture/decisions/0005-owner-ledger.md).
- **Task delivery.** Received messages and product-authored work enter the agent's durable work queue. The Host worker inside Router claims the work, starts runs on an [Agent Host](../host/README.md), relays questions and tool calls, and records the result. Known state is restored after a restart; a run with an unknown outcome waits for reconciliation and is not executed again.

| Channel | Capabilities |
| --- | --- |
| Feishu | Text, media, replies, streaming cards and buttons through the official Channel SDK; QR setup of the app |
| Weixin (WeChat) | Tencent iLink QR login; private text and media messages, voice transcripts, replies |
| Telegram | Bot API through grammY: text, media, drafts, buttons and replies in private chats and group topics |
| Email | Incoming mail and replies through a Grove Mail service |
| Bark (push only) | Owner notifications on iOS through the [Bark](https://github.com/Finb/Bark) app, optionally encrypted |
| Web | Owner chat, groups, cards and attachments through the ledger web API |

## Build and test

Requires Node.js 24 or later.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## Run standalone

```sh
MATRIX_SERVER_NAME=agents.example.test \
AGENT_SERVICE_URL=https://router.example.test \
AGENT_EDGE_IDENTITY_FILE=/private/edge-identity.json \
npm run agent:service
```

The service listens on `127.0.0.1:8790` and stores its state under `state/agent-service`.

| Variable | Meaning |
| --- | --- |
| `MATRIX_SERVER_NAME` | Required. The account namespace: owner ids are `@name:<namespace>`. The variable name is historical. |
| `AGENT_SERVICE_URL` | Required. The public URL of the service. |
| `AGENT_SERVICE_STATE` | State directory. Default `state/agent-service`. |
| `HOST`, `PORT` | Listen address. Default `127.0.0.1` and `8790`. |
| `AGENT_EDGE_IDENTITY_FILE` | Owner sign-in through Cloudflare Access; see [Accounts and agents](docs/guides/managed-agents.md). |
| `AGENT_TRUST_PROXY` | Comma-separated trusted proxy addresses or ranges. Forwarded headers are ignored without it. |
| `AGENT_ROUTER_CONNECTIONS_FILE` | JSON file with `mailServices` for email connections; see [Connections](docs/guides/connections.md). |
| `AGENT_LEDGER_READ`, `AGENT_LEDGER_SEND` | Set to `1` to serve the web history API and event socket, and to accept owner web messages. `AGENT_LEDGER_READ` requires `AGENT_LEDGER_SEND`. |
| `AGENT_LEDGER_CARDS`, `AGENT_LEDGER_CONTROL`, `AGENT_LEDGER_GROUPS`, `AGENT_LEDGER_ATTACHMENTS` | Set to `1` for card answers, cancel/steer/reset/purge, groups, and attachments on the web API. Each needs `AGENT_LEDGER_SEND`. |
| `AGENT_LEDGER_IDENTITY` | Set to `1` for owner resolution by linked identity and `/link` pairing. |
| `AGENT_BLOB_STORE` | `local` (default) or `r2`. |
| `AGENT_BLOB_DIR` | Directory of the local blob store. Default `<state>/blobs`. |
| `AGENT_R2_BUCKET`, `AGENT_R2_ACCESS_KEY_ID_FILE`, `AGENT_R2_SECRET_ACCESS_KEY_FILE` | Required with `AGENT_BLOB_STORE=r2`. The keys are read from files. |
| `AGENT_R2_ENDPOINT` or `AGENT_R2_ACCOUNT_ID` | The R2 endpoint, or the account id it is derived from. |
| `AGENT_ATTACHMENT_QUOTA_BYTES` | Attachment quota per owner. Default 5 GiB. |

Owners sign in through the edge identity. A standalone service without `AGENT_EDGE_IDENTITY_FILE` accepts no owner requests; an embedding product can supply its own bearer-token authenticator.

## Embed in a product

```ts
import { createRouter, loadServiceConfig } from "@agent-router/server";

const router = createRouter(loadServiceConfig(), { connections: {} });
const server = router.app.listen(8790, "127.0.0.1");
server.on("upgrade", (req, socket, head) => { if (!router.upgrade(req, socket, head)) socket.destroy(); });
await router.start();
```

See [Embedding Agent Router](docs/architecture/embedding.md) for authentication, Host bindings and the agent lifecycle.

## HTTP surface

All routes except `GET /health/live` are under `/_agent-router/v1` and require an authenticated owner.

| Routes | Purpose |
| --- | --- |
| `GET /account` | The authenticated owner |
| `GET`, `POST /agents`; `GET`, `DELETE /agents/:id` | List, create, read and delete agents |
| `GET /connection-options`; `/agents/:id/configuration`, `/connections`, `/connection-jobs`, `/check` | Channel connection setup and checks |
| `/agents/:id/communication` | Channel and Host status; `sessions`, `work-events`, `tasks` and `runs` for work sessions and run observation |
| `/web/...` | Ledger web API: chats, events, messages, cards, groups, attachments, identities and socket tickets |

## Documentation

| Topic | Guide |
| --- | --- |
| Owner sign-in, agents, deletion, rate limits | [Accounts and agents](docs/guides/managed-agents.md) |
| Connecting channels over HTTP | [Connections](docs/guides/connections.md) · [简体中文](docs/guides/connections.zh-CN.md) |
| Channel configuration, groups, media and recovery | [Channels](docs/guides/personal-channels.md) |
| Work sessions and product-authored work | [Native sessions](docs/guides/native-sessions.md) |
| Tools inside the execution environment | [Worker tools](docs/guides/worker-tools.md) · [简体中文](docs/guides/worker-tools.zh-CN.md) |
| Writing a channel adapter | [Adding a channel](docs/guides/adding-a-channel.md) |
| Embedding API | [Embedding Agent Router](docs/architecture/embedding.md) |
| Module boundaries and sessions (Chinese) | [Communication architecture](docs/architecture/communication-layer.md) |
| Ledger design | [ADR 0005](docs/architecture/decisions/0005-owner-ledger.md) |

License: [MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for reused components and their licenses.
