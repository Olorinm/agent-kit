# Agent Host

[English](README.md)

Agent Host 是面向各类产品和个人使用场景的开源 Agent 接入层。产品提供自己的上下文、工具和用户交互，Agent Host 负责连接原生 Agent，返回执行过程和结果。

**七个内核，两种接入方式：**支持 Codex、Claude Agent、Pi、OpenCode、Kimi Code、Hermes 和 OpenClaw。可以嵌入产品后台，也可以作为独立 HTTP 服务运行，两种方式共用同一套内核适配。

**当前为 alpha 版本。** 可直接安装 [GitHub Release 包](https://github.com/Olorinm/agent-host/releases)，不必克隆源码；尚未发布到 npm。实际验证版本与能力范围见[内核支持清单](docs/kernel-support.md)。

HTTP 服务保留附件的实际字节、内核支持的原生图片输入与图片工具结果，具体限制见[媒体输入](docs/http-service.md#media-input)。语音和视频理解由所选内核的模型或工具提供。

## 核心理念

**最大程度保留原生 Agent 的能力，让任何产品和个人都能通过简单、统一的方式使用它。**

1. **尊重原生内核。** 执行过程、工具、会话和权限由内核自己负责；接入层完整传递它所支持的输入、输出和操作。内核的特色能力要有明确的扩展入口，暂未接入或无法使用的能力要说清楚。
2. **让接入和使用足够简单。** 配置 Agent、发任务、看进度、处理审批和提问、取消执行、继续会话，都应有清晰一致的使用方式。嵌入式和 HTTP 应在运行环境允许的范围内开放相同的原生能力，差异应能在使用前查明。

**统一的是使用方式，能力可以因内核而异。** 常用操作提供统一接口，特色功能通过明确的扩展入口使用。宣称支持一项能力，需要有实际实现和验证依据；接入过程中的能力损失或限制必须明确告知。

[实现差距清单](docs/capability-gaps.md)逐项记录了实现、验证结果，以及仍然受原生内核和运行环境限制的部分。

## 提供什么

- 创建和继续原生会话；按内核能力列出、读取、分叉和删除会话。
- 用统一回调处理审批、提问和表单，接收文本、推理进度、用量和原生工具事件。
- 选择服务端允许的原生参数，追加指令、压缩会话、取消执行。
- 个人可直接通过 `agent-host init`、`doctor`、`run` 开始任务。
- 接入产品工具，把内核支持的审批和结构化提问交给产品界面处理。
- 保留 Agent 自己的模型循环、原生工具、对话记录和权限语义。
- 按内核能力提供运行中补充指令、压缩会话等可选操作。
- 查询统一的能力说明，用 `createAgent()` 选择嵌入式内核，同时保留它原有的方法和配置。
- 明确存储、运行配置和产品权限的边界。

产品拥有自己的界面、账号、业务权限、长期记忆策略和数据；Agent Host 负责与原生 Agent 的接入。不同内核的能力并不完全相同，具体以[支持清单](docs/kernel-support.md)为准。

## 可选的 React 聊天组件

`@olorinm/agent-ui` 提供可复用的消息、Markdown、输入框、执行过程、审批、提问和资源卡片。它是独立仓库 [Olorinm/agent-ui](https://github.com/Olorinm/agent-ui) 的安装包，Agent Host 核心不依赖 React。产品继续管理自己的数据、权限和文件操作。

接入方式见 [React UI 说明](docs/react-ui.md)，也可以运行[独立文档编辑器](examples/react-editor/README.md)。

## 两种使用方式

- **嵌入式**：从构建包安装 `@olorinm/agent-host`，在产品的 Node.js 后台直接调用，由产品管理启动、停止和存储。
- **独立后台**：运行 `agent-host serve --config host.json`，产品通过 HTTP 连接。后台保存任务和结果，转交产品工具调用、审批和提问。

从[快速开始](docs/quickstart.md)、[统一接口说明](docs/common-api.md)或[HTTP 后台接入说明](docs/http-service.md)开始。原生内核的安装和登录单独配置。

通过[能力查询](docs/capabilities.md)，可以在展示功能前区分已经实现、需要配置、需要原生协商和尚未接入的操作。

## 示例和验证

- [终端文件编辑器](examples/file-editor)：批准或拒绝修改、保存文档、取消执行，以及重启后继续原生会话。
- [浏览器文件编辑器](examples/http-editor/README.md)：作为独立产品连接 HTTP 服务，通过自己的界面处理文件修改。

示例使用同一套公开接口。安装包测试会在仓库外安装构建包，并覆盖七个内核适配。自动化模拟测试与真实模型测试的范围分别记录在[内核支持清单](docs/kernel-support.md)中。

## 设计和范围

[职责与范围](docs/scope.md)说明产品、Agent Host 和原生 Agent 各自负责什么；[Rivet 后端评估](docs/rivet.md)记录当前适配方案对原生会话恢复的要求。

## 许可证

[Apache-2.0](LICENSE)。原始代码署名保留在 [NOTICE](NOTICE) 中。
