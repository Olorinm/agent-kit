import { testGapsPackage } from "./test-gaps-package.mjs";
import assert from "node:assert/strict";
import { testHttpPackage } from "./test-http-package.mjs";
import { testCapabilitiesPackage } from "./test-capabilities-package.mjs";
import { model, fixture as piStream } from "../test/fixtures/pi-stream.mjs";
import { startOpenClawFixture } from "../test/fixtures/openclaw-gateway.mjs";
import { createClaudeQueryFixture } from "../test/fixtures/claude-query.mjs";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const root = process.cwd();
const consumer = await mkdtemp(join(tmpdir(), "agent-host-consumer-"));
await mkdir(resolve(".local"), { recursive: true });
console.log("Packing the distributable archive");
// Exercise a developer checkout that has installed the companion's dependencies.
const exampleDependencies = resolve("examples/http-editor/node_modules");
await mkdir(exampleDependencies, { recursive: true });
const packSentinel = await mkdtemp(join(exampleDependencies, "agent-host-pack-sentinel-"));
try {
  await writeFile(join(packSentinel, "package.json"), JSON.stringify({ name: "agent-host-pack-sentinel", version: "1.0.0" }));
  const [archive] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--pack-destination", consumer, "--json"], {
    encoding: "utf8",
    stdio: "pipe",
  }));
  assert.ok(
    archive.files.every(({ path }) => !path.split(/[\\/]/).includes("node_modules")),
    "The distributable must not include installed example dependencies",
  );
} finally {
  await rm(packSentinel, { recursive: true, force: true });
}
await cp("examples/file-editor", consumer, { recursive: true });
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify({ private: true, type: "module" }),
);
console.log("Installing the archive into an independent consumer");
execFileSync(
  process.execPath,
  [
    process.env.npm_execpath,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `./olorinm-agent-host-${JSON.parse(await readFile(join(root,"package.json"),"utf8")).version}.tgz`,
  ],
  { cwd: consumer, stdio: "inherit" },
);
console.log("Checking the installed editor and native contracts");
const { createEditor } = await import(
  pathToFileURL(join(consumer, "editor.mjs"))
);
const fixture = resolve("test/fixtures/codex-server.mjs");
const directory = join(consumer, "document-workspace");
let approves = 0;
let editor = await createEditor({
  directory,
  command: fixture,
  args: [],
  approve: async () => {
    approves++;
    return true;
  },
});
try {
  const edited = await Array.fromAsync(editor.run("duplicate-tool"));
  assert.equal(edited.at(-1).outcome.status, "completed");
  assert.equal(await editor.read(), "Updated by Agent");
  assert.equal(approves, 1);
  const nativeId = edited.find((e) => e.type === "session.bound").threadId;
  await editor.close();
  editor = await createEditor({
    directory,
    command: fixture,
    args: [],
    approve: async () => false,
  });
  const rejected = await Array.fromAsync(editor.run("tool"));
  assert.equal(
    rejected.find((e) => e.type === "session.bound").threadId,
    nativeId,
  );
  assert.equal(rejected.find((e) => e.type === "session.bound").resumed, true);
  assert.equal(
    rejected.find((e) => e.type === "tool.finished").result.success,
    false,
  );
  assert.equal(await editor.read(), "Updated by Agent");
  const controller = new AbortController();
  await editor.close();
  editor = await createEditor({
    directory,
    command: fixture,
    args: [],
    approve: async (_request, signal) => {
      controller.abort();
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(false), { once: true }),
      );
    },
  });
  const cancelled = await Array.fromAsync(
    editor.run("tool", { signal: controller.signal }),
  );
  assert.equal(cancelled.at(-1).outcome.status, "cancelled");
  assert.equal(await editor.read(), "Updated by Agent");
  // Check the installed declarations, not repository-relative imports.
  await writeFile(
    join(consumer, "consumer.ts"),
    `import { AcpAgent, AcpHostToolBridgeServer } from '@olorinm/agent-host/acp';\nimport { ClaudeAgent, ClaudeQueryHost } from '@olorinm/agent-host/claude';\nimport { PiAgent } from '@olorinm/agent-host/pi';\nimport { HermesAgent, HermesGatewayAgent } from '@olorinm/agent-host/hermes';\nimport { OpenClawAgent } from '@olorinm/agent-host/openclaw';\nconst adapters = [AcpAgent, ClaudeAgent, ClaudeQueryHost, PiAgent, HermesAgent, OpenClawAgent];\nimport { CodexAgent } from '@olorinm/agent-host/codex';\nimport { FileBindingStore } from '@olorinm/agent-host';\nimport { createAgent } from '@olorinm/agent-host/adapters';\nimport { getKernelCapabilities } from '@olorinm/agent-host/capabilities';\nconst agent: CodexAgent = createAgent({ kernel: 'codex', options: { bindings: new FileBindingStore('state') } });\nconst pi: PiAgent = createAgent({ kernel: 'pi' });\nconst kimi: AcpAgent = createAgent({ kernel: 'kimi' });\nconst bridge = new AcpHostToolBridgeServer('agent-host', 'AGENT_HOST_TOOL', { connectionDirectory: 'state/tools' });\nconst canonical: HermesGatewayAgent = createAgent({ kernel: 'hermes', transport: 'acp', options: { toolBridgeProvider: bridge } });\nconst tui: HermesAgent = createAgent({ kernel: 'hermes', options: { command: 'python' } });\n// @ts-expect-error Canonical ACP must not inherit TUI-only construction options.\ncreateAgent({ kernel: 'hermes', transport: 'acp', options: { exclusiveProfile: true } });\nvoid [canonical, tui];\ngetKernelCapabilities('kimi', 'http').features['controls.compact'].status;\n// @ts-expect-error OpenClaw requires a configured Gateway.\ncreateAgent({ kernel: 'openclaw' });\n// @ts-expect-error Preserve native option validation.\ncreateAgent({ kernel: 'codex', options: { madeUp: true } });\nfor await (const e of agent.run({ sessionId: 's', cwd: '.', input: 'hi', instructions: '' })) console.log(e.type);\nawait agent.close();\n`,
  );
  await writeFile(
    join(consumer, "http-consumer.ts"),
    `import { createNativeRuntime, startAgentHostServer } from '@olorinm/agent-host/server';
import { AgentHostClient } from '@olorinm/agent-host/client';
const runtime = createNativeRuntime({ id: 'codex', kernel: 'codex', cwd: '.' }, 'state');
const server = await startAgentHostServer({ runtimes: [runtime], stateDirectory: 'state', token: 'example-owner-token' });
const client = await new AgentHostClient({ baseUrl: server.url, token: 'example-owner-token' }).connect();
const task = await client.session({ sessionId: 's', runtimeId: 'codex', tools: [{ name: 'edit', description: 'Edit', inputSchema: {}, async execute(input, context) { context.signal.throwIfAborted(); return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(input) }] }; } }] }).run('hi');
await task.wait({ onInteraction: async i => i.choices?.length ? { choice: i.choices[0]!.id } : { action: 'cancel' } });
await client.nativeSessions('codex').history('s');
await client.discover('codex');
await server.close();
`,
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "--typeRoots",
      join(root, "node_modules/@types"),
      "consumer.ts",
      "http-consumer.ts",
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  assert.match(
    await readFile(
      join(consumer, "node_modules/@olorinm/agent-host/NOTICE"),
      "utf8",
    ),
    /OpenGrove/,
  );
  console.log(
    "PASS archive install, independent editor, approve/reject/cancel, native binding restart, TypeScript consumer",
  );
  console.log(`Consumer retained at ${consumer}`);
} finally {
  await editor.close();
}

