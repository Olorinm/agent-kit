# React document editor

A small independent product using Agent UI and Agent Host. The product owns its document, attachment handling, tool authorization and persistence. It uses the same authenticated companion as the plain [HTTP editor](../http-editor/README.md), with a React frontend.

From the repository root:

```sh
npm ci
npm run build
npm pack
npm --prefix examples/http-editor install --ignore-scripts --no-package-lock
npm --workspace @olorinm/agent-ui run build
node examples/react-editor/build.mjs
# Start/configure Agent Host first using the HTTP editor guide.
AGENT_HOST_TOKEN_FILE=/path/to/host/token node examples/react-editor/server.mjs
```

Open the printed local URL, select an available runtime and send a request. To change the document, the agent calls `edit_document`; the UI shows Apply edit / Keep original. Native approvals and questions appear using the shared Host interaction adapter. The stop button cancels the active task.

The example keeps the runtime fixed once its product session has started. Attachments are limited to 500 KB per turn by this example's companion transport; this is not the Host's media limit. Reloading preserves the document/session but this minimal frontend does not restore its in-memory conversation view. Product storage and reconnect UX are intentionally owned by the consumer.

The companion binds to loopback and keeps the Host token out of browser code. `AGENT_HOST_URL`, `EDITOR_DIRECTORY` and `EDITOR_PORT` configure it. Defaults are `http://127.0.0.1:37420`, `editor-project` and port `37431`.

Run `npm run test:ui:package` to exercise the packaged UI and this product against a protocol fixture. Native kernels still require their own installation and authentication.
