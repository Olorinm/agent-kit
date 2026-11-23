# Cloudflare gateway

An operator gateway over Cloudflare's native Durable Object Container API.
The existing Environment interface remains unchanged; Mau handles accounts,
ownership and lifecycle coordination, while Host retains native Agent sessions,
tools and approvals. The Environment package also has a local
[Docker provider](../README.md#docker-local) for trying things out; it enforces none of this gateway's restrictions.

## Deploy

Requires Workers Paid and Node.js 24+. Run `npm ci`, `npm run check`, and
`npm test` in this directory. Copy `wrangler.example.jsonc` to a private location,
set `account_id`, choose the Worker name, and make `main` point to `src/index.ts`
in this checkout. Use the pinned local Wrangler, not an older global executable.

Generate two independent random secrets of at least 32 bytes, named
`CONTROL_TOKEN` and `ACCESS_SIGNING_KEY`. Put them in a private mode-0600 JSON
file; upload with:

```sh
./node_modules/.bin/wrangler deploy --config /private/wrangler.json
./node_modules/.bin/wrangler secret bulk /private/worker-secrets.json --config /private/wrangler.json
```

Until secrets are configured, authenticated routes fail closed. Do not put
secrets, account IDs or deployment state in this repository. Save the control
token to a separate mode-0600 file for the Environment client:

```json
{
  "providers": [{
    "id": "cloudflare",
    "kind": "cloudflare",
    "apiUrl": "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",
    "apiKeyFile": "gateway-key"
  }]
}
```

Use template `node24`. It starts the official `cloudflare/debian-trixie` image
with 2 vCPU, 6144 MiB memory and 10000 MB disk. The default limit is three
environments including paused environments. The default lifetime is 600 seconds;
expiry saves a filesystem snapshot and stops compute. Change resource sizes
in the gateway source only after checking Cloudflare's supported combinations.

## Start Host through Mau

Package and independently verify Agent Host first. Supply these files in a
Mau profile, in this order:

| Private source | Guest destination |
| --- | --- |
| Verified Host archive | `/opt/agent-environment/agent-host.tgz` |
| SHA-256 manifest for that archive | `/opt/agent-environment/agent-host.sha256` |
| Native credential file for this owner | `/home/user/.codex/auth.json` |
| [Verified offline connector skills](examples/official-skills.tgz) | `/opt/agent-environment/official-skills.tgz` |
| Optional product-specific skill addendum | `/opt/agent-environment/mau-sandbox/SKILL.md` |
| [Startup script](examples/start-host.sh) | `/opt/agent-environment/start.sh` |

The checksum manifest must name `/opt/agent-environment/agent-host.tgz`.
Mau supplies Host configuration, per-Agent token and readiness hashes separately.
Use the existing Host profile, directory `/home/user/.agent-host-service`,
port 37420, `onTimeout: "pause"`, lifetime 1800 seconds and idle pause 600 seconds.
Assign the profile to the intended owner; do not use a shared credential for
unrelated users. Mau must load an Environment build containing this adapter.

The first launch installs the verified Host package, pinned native Codex CLI,
system CA certificates and basic tools. If a Host profile selects Antigravity, the starter downloads the matching Linux build and verifies its pinned SHA-512 digest. A DeepSeek Harness profile installs the pinned official DSH npm package. Subsequent launches reuse the snapshot.
The verified bundle contains 25 Lark skills, nine Gmail/shared skills and the agent-browser discovery skill.
The bundle preserves upstream instructions, references and support files. It includes a source manifest with commit IDs and licenses.
It is reproducible from the [pinned upstream archives](scripts/bundle-skills.py). The starter copies selected skills into
`~/.agents/skills`, `~/.claude/skills`, `~/.gemini/config/skills` and `~/.hermes/skills` before Host starts.
An environment with the Mau addendum starts with its browser skill and sandbox instructions. Mau selects additional groups using the connections assigned to the environment. The selection survives restarts and bundle upgrades. A generic environment initially installs all groups. Locally edited skills and other user-authored files stay in place.
The script also installs a browser for the pages the Agent serves inside the environment: Debian's
`chromium-headless-shell` with Latin, CJK and emoji fonts, and the official agent-browser CLI,
unmodified, at the version Agent Connectors pins. Run the CLI as `/opt/local-browser/agent-browser`,
which sets the Chromium path and the arguments a container needs and passes everything else on; the
file appears when the installation has finished. That happens in the background after the first
launch so that Host does not wait for it, about 285 MB to download and 670 MB on disk. The gateway's
network policy admits no websites, so this browser reaches only what the environment serves.
For production, replace runtime installation with a verified immutable image.
SSH upgrade forwarding and shared object-storage mounts are not validated
for this gateway; do not enable those profile options.

## Security and lifecycle

- The gateway has operator authority. End users and Agents must not receive its
  control token or a Cloudflare account token.
- Host requests carry a five-minute HMAC capability scoped to one environment
  and port, plus Host's separate per-Agent token. Mau refreshes the capability
  for each request. The gateway strips its own credentials before forwarding.
- TLS protects transit. Worker secrets protect deployment configuration; they
  are not a replacement for a dedicated credential broker or customer KMS.
  Native credentials inside an Agent's own filesystem remain readable to that
  Agent and are included in its filesystem snapshots.
- Pause saves files, not RAM or live processes. Host and the native kernel
  restart from persisted state. Stop active Agent runs before requesting pause;
  an accepted asynchronous Host task can outlive its HTTP request. Mau's normal
  lifecycle guard and lifetime renewal are required.
- Concurrent command/file I/O and HTTP response streams block pause, including
  automatic pause. Long-running work can therefore exceed the nominal lifetime;
  this is not a hard spending cap. A disconnected command stream is
  marked uncertain by the client until reconciled. Native cancellation targets
  the started process; it does not promise termination of every descendant.
- Snapshot restoration fails closed when the snapshot is missing or expired.
  There is no fallback to an empty environment. Cloudflare documents snapshot
  retention of 30 days since creation or last restoration. Keep independent
  backups for long-lived user data.
- Destroy removes the environment, not retained snapshots. Snapshot references
  are retained in private Durable Object storage for audit. This API currently
  exposes no snapshot deletion; storage may remain billable until expiration.
- File transfers are limited to 16 MiB per file; recursive listings to 10000
  files. Invocation logs must stay disabled. Explicit audit logs contain only safe event codes, resource IDs, outcomes and byte counts; never log headers, commands, request bodies or results.
- Container placement is selected by Cloudflare. The gateway does not promise
  a particular region or data residency. Check destination network access with
  the real native runtime before migrating traffic.

## Recover a stopped process from its existing snapshot

An operator can call `POST /v1/environments/:id/recover` with the existing
`X-Environment-Control` credential and
`{"fromLatestSnapshot":true,"timeoutSeconds":600}`. The confirmation is required;
the timeout defaults to 600 seconds. This restores the latest saved filesystem
snapshot in the same environment ID. Changes made after that snapshot are not
included. Recovery refuses a running container, a missing snapshot, and records
other than `running` or `unknown`; use normal resume for a paused environment.

Recovery starts a fixed `sleep infinity` maintenance process instead of the guest's
startup script. It retains the same outbound network policy, CA setup and runtime
allowance. Arbitrary images, snapshots and entrypoints cannot be supplied. The
response and subsequent operator `/info` include `maintenance:true` and `snapshotId`
so an interrupted response can be checked without repeating restoration.
The maintenance window always pauses on expiry, even if the environment's normal
timeout policy is `kill`; that saved policy is retained for normal operation.

Use the existing authenticated `/exec` or `/files` routes to inspect and repair the
program. Then pause to persist the repaired filesystem and resume normally to run
the original startup script. Confirm Host health before reconciling Mau's existing
binding. Recovery does not create another environment, import transcripts, change
native session IDs or grant new access. This is filesystem recovery, not process
memory continuation.

## Verification

Adapter fixtures: from the parent directory run `npm test` and
`npm run test:package`. Gateway validation: `npm run check && npm test`.

These checks use local fixtures and do not create cloud environments.

Real cloud acceptance on 2026-10-20 confirmed create, separate command streams,
binary files, listing, explicit pause and resume with the same ID and file bytes.
Separate native acceptance confirmed Host startup, both application and Host
authentication, a real Codex filesystem read, and conversation plus file
continuity after snapshot restoration and process restart. Execution acceptance
confirmed that pause rejects a running command, disconnect marks the result
uncertain, and cancellation stops the observed process before reconciliation.
Fixture, cloud, native model and full Mau onboarding checks remain distinct.

Upstream: [Container API](https://developers.cloudflare.com/containers/api/durable-object-container/).


## Managed secrets, network restrictions and independent backups

Set the backup Worker’s `HEALTH_CHECK_URL` to your product’s HTTPS liveness endpoint.
The security deployment binds a private R2 bucket as `BACKUPS`, and configures
`BACKUP_RECIPIENT`, `AGE_KEY`, `AGE_SHA256`, and `DAILY_RUNTIME_MINUTES`. Upload the
verified Linux amd64 age binary to the configured artifact key. The recipient is an
age public key; keep its private recovery identity off the servers, Workers, R2 and
Agent filesystems. No separate KMS subscription is required for this design.

The outside-of-guest egress Worker denies arbitrary destinations. It admits only the
reviewed model endpoints, native Codex read-only workspace routing discovery, read-only npm package fetches, signed Debian package
repositories and GitHub endpoints selected by the operator. The container cannot widen the policy. The ephemeral Cloudflare TLS
inspection CA is added to the system and Node trust stores before Host starts.
Read `src/egress.mjs` when changing native runtime dependencies; do not disable TLS
verification to fix a failed request.

Package fetches are always admitted. Model endpoints are grouped into named model
services in `src/egress.mjs`, and each environment reaches only the services selected
for it:

| Service | Admits |
| --- | --- |
| `openai` | ChatGPT Codex backend and workspace discovery, `api.openai.com` responses and model list, `auth.openai.com` token refresh |
| `anthropic` | `api.anthropic.com`: `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models` and `GET /v1/models/:id` |
| `google` | Antigravity (`agy`) with a Gemini API key, on `generativelanguage.googleapis.com`. Key held by the gateway (`modelCredentials.google`): every path and method of that host. Key in the guest: `POST /v1beta/models/<model>:streamGenerateContent` only |
| `deepseek` | DSH on `api.deepseek.com` with a held API key. Model listing, Messages, and Files collection and item operations |

What the `google` service admits depends on who holds the key:

- **The gateway holds it** (`modelCredentials.google`, see below): the whole Gemini API on that host, any path and
  method. Every request leaves under the owner's key and the guest's own credentials are removed, so whatever the
  guest sends, uploaded files included, stays in the owner's own project.
- **The guest holds it**: only the one request Antigravity CLI 1.5.15 made for a turn with
  `modelProvider: "gemini"` and `GEMINI_API_KEY`, in print mode and through `agy acp`, a turn with a shell command
  included. The gateway cannot tell whose key a request carries. With files, caches or tuning admitted, a guest
  that is talked into it could use someone else's key to put the owner's files into that person's project. Model
  listing and the other Gemini API methods stay closed for the same reason.

In both cases its Google sign-in (the Cloud Code backend and OAuth), Vertex AI, its telemetry and every other
Google host are not admitted: each is a change to the rule.

The product selects services with an optional `modelServices` array in the create
body and in the resume body (`{"timeoutSeconds":600,"modelServices":["openai","anthropic"]}`).
Without it, a new environment uses `["openai"]`, the same destinations as before, and
a resume keeps the stored list. An empty array admits package fetches only. Unknown or
repeated names are refused: `invalid_create` on create, `invalid_model_services` on
resume. The list is stored with the environment and applied when its container
starts, including a recovery start. A running container keeps the list it started
with; a resume that changes the list of a running environment stores it for the
next start. `/security` reports the effective list as `modelServices`: the stored
selection, or the default when there is none. After such a change it is the list for
the next start.

A destination rule does not say whose account a request uses: a guest that is talked into it could send the
owner's data to the same provider with someone else's credential. `modelAccounts` in the create or resume body
(`{"modelAccounts":{"openai":["<ChatGPT account id>"]}}`, at most eight ids) holds an environment to its own
account:

- `chatgpt.com/backend-api/**`, WebSocket upgrades included, needs `Authorization: Bearer <access token>` whose
  `https://api.openai.com/auth` claim `chatgpt_account_id` is listed, and a `ChatGPT-Account-ID` header, when
  present, must be listed too. Otherwise the answer is `403` with `model_account_required` (no token, or not a
  ChatGPT access token) or `model_account_not_allowed`. The gateway decodes the token without verifying its
  signature: the provider refuses a token it did not sign, so a token that names a listed account is that
  account's or useless.
- `api.openai.com` is refused (`model_api_key_not_allowed`). An API key names no account, and a kernel signed in
  with ChatGPT does not use that host. Do not set `modelAccounts` for an environment whose kernel uses an API key.
- `auth.openai.com/oauth/token` stays open: a token refresh stores nothing.
- Only `openai` can be listed. An Anthropic credential (`x-api-key` or a bearer token) cannot be mapped to an
  account without asking the provider, so the `anthropic` service is not held to an account. Neither is `google`:
  an API key names no account.

Without `modelAccounts` nothing about a request's credential is checked, as before. The value is stored with the
environment and applied when its container starts; a resume without the field keeps it, `{}` removes it, and a
resume of a running environment stores it for the next start (pause and resume to apply it at once). An invalid
value is refused with `invalid_create` or `invalid_model_accounts`. `/security` reports it as `modelAccounts`
(`null` when unset).

### Credentials held by the gateway

The gateway can keep a model credential itself, so the real one never enters the guest. The operator stores it
under an ID and selects it per environment; the guest keeps a placeholder, and the egress Worker replaces what the
guest sends before the request leaves.

| Request | Does |
| --- | --- |
| `PUT /v1/model-credentials/<id>` | Stores or replaces a credential. With `If-None-Match: *` an existing one is kept and returned |
| `GET /v1/model-credentials`, `GET /v1/model-credentials/<id>` | Metadata only: `id`, `service`, `mode`, `accountId`, `expiresAt`, `renewable`, `updatedAt`. No token or key is ever returned |
| `DELETE /v1/model-credentials/<id>` | Removes it. Environments that select it are refused at the model host from then on |

| Body | Sent as |
| --- | --- |
| `{"service":"openai","mode":"chatgpt","accessToken","refreshToken"?,"accountId"?,"clientId"?}` | `Authorization: Bearer <access token>` and `ChatGPT-Account-ID` on `chatgpt.com`. The gateway refreshes the token; the guest cannot reach `auth.openai.com` |
| `{"service":"openai","mode":"api_key","apiKey"}` | `Authorization: Bearer <key>` on `api.openai.com` |
| `{"service":"google","mode":"api_key","apiKey"}` | `X-Goog-Api-Key: <key>` on `generativelanguage.googleapis.com` |
| `{"service":"anthropic","mode":"api_key","apiKey"}` | `x-api-key` on the reviewed Messages and Models paths at `api.anthropic.com` |
| `{"service":"deepseek","mode":"api_key","apiKey"}` | `x-api-key` on the reviewed DSH paths at `api.deepseek.com` |
| `{"service":"github","mode":"token","accessToken"}` | HTTP Basic for Git smart HTTP on `github.com`, Bearer for `api.github.com` and release asset uploads on `uploads.github.com` |

Select credentials with `modelCredentials` in the create or resume body
(`{"modelCredentials":{"openai":"<id>","google":"<id>"}}`). The value is stored with the environment and applied
when its container starts; a resume without the field keeps it and `{}` removes it. `/security` reports the IDs.
Include the corresponding model service (`anthropic`, `google`, or `deepseek`) in `modelServices`. A `github` credential enables its own egress rule.
GitHub HTTPS clone/fetch/push, REST/GraphQL (including pull requests) and release uploads run with the selected token's scopes.
Each response redirect goes back through the egress policy. GitHub Enterprise, SSH, Git LFS and off-host asset downloads require additional routes.
The Cloudflare starter installs `gh` for this binding. `GH_TOKEN` and the native CLI fallback `hosts.yml` hold a placeholder.
The model bindings supply placeholders for `ANTHROPIC_API_KEY` and `DEEPSEEK_API_KEY`.

- With `modelCredentials.google`, a request to `generativelanguage.googleapis.com` loses every credential the
  guest sent (the `X-Goog-Api-Key` and `Authorization` headers, the `key`, `access_token` and `oauth_token` query
  parameters) and gets the held key in `X-Goog-Api-Key`. Antigravity only checks that `GEMINI_API_KEY` is not
  empty, so the guest's value can be any placeholder.
- A credential is sent only to its own service. An ID under `openai` that names a Google credential, or the
  reverse, is refused with `model_credential_service_mismatch`: at create and resume (`400`), and again on every
  request (`403`), since a credential can be replaced after an environment selected it. A Gemini key never
  reaches an OpenAI host and an OpenAI key or token never reaches Google.
- When the selected credential does not exist the request is refused with `model_credential_missing` (`403`). It
  is never forwarded with the guest's own credential instead.
- A Gemini API key has nothing to refresh. To rotate it, `PUT` the new key under the same ID: requests use it at
  once, running environments included.

Only the holder of the operator credential can select services, accounts or credentials. Nothing inside the
guest can change the list, and no request can add a destination: the rule sets are
reviewed source. Admitting another provider or a private model gateway host means
adding a service to `src/egress.mjs` with tests and redeploying the gateway.

A configurable daily runtime allowance blocks another start after the allowance is
used and requests pause when idle. Concurrent work can defer pause. It is not a hard
account spending cap; budget notifications also do not stop billing. Maintenance
exports, snapshots, connector compute and storage have separate usage.

Pause commits a filesystem snapshot before stopping the guest. A daily encrypted
export is then made from that stopped snapshot, without starting Host: Host uses an
exclusive SQLite lock while running. SQLite databases are copied with the backup API
and bounded lock waits. The archive includes `/home/user`, `/projects` and `/workspace` when present. Dependencies and caches are excluded. Only age ciphertext
leaves the guest; the Worker writes bounded chunks and a final checksum manifest.
An export failure logs an error and leaves the recoverable pause snapshot intact.
The daily maintenance cron exports paused snapshots and refreshes their restoration
retention. `/security` reports the last successful export; `/backup` retries an export
only while paused. Neither endpoint is available without the operator credential.

`backup/src/index.ts` is the separate server-backup ingress and monitor. Each server
has an upload-only credential scoped to its source and current dated prefix. It cannot
list, read, overwrite or delete R2 objects. Uploads have per-source daily byte/object
limits, which only stored objects count against; a manifest is committed only after every part is present, the
first part starts with an age header for exactly one recipient that is not a passphrase, and, when the
`BACKUP_RECIPIENTS` variable (a JSON array of age public keys) is set, the manifest's `recipient` is one of them
(`recipient_refused`, `not_an_age_archive`). These checks catch a wrong or missing recipient in a server's backup
configuration. They do not hold against whoever has an upload credential: an age header does not reveal its
recipient's public key and the manifest's `recipient` is the uploader's own statement, so such a holder can commit an
archive nobody can decrypt and keep the status fresh. A second secret for the uploader would sit on the same machine
as the credential and add nothing. Only a restore with the recovery identity shows that a backup is usable; do one
on a schedule. The ingress has its own hostname (`routes`); `workers_dev` and `preview_urls` stay off. Recovery uses a
separate operator credential that returns ciphertext only. Retention policy belongs
to the private R2 bucket: daily objects are locked for 30 days and expire after 31;
weekly objects are locked for 84 days and expire after 85. Cloudflare administrators
can change bucket rules; an operator who needs protection from that keeps a copy of the
ciphertext elsewhere, read through the recovery credential.

`backup/scripts/server-backup.py CONFIG.json` archives the product's state: it copies
SQLite databases with the backup API so they are consistent while the product runs,
encrypts the archive to the public recipient, uploads checksum-verified parts and then
the manifest, and leaves nothing on the machine. Its header describes the configuration
file. It needs Python 3 and `age`. Keep the recovery identity in an independent password
manager/offline location. A successful upload is not a restore test: retrieve the parts,
verify their hashes, decrypt locally and run SQLite `quick_check` before relying on the
backup.

The monitor runs hourly. It checks the product's liveness endpoint and that every
source with an upload credential in `UPLOAD_TOKENS` committed a backup within 36 hours.
A failed check logs `mau_security_check` with `ok: false` and throws, so the invocation
counts as failed; a deployment without any upload credential fails it too. Remove a
retired server's credential from `UPLOAD_TOKENS`, otherwise the check keeps failing for
it and hides a later failure of another source. `GET /v1/status` reports the same sources.

Configure a Cloudflare email alert on the three service Workers' failures and safe error
logs, plus budget notifications. Notification delivery and retention settings must be
verified in the account console: let the check fail once and confirm the message arrives.

Native Codex OAuth remains owner-scoped in the Agent's private filesystem. This design
moves business/Feishu tool credentials into the connector, not native model sign-in
or Mau's communication-channel credentials.
