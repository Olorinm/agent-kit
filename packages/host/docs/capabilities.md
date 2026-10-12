# Capability discovery and common access

Products can inspect the Host integration before deciding which features to present. Capability descriptions do not start a native process, log into an account or contact a model.

## Embedded

```ts
import { createAgent } from '@olorinm/agent-host/adapters';
import { getKernelCapabilities } from '@olorinm/agent-host/capabilities';

const capabilities = getKernelCapabilities('kimi');
console.log(capabilities.features['controls.compact']);
// { status: 'conditional', reason: 'configuration_required', details: '...' }

const agent = createAgent({
  kernel: 'kimi',
  options: { command: 'kimi', elicitation: { form: {} } },
});
// agent remains an AcpAgent, including its native methods and typed run options.
// Supply a persistent binding store when continuation must survive a product restart.
try {
  for await (const event of agent.run({
    sessionId: 'document-1',
    cwd: process.cwd(),
    instructions: 'Help edit this document.',
    input: 'Suggest a title.',
  })) {
    if (event.type === 'assistant.delta') process.stdout.write(event.text);
  }
} finally {
  await agent.close();
}
```

The factory selects existing native adapters. It preserves their methods and options, and does not invent equivalents for Kernel-specific features. Hermes requires `options.command`; OpenClaw requires `options.url`. Existing imports such as `@olorinm/agent-host/codex` remain supported.

The capabilities subpath is browser-safe; the adapters subpath is for the Node.js host. `getKernelCapabilities(kernel, 'http')` describes the built-in service adapter. For a running service, use its runtime description so custom compositions and configuration checks are represented.

## HTTP

```ts
const runtime = await client.inspect('local-kimi');
const compaction = runtime.capabilities.features['controls.compact'];
if (!runtime.available) console.log(runtime.reason);
else if (compaction.status === 'conditional') console.log(compaction.details);
// With the required native profile/binding in place:
// await (await session.compact()).wait();
```

`GET /v1/runtimes` and `POST /v1/runtimes/inspect` return the same `AgentCapabilities` schema, with `version: 1`, `kernel`, `mode` and `features`. Existing control booleans remain compatible. Capability descriptions concern implementation; `available` concerns local configuration checks. Neither confirms account access, model vision support, or successful execution.

When a protocol-v1 server predates capability discovery, the client preserves its control booleans and marks undeclared features unknown. It does not infer a built-in adapter from the runtime name. Browser applications should bundle the client module and its browser-safe capability dependency, or serve both modules as the HTTP editor does.

| Status | Meaning |
| --- | --- |
| `supported` | The Host has an implementation path through this interface. |
| `conditional` | The path requires the stated configuration, native negotiation or lifecycle conditions. |
| `unsupported` | This interface does not provide the capability. The reason distinguishes Host omissions and known native limitations. |
| `unknown` | The runtime has not declared this capability. Do not assume it from the Kernel name. |

Reasons are `host_not_integrated`, `native_not_supported`, `native_negotiation_required`, `configuration_required` or `runtime_not_declared`. Optional `details` explain the requirement or native entry point.

Feature keys cover text/images/attachments; product tools and image results; approvals, questions and elicitation; native continuation/history/fork/delete; cancellation, steering and compaction; native options and events. Host session records are distinct from native history. The Pi tool-policy hook is described as a policy hook, not a native approval dialog.

For HTTP media, `input.attachments` means bytes can be delivered into the configured workspace; `input.images` means native image blocks can be passed to the Kernel. Hermes currently delivers image files through the workspace. ACP images require native negotiation. Neither file delivery nor image-block delivery certifies the selected model's interpretation. Tool-result image support describes inline image data; see [media details](http-service.md#media-input).

Native capabilities can be more specific than this shared description. For ACP, `await agent.connect()` and `agent.getCapabilities(client)` expose the actual handshake. Image input and resume remain conditional until that handshake advertises them. The generic description deliberately does not guess a provider's capabilities.

## Custom runtimes and evidence

Custom `ServiceRuntime` implementations may supply `capabilities`, using `unknownCapabilities(kernel, 'http')` as a starting point. The service leaves undeclared features unknown and derives control availability from the installed control handlers. Disabling a control prevents it from being advertised as usable.

Custom attachment delivery additionally requires `inputs: { attachments: true, images: 'native' | 'negotiated' | 'workspace' }`. Without it, the service rejects attachment requests before creating a session/task or saving files. These explicit media hints also populate discovery when a custom runtime has no full capability declaration. Compaction never accepts attachments.

Capability metadata is not a live-test certificate. Consult the [support matrix](kernel-support.md) for exact tested versions, platforms and native probes. Keep these descriptions, their implementation paths and consumer tests in sync when adding capabilities.
