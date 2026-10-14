# React UI

The React components live in their own repository, [Olorinm/agent-ui](https://github.com/Olorinm/agent-ui): chat messages, Markdown, composer, process details, approvals, questions, resources and application primitives. Agent Host itself does not depend on React or that package.

```sh
npm install https://github.com/Olorinm/agent-ui/releases/download/v0.1.0-alpha.2/olorinm-agent-ui-0.1.0-alpha.2.tgz
```

Its optional `@olorinm/agent-ui/agent-host` entry accepts this package's interaction callback and run events without renaming native IDs or choices. See the [Agent UI guide](https://github.com/Olorinm/agent-ui/blob/main/docs/guide.md) for components, styling and localization.

## Working example and verification

The [React document editor](../examples/react-editor/README.md) uses the HTTP client and an authenticated local companion. The Host owner token stays in that companion. Product document writes still require an explicit UI decision.

```sh
npm test
npm run test:package
npm run test:ui:package
```

`test:ui:package` installs this Host build and the pinned Agent UI release into an independent product, checks TypeScript compatibility with the native interaction contracts, and runs the editor through the real HTTP service and a deterministic Codex protocol fixture. This verifies integration behavior; it is not a claim of a new live-model test on all seven kernels.

After following the editor's setup steps, `node scripts/smoke-ui-native.mjs`
optionally sends one minimal prompt through the real local Codex, HTTP service
and React UI. It uses your existing authentication and can incur model usage.
It is separate from CI; set `AGENT_HOST_CODEX` to choose the local executable.
