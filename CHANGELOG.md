# Changelog

Notable changes to Agent Kit, newest first. All packages share one version. Pushing a `v<version>`
tag publishes a GitHub Release whose notes are this file's section for that version, so add the
section in the version-bump commit before tagging. Changes up to the versions listed under
0.8.0-alpha.1 are in each package's own `CHANGELOG.md`.

## [0.11.0-alpha.16] - 2026-11-24

- Router: deliver scheduled and delegated input as one JSON object, `{ "from": …, "message": … }`, as a native tool output where the runtime takes one and as text otherwise. The fixed notice, the `Source:` line and the boundary line of a text delivery are gone, and so are `source.kind`, `source.reference` and the sender's id in what a model reads. A session that exists keeps its definition; its next delivered turn has the new object.
- Router: `WorkSessions.submit` accepts `json: true` with the text of a JSON object as `input`. Its members are delivered beside `from` in place of `message`. `notice` is removed.
- Router: `WorkSessions.resetOwnerConversation()` continues the owner conversation in a new window, for a product whose instructions or tool definitions changed. It refuses a busy conversation (`session_busy`) instead of cancelling its turns.

## [0.11.0-alpha.15] - 2026-11-23

- Send an ACP session its stable instructions once per process: when the session is created or resumed, and again after a compaction. Per-turn context still precedes every prompt.
- Keep the agent, conversation and source of a turn out of the Host request's `context`. A linked Host is still told who is asking.
- Add channel routing IDs to a turn only for a group message or a quoted message. A direct chat's turn is the message alone.
- Use `notice: "brief"` for delegated text from a named partner. Router includes the sender and the existing permission boundary before the message.

## [0.11.0-alpha.14] - 2026-11-23

- Fix duplicate Pi message-start events when the 1.6 harness delays persistence of an assistant message.
- Restore the environment's selected skill groups after restart. Preserve the product addendum and locally edited guides when updating or pruning the official bundle.
- Update the connector, router and Cloudflare dependencies. Resolve agent-browser 0.43.0 and its bundled guides from its platform package, and align the offline skill bundle with Lark CLI 1.0.100.

## [0.11.0-alpha.13] - 2026-11-23

- Add Antigravity and DeepSeek Harness through the shared ACP adapter. Support native model configuration, session binding and product tools.
- Update the supported Codex, Claude, Pi, OpenCode, Kimi, Hermes and OpenClaw releases. Pi uses its public Durable 1.6 event API and can enable the official Bash extension.
- Allow explicitly configured product tools to relay from a local employee shell using the running kernel's session identity.
- Add gateway-held Gemini, Anthropic, DeepSeek and GitHub credentials. The GitHub route supports HTTPS Git and the official GitHub CLI. The gateway verifies a stored credential's service before use.
- Install headless Chromium and the official browser CLI for workspace pages. Ship verified upstream Lark, Google Workspace Gmail and agent-browser skills for offline installation.

## [0.11.0-alpha.12] - 2026-11-22

- Hold OpenAI model credentials at the Cloudflare gateway, preserve rotated credentials across imports, and bind model requests to the selected account.
- Install credential-free Codex login files under the guest user's permissions before restoring managed workloads.

## [0.11.0-alpha.11] - 2026-11-22

- Upgrade Agent Host to Zod 4.6.7 and refresh the Hono dependencies used by Host and Connectors.

## [0.11.0-alpha.10] - 2026-11-21

- Router lets an embedding product edit an agent's name and description together. Direct chats
  show its current name. Its address, runtime, device link and conversation history stay with its ID.

## [0.11.0-alpha.9] - 2026-11-19

