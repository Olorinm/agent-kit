# 连接 Agent 渠道

[English](connections.md)

Router 负责账号、Agent、渠道连接和任务投递。创建执行环境、启动 Host 由运营者或嵌入方产品负责。

以下路由都在 `/_agent-router/v1` 下，要求以该 Agent 的所有者身份认证（见[账号与 Agent](managed-agents.md)）。

| 路由 | 用途 |
| --- | --- |
| `GET /connection-options` | 所有者可选的邮件服务（`id`、`label`） |
| `GET /agents/:id/configuration` | Agent、Host（`runtimeId`）、连接列表（`id`、`kind`）和实时渠道状态，不含密钥 |
| `POST /agents/:id/connections` | 连接一个平台 |
| `GET /agents/:id/connection-jobs`、`GET /agents/:id/connection-jobs/:job` | 查看连接任务 |
| `POST /agents/:id/connection-jobs/:job/pairing` | 提交微信配对码：`{ "code": "123456" }` |
| `POST /agents/:id/check` | 只读检查 Host 和每个连接，请求体为 `{}` |

## 连接平台

`POST /agents/:id/connections` 的请求体按平台为 `{ "kind": "feishu", "domain": "feishu" }`、`{ "kind": "weixin" }`、`{ "kind": "telegram", "token": "<bot token>" }`，或邮件的 `{ "kind": "grove-mail", "serviceId", "inboxId", "apiKey", "ownerEmail" }`。每个 Agent 每个平台最多一个连接；平台已连接时返回 `409 platform_already_connected`，不会替换原连接。

飞书、微信和 Telegram 返回 `202` 和一个连接任务（`id`、`kind`、`state`、`expiresAt`，需要所有者打开或扫码时带 `url` 和 `qr`）。轮询任务直到 `state` 为 `ready` 或 `failed`；失败时带 `error`。

- **飞书：** 打开或扫描 `url`，在官方页面创建应用并授权，之后通过应用机器人收发消息。Lark 使用 `"domain": "lark"`。Router 只以机器人身份收发，不提供以所有者个人身份调用飞书的工具。应用凭据保存在 Agent 连接目录（`feishu/credentials.json`、`feishu/app-secret`）。
- **微信：** 用微信扫码。任务状态变为 `pairing` 时，把微信显示的配对码提交到 pairing 路由。仅支持腾讯 iLink 私聊。
- **Telegram：** 用 BotFather 创建 bot，在请求中提交 token，打开 `url` 中的一次性链接并在私聊中点击 Start。Router 收到匹配的 `/start` 消息后才把该发送者绑定为所有者。bot 不能有 webhook 或其他 polling 消费者。
- **邮件：** `serviceId` 选择运营者配置的 Grove Mail 服务，`inboxId` 为已有邮箱，`apiKey` 为其密钥。Router 验证邮箱访问后把密钥存为私有文件，直接返回 `200` 和 Agent 配置，没有连接任务。不能用这种方式接入任意 Gmail 或 Outlook 邮箱。

Bark 推送和手动创建的飞书应用由运营者写入 Agent 的渠道配置，见[渠道指南](personal-channels.md)（英文）。

飞书应用授权按官方 SDK 返回的 `expireIn` 等待，SDK 未返回时为十分钟；微信和 Telegram 任务的期限为十分钟。任务记录、凭据和连接配置跨重启保存。被重启打断的授权轮询标记为失败（`connection_setup_interrupted`）：官方 SDK 没有可持久恢复的令牌，丢失的轮询无法续接。

失败的飞书任务带 `recovery` 对象（`action`、可选 `appId`、`domain`）：

- `retry_binding`：凭据已保存但绑定失败。重新提交同一请求即可，已保存的凭据会被复用。
- `authorize_existing_app`：应用已创建或可能已创建，但凭据未保存。用开发者后台显示的 App ID 提交 `{ "kind": "feishu", "appId": "cli_…", "domain": "feishu" }`，重新授权同一个应用，无需复制 App Secret。创建结果不明时 Router 不会再创建应用；不要删除 pending 标记绕过检查。
- `retry`：重新开始。

重试时保留原来的 `domain`。已分配给其他 Agent 的应用会被拒绝。

## 检查

`POST /agents/:id/check` 返回 `{ "checks": [...] }`，每项包含 `agentId`、`kind`、`status`（`verified`、`needs_action`、`not_verified`）、`detail`，连接项还带 `connectionId`。Host 检查验证服务可达并存在所配置的 runtime；连接检查验证凭据和访问权限，并确认运行中的连接已无错启动。没有 Host 或没有连接时会明确报告。检查不消费消息、不发送测试消息、不调用模型；完整往返需要在平台上发一条真实消息验证。

## Host 与运营配置

Host 不通过 HTTP 配置：所有者请求不能提交 Host 地址或凭据路径。运营者把 `host` 写入 Agent 的渠道配置，或由嵌入方产品通过 `router.connections` 设置并经包 API 提供 Host，见[嵌入 Agent Router](../architecture/embedding.md)（英文）。没有 Host 的 Agent 会接收并保存消息，但没有执行端应答。

独立 Router 通过 `AGENT_ROUTER_CONNECTIONS_FILE`（嵌入时为 `createRouter` 的 `connections` 选项）提供邮件服务：一个包含 `mailServices`（`id`、`label`、`url`、`attachmentOrigins`）的 JSON 对象。不提供邮件连接时无需此配置。Router 不加载云密钥或环境方案。

每个 Agent 的连接保存在状态目录的 `connections/agents/<agentId>/channels.json`，凭据文件在同一目录。请持久保存整个状态目录。配置变更是原子的：先停止旧消费者再启动新的；Agent 有运行中或结果未知的运行时拒绝变更。

已保存的配置里如果还有 `matrix` 类型的连接，仍可加载：读取文件时会丢弃该连接，不启动也不列出。
