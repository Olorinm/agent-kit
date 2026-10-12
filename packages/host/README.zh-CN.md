# Agent Host

[English](README.md)

Agent Host 是面向各类产品的开源 Agent 接入层。产品提供自己的上下文、工具和用户交互，Agent Host 负责连接原生 Agent，返回执行过程和结果。

**七个内核，两种接入方式：**支持 Codex、Claude Agent、Pi、OpenCode、Kimi Code、Hermes 和 OpenClaw。可以嵌入产品后台，也可以作为独立 HTTP 服务运行，两种方式共用同一套内核适配。

**当前为 alpha 版本。** 源码已公开，可从构建包安装，尚未发布到 npm。实际验证版本与能力范围见[内核支持清单](docs/kernel-support.md)。

## 提供什么

- 创建和继续原生会话，接收流式进度，取消执行。
- 接入产品工具，把内核支持的审批和结构化提问交给产品界面处理。
- 保留 Agent 自己的模型循环、原生工具、对话记录和权限语义。
- 按内核能力提供运行中补充指令、压缩会话等可选操作。
- 明确存储、运行配置和产品权限的边界。

产品拥有自己的界面、账号、业务权限、长期记忆策略和数据；Agent Host 负责与原生 Agent 的接入。不同内核的能力并不完全相同，具体以[支持清单](docs/kernel-support.md)为准。

## 两种使用方式

- **嵌入式**：从构建包安装 `@olorinm/agent-host`，在产品的 Node.js 后台直接调用，由产品管理启动、停止和存储。
- **独立后台**：运行 `agent-host serve --config host.json`，产品通过 HTTP 连接。后台保存任务和结果，转交产品工具调用、审批和提问。

从[安装与接口说明](docs/api.md)或[HTTP 后台接入说明](docs/http-service.md)开始。原生内核的安装和登录单独配置。

## 示例和验证

- [终端文件编辑器](examples/file-editor)：批准或拒绝修改、保存文档、取消执行，以及重启后继续原生会话。
- [浏览器文件编辑器](examples/http-editor/README.md)：作为独立产品连接 HTTP 服务，通过自己的界面处理文件修改。

示例使用同一套公开接口。安装包测试会在仓库外安装构建包，并覆盖七个内核适配。自动化模拟测试与真实模型测试的范围分别记录在[内核支持清单](docs/kernel-support.md)中。

## 设计和范围

[职责与范围](docs/scope.md)说明产品、Agent Host 和原生 Agent 各自负责什么；[Rivet 后端评估](docs/rivet.md)记录当前适配方案对原生会话恢复的要求。

## 许可证

[Apache-2.0](LICENSE)。原始代码署名保留在 [NOTICE](NOTICE) 中。