- **Host:** `agent-host link --url <router> --code <pairing code>` pairs a machine with a Router and
  keeps an outbound WebSocket to it; `agent-host serve` reconnects to a stored link by itself,
  with backoff up to 30 seconds. Through the link a Router reaches one runtime and only health,
  that runtime's description, runs with their events, cancel and steer, and calls. Workspace
  files, native sessions, the native extension and the relay answer `403 link_route_not_allowed`,
  and a linked submission that carries `instructions`, `tools`, `toolOutput`, `inputItems` or
  `attachments` is refused. The device credential is stored in `link.json` in the state
  directory. See `packages/host/docs/host-link.md`, which also describes running the service at
  sign-in on Windows, macOS and Linux.
- **Host:** `interactionTimeoutMs` in `host.json` sets how long a native approval or question
  waits for an answer (default 120000, unchanged).
- **Host:** `startAgentHostServer` accepts `link`; the server package exports `enrollHostLink`,
  `readHostLink` and `routerBaseUrl`.
- **Router:** host links. `POST /_agent-router/v1/host-links/pairing-codes`, `GET /host-links`
  and `DELETE /host-links/:linkId` let an owner pair, list and revoke machines;
  `POST /host-links/enroll` (pairing code) and the `/host-links/socket` upgrade (device
  credential) are the machine's two entry points. `createRouter(...).hostLinks` is the same for
  embedding code, with `subscribe` for `enrolled`, `online`, `offline` and `revoked`. Host
  bindings `link:<linkId>` are resolved by Router. See `packages/router/docs/guides/host-links.md`.
- **Router:** a Host that connects by itself (`HostPort.online`) is given no work while it is
  away: tasks stay queued instead of becoming `unknown`. A submission that provably never left
  Router (`host_offline`) returns to the queue. A restricted Host (`HostPort.restricted`) is
  sent no instructions, tools, native input items, tool output or attachments.
- **Router:** an approval or question asked by a work turn that has no `reply` route is now a card
  in the turn's session instead of being dropped: the web chat API lists it, counts it and takes
  the owner's answer, and it closes like any card of a run. No channel message or push is sent for
  it. `WorkEventResult.pendingCards` (`cardId`, `chatId`, `kind`, `text`, `choices`,
  `deadlineAt`, `origin`) reports the cards a work event's turn is waiting on.
- **Router:** a card of a turn that delegated or scheduled work started carries `origin`
  (`kind`, `reference`, `sender`), and its text begins with a line that says the owner did not
  start the turn. This also applies to such turns submitted with `reply`.
- **Router:** `HostBindingProvider.http` and `checkChannels` take a `HostTransport`
  (`ServiceHttp` is one). `HostRuns` holds the run operations of `HttpAgentHost` for any transport.

## [0.11.0-alpha.8] - 2026-11-19

- **Router:** `ServiceDependencies.authorizeOperator(principal, request)` lets the embedding
  product allow a single request by a service token without owner access that the default
  refuses. It is called only for such a request, after the Access assertion verified; only an
  exact `true` allows it, and a hook that throws refuses. The allowed principal is marked
  `granted`. The CSRF check applies to a granted request as to an owner's.
- **Router:** every entry of `routerApiReference` has a `scope` (`read`, `chat`, `approve`,
  `manage` or `owner`), and `routerRouteScope(method, path)` returns the scope of a request.
  A path it does not know returns `undefined`; a product must treat that as a refusal.

## [0.11.0-alpha.7] - 2026-11-19

- **Router:** `DELETE /_agent-router/v1/agents/:agentId/connections/:connectionId` disconnects
  a channel connection: it leaves the agent's configuration, its worker stops and the
  credential files Router wrote for it are removed. Chat history stays. Unknown connections
  (and the built-in `web` and `room`) return `404 connection_not_found`; an agent with an
  active or unknown run returns `409 agent_has_active_or_unknown_run`.
- **Router:** `GET` and `PUT /_agent-router/v1/agents/:agentId/connections/:connectionId/access`
  read and replace a connection's `groupIds` and `peerAddresses` without a restart. The
  channel's own validation applies. Existing sessions are kept.
- **Router:** `routerApiReference` lists every owner-facing HTTP route (method, path, summary,
  request body schema, whether a default service token may call it). A test compares it with
  the routes the app registers.
