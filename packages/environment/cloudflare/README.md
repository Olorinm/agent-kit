# Cloudflare trial gateway

An operator gateway over Cloudflare's native Durable Object Container API.
The existing Environment interface remains unchanged; Mau handles accounts,
ownership and lifecycle coordination, while Host retains native Agent sessions,
tools and approvals. This is a bounded trial, not a completed production migration.

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
| [Startup script](examples/start-host.sh) | `/opt/agent-environment/start.sh` |

The checksum manifest must name `/opt/agent-environment/agent-host.tgz`.
Mau supplies Host configuration, per-Agent token and readiness hashes separately.
Use the existing Host profile, directory `/home/user/.agent-host-service`,
port 37420, `onTimeout: "pause"`, lifetime 1800 seconds and idle pause 600 seconds.
Assign the profile to the intended owner; do not use a shared credential for
unrelated users. Mau must load an Environment build containing this adapter.

The first launch installs the verified Host package, pinned native Codex CLI,
system CA certificates and basic tools. Subsequent launches reuse the snapshot.
For production, replace runtime installation with a verified immutable image.
SSH upgrade forwarding and shared OMA object-storage mounts are not validated
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
- Container placement is selected by Cloudflare. This trial does not promise
  a particular region or data residency. Check destination network access with
  the real native runtime before migrating traffic.

## Verification

Adapter fixtures: from the parent directory run `npm test` and
`npm run test:package`. Gateway validation: `npm run check && npm test`.

The existing live probe provisions and destroys a billable environment:

```sh
node scripts/probe.mjs --config /private/providers.json --provider cloudflare \
  --template node24 --workspace /workspace --report /private/probe.json
```

Run it from the parent directory. Where a local Node installation needs a proxy,
configure it explicitly, for example `NODE_USE_ENV_PROXY=1`; never copy a local
proxy address into the guest.

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
reviewed model endpoints and native Codex read-only workspace routing discovery, read-only npm package fetches and signed Debian package
repositories. The container cannot widen the policy. The ephemeral Cloudflare TLS
inspection CA is added to the system and Node trust stores before Host starts.
Read `src/egress.mjs` when changing native runtime dependencies; do not disable TLS
verification to fix a failed request.

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
limits; a manifest is committed only after every part is present. Recovery uses a
separate operator credential that returns ciphertext only. Retention policy belongs
to the private R2 bucket: daily objects are locked for 30 days and expire after 31;
weekly objects are locked for 84 days and expire after 85. Cloudflare administrators
can change bucket rules, so retain an independently encrypted copy outside Cloudflare.

`backup/scripts/server-backup.py` performs consistent SQLite backups and a PostgreSQL
logical dump, encrypts the archive with the public recipient, uploads checksum-verified
parts and records the committed manifest. Keep the recovery identity in an independent
password manager/offline location. A successful upload is not a restore test: retrieve
parts, verify their hashes, decrypt locally, run SQLite `quick_check`, and restore the
PostgreSQL logical dump in a disposable database before relying on the backup.

Configure a Cloudflare custom email alert for the three service Workers' safe error
logs and failed health checks, plus budget notifications. The monitor runs hourly;
notification delivery and retention settings must be verified in the account console.
`backup/scripts/agent-backup-mirror.py` keeps two checksum-verified encrypted Agent
exports outside Cloudflare. Its root-only `/etc/mau-agent-backup-mirror.json` contains
the `gateway` and `backupUrl` HTTPS endpoints, an operator gateway credential and the ciphertext recovery API credential, **not**
the age recovery private key. Run it daily after the Cloudflare export cron (the
production timer is 04:15 Asia/Shanghai with up to 10 minutes jitter). It refuses
exports older than 36 hours. Inspect the systemd service result separately: the
Cloudflare log alert does not currently monitor this mirror's local service status.
Do not make a mirror failure prevent the primary server backup from running.

Native Codex OAuth remains owner-scoped in the Agent's private filesystem. This design
moves business/Feishu tool credentials into the connector, not native model sign-in
or Mau's communication-channel credentials.
