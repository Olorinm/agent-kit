# Providers

Both adapters use the official `e2b@2.24.0` package, pinned to the version used by OMA. Provider IDs name a particular endpoint/account configuration, so two users or deployments can use different providers of the same kind.

## Alibaba Cloud

Use an existing Agent Sandbox service with an E2B endpoint and a compatible template. `domain` resolves the control plane as `https://api.<domain>` unless `apiUrl` is explicitly supplied. OMA's existing templates, CSI mount metadata and storage attestation can be retained.

`onTimeout: 'pause'` maps to E2B auto-pause with automatic resume disabled. `pausedRetention` adds Alibaba's reserve-paused-sandbox-duration metadata. OMA's 150-second claim/readiness annotations remain caller metadata, rather than global defaults for all consumers.

## Volcengine

The adapter targets **VCI Agent Sandbox's E2B service**, not the account-level ECS API. An ECS machine alone is insufficient. The documented foundation is a VKE cluster, `vci-virtual-kubelet`, the `agent-sandbox` addon with authenticated E2B enabled, and a sandbox template.

Configure the control-plane `apiUrl` and data-plane `domain` from that deployment. With only `domain`, this adapter defaults to `https://<domain>`, matching Volcengine's root-domain example. Both control plane and the wildcard data-plane route must be reachable with valid TLS. Private HTTP gateways require the explicit `allowHttp` option; never disable certificate verification globally.

For a fixed private proxy, configure `sandboxUrl` explicitly; the SDK sends `E2b-Sandbox-Id` and `E2b-Sandbox-Port`. The proxy must route those headers. Private acceptance tests can use a loopback Kubernetes API proxy; VCI virtual nodes may reject ordinary `kubectl port-forward`.

Kubernetes' API proxy strips the Basic username header used by envd RPCs. The source checkout includes `scripts/kubernetes-envd-proxy.go`, a diagnostic bridge that restores the fixed test OS user inside a private test pod while preserving sandbox access-token authentication. Build it for Linux, provide the data-plane service address explicitly, and remove it after testing. Production deployments should use the vendor's documented TLS ingress.

[The example template](../examples/volcengine-template.yaml) follows the vendor's E2B quick start. Replace its image with an agent-ready image reachable from your deployment and pin its digest for production. Without configured public egress, Docker Hub and cross-region public registry pulls can time out; use a regional private registry or configure the required outbound access. The E2B SDK expects a `user` account and Bash in the image.

Volcengine creation does not support auto-pause. The adapter runs `sync` successfully before requesting a disk snapshot; serialize work and stop concurrent writers before pausing. Explicit pause is asynchronous: confirm state before resume. Resumption can restore container filesystem snapshots but does not promise live process memory. Mount persistent user data separately according to the template. Alibaba's `.kruise.io/` mount annotations are rejected on this provider, preventing an apparently successful environment with the wrong storage recipe.

Reconnect explicitly updates the lifetime because VCI ignores the timeout on a connection to an already running sandbox. The adapter also recognizes VCI's resource-specific `NOT_FOUND` response, which E2B 2.24 otherwise surfaces as a generic error. An unrelated gateway 404 remains an error.

## Shared operational contract

- Cloud account credentials stay in the cloud deployment layer; sandbox API keys stay in private operator configuration. No key goes in an environment ref or metadata.
- Native SDK execution streams are text. File transfer preserves binary bytes; stdout is not a binary transport.
- `timeoutSeconds` is in seconds, capped at 86400. Command timeout `0` disables its SDK deadline; environment lifetime is always finite.
- Failed commands report their nonzero exit through `onExit`. Transport/startup failure throws without a synthetic exit. After an uncertain mutation, reconcile before retrying.
- Cancellation terminates the SDK process handle. Arbitrarily daemonized descendants require runtime supervision or environment destruction; there is no process-tree isolation claim here.
- `list()` uses the SDK's paginated `/v2/sandboxes` endpoint. Older E2B gateways without this endpoint need upgrading; no fallback treats an unavailable list as empty.
- Lifecycle serialization, persistent uncertainty tracking across service restarts, quotas and ownership are caller responsibilities.
- Destroy confirms the sandbox ID is missing. Cloud snapshot retention, external volumes and image caches have their own deletion policies; inspect and clean them separately when decommissioning a deployment.
- Ambient `E2B_DEBUG=true`, `E2B_SANDBOX_URL` and `E2B_ACCESS_TOKEN` are refused because E2B 2.24 can let them override explicit connection settings. Explicit API endpoint/key settings override `E2B_API_URL`, `E2B_DOMAIN` and `E2B_API_KEY`.

## Sources

- [Alibaba Agent Sandbox quick start](https://www.alibabacloud.com/help/en/agent-sandbox/getting-started/create-an-agent-sandbox)
- [Volcengine installation](https://docs.volcengine.com/docs/6460/2277052)
- [Volcengine agent-sandbox addon](https://docs.volcengine.com/docs/6460/2626763)
- [Volcengine E2B SDK guide](https://docs.volcengine.com/docs/6460/2479109)
- [E2B upstream](https://github.com/e2b-dev/E2B)

Protocol compatibility and live deployment verification are tracked separately in [verification.md](verification.md).


## Application endpoints

`provider.httpEndpoint(id, port)` returns an application's URL and ephemeral request headers through the official SDK's `getHost`. The optional `serviceUrl` selects a private application gateway; it then includes `E2b-Sandbox-Id` and `E2b-Sandbox-Port`. This is separate from the envd-specific `sandboxUrl`. Preserve the application's own `Authorization` header and follow no redirects when sending credentials.

When the SDK returns `trafficAccessToken`, only that token accompanies application requests as `e2b-traffic-access-token`. Neither the cloud API key nor envd's controller token is returned. These details belong in the trusted backend, never in end-user responses or durable environment refs. Application services still need their own authentication. Endpoint projection has SDK/local fixture coverage; live application ingress must be verified for each deployed gateway.