- **Router:** the managed-agents guide states exactly when a bearer token is accepted.
- **Environment:** provider kind `docker` runs each environment as a local Docker container
  through the `docker` CLI, for trying a product on one's own machine. It keeps the Cloudflare
  provider's contract for files, commands, pause and resume. It does not enforce
  `modelServices` or `modelAccounts` and has no automatic timeout. A `docker` entry in the
  providers file needs no `apiUrl` or `apiKeyFile`.

## [0.11.0-alpha.6] - 2026-11-19

- **Router:** approvals (kernel permission requests, connector approvals, `approval` owner
  requests) are decided only by a button or the card answer route with `choiceId`. A typed
  reply no longer approves or rejects; it is delivered to the agent as an ordinary message. On
  channels without buttons an approval message points to the web console.
- **Router:** a pending pairing code that appears in a message outside a direct chat is
  revoked when the message is received.
- **Router:** a Cloudflare Access service token is an operator by default. It reads as its
  owner and may only send a web chat message, open a DM chat, mark a chat read and request a
  socket ticket; other requests return `403 owner_sign_in_required`. Set
  `{ "owner": "...", "access": "owner" }` in `serviceTokens` to keep full access.
  `OwnerRequest` accepts `originalUrl`; `OwnerPrincipal` has `operator`.
- **Router:** the CSRF check accepts the request's own host as `Origin` only over HTTPS (HTTP
  only for loopback hosts).
- **Connectors:** approval summaries are never shortened. A write whose summary exceeds 3500
  characters fails with `approval_too_long_to_display` before any operation is created. `gws`
  and `lark-cli` summaries show every argument in full, with control, bidirectional,
  zero-width and unusual space characters written as escapes; `gws` summaries use JSON-style
  quoting.
- **Connectors:** a command that repeats an option is refused before approval:
  `feishu_flag_repeated` unless lark-cli's help declares the option repeatable,
  `gws_flag_repeated` for any repeated long option.
- **Connectors:** lark-cli runs with an allow-listed environment instead of inheriting the
  service's environment.
- **Connectors:** browser site permissions per connection. New sites open directly (default)
  or ask first; always-allowed sites and per-task permissions (`task` in the tool input, 24 h
  idle) are managed with `GET|PUT /v1/connections/:id/access`. Commands and page-started
  top-level navigations are held to permitted sites; refusals are
  `browser_site_permission_required` / `browser_site_command_too_long`, and blocked
  navigations are reported in the command output. Connectors can expose owner-managed access
  rules (`Connector.access`).
- **Connectors:** browser URL checks refuse trailing-dot and single-label hosts, CGNAT,
  further IPv6 private forms and metadata names, and no longer refuse names that start like
  an IPv6 prefix. Download capture reads the response as a bounded stream. The handoff banner
  keeps no link from the Agent; the upload approval summary names the site first and quotes
  file names.
- **Environment:** `modelAccounts` on create and resume holds an environment to its own
  account at a model service. With `{ openai: [...] }` the gateway requires a ChatGPT access
  token of a listed account on `chatgpt.com/backend-api/**` and refuses `api.openai.com`.
  `/security` reports the stored value.
- **Environment:** backup ingress: refused uploads no longer count against the daily quota. A
  manifest is committed only when the first part starts with an age header for one
  non-passphrase recipient and, when `BACKUP_RECIPIENTS` is set, names one of those
  recipients. The example configuration disables `workers_dev`.

## [0.11.0-alpha.5] - 2026-11-19

- **Router:** Feishu group chats follow the group allowlist. The owner can mention the bot in
  any group; anyone else is admitted only when the group is in `groupIds` and the sender is in
  `peerAddresses`. A refused message is stored as `ignored` and gets no reply or session. The
  adapter hook for an open group policy is removed.
- **Connectors:** `gws_read` / `gws_write` classify a command by its method's HTTP verb only;
  `--dry-run` no longer makes a write a read. `--api-version` is refused, as are attached and
  combined short forms of the refused file flags (`-o/path`, `-a/path`).
