# Changelog

Notable changes to Agent Kit, newest first. All packages share one version. Pushing a `v<version>`
tag publishes a GitHub Release whose notes are this file's section for that version, so add the
section in the version-bump commit before tagging. Changes up to the versions listed under
0.8.0-alpha.1 are in each package's own `CHANGELOG.md`.

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
