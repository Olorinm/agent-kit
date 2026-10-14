# Agent Environment


本版直接复用 OMA 的 sandbox 源码，见[来源和更新方式](docs/upstream.md)。衍生版本目前仅用于本地／私有验证，公开分发需先确认上游授权。

[English](README.md) | [简体中文](README.zh-CN.md)

用一套 TypeScript API 和 CLI，为任意 Agent 创建和管理云端执行环境。

通过官方 E2B SDK 接入阿里云 Agent Sandbox 和火山云 VCI Agent Sandbox。我们的 Agent Host 和 OMA 都可以使用，无需绑定对方的 Agent 内核、账号或数据库。

```text
我们的服务 / OMA
        │ 选择云和模板，保存环境 ID
Agent Environment
        ├── 阿里云 Agent Sandbox
        └── 火山云 VCI Agent Sandbox
                    └── 镜像、工具、Agent 运行时
```

## 提供什么

- 创建、查询、列出、暂停、恢复、续期和销毁环境。
- 执行命令，流式返回标准输出和错误输出，保留退出码，支持取消。
- 按原始字节读写文件、递归列出文件。
- 接入 OMA 的 `SandboxClient`，保留它已有的文件系统和工作区校验。

镜像、CPU、内存、网络和持久化目录由云端**模板**定义。环境里运行 Codex、Pi、Claude Code 还是其他内核，由调用方的镜像或启动命令决定。

这是独立库和运维 CLI。账号、用户归属、配额、Agent 绑定与调度仍由上层负责；本模块不负责搭建 VKE/ACS 底座。[Mau](https://github.com/Olorinm/mau) 负责产品开通和 Host 自动启动，见[接入说明](docs/integration.md)。

## 开始使用

需要 Node.js 24+，以及已部署的云端沙箱服务地址、API Key 和模板。

```sh
npm ci
npm run build
node dist/cli.js --help
```

把[配置示例](examples/providers.json)复制到仓库外，填入服务地址和密钥文件路径；密钥文件权限设为 `0600`。这里使用的是**沙箱服务 API Key**，不是云账号 AK/SK。

```sh
node dist/cli.js create --config /secure/providers.json --provider volc --template node-tools --seconds 600
# 将返回的 {"provider":"volc","id":"..."} 存入 Agent 的环境绑定。
node dist/cli.js exec --config /secure/providers.json --provider volc --id SANDBOX_ID -- node --version
node dist/cli.js pause --config /secure/providers.json --provider volc --id SANDBOX_ID
node dist/cli.js resume --config /secure/providers.json --provider volc --id SANDBOX_ID
node dist/cli.js destroy --config /secure/providers.json --provider volc --id SANDBOX_ID
```

在其他项目中使用时，先 `npm pack`，再安装生成的包；目前尚未发布到 npm。

## 两家云的差异

| 能力 | 阿里云 | 火山云 |
| --- | --- | --- |
| 显式暂停、恢复 | 已实现适配 | 已实现适配 |
| 到期自动暂停 | `onTimeout: 'pause'` | 不支持，需显式暂停 |
| 恢复进程内存 | 不作保证 | 不作保证 |
| 持久化工作区 | 在模板中配置并校验挂载 | 在模板中配置并校验挂载 |

火山适配器会先刷新磁盘写入，再请求暂停；查询到 `paused` 后再恢复。恢复使用原来的环境 ID；环境丢失会报错，不会偷偷新建。断线不会被当成“环境不存在”或“命令成功”。取消后请求终止进程，最多等待十秒确认退出；未确认时记录执行结果不确定。SDK 请求连接还有独立超时。

上层需要按环境串行处理生命周期变更和工作，并持久化环境归属。创建请求丢失响应时，用自己记录的操作标识查询云资源，核对后再决定是否重试。模块不自动重试创建，也不提供分布式锁；metadata 筛选不是用户隔离措施。

## 接入与验证

- [OMA / Agent Host 接入说明](docs/integration.md)
- [云端配置与能力差异](docs/providers.md)
- [实际验证状态](docs/verification.md)
- [部署方式](docs/deployment.md)

```sh
npm test
npm run test:package
npm run test:oma
npm run check:upstream -- /path/to/open-managed-agents
# 创建一个计费沙箱，验证执行、文件、暂停恢复，然后销毁：
npm run probe -- --config /secure/providers.json --provider volc --template node-tools \
  --workspace /home/user/workspace --report state/probe.json
```

OMA 测试直接读取它的源代码，不修改参考仓库。真机测试会把环境 ID 和清理结果记录到私有报告。复用范围与来源见 [NOTICE](NOTICE)。