- **Connectors:** the browser connection's `handoff_start` result includes `pageHost`, the
  host of the page handed over.

## [0.11.0-alpha.4] - 2026-11-18

- **Router:** an agent's store lease is written again only in its second half. The
  five-second heartbeat wrote the lease on every beat, one synchronous commit per agent every
  five seconds on an idle service; it now writes every third beat. The lease is still 30
  seconds, and a second process is refused for as long as before.

## [0.11.0-alpha.3] - 2026-11-18

- **Connectors:** the store's SQLite database runs in WAL mode with `synchronous = FULL` and a
  five-second busy timeout, as Router's stores do, so one replication or backup tool handles
  every database of a deployment. SQLite creates the WAL and shared-memory files with the
  database file's 0600 mode. An existing database is converted when the service opens it.
- **Environment:** the backup ingress's hourly check covers the sources named in
  `UPLOAD_TOKENS` instead of two names fixed in code, as does `GET /v1/status`, and a failed
  check throws, so the invocation is recorded as failed. Remove a retired server's upload
  credential, otherwise the check keeps failing for it. A deployment without an upload
  credential fails the check.
- **Environment:** the same check's liveness request used a fetch option the Workers runtime
  rejects, so it reported the product as down on every run. It now passes when the endpoint
  answers 2xx without a redirect.
- **Environment:** `backup/scripts/server-backup.py` takes its configuration file as its
  argument and accepts `exclude` patterns. It no longer dumps a PostgreSQL container, keeps no
  archive on the machine after the upload, and applies no built-in exclusions.
  `backup/scripts/agent-backup-mirror.py` is removed.

## [0.11.0-alpha.2] - 2026-11-18

- **Environment:** the model endpoints a sandbox may reach are selected per environment. The
  Cloudflare gateway's outbound allowlist keeps its rules as reviewed source, grouped into named
  model services (`openai`, and new `anthropic`: `POST /v1/messages`,
  `POST /v1/messages/count_tokens` and `GET /v1/models` on `api.anthropic.com`), and the product
  names the services of an environment with `modelServices` on create and on resume. The gateway
  keeps the list on the environment's record and gives it to the egress entrypoint at each container
  start; a running container keeps the list it started with. Without a list the default is
  `openai`, which admits exactly what the gateway admitted before, and package fetches (npm,
  Debian) are unchanged. The guest cannot change the list. `GET /v1/environments/:id/security`
  reports it.
- **Environment:** `CreateEnvironment.modelServices` and
  `resume(id, timeoutSeconds, { modelServices })` in the client. A caller that passes neither sends
  the same requests as before.
- **Router:** `WorkSessions.submit` and `WorkSessions.request` accept `display`, a JSON object the
  product defines (at most 64,000 bytes) for showing the input or the card. It is recorded on the
  input event or on the card and returned by the web chat API as the message event's `display` or
  as `card.display`. Router does not interpret it, and it is not part of the model input, the
  context, the admission, the Host request or a message sent to an external channel. Too large a
  value is refused with `work_display_too_large` or `owner_request_display_too_large`. Work
  submitted without it is recorded exactly as before; Host scope, session definitions and
  execution bindings are unchanged.

## [0.11.0-alpha.1] - 2026-11-17

- **Router:** an embedding product can work in an agent's owner conversation without a message
  from the owner. `WorkSessions.openOwnerConversation()` returns its session id and makes it a
  `submit` target before the owner has written; the owner's later messages continue the same
  session and native thread. Work submitted there earlier used to open a Host session without the
  channel tool, which the owner's first message then conflicted with; an existing session is not
  changed.
