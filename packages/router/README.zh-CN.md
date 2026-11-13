# Agent Router

[English](README.md) | **简体中文**

Agent Router 是 Agent 的消息路由服务：接收聊天渠道和网页发来的消息，通过 Agent Host 交给运行中的 Agent，再把回复送回消息原来所在的对话。产品可以通过包入口（`@agent-router/server`）嵌入它，也可以把它作为独立 HTTP 服务运行。

```text
飞书 / 微信 / Telegram / 邮件 / 网页
                ↕
  Agent Router：账号、渠道连接、账本、工作队列
                ↕
  Agent Host：模型、工具与工作区
```

## 功能

- **账号与 Agent。** 所有者用账号 ID `@name:<命名空间>` 标识。每个所有者最多创建 50 个 Agent；每个 Agent 有独立的 SQLite 存储和工作队列。
- **渠道连接。** 每个 Agent 可以连接飞书、微信、Telegram、通过 Grove Mail 服务收发的邮件，以及 Bark 推送通知。所有者已关联的私聊共享一个主会话；群聊和其他联系人使用独立会话。每轮回复回到收到该轮消息的渠道。
- **所有者账本。** 对话历史、卡片、附件、群组和已关联身份由 Router 保存，并通过 `/_agent-router/v1/web` 提供给网页客户端。见 [ADR 0005](docs/architecture/decisions/0005-owner-ledger.md)。
- **任务投递。** 收到的消息和产品提交的工作进入 Agent 的持久化工作队列。Router 进程内的 Host worker 领取工作，在 [Agent Host](../host/README.md) 上启动运行，转发提问和工具调用，并记录结果。重启后恢复已知状态；结果未知的运行等待核对，不会重复执行。

| 渠道 | 能力 |
| --- | --- |
| 飞书 | 通过官方 Channel SDK 收发文字、媒体、引用、流式卡片和按钮；扫码配置应用 |
| 微信 | 腾讯 iLink 扫码登录；私聊文字和媒体、语音转写、引用 |
| Telegram | 通过 grammY 使用 Bot API：私聊和群组 topic 中的文字、媒体、草稿、按钮和引用 |
| 邮件 | 通过 Grove Mail 服务收信和回复 |
| Bark（只推送） | 通过 [Bark](https://github.com/Finb/Bark) App 在 iOS 上给所有者推送通知，可加密 |
| 网页 | 通过账本 Web API 提供所有者聊天、群组、卡片和附件 |

## 构建与测试

需要 Node.js 24 或更高版本。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## 独立运行

```sh
MATRIX_SERVER_NAME=agents.example.test \
AGENT_SERVICE_URL=https://router.example.test \
AGENT_EDGE_IDENTITY_FILE=/private/edge-identity.json \
npm run agent:service
```

服务监听 `127.0.0.1:8790`，状态保存在 `state/agent-service`。

| 变量 | 含义 |
| --- | --- |
| `MATRIX_SERVER_NAME` | 必填。账号命名空间：所有者 ID 为 `@name:<命名空间>`。变量名是历史名称。 |
| `AGENT_SERVICE_URL` | 必填。服务的公开 URL。 |
| `AGENT_SERVICE_STATE` | 状态目录，默认 `state/agent-service`。 |
| `HOST`、`PORT` | 监听地址，默认 `127.0.0.1` 和 `8790`。 |
| `AGENT_EDGE_IDENTITY_FILE` | 通过 Cloudflare Access 登录所有者；见[账号与 Agent](docs/guides/managed-agents.md)。 |
| `AGENT_TRUST_PROXY` | 可信代理地址或网段，逗号分隔。未设置时忽略转发头。 |
| `AGENT_ROUTER_CONNECTIONS_FILE` | 包含 `mailServices` 的 JSON 文件，用于邮件连接；见[渠道连接](docs/guides/connections.zh-CN.md)。 |
| `AGENT_BLOB_STORE` | `local`（默认）或 `r2`。 |
| `AGENT_BLOB_DIR` | 本地 blob 存储目录，默认 `<状态目录>/blobs`。 |
| `AGENT_R2_BUCKET`、`AGENT_R2_ACCESS_KEY_ID_FILE`、`AGENT_R2_SECRET_ACCESS_KEY_FILE` | `AGENT_BLOB_STORE=r2` 时必填。密钥从文件读取。 |
| `AGENT_R2_ENDPOINT` 或 `AGENT_R2_ACCOUNT_ID` | R2 端点，或用于推导端点的账号 ID。 |
| `AGENT_ATTACHMENT_QUOTA_BYTES` | 每个所有者的附件配额，默认 5 GiB。 |

所有者通过边缘身份登录。独立服务未设置 `AGENT_EDGE_IDENTITY_FILE` 时不接受任何所有者请求；嵌入方产品可以提供自己的 bearer token 认证函数。

## 嵌入产品

```ts
import { createRouter, loadServiceConfig } from "@agent-router/server";

const router = createRouter(loadServiceConfig(), { connections: {} });
const server = router.app.listen(8790, "127.0.0.1");
server.on("upgrade", (req, socket, head) => { if (!router.upgrade(req, socket, head)) socket.destroy(); });
await router.start();
```

认证、Host 绑定和 Agent 生命周期见[嵌入 Agent Router](docs/architecture/embedding.md)。

## HTTP 接口

除 `GET /health/live` 外，所有路由都在 `/_agent-router/v1` 下，并要求已认证的所有者。

| 路由 | 用途 |
| --- | --- |
| `GET /account` | 当前认证的所有者 |
| `GET`、`POST /agents`；`GET`、`DELETE /agents/:id` | 列出、创建、读取和删除 Agent |
| `GET /connection-options`；`/agents/:id/configuration`、`/connections`、`/connection-jobs`、`/check` | 渠道连接的配置与检查 |
| `/agents/:id/communication` | 渠道和 Host 状态；其下的 `sessions`、`work-events`、`tasks`、`runs` 用于工作会话和运行观察 |
| `/web/...` | 账本 Web API：聊天、事件、消息、卡片、群组、附件、身份和 socket ticket |

## 文档

| 主题 | 指南 |
| --- | --- |
| 所有者登录、Agent、删除、限流 | [账号与 Agent](docs/guides/managed-agents.md)（英文） |
| 通过 HTTP 连接渠道 | [渠道连接](docs/guides/connections.zh-CN.md) · [English](docs/guides/connections.md) |
| 渠道配置、群聊、媒体与恢复 | [渠道](docs/guides/personal-channels.md)（英文） |
| 工作会话和产品提交的工作 | [原生会话](docs/guides/native-sessions.md)（英文） |
| 执行环境里的工具 | [执行环境里的工具](docs/guides/worker-tools.zh-CN.md) · [English](docs/guides/worker-tools.md) |
| 编写渠道适配器 | [新增渠道](docs/guides/adding-a-channel.md)（英文） |
| 嵌入 API | [嵌入 Agent Router](docs/architecture/embedding.md)（英文） |
| 模块边界与会话 | [通信层架构](docs/architecture/communication-layer.md) |
| 账本设计 | [ADR 0005](docs/architecture/decisions/0005-owner-ledger.md)（英文） |

许可证：[MIT](LICENSE)。复用的组件及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
