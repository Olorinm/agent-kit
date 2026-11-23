import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgent } from "../dist/adapters.js";
import { getKernelCapabilities, kernels } from "../dist/capabilities.js";
import { describeInteraction } from "../dist/interactions.js";
import { selectableSettings } from "../dist/settings.js";
import {
  configSchema,
  createConfiguredRuntimes,
} from "../dist/service/config.js";

// Antigravity (`agy acp`) through the shared ACP adapter. The fixture replays the shapes of a recorded local
// handshake with Antigravity CLI 1.5.15; no model is contacted here.
const fixture = resolve("test/fixtures/agy-acp-server.mjs");
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "agent-host-agy-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  return root;
}
function configured(root, profile = {}, log) {
  const { args = [], ...rest } = profile;
  const config = configSchema.parse({
    stateDirectory: join(root, "state"),
    runtimes: [
      {
        id: "agy",
        kernel: "agy",
        cwd: root,
        command: process.execPath,
        args: [fixture, ...args],
        ...(log ? { env: { ...process.env, ACP_TEST_LOG: log } } : {}),
        ...rest,
      },
    ],
  });
  return createConfiguredRuntimes(config, join(root, "host.json"))[0];
}
async function turn(runtime, input, options = {}) {
  const requests = [];
  let text = "",
    outcome,
    bound;
  for await (const event of runtime.run({
    sessionId: options.sessionId ?? "product",
    runId: `run-${Math.random()}`,
    input,
    instructions: "",
    tools: options.tools ?? [],
    settings: options.settings,
    mode: options.mode ?? "turn",
    signal: AbortSignal.timeout(15_000),
    onRequest: async (request) => {
      requests.push(request);
      return options.answer?.(request);
    },
  })) {
    if (event.type === "assistant.delta") text += event.text;
    if (event.type === "session.bound") bound = event;
    if (event.type === "turn.finished") outcome = event.outcome;
  }
  return { text, outcome, bound, requests };
}
const choose = (optionId) => async () => ({
  outcome: { outcome: "selected", optionId },
});
const calls = async (log, method) =>
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.method === method);

test("agy is a Host kernel with ACP profile fields and caller-selectable model, effort and config", () => {
  assert.ok(kernels.includes("agy"));
  assert.deepEqual(selectableSettings.agy, ["model", "effort", "config"]);
  const parse = (runtime) =>
    configSchema.safeParse({
      runtimes: [{ id: "agy", kernel: "agy", cwd: ".", ...runtime }],
    });
  assert.equal(parse({}).success, true);
  assert.equal(
    parse({
      command: "/opt/agy/bin/agy",
      args: ["acp", "--dangerously-skip-permissions"],
      env: { HOME: "/home/user" },
      model: "gemini-4-neon",
      effort: "high",
      config: { mode: "auto" },
      allowedSettings: { model: { values: ["gemini-4-neon"] } },
    }).success,
    true,
  );
  for (const field of [
    { native: {} },
    { thinkingLevel: "high" },
    { transport: "acp" },
    { gatewayUrl: "ws://127.0.0.1:1" },
    { thread: {} },
  ]) {
    const result = parse(field);
    assert.equal(result.success, false, JSON.stringify(field));
    assert.match(
      result.error.issues[0].message,
      /is not supported by this agy CLI profile/,
    );
  }
});

test("agy capabilities declare negotiated ACP paths, native approvals, and no steering or compaction", () => {
  for (const mode of ["embedded", "http"]) {
    const f = getKernelCapabilities("agy", mode).features;
    assert.equal(f["interactions.approval"].status, "supported");
    assert.equal(f["tools.product"].status, "supported");
    for (const name of [
      "input.images",
      "input.documents",
      "sessions.resume",
      "sessions.list",
      "sessions.history",
      "sessions.fork",
      "sessions.delete",
    ])
      assert.equal(f[name].reason, "native_negotiation_required", name);
    assert.equal(f["controls.steer"].reason, "native_not_supported");
    assert.deepEqual(
      [f["controls.compact"].status, f["controls.compact"].reason],
      ["unsupported", "host_not_integrated"],
    );
    assert.equal(f["input.nativeItems"].status, "unsupported");
  }
});