- **Router:** `WorkSessions.submit` accepts `reply: { connectionId? }` for a turn in the owner
  conversation. The turn then answers the owner like a turn started by a channel message: its
  answer, notices and the cards of its questions and approvals are recorded once and sent through
  the delivery queue along a route chosen by the `connectionId` rule of `deliver` (omitted: the
  connection the owner was last on; `web`: the transcript; a notify connection: a push; another
  connection: the owner's conversation there, or `suppressed` with
  `no_conversation_on_connection`). The notify policy applies as for an owner's web turn, and
  `get`, `lookup` and `wait` return the receipt as `reply`. Work submitted without `reply` is
  unchanged.
- **Router:** owner requests. `WorkSessions.request` puts a card with choices in the owner
  conversation that belongs to no run, for a decision the product needs about something that
  happens elsewhere. It is an ordinary ledger card (`source: "product"`), shown and answered on
  the web and in channels like a card of a run; the first answer wins. It is idempotent by event
  id, expires at `expiresAt`, and can be withdrawn; `lookupRequest` and `withdrawRequest` read
  and close it.
- **Router:** `WorkSessions.settlements({ after, limit })` lists, by a durable cursor, the work
  events whose turn ended and the owner requests that were closed, so a product does not have to
  poll each event.
- **Router:** delegated and scheduled input reaches runtimes that take no native tool output.
  Before such a turn Router asks the Host whether the runtime takes native input items. A runtime
  that reports them as unsupported gets the input as text behind a fixed notice that names its
  source and says that no human wrote or authorized it; such turns used to fail with
  `native_tool_output_unsupported`. Every other case, including Codex and a Host that does not
  answer, gets the same tool output as before.
- **Router:** `WorkSessions.submit` accepts `sender: { kind: "agent", id, name }` for delegated
  and scheduled input. The sender is recorded on the input event, returned by the web chat API
  as the event's `sender`, and included in the source the model is given. The web API also
  returns `origin` (`work`, `delegation` or `schedule`) on inputs that no channel message
  carried.
- **Router:** ledger schema step 6 adds `ledger_pending_inputs.route`, `ledger_cards.route` and
  the `ledger_settlements` table. Existing rows are not rewritten. Host scope, session definitions
  and execution bindings of existing sessions are unchanged, and no tool definition changed.
- **Host:** runtime inspection reports `input.nativeItems` from the flag that admits `inputItems`
  and `toolOutput`, so a caller can tell before submitting whether a runtime takes them. A custom
  runtime is reported as `supported` or `unsupported` by that flag instead of `unknown`.

## [0.10.0-alpha.4] - 2026-11-13

- **Host:** a Codex turn that selects no model names the runtime's configured `model` again.
  Codex keeps a turn's model for the thread's following turns, so after one turn had selected
  another model, later turns without a selection stayed on it instead of returning to the
  configured one. A runtime without a configured `model` is unchanged.

## [0.10.0-alpha.3] - 2026-11-13

- **Router:** an agent can have default native settings. `WorkSessions.setDefaultSettings`
  stores a selection such as `{ model, effort }` and Router sends it with every turn of that
  agent, including turns started by channel messages, which could not carry settings before. A
  work event's own `settings` win key by key and compaction takes none. Host still decides which
  values are allowed; a turn whose setting Host refuses fails with `setting_not_allowed:<key>`
  and a message saying so, and is not retried with other settings. `WorkSessions.inspect()`
  returns the runtime description, including its allowed settings, without a native handshake.

## [0.10.0-alpha.2] - 2026-11-13

- **Host:** a runtime's `allowedSettings` list is no longer part of its configuration key. Adding,
  changing or removing the values an owner lets callers select (model, effort and the other
  per-run settings) used to make every existing session of that runtime fail with
  `409 session_configuration_conflict`; those sessions now continue, and a selected value is still
  checked against the current list on each run. The key of a runtime that has no list is unchanged,
  so upgrading keeps existing sessions.
- Dependency updates across the packages; Environment builds with TypeScript 7. `@larksuite/cli`
  in Connectors stays at 1.0.97.

## [0.10.0-alpha.1] - 2026-11-13

