# Verification

## Automated checks

`npm test` runs the 119 extracted OMA sandbox tests and provider/workspace checks covering both provider adapters, real local command execution and the official E2B SDK against a loopback HTTP fixture. It checks argument quoting, cancellation, nonzero exit, binary files, explicit reconnect, error handling, lifecycle request bodies, authentication, pagination and disk flushing before a VCI snapshot. The HTTP fixture exercises control-plane calls; envd execution is covered separately and by the live probe.

`npm run test:package` installs an actual tarball into a clean consumer and checks both public exports and the CLI. `npm run test:workspace:oma -- CHECKOUT` verifies the original OMA interface and native filesystem rather than a copied approximation.

## Live cloud acceptance

| Provider | Status |
| --- | --- |
| Alibaba | Credentials deferred by the owner. OMA's prior Alibaba deployment is reference evidence, not a live test of this new module. |
| Volcengine | Passed on 2026-10-13 using VKE v1.36.1, agent-sandbox v0.4.6-vke.6 and envd 0.2.10. |

The complete Volcengine probe passed create → exact binary write/read → command execution → filtered list → disk flush and pause → reconnect from a new client using the same ID → compare restored bytes → remove file → destroy and confirm missing. Kubernetes events confirmed the original pod was removed and a new pod created during resume.

Separate live checks passed stdout/stderr separation, exit code 7, quoted/empty/Unicode/newline arguments, recursive file listing and command cancellation with an observed remote exit. The live run used a vendor Debian image with a test entrypoint, not an installed Codex/Pi agent, and verified container filesystem snapshots rather than OSS/TOS/NAS mount attestation.

The run exposed three provider details now handled by the module: VCI's string `NOT_FOUND` error code, reconnect not extending a running sandbox's lifetime, and flushing disk writes before a snapshot. Deployment findings are in [providers.md](providers.md): regional image reachability and the Kubernetes proxy's stripped username header. Credentials and raw operational reports remain outside version control and the npm package.

Do not read the adapter capability table as a cloud acceptance report. Use `npm run probe` against a real endpoint and a template with a durable writable directory. It records the environment ID immediately, checks exec/files/list/pause/resume and destroys the created environment in `finally`. A failed create may have succeeded remotely; reconcile using its probe metadata before retrying.

The probe destroys its sandbox, not an existing VKE/ACS cluster, volume, template or gateway. Foundation resources and retained cloud snapshots require separate cleanup and verification. After this acceptance run, cloud queries confirmed removal of the disposable cluster, load balancer, public IP, two security groups, four retained snapshots and image cache. The temporary IAM key was disabled and deleted, and its user and custom policy were deleted. The pre-existing network and five authorized official VKE service roles were retained. The local diagnostic proxy was stopped.

## Router → Environment → Host acceptance

On 2026-10-13 the merged Router and Host integration was deployed against a new
persistent Volcengine VKE/VCI service. This is separate from the disposable probe
above. The operator's existing account created a new Agent through
`agent-router setup NAME --environment PROFILE`; the image started Host after
Router uploaded the private configuration bundle. An actual Codex 0.162.0 process
using model `gpt-6.1-sol` completed a Router task with a shell-written marker file.

CLI pause reached `paused` and the original pod was removed. Resume retained the
same sandbox ID, created a new pod, and restored the Host/native state and file.
A second Router task in the original context read the unchanged marker through a
shell tool and recalled the phrase from the first turn. This verifies actual
model execution and native conversation continuation, beyond HTTP readiness.
The image also contains lark-cli 1.0.97; no Lark account or channel was added to
this new Agent as part of acceptance.

The production environment uses a private registry image by digest, automatic
registry pull-credential refresh, private control/data gateways and a restricted
SSH tunnel. User-specific native login state and per-Agent Host tokens are
injected privately; they are absent from the image, repository and package.
These resources remain deployed. Alibaba and OSS/TOS mount attestation remain
outside this acceptance scope. See [deployment.md](deployment.md).

## Shared TOS workspace acceptance — 2026-10-14

A separate live run on the persistent VKE/VCI service passed both actual CSI
mount attestations, two-container binary/Unicode/percent-literal file sharing,
owner-prefix isolation, public signed download, same-ID pause/resume preserving
both private snapshot and shared bytes, and object survival after destroying
both sandboxes. Both test environments were removed. Retained test volumes,
templates and snapshots are tracked separately in private operational reports.

This checks real TOS storage and VCI mounts with the Host image (including Python
3), but does not itself run an LLM turn. The script is
`scripts/probe-workspace.mjs`; private reports and cloud credentials are excluded
from the package and Git. Runtime dependency audit reports no known vulnerabilities.
