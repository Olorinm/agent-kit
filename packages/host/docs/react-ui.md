# React chat UI

`@olorinm/agent-ui` is an optional frontend package in this repository. It supplies message, Markdown, composer, process, approval, question and resource components. Agent Host can still be used without React or this UI package.

Build and install the UI archive:

```sh
npm ci
npm pack --workspace @olorinm/agent-ui
# In your product:
npm install /path/to/olorinm-agent-ui-0.1.0-alpha.1.tgz
```

React and React DOM 19 are peer dependencies. The package root only renders caller-owned data. It makes no HTTP calls and has no product-specific stores, authentication, room membership, filesystem access or knowledge of business objects.

## Connect Agent Host

The optional `/agent-host` entry accepts Agent Host's existing interaction callback:

```tsx
import { AgentInteraction, useAgentInteractions } from "@olorinm/agent-ui/agent-host";

function Interactions() {
  const {pending, onInteraction} = useAgentInteractions();
  // Pass onInteraction to task.wait({onInteraction}) or your embedded integration.
  // The product still decides when to start/observe/cancel the task.
  return pending.map(item => <AgentInteraction
    key={item.id} requestId={item.id}
    request={item.request} onReply={item.reply}
  />);
}
```

The hook handles concurrent requests and removes/rejects them when their abort signal fires or the UI unmounts. Native replies are translated by Agent Host, not by the presentation package. Errors from remote submission remain part of the caller's observer/error handling.

`createRunView(runId)` and `appendRunEvent(view, {sequence, event})` project text and reasoning from ordered HTTP service events. They ignore replayed sequences, reject events for another run and retain original events for custom renderers. They are an in-memory view, not a durable conversation store. Use the final run result as the authoritative answer and handle `onHistoryGap` explicitly.

## Native capability boundaries

- Approval choices retain exact IDs and native persistence scopes. An empty choice list never gains an invented “allow” button.
- Questions return strings/arrays by their original IDs. The Host adapter disables skipping required IDs and uses password inputs for secret questions.
- Native forms use a JSON response editor with the original schema available. Complex schema-driven widgets can replace it through `renderNative`; the kernel/service remains responsible for native validation.
- URL requests open only HTTP(S) links and require explicit completion. Unknown native requests remain explicit JSON replies.
- Model, effort, mode, permission and budget menus belong in composer slots. Populate them using the selected runtime's capabilities and allowed settings.
- Attachment upload, resource identity, authorization, downloads, persistence, accounts, Rooms and Apps remain product responsibilities.

## Styling and localization

Import `@olorinm/agent-ui/styles.css` and wrap your UI in `.agent-chat` for a default theme; set `data-theme="dark"` for dark mode. All colors/spacing/typography use CSS variables. Existing products can import the three component stylesheets and keep their tokens. CSS imports are optional and do not reset the document root.

`ChatProvider` accepts a `translate` function and a `Button` replacement. `AgentInteraction.labels` replaces adapter copy. Message render callbacks, composer slots, resource actions and native interaction renderers let the product retain its own UI conventions.

## Working example and verification

The [React document editor](../examples/react-editor/README.md) uses the HTTP client and an authenticated local companion. The Host owner token stays in that companion. Product document writes still require an explicit UI decision.

```sh
npm test
npm run test:package
npm run test:ui
npm run test:ui:browser
npm run test:ui:package
```

The UI archive test installs fresh Host/UI archives into an independent product, checks TypeScript compatibility with native interaction contracts, bundles without product source imports, drives browser controls, and runs the editor through the real HTTP service and a deterministic Codex protocol fixture. This verifies integration behavior; it is not a claim of a new live-model test on all seven kernels.

After following the editor's setup steps, `node scripts/smoke-ui-native.mjs`
optionally sends one minimal prompt through the real local Codex, HTTP service
and React UI. It uses your existing authentication and can incur model usage.
It is separate from CI; set `AGENT_HOST_CODEX` to choose the local executable.

OpenGrove consumes the same archive and shared rendering implementations, retaining its product adapters and theme. Source attribution is preserved in the UI package's NOTICE.