- **Router:** the owner ledger is the only record of channel messages. The inbox and outbox
  documents (`communication_inbox`, `communication_outbox`) that every message was also written to,
  and the code that kept the two in step, are gone.
  - A received message is kept on its ledger claim; dispatch reads only pending inputs. What is
    sent (text, native content, the turn it belongs to) is kept on its delivery row, which is the
    send queue. Owner notifications and pairing replies are delivery rows as well.
  - A message that cannot be recorded no longer falls back to a second record. A channel still
    acknowledges it, so its cursor and the messages behind it are not held up, and the message is
    kept with the error in `ledger_ingress_failures` and listed by the channel status as
    `receiptFailures`; a redelivery is tried again. A web send or a group message fails instead and
    is retried by its caller.
  - The ledger switches are removed: the web API, card answers, cancel/steer/reset/purge, groups,
    identities with `/link` pairing, and attachments are always on. `GET /web/me` no longer has
    `limits.features`; a client that waited for a feature to be advertised must stop checking.
  - An agent whose ledger cannot be opened or migrated does not start.
  - Operators: no step is required. On first start each agent's store is migrated (ledger schema 5):
    stored messages and queued sends are moved onto their ledger rows, then the old documents are
    deleted. A stored message that never had a ledger claim is not kept. `AGENT_LEDGER_READ`,
    `AGENT_LEDGER_SEND`, `AGENT_LEDGER_CARDS`, `AGENT_LEDGER_CONTROL`, `AGENT_LEDGER_GROUPS`,
    `AGENT_LEDGER_IDENTITY` and `AGENT_LEDGER_ATTACHMENTS` are ignored and can be deleted.
  - Embedding API: `ServiceConfig` has no `ledgerRead`, `ledgerSend`, `ledgerCards`, `ledgerControl`,
    `ledgerGroups`, `ledgerIdentity` or `ledgerAttachments`. `ManagedService.web`, `.identity`,
    `.attachments` and `.fanout` are always present, and `createRouter(...).upgrade` always handles
    the event socket. `CommunicationCore.input(taskId)` returns a `ChannelInput` (the same fields as
    before, read from the ledger); the `InboxRecord` and `OutboxRecord` types are removed, and
    `AgentLedger.attached` is replaced by `AgentLedger.open`. The channel status keeps `inbox` and
    `outbox`; `outbox` no longer lists replies to the web connection, whose event is its delivery.

## [0.9.0-alpha.1] - 2026-11-12

- **Router:** the service (`ManagedService`, `createManagedApp`) lives in `src/service/managed.ts`,
  the standalone entry in `src/service/main.ts` (`npm run agent:service` starts
  `dist/service/main.js`) and the per-agent runtime in `src/agents/runtime.ts`; `src/matrix/` is gone.
- **Router:** removed Matrix and everything built on it. Router is now accounts and agents, channel
  connections, the owner ledger and task delivery to Agent Host.
  - Removed: the Matrix transport, Application Service, per-agent Matrix toggle and `matrix` connection
    kind; the social/contacts/rooms API, A2A between agents over Matrix and federation; `/directory`;
    external identity (`ars_` sessions, `/auth/exchange`, `AGENT_IDENTITY_CONFIG_FILE`); the per-agent
    HTTP gateway (`/agents/:id/gateway/*`) and instance routes (`/agents/:id/instances`), so work is
    taken only by the in-process Host worker; the Go CLI `agent-router` with its install script and
    release archives; the standalone connector (`agent-router-connector`); the TypeScript SDK
    (`packages/sdk`) and `examples/echo-agent`; `compose.yaml`, `Dockerfile`, `Caddyfile`, `deploy/`,
    `scripts/matrix` and the two-homeserver lab; the guides, specification, conformance document and
    ADRs 0002–0004 that described them.
  - Operators: no configuration change is required. `MATRIX_SERVER_NAME` is still read, as the account
    namespace. `AGENT_MATRIX`, `MATRIX_HOMESERVER_URL`, `MATRIX_AS_TOKEN_FILE`, `MATRIX_HS_TOKEN_FILE`
    and `MATRIX_ADMIN_TOKEN_FILE` are ignored. `ledgerRead` without `ledgerSend` is rejected at start.
    A `matrix` connection left in a stored channel configuration is ignored.
  - Embedding API: `ServiceConfig` has no `matrix`, `homeserver`, `asToken`, `hsToken` or
    `externalIdentity`; `ServiceDependencies` has no `provision`, `transport` or `deprovision`;
    `service.runtime(id)` resolves to an `AgentRuntime` (`store`, `work`, `extension`) instead of
    `{ connector, app, token, extension }`; agent API objects and the `GET /web/me` features have no
    `matrix` member; `externalIdentityConfigSchema` is no longer exported; the package has no `bin`.
    A bearer token is resolved only by `ServiceDependencies.authenticate` (401
    `account_login_required` without it) and its result is not cached.
  - `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md` and `SECURITY.md` moved to the repository root and cover
    all packages.