// A second protocol uses the very same installed editor and product tool.
for (const kernel of ["opencode", "kimi"]) {
  const directory = join(consumer, `${kernel}-workspace`);
  const command = resolve("test/fixtures/acp-server.mjs");
  let editor = await createEditor({
    directory,
    kernel,
    command,
    args: [],
    approve: async () => true,
  });
  try {
    const approved = await Array.fromAsync(editor.run("tool"));
    assert.equal(approved.at(-1).outcome.status, "completed");
    assert.equal(await editor.read(), "Saved via ACP");
    const nativeId = approved.find(
      (event) => event.type === "session.bound",
    ).threadId;
    await editor.close();
    editor = await createEditor({
      directory,
      kernel,
      command,
      args: [],
      approve: async () => false,
    });
    const rejected = await Array.fromAsync(editor.run("tool"));
    assert.equal(
      rejected.find((event) => event.type === "session.bound").threadId,
      nativeId,
    );
    assert.equal(
      rejected.find((event) => event.type === "tool.finished").result.success,
      false,
    );
    assert.equal(await editor.read(), "Saved via ACP");
    const controller = new AbortController();
    let outcome;
    for await (const event of editor.run("wait", {
      signal: controller.signal,
    })) {
      if (event.type === "assistant.delta") controller.abort();
      if (event.type === "turn.finished") outcome = event.outcome;
    }
    assert.equal(outcome.status, "cancelled");
    console.log(
      `PASS installed ${kernel} editor: MCP, approve/reject, cancellation and restart (protocol fixture)`,
    );
  } finally {
    await editor.close();
  }
}

