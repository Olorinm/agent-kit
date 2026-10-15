# Gateway harness refresh — 2026-10-15

Tracked by [issue #29](https://github.com/Olorinm/agent-host/issues/29). This review distinguishes upstream source contracts, deterministic protocol tests and native runtime probes. It does not certify an untested provider or platform.

## Upstream targets

| Harness | Previous tested pin | Stable target | Official evidence |
| --- | --- | --- | --- |
| Hermes | 0.21.6 | 0.22.1 | [Release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.1), published 2026-10-14 23:59:24 UTC; release commit `297552a9d646119871391d202509822cd86330df` |
| OpenClaw | 2026.9.9 | 2026.10.3 | [Release](https://github.com/openclaw/openclaw/releases/tag/v2026.10.3), published 2026-10-13 13:49:25 UTC; release commit `59cb44796b0f1f0daa0e37af8b1495abb45d9bc1` |

The versions above were checked against the official GitHub releases API on 2026-10-15. Search-engine release caches were older and were not used as the target authority.

## Hermes: preserve both native integration surfaces

Hermes 0.22 introduces a canonical Gateway authority. Its native CLI, TUI and ACP viewers can share stable logical sessions, durable admissions, execution generations and native approvals. The authority owns queued work and unknown outcomes; the Host does not recreate those mechanisms. See the [upstream local-session contract](https://github.com/NousResearch/hermes-agent/blob/v0.22.1/website/docs/developer-guide/gateway-local-sessions.md).

`HermesGatewayAgent` uses the official `hermes acp` viewer and the existing ACP adapter. Hermes itself handles daemon discovery, authentication, canonical IDs, admission recovery, MCP attachment and approval routing. The viewer closes independently of the shared Gateway. This is an explicit integration choice; existing TUI bindings are not rewritten into canonical identities. See [official ACP implementation](https://github.com/NousResearch/hermes-agent/blob/v0.22.1/acp_adapter/gateway_server.py) and [entry point](https://github.com/NousResearch/hermes-agent/blob/v0.22.1/acp_adapter/entry.py).

The canonical ACP interface advertises native resume/load, list, fork and image input. Native model changes use Hermes mutation receipts. ACP configuration/mode mutation is explicitly refused upstream. No native ACP delete or steering operation is advertised. `/compress` executes in Hermes, but ACP returns only `end_turn`, omitting the detailed compression receipt. Agent Host therefore does not advertise confirmed compaction on this surface. Embedded consumers can use the raw native RPC extension for commands while preserving that distinction. `getHermesGatewayCapabilities()` describes this surface independently of the TUI integration.

Hermes freezes each canonical session's complete editor MCP specification, including its transport arguments and environment. The Host's stable bridge preserves that specification by referencing a private connection file. The wrapper reads the current endpoint/token for every tool request; Host replacement rotates them through an atomic file replacement with POSIX mode `0600` in a `0700` directory. The HTTP service uses its existing state directory for this reference. Embedded consumers can inject an `AcpHostToolBridgeServer` with `connectionDirectory` through the caller-owned `toolBridgeProvider` option, or supply their own stable native `mcpServers` transport. The provider must remain available while native sessions use its tools and must be closed by its owner. See the [native frozen MCP policy](https://github.com/NousResearch/hermes-agent/blob/v0.22.1/gateway/session_local_mcp.py).

Forks retain the parent's native transport specification and configuration scope. The bridge rejects simultaneous activation of that shared scope rather than route one fork's tool calls into another turn. Existing ephemeral bridges remain the default for integrations that do not freeze transport configuration. Attempting to resume an older canonical session with a changed MCP specification still preserves Hermes's `acp_mcp_policy_conflict` refusal; no replacement conversation or policy rewrite is attempted.

The 0.22.1 canonical list operation also has an observed upstream limitation: its [catalog](https://github.com/NousResearch/hermes-agent/blob/v0.22.1/acp_adapter/catalog.py) filters storage rows to `source="acp"`, while freshly created canonical sessions in the native probe were stored as `source="local"`. As a result the native list was empty despite successful resume and history; a native fork used `source="acp"`. The Host returns that native list unchanged and does not infer a replacement catalog from local bindings.

The original `HermesAgent` continues to use the official TUI stdio Gateway for product-owned isolated profiles. That entry point still claims exclusive ownership and refuses to start against a profile already owned by another Gateway; it does not secretly delegate to the canonical listener. See [official stdio entry](https://github.com/NousResearch/hermes-agent/blob/v0.22.1/tui_gateway/entry.py).

The TUI integration now exposes session-scoped `fastMode` values `fast`, `normal`, `auto`, `cold` and `ultrafast`. Hermes validates provider/model availability; the Host does not change global configuration or silently substitute tiers. Whole-history forks use native `session.branch_whole`, avoiding transfer of the copied transcript. Compression success also checks native `summary.noop`, `summary.aborted` and `summary.refused_would_grow`, so a completed RPC is not mistaken for successful compaction. See [settings implementation](https://github.com/NousResearch/hermes-agent/blob/v0.22.1/tui_gateway/methods_config_set.py) and [session contracts](https://github.com/NousResearch/hermes-agent/blob/v0.22.1/tui_gateway/contracts/sessions.py).

## OpenClaw: protocol negotiation and native settings

OpenClaw retains Gateway protocol 4. Agent Host checks the negotiated protocol, preserves the advertised method/event/capability inventories, and treats advertised methods as positive evidence. Unadvertised methods remain unknown: upstream deliberately hides supported compatibility methods such as `sessions.resolve`. Native RPC errors remain authoritative. RPC failures retain native `code`, `details`, `retryable` and `retryAfterMs`; the Host does not automatically retry mutations. See the [hello/error schemas](https://github.com/openclaw/openclaw/blob/v2026.10.3/packages/gateway-protocol/src/schema/frames.ts).

`OpenClawRunRequest.fastMode` forwards the native `chat.send` values `true`, `false`, `auto` and `ultrafast`, including explicit `false`. The separate `agent` RPC lacks that field and fails explicitly if it is requested there. Steering uses the native `chat.send` `queueMode: "interrupt"` entry point, preserving the replacement run ID and cancellation semantics. The former `sessions.steer` alias is deprecated and hidden upstream. See [chat schema](https://github.com/openclaw/openclaw/blob/v2026.10.3/packages/gateway-protocol/src/schema/logs-chat.ts).

The bundled product-tool plugin continues to use the official version-2 invocation context and native Gateway registration. It does not use deprecated session-persistence/runtime aliases, impersonate browser tool bindings, or replace native approval policy. The upstream October releases change provider-native compaction defaults and repair model/runtime routing; those remain Gateway responsibilities. See [plugin API](https://github.com/openclaw/openclaw/blob/v2026.10.3/src/plugins/plugin-api.types.ts), [2026.10.2 changes](https://github.com/openclaw/openclaw/blob/v2026.10.3/CHANGELOG/2026.10.2.md), and [2026.10.3 changes](https://github.com/openclaw/openclaw/blob/v2026.10.3/CHANGELOG/2026.10.3.md).

## Verification

Deterministic adapter tests cover method negotiation and protocol mismatch, structured RPC errors, all native fast-mode wire values, whole-history fork identity, compression no-op/abort/refusal receipts, MCP tools, approvals, continuation and cancellation. Canonical Hermes fixture tests exercise the shared ACP integration and separate capability discovery; they are not a native Gateway certification.

Commands:

```sh
npm run build
node --test test/acp-tool-bridge.test.mjs test/hermes.test.mjs test/hermes-gateway.test.mjs test/openclaw.test.mjs
npm test
npm run test:package
```

Native runtime probes use isolated installations and profiles under the ignored `.local/harness-refresh-20261015/` directory. Credentials, transcripts and raw logs are not distributed. The probes ran on macOS arm64 with Node 24.18.0 and Python 3.14.4 using one configured Anthropic-compatible provider; they do not certify every provider/model or operating system.

| Native surface | Result observed on 2026-10-15 |
| --- | --- |
| OpenClaw 2026.10.3 Gateway | Protocol 4; 494 advertised methods; bundled native product-tool plugin invoked once; `fastMode: false`; close/reopen preserved native ID and recalled the earlier token; native history returned 6 messages; `chat.send` interrupt steering replaced the active native run and completed with the new instruction's answer. |
| Hermes 0.22.1 TUI stdio | Native `fastMode: "normal"`; product MCP tool invoked once; close/reopen preserved native ID and recalled the earlier token; native list/history succeeded (6 history messages); `session.branch_whole` returned a distinct fork. |
| Hermes 0.22.1 canonical ACP | Advertised image/load/list/resume/fork; native product MCP tool invoked on the first turn, again after replacing both Host and bridge, and again in a native fork (3 calls). Restart preserved the native ID and recalled the earlier token; native history returned 8 messages. An independent no-tool session also survived viewer replacement. Listing limitation described above was reproduced. |

Hermes was installed from the official 0.22.1 source tag with its `acp`, `anthropic` and `mcp` extras. The `acp` extra alone does not install MCP: without the documented `mcp` extra the canonical authority refuses product-tool discovery with `acp_mcp_discovery_failed`. The isolated runner stopped only its own profile's Gateway after verification; adapter close itself only detached the viewer.

Dedicated protocol checks cover the Gateway suites and the existing OpenClaw replacement-run steering regression in `gaps.test.mjs`. Stable-bridge checks additionally keep one actual stdio MCP process alive across bridge replacement, reject obsolete tokens, check private file permissions and verify that history/forks retain the same native MCP specification. Repository-wide tests and independent package-consumer validation belong to the combined harness refresh and are recorded with that change.
