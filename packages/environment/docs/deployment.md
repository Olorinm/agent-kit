# Deployment recipe

Agent Environment is a library in Router's trusted process. Host runs inside each
sandbox. The cloud foundation and network are configured by the operator.

## Image and cloud foundation

1. Install VKE's official `vci-virtual-kubelet` and `agent-sandbox` addons with
   authenticated E2B enabled. Keep the controller's cloud credentials outside
   sandbox images and metadata. Use the official addon role and permission setup.
2. Build the merged Agent Host source with its `--ready-file` support, run its
   package tests, and copy the resulting archive as `agent-host.tgz` beside
   [the tested Dockerfile](../examples/host/Dockerfile). Build for the target CPU
   architecture, push to a reachable regional registry, and pin the image digest
   in your SandboxTemplate. This example installs Codex and lark-cli; choose a
   different image/runtime for other kernels. It contains no native login state.
3. Start from [the VCI template](../examples/volcengine-template.yaml), replace its
   image, and use a suitable termination grace period (30 seconds was tested).
   Keep envd injection enabled, a Bash-capable `user` account, and no service
   account token mounted in the sandbox. Templates are addressed by the E2B
   service as `namespace--template-name` in the tested VCI deployment.
4. For a private Volcengine CR image, use the official `cr-credential-controller`
   addon to maintain pull credentials for the chosen namespace/service account.
   Verify that its generated secret is refreshed. The tested CR Micro instance
   does not support robot accounts or private VPC endpoints; do not assume either
   feature when choosing an image-pull recipe.

## Network

Route the authenticated control plane and data plane through a documented TLS
ingress, or keep both on private networks. The tested deployment uses two private
load balancer services selecting `app=agent-sandbox-control-plane` (8081) and
`app=agent-sandbox-data-plane` (8080). Do not reuse a VKE-managed load balancer
between these services when the cloud controller rejects that ownership.

When Router is outside that VPC, an SSH tunnel can terminate on a VPC machine.
Bind local forwarding to Router's private container bridge, use pinned host keys,
and restrict the SSH key with `restrict,port-forwarding` and exact `permitopen`
destinations. Run the tunnel under a restarting supervisor. Restrict SSH to the
Router source address; do not publish sandbox ports on the Internet.

Configure `apiUrl` for control-plane traffic and `sandboxUrl` / `serviceUrl` for
envd / Host traffic. Explicit `allowHttp` is appropriate only for the private
HTTP segments. The cross-network tunnel is encrypted. Preserve the SDK routing
headers and Host's own `Authorization` header; the Kubernetes API proxy strips
headers and is unsuitable for this production path.

Sandboxes and addon controllers also need outbound access to their API endpoints.
Configure VPC egress or an existing private proxy. The optional
[`scripts/private-tcp-forward.mjs`](../scripts/private-tcp-forward.mjs) bridges a
private listener to an existing proxy without altering HTTP headers. Configure
`LISTEN_HOST`, `LISTEN_PORT`, `UPSTREAM_HOST`, and `UPSTREAM_PORT`; bind/publish only
on a private interface and restrict the listener to the sandbox subnet. It does
not add authentication, filtering, or a cloud network policy.

If addon API requests use a proxy, set `HTTP_PROXY` and `HTTPS_PROXY` on the addon
deployment, and bypass the Kubernetes API, service DNS, loopback and platform
metadata addresses with `NO_PROXY`. Verify controller API calls and image pulls.
An addon upgrade may overwrite deployment environment settings; reapply and
verify them as part of that upgrade. Native model processes need their own
runtime proxy configuration where required.

## Router onboarding

Follow [Router's cloud setup guide](https://github.com/Olorinm/agent-router/blob/main/docs/guides/cloud-environments.md).
Install the built Environment archive into Router, mount its private provider and
Host profile files, and assign profiles to their allowed account owners. Use
per-user native credentials; do not share an operator's login with all accounts.
Retain Router's operation journal and per-Agent Host tokens across upgrades.

```sh
agent-router login @alice:agents.example
agent-router setup-options
agent-router setup helper --environment cloud-codex
agent-router setup-check
# Optional, after the environment is ready:
agent-router channel-connect feishu
```

Readiness verifies the authenticated Host/runtime. Acceptance also requires an
actual model task, a tool-written file, and same-ID pause/resume with a continued
native conversation. A new conversation gets its context ID from Router; reuse
that returned ID for follow-ups. Do not invent an ID before opening a conversation.

VCI pause/resume restores disk state, not process memory. With the current adapter,
Volcengine lifetime expiry kills the environment: Router renews ready environments,
but choose a lifetime and durable storage for Router outages. Keep a private
inventory of cloud resources, service paths, image digests and backup locations.
Cluster, registry, load balancers and retained snapshots have their own lifecycle
and billing, independent of whether the Agent is paused.