test("the agy adapter starts `agy acp` by default and has no compaction path", {
  // The default command is found on PATH; a shell-script stand-in needs a POSIX system.
  skip: process.platform === "win32",
}, async (t) => {
  const root = await workspace(t),
    log = join(root, "acp.log");
  await writeFile(
    join(root, "agy"),
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
  );
  await chmod(join(root, "agy"), 0o755);
  const agent = createAgent({
    kernel: "agy",
    options: {
      cwd: root,
      env: { ...process.env, PATH: root, ACP_TEST_LOG: log },
    },
  });
  try {
    const client = await agent.connect();
    assert.deepEqual((await calls(log, "initialize"))[0].argv, ["acp"]);
    assert.equal(
      agent.getInitialization(client).agentInfo.name,
      "Antigravity ACP Server",
    );
    assert.deepEqual(agent.getOperationSupport(client), {
      resume: true,
      history: true,
      delete: false,
      compact: false,
      compactionTransport: undefined,
    });
  } finally {
    await agent.close();
  }
});

test("an agy runtime sets model, thinking level and mode through native config options", async (t) => {
  const root = await workspace(t),
    log = join(root, "acp.log");
  const runtime = configured(
    root,
    {
      model: "gemini-3.8-flash",
      effort: "low",
      config: { mode: "auto" },
      allowedSettings: {
        model: { values: ["gemini-3.8-flash", "gemini-4-neon-xhigh"] },
        effort: { values: ["low", "medium", "xhigh"] },
      },
    },
    log,
  );
  t.after(() => runtime.close());
  const first = await turn(runtime, "hello");
  assert.deepEqual(first.outcome, { status: "completed" });
  assert.equal(first.text, "model=gemini-3.8-flash effort=low mode=auto");
  assert.deepEqual(
    (await calls(log, "session/set_config_option")).map(({ params }) => [
      params.configId,
      params.value,
    ]),
    [
      ["model", "gemini-3.8-flash"],
      ["mode", "auto"],
      ["thought_level", "low"],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(
      first.bound.configuration.map((option) => [
        option.id,
        option.currentValue,
      ]),
    ),
    { model: "gemini-3.8-flash", thought_level: "low", mode: "auto" },
  );
  // A caller's allowed selection: the CLI's model ID that carries its thinking level is accepted as it is.
  const second = await turn(runtime, "again", {
    settings: { model: "gemini-4-neon-xhigh" },
  });
  assert.equal(second.bound.resumed, true);
  assert.equal(second.text, "model=gemini-4-neon effort=low mode=auto");
  // A thinking level the selected model does not offer is the native refusal, not a silent fallback.
  const refused = await turn(runtime, "third", { settings: { effort: "xhigh" } });
  assert.equal(refused.outcome.status, "failed");
  assert.match(refused.outcome.error, /Thinking level "xhigh" is not offered/);
  assert.throws(
    () => runtime.validateSettings({ model: "claude-opus-5-5" }),
    /setting_not_allowed:model/,
  );
  assert.throws(
    () => runtime.validateSettings({ config: { mode: "auto" } }),
    /setting_not_allowed:config/,
  );
});

test("an agy permission request is a Host approval with the native option IDs; unanswered it is cancelled", async (t) => {
  const root = await workspace(t);
  const runtime = configured(root);
  t.after(() => runtime.close());
  const approved = await turn(runtime, "command", { answer: choose("allow") });
  assert.equal(approved.text, "command ran");
  assert.equal(approved.requests.length, 1);
  assert.equal(approved.requests[0].method, "session/request_permission");
  const card = describeInteraction(approved.requests[0]);
  assert.deepEqual(
    { kind: card.kind, title: card.title, choices: card.choices },
    {
      kind: "approval",
      title: "date > probe.txt",
      choices: [
        { id: "allow", label: "Allow", allows: true, scope: "once" },
        { id: "deny", label: "Deny", allows: false, scope: "once" },
      ],
    },
  );
  assert.equal(
    (await turn(runtime, "command", { answer: choose("deny") })).text,
    "command refused",
  );
  // Nobody answers, as in a turn that cannot ask its owner: the native request is cancelled, never approved.
  const unanswered = await turn(runtime, "command");
  assert.equal(unanswered.requests.length, 1);
  assert.equal(unanswered.text, "command refused");
  assert.deepEqual(unanswered.outcome, { status: "completed" });
});

test("agy asks about Host product tools in auto mode; --dangerously-skip-permissions is the non-interactive profile", async (t) => {
  const tools = () => {
    const calls = [];
    return {
      calls,
      list: [
        {
          name: "edit_document",
          description: "Replace the document",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          execute: async (input) => {
            calls.push(input);
            return {
              success: true,
              contentItems: [{ type: "inputText", text: "Saved" }],
            };
          },
        },
      ],
    };
  };
  const autoRoot = await workspace(t),
    auto = configured(autoRoot, { config: { mode: "auto" } });
  t.after(() => auto.close());
  // Auto mode runs commands unasked, and still asks before a tool of the Host's MCP server.
  assert.equal((await turn(auto, "command")).requests.length, 0);
  const asked = tools();
  const refused = await turn(auto, "tool", {
    sessionId: "tools",
    tools: asked.list,
  });
  assert.equal(refused.requests.length, 1);
  assert.equal(
    describeInteraction(refused.requests[0]).title,
    "Run mcp_agent-host_edit_document",
  );
  assert.equal(refused.text, "tool refused");
  assert.deepEqual(asked.calls, []);

  const skipRoot = await workspace(t),
    log = join(skipRoot, "acp.log");
  const skip = configured(
    skipRoot,
    { args: ["--dangerously-skip-permissions"] },
    log,
  );
  t.after(() => skip.close());
  const unasked = tools();
  const ran = await turn(skip, "tool", { tools: unasked.list });
  assert.equal(ran.requests.length, 0);
  assert.deepEqual(unasked.calls, [{ text: "Saved via ACP" }]);
  assert.deepEqual(ran.outcome, { status: "completed" });
  assert.equal(
    (await turn(skip, "command", { sessionId: "commands" })).text,
    "command ran",
  );
  assert.ok(
    (await calls(log, "initialize"))[0].argv.includes(
      "--dangerously-skip-permissions",
    ),
  );
});

test("agy discovery reports what the native server negotiated, and compaction is refused", async (t) => {
  const root = await workspace(t);
  const runtime = configured(root);
  t.after(() => runtime.close());
  assert.equal(runtime.supportsCompaction, false);
  assert.deepEqual(runtime.inputs, { attachments: true, images: "negotiated" });
  const { capabilities, native } = await runtime.discover();
  const status = (name) => capabilities.features[name].status;
  for (const name of [
    "input.images",
    "input.documents",
    "sessions.resume",
    "sessions.list",
    "sessions.history",
    "interactions.approval",
  ])
    assert.equal(status(name), "supported", name);
  for (const name of [
    "input.audio",
    "sessions.fork",
    "sessions.delete",
    "controls.compact",
    "controls.steer",
  ])
    assert.equal(status(name), "unsupported", name);
  assert.equal(native.initialization.agentInfo.version, "1.5.15");
  assert.deepEqual(native._meta, {
    antigravity: { tier: true, systemPrompt: { append: true } },
  });
  await turn(runtime, "hello");
  await assert.rejects(
    turn(runtime, "", { mode: "compact" }),
    /compaction_unsupported/,
  );
});
