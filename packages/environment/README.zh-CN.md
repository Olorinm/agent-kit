# Agent Environment

[English](README.md) | [简体中文](README.zh-CN.md)

用一套 TypeScript API 和 CLI，为任意 Agent 创建和管理云端执行环境。

目前提供一个供应商：**Cloudflare**。它通过运维网关调用 Cloudflare 原生的 Durable Object
Container API；网关源码和独立的加密恢复备份在 [cloudflare/](cloudflare/README.md)。

```text
上层服务
        │ 选择供应商和模板，保存环境 ID
Agent Environment
        └── Cloudflare 网关（cloudflare/）
                    └── 容器：工具、Agent 运行时
```

## 提供什么

- 创建、查询、列出、暂停、恢复、续期和销毁环境。
- 执行命令，流式返回标准输出和错误输出，保留退出码，支持取消。
- 按原始字节读写文件、递归列出文件。
- 为环境内某个端口返回带鉴权的 HTTP 地址。

镜像、CPU、内存和磁盘由网关**模板**定义。环境里运行 Codex、Pi、Claude Code 还是其他内核，由调用方的镜像或启动命令决定。

这是独立库和运维 CLI。账号、用户归属、配额、Agent 绑定与调度由上层负责；[Mau](https://github.com/Olorinm/mau) 是其中一个调用方，见[接入说明](docs/integration.md)。

## 开始使用

需要 Node.js 24+，以及已部署的 [Cloudflare 网关](cloudflare/README.md)。

```sh
npm ci
npm run build
node dist/cli.js --help
```

把[配置示例](examples/providers.json)复制到仓库外，填入网关地址和密钥文件路径；密钥文件权限设为 `0600`。这里使用的是网关的控制凭据，不是 Cloudflare 账号令牌。

```sh
node dist/cli.js create --config /secure/providers.json --provider cloudflare --template node24 --seconds 600
# 将返回的 {"provider":"cloudflare","id":"..."} 存入 Agent 的环境绑定。
node dist/cli.js exec --config /secure/providers.json --provider cloudflare --id ENVIRONMENT_ID -- node --version
node dist/cli.js pause --config /secure/providers.json --provider cloudflare --id ENVIRONMENT_ID
node dist/cli.js resume --config /secure/providers.json --provider cloudflare --id ENVIRONMENT_ID
node dist/cli.js destroy --config /secure/providers.json --provider cloudflare --id ENVIRONMENT_ID
```

在其他项目中使用时，安装 GitHub Release 里的包（或 `npm pack` 后安装生成的包）；没有发布到 npm。

## 需要注意的行为

- `pause()` 只确认请求已受理；查询到 `paused` 后再恢复。到期会保存文件系统快照并停止计算，不恢复进程内存。
- 恢复使用原来的环境 ID；环境丢失会报错，不会偷偷新建。
- 断线不会被当成“环境不存在”或“命令成功”。没有确认退出的命令会标记为执行结果不确定，核对后再暂停或重试。
- 上层需要按环境串行处理生命周期变更和工作，并持久化环境归属；创建请求丢失响应时，用自己记录的操作标识核对后再决定是否重试。metadata 筛选不是用户隔离措施。

## 新增供应商

供应商实现 [src/types.ts](src/types.ts) 里的 `EnvironmentProvider`：生命周期（`create`、`info`、`list`、`resume`、`pause`、`destroy`、`setTimeout`）、命令执行（`exec` 以及 `hasUncertainExecution` / `resetExecutionUncertainty`）、文件（`readFile`、`writeFile`、`removeFile`、`listFiles`）和 `httpEndpoint`。参考实现是 [src/cloudflare.ts](src/cloudflare.ts)。

1. 新增 `src/<供应商>.ts`，导出 `create<Provider>Provider(options)`。
2. 在 [src/config.ts](src/config.ts) 的 `factories` 表里登记它的 `kind`，配置文件才能选用。
3. 在 [src/index.ts](src/index.ts) 导出，并在 `test/` 下用本地夹具服务写测试。

凭据只放在配置引用的私有密钥文件里，不要写进 metadata 或环境 ID。

## 验证

```sh
npm test
npm run test:package
```

网关另有检查：在 `cloudflare/` 下 `npm ci && npm run check && npm test`，以及 `node --test cloudflare/backup/test/*.test.mjs`。这些测试只用本地夹具，不会创建云端环境。