## [0.8.0-alpha.2] - 2026-11-12

- **Router:** removed the one-time migration tools that moved a deployment from Matrix to the
  owner ledger (`ledger:backfill`, `ledger:promote-media`, `matrix:export`, `matrix:forget`) and
  the `GET /web/debug/ledger` diffing endpoint. Deleting an agent whose Matrix account is dormant
  no longer records it in `matrix_orphans`.
- **Host:** removed the package exports `./environment/windows-discovery`,
  `./environment/windows-query`, `./transport`, `./acp/mcp-server`, `./native-session-lock` and
  `./openclaw/plugin`; the modules remain internal and the OpenClaw plugin is still loaded from
  `plugins/openclaw`. Removed the manual probe scripts, the `probe:codex` script and the
  `AGENT_HOST_NATIVE_COVERAGE` option of `test:package`. Removed the dated upgrade, evidence,
  audit and evaluation documents and `examples/cloud` from the package. The two editor examples
  depend on the package directory that contains them instead of a fixed archive version. The
  service store no longer reads run records written before event kinds were tracked.
- **Connectors:** the package root no longer exports `GENERIC_CATALOG`, `defaultSetting`,
  `PolicyOperationView`, `LIMITS`, `TOKEN_TYPES`, `TokenError`, `operationDigest` and
  `CloudflareBrowserRun`. Removed the `Dockerfile` and the `test:cloudflare` script; run
  `npm test` in `cloudflare/` instead.
- **Environment:** requires Node.js 24 or later. Removed `scripts/probe.mjs` and the `probe`
  script. The Cloudflare start script example installs Codex 0.166.0.
- **CI:** Host is tested on Linux and Windows, Connectors and Environment on Linux, all with
  Node.js 24.22.2.

## [0.8.0-alpha.1] - 2026-11-12

First release from this repository. Host, Router, Connectors and Environment now share one
version and one release; they continue from Host 0.1.0-alpha.14, Router 0.7.0-alpha.14,
Connectors 0.1.0-alpha.11 and Environment 0.2.0-alpha.3.

- **Release:** one tag `v<version>` publishes every package, the Router CLI archives and a single
  `SHA256SUMS` covering all of them. `scripts/set-version.mjs` sets the version everywhere.
- **Environment:** Cloudflare is the only provider; the provider interface is unchanged and
  further providers are added through the factory table in `src/config.ts`. Removed the Alibaba
  and Volcengine providers, the E2B driver, the OSS and TOS workspace stores, and the `./sandbox`,
  `./contracts`, `./sdk`, `./oma` and `./workspace` exports. The package has no runtime
  dependencies and is distributed as a regular `.tgz` archive.
- **Host:** removed the React editor example and the UI package test; dropped the unused
  `@earendil-works/pi-agent-core` dependency. No runtime change.
- **Router:** the CLI reads its version from `package.json`. `scripts/install.sh` installs
  releases from this repository.
- **Connectors:** no functional change.
