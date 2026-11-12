# Configuration-gated cloud startup

This feature is unreleased; build the matching source archive. Published alpha.8 does not include `--ready-file`.

An image can run Agent Host before the provisioning service uploads its private configuration:

```sh
agent-host serve --config /home/user/.agent-host-service/host.json \
  --token-file /home/user/.agent-host-service/token \
  --ready-file /home/user/.agent-host-service/ready.json --host 0.0.0.0 --port 37420
```

The process waits without listening until `ready.json` exists and its SHA-256 hashes match the exact config and token bytes. Upload configuration and token first, then publish this manifest last:

```json
{"version":1,"configSha256":"SHA256_OF_HOST_JSON_BYTES","tokenSha256":"SHA256_OF_TOKEN_FILE_BYTES"}
```

Use private directories (0700) and files (0600). Prepare files under temporary names and rename them before publishing the manifest. A mismatched manifest fails startup rather than using partial data. SIGTERM/SIGINT also work while waiting. Do not set `AGENT_HOST_TOKEN` with this mode. The config follows the existing [HTTP service format](../../docs/http-service.md); no Router identity or cloud account key belongs in it.

The example Dockerfile installs a supplied, independently verified `agent-host.tgz`. Create it with `npm pack --pack-destination examples/cloud`, then rename the archive to `agent-host.tgz` before building this directory. Install the native executable and dependencies for your selected kernel in a derived image and pin that image's digest in the cloud template. The example includes no model login or public ingress.

For example, a Codex image can extend the verified base with the Host-tested native version (the environment module itself remains kernel-independent):

```dockerfile
FROM your-agent-host-base
RUN npm install --prefix /opt/native @openai/codex@0.162.0
ENV PATH="/opt/native/node_modules/.bin:${PATH}"
```

Configure the cloud's supported envd injection separately. Ensure `/home/user`, the workspace, Host SQLite state and native kernel state survive the selected pause/resume mechanism. A writable directory alone does not establish persistence. The cloud/container supervisor should restart the entrypoint after a process crash or environment resume. Bootstrap is a readiness gate, not a second process supervisor; it preserves the existing Host store lock, recovery rules and native sessions. Do not silently replay interrupted model/tool work.

The provisioning service can then check authenticated `/v1/health` and `/v1/runtimes/inspect`. Those checks prove service/local readiness; a native handshake or model-backed task is a separate acceptance step. The entrypoint and archive are covered by deterministic tests; this image is a deployment recipe, not a live certification for every cloud/kernel combination.