{
  const directory = join(consumer, "claude-workspace");
  const query = createClaudeQueryFixture();
  let editor = await createEditor({
    directory,
    kernel: "claude",
    adapterOptions: { query },
    approve: async () => true,
  });
  try {
    const approved = await Array.fromAsync(editor.run("fixture tool"));
    assert.equal(approved.at(-1).outcome.status, "completed");
    assert.equal(await editor.read(), "Saved via Claude");
    const threadId = approved.find(
      (event) => event.type === "session.bound",
    ).threadId;
    await editor.close();
    editor = await createEditor({
      directory,
      kernel: "claude",
      adapterOptions: { query },
      approve: async () => false,
    });
    const rejected = await Array.fromAsync(editor.run("fixture tool"));
    assert.equal(
      rejected.find((event) => event.type === "session.bound").threadId,
      threadId,
    );
    assert.equal(
      rejected.find((event) => event.type === "tool.finished").result.success,
      false,
    );
    assert.equal(await editor.read(), "Saved via Claude");
    console.log(
      "PASS installed Claude editor: SDK MCP approve/reject and native binding restart (SDK seam fixture)",
    );
  } finally {
    await editor.close();
  }
}

// Hermes uses the same product, through its native Gateway/MCP contract fixture.
{
  const directory = join(consumer, "hermes-workspace");
  const options = {
    directory,
    kernel: "hermes",
    command: process.execPath,
    args: [resolve("test/fixtures/hermes-gateway.mjs")],
    env: { ...process.env, HERMES_HOME: join(directory, "native-home") },
  };
  let editor = await createEditor({ ...options, approve: async () => true });
  try {
    const approved = await Array.fromAsync(editor.run("CALL_TOOL"));
    assert.equal(
      approved.at(-1).outcome.status,
      "completed",
      JSON.stringify(approved.at(-1)),
    );
    assert.equal(await editor.read(), "Shared Hermes editor");
    const threadId = approved.find((e) => e.type === "session.bound").threadId;
    await editor.close();
    editor = await createEditor({ ...options, approve: async () => false });
    const rejected = await Array.fromAsync(editor.run("CALL_TOOL"));
    assert.equal(
      rejected.at(-1).outcome.status,
      "completed",
      JSON.stringify(rejected.at(-1)),
    );
    assert.equal(
      rejected.find((e) => e.type === "session.bound").threadId,
      threadId,
    );
    assert.equal(
      rejected.find((e) => e.type === "tool.finished").result.success,
      false,
    );
    assert.equal(await editor.read(), "Shared Hermes editor");
    console.log(
      "PASS installed Hermes editor: product MCP approve/reject and stored native ID restart (Gateway fixture)",
    );
  } finally {
    await editor.close();
  }
}

// The current Pi loop and persistence are native; only provider output is deterministic.
for (const kernel of ["pi", "openclaw"]) {
  const gateway =
    kernel === "openclaw" ? await startOpenClawFixture() : undefined;
  const observed = [];
  const options = {
    directory: join(consumer, `${kernel}-workspace`),
    kernel,
    adapterOptions: gateway ?? {
      model,
      streamFn: piStream(observed, "edit_document"),
    },
  };
  let editor = await createEditor({ ...options, approve: async () => true });
  try {
    const first = await Array.fromAsync(
      editor.run(kernel === "pi" ? "call edit" : "TOOL"),
    );
    assert.equal(
      first.at(-1).outcome.status,
      "completed",
      JSON.stringify(first.at(-1)),
    );
    const expected = kernel === "pi" ? "CEDAR" : "Saved via OpenClaw";
    assert.equal(await editor.read(), expected);
    const thread = first.find((e) => e.type === "session.bound").threadId;
    await editor.close();
    editor = await createEditor({ ...options, approve: async () => false });
    const denied = await Array.fromAsync(
      editor.run(kernel === "pi" ? "call edit" : "TOOL"),
    );
    assert.equal(
      denied.at(-1).outcome.status,
      "completed",
      JSON.stringify(denied.at(-1)),
    );
    assert.equal(
      denied.find((e) => e.type === "session.bound").threadId,
      thread,
    );
    assert.equal(
      denied.find((e) => e.type === "tool.finished").result.success,
      false,
    );
    assert.equal(await editor.read(), expected);
    console.log(
      `PASS installed ${kernel} editor: approve/reject and native binding restart (provider/protocol fixture)`,
    );
  } finally {
    await editor.close();
    await gateway?.close();
  }
}
const installed = join(consumer, "node_modules/@olorinm/agent-host");
await testHttpPackage(consumer);
await testCapabilitiesPackage(consumer);
await writeFile(
  resolve(".local/last-package-consumer.json"),
  JSON.stringify({ consumer }),
);
if (process.env.AGENT_HOST_HTTP_NATIVE === "1")
  await testHttpPackage(consumer, { native: true });
assert.equal(
  JSON.parse(
    await readFile(
      join(installed, "plugins/openclaw/openclaw.plugin.json"),
      "utf8",
    ),
  ).contracts.tools[0],
  "agent_host_call",
);
assert.equal(
  (await import(pathToFileURL(join(installed, "plugins/openclaw/index.js"))))
    .default.id,
  "agent-host",
);

if (process.env.AGENT_HOST_NATIVE_PROBE === "1") {
  const command =
    process.env.AGENT_HOST_CODEX ?? join(root, "node_modules/.bin/codex");
  const directory = join(consumer, "native-editor-workspace");
  let requests = 0;
  let allow = false;
  let native = await createEditor({
    directory,
    command,
    approve: async () => {
      requests++;
      return allow;
    },
  });
  const original = await native.read();
  const run = async (input) => {
    const events = await Array.fromAsync(
      native.run(input, { signal: AbortSignal.timeout(120_000) }),
    );
    assert.equal(
      events.at(-1).outcome.status,
      "completed",
      JSON.stringify(events.at(-1)),
    );
    return events;
  };
  try {
    await run(
      'Call edit_document once with text "Edited through the standalone product". Respect the returned approval decision; do not retry a rejected edit.',
    );
    assert.equal(requests, 1);
    assert.equal(await native.read(), original);
    allow = true;
    const approved = await run(
      'I now approve. Call edit_document exactly once with text "Edited through the standalone product".',
    );
    assert.equal(requests, 2);
    assert.equal(await native.read(), "Edited through the standalone product");
    const thread = approved.find((e) => e.type === "session.bound").threadId;
    await native.close();
    native = await createEditor({
      directory,
      command,
      approve: async () => false,
    });
    const resumed = await run(
      "Without editing, tell me whether my first edit attempt was approved or rejected.",
    );
    assert.equal(
      resumed.find((e) => e.type === "session.bound").threadId,
      thread,
    );
    assert.equal(resumed.find((e) => e.type === "session.bound").resumed, true);
    assert.match(
      resumed.find((e) => e.type === "model.response").text,
      /reject|denied|拒绝/i,
    );
    console.log(
      "PASS native Codex through installed editor: rejected edit stays unchanged, approved edit saves, restart resumes",
    );
  } finally {
    await native.close();
  }
}

await testGapsPackage(consumer);

await testCodexNativeCoveragePackage(consumer);

// Copy the callers outside the checkout so every import resolves to the archive.
async function testCodexNativeCoveragePackage(consumerDirectory) {
  const coverageTest = join(consumerDirectory, "codex-native-coverage.test.mjs");
  await cp(join(root, "test/codex-native-coverage.test.mjs"), coverageTest);
  execFileSync(process.execPath, ["--test", coverageTest], { cwd: consumerDirectory, stdio: "inherit" });
  if (process.env.AGENT_HOST_NATIVE_COVERAGE === "1") {
    const probe = join(consumerDirectory, "probe-codex-native-coverage.mjs");
    await cp(join(root, "scripts/probe-codex-native-coverage.mjs"), probe);
    execFileSync(process.execPath, [probe, "--command", process.env.AGENT_HOST_CODEX ?? join(root, "node_modules/.bin/codex"),
      "--out", join(root, ".local/codex-native-package-coverage.json")], { cwd: consumerDirectory, stdio: "inherit", timeout: 180_000 });
  }
}
