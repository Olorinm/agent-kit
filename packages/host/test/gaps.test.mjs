import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  describeInteraction,
  answerInteraction,
  routeInteraction,
  projectProgress,
  MemoryBindingStore,
  SessionManager,
} from "../dist/index.js";
import {
  createNativeRuntime,
  startAgentHostServer,
  diagnoseRuntime,
} from "../dist/service/index.js";
import { AgentHostClient } from "../dist/service/client.js";
import { CodexAgent } from "../dist/codex/index.js";
import { ClaudeAgent } from "../dist/claude/index.js";
import { PiAgent } from "../dist/pi/index.js";
import { AcpAgent } from "../dist/acp/index.js";
import { HermesAgent } from "../dist/hermes/index.js";
import { OpenClawAgent } from "../dist/openclaw/index.js";
import { InMemorySessionStore } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeQueryFixture } from "./fixtures/claude-query.mjs";
import { fixture, model } from "./fixtures/pi-stream.mjs";
import { startOpenClawFixture } from "./fixtures/openclaw-gateway.mjs";
const context = {
  sessionId: "s",
  runId: "r",
  threadId: "t",
  turnId: "u",
  signal: new AbortController().signal,
};
const command = (k) => ({
  command: process.execPath,
  args: [resolve(`test/fixtures/${k}.mjs`)],
});
const base = {
  sessionId: "s",
  cwd: process.cwd(),
  instructions: "Stable",
  input: "hello",
};
const outcome = (events) => events.at(-1).outcome;

test("OpenClaw approval choices honor native allowed and unavailable decisions", () => {
  for (const request of [
    { allowedDecisions: ["allow-once", "deny"] },
    { unavailableDecisions: ["allow-always"] },
    {
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      unavailableDecisions: ["allow-always"],
    },
  ]) {
    const interaction = describeInteraction({
      method: "exec.approval.requested",
      params: { request },
    });
    assert.deepEqual(
      interaction.choices.map((c) => c.id),
      ["allow-once", "deny"],
    );
    assert.throws(
      () => answerInteraction(interaction, { choice: "allow-always" }),
      /invalid_interaction_choice/,
    );
  }
});

test("Codex MCP approvals preserve explicit persistence choices without treating arbitrary forms as approvals", () => {
  for (const persist of [undefined, "session", ["session", "always"]]) {
    const native = {
      method: "mcpServer/elicitation/request",
      params: {
        message: "Allow test tool?",
        _meta: { codex_approval_kind: "mcp_tool_call", persist },
        requestedSchema: { type: "object", properties: {} },
      },
    };
    const interaction = describeInteraction(native);
    assert.equal(interaction.kind, "approval");
    assert.equal(interaction.native, native);
    assert.deepEqual(answerInteraction(interaction, { choice: "accept" }), {
      action: "accept",
    });
    for (const action of ["decline", "cancel"])
      assert.deepEqual(answerInteraction(interaction, { action }), { action });
    for (const scope of ["session", "always"])
      if ([persist].flat().includes(scope))
        assert.deepEqual(answerInteraction(interaction, { choice: scope }), {
          action: "accept",
          _meta: { persist: scope },
        });
      else
        assert.throws(
          () => answerInteraction(interaction, { choice: scope }),
          /invalid_interaction_choice/,
        );
  }
  assert.equal(
    describeInteraction({
      method: "mcpServer/elicitation/request",
      params: { requestedSchema: { type: "object", properties: {} } },
    }).kind,
    "form",
  );
  assert.equal(
    describeInteraction({
      method: "elicitation/create",
      params: { _meta: { codex_approval_kind: "mcp_tool_call" } },
    }).kind,
    "form",
  );
});

test("Claude elicitation keeps cancel distinct from decline through the SDK callback", async (t) => {
  const agent = new ClaudeAgent({ query: createClaudeQueryFixture() });
  t.after(() => agent.close());
  for (const action of ["cancel", "decline"]) {
    const events = await Array.fromAsync(
      agent.run({
        ...base,
        sessionId: randomUUID(),
        input: "fixture question",
        onInteraction: async () => ({ action }),
      }),
    );
    assert.equal(outcome(events).status, "completed");
    assert.deepEqual(
      JSON.parse(events.find((e) => e.type === "model.response").text),
      { action },
    );
  }
});

test("common interactions preserve exact native options, scopes, multi-questions and form/url payloads", async () => {
  const cases = [
    [
      {
        method: "item/commandExecution/requestApproval",
        params: { availableDecisions: ["accept", "decline"] },
      },
      { choice: "accept" },
      { decision: "accept" },
    ],
    [
      {
        method: "session/request_permission",
        params: {
          options: [{ optionId: "once-7", kind: "allow_once", name: "Allow" }],
        },
      },
      { choice: "once-7" },
      { outcome: { outcome: "selected", optionId: "once-7" } },
    ],
    [
      {
        method: "permission",
        params: { name: "Bash", input: { command: "pwd" } },
      },
      { choice: "allow" },
      { behavior: "allow", updatedInput: { command: "pwd" } },
    ],
    [
      { method: "pi/toolApproval", params: { name: "edit" } },
      { choice: "deny" },
      { block: "Declined by user" },
    ],
    [
      { method: "approval", params: { choices: ["once", "deny"] } },
      { choice: "once" },
      { choice: "once" },
    ],
    [
      {
        method: "exec.approval.requested",
        params: { request: { command: "pwd" } },
      },
      { choice: "allow-once" },
      { decision: "allow-once" },
    ],
    [
      {
        method: "item/tool/requestUserInput",
        params: { questions: [{ id: "a", question: "Color?" }] },
      },
      { answers: { a: ["Blue"] } },
      { answers: { a: { answers: ["Blue"] } } },
    ],
    [
      {
        method: "AskUserQuestion",
        params: {
          input: { questions: [{ question: "Color?", multiSelect: true }] },
        },
      },
      { answers: { "Color?": ["Blue", "Red"] } },
      {
        behavior: "allow",
        updatedInput: {
          questions: [{ question: "Color?", multiSelect: true }],
          answers: { "Color?": "Blue, Red" },
        },
      },
    ],
    [
      {
        method: "clarify",
        params: { questions: [{ qid: "a", question: "Color?" }] },
      },
      { answers: { a: "Blue" } },
      { answers: { a: "Blue" } },
    ],
    [
      {
        method: "elicitation/create",
        params: { message: "Name", requestedSchema: { type: "object" } },
      },
      { action: "accept", content: { name: "Oak" } },
      { action: "accept", content: { name: "Oak" } },
    ],
    [
      {
        method: "mcpServer/elicitation/request",
        params: { mode: "url", url: "https://example.org/login" },
      },
      { action: "cancel" },
      { action: "cancel" },
    ],
  ];
  for (const [native, answer, expected] of cases) {
    const i = describeInteraction(native);
    assert.deepEqual(i.native, native);
    assert.deepEqual(answerInteraction(i, answer), expected);
    assert.deepEqual(
      await routeInteraction(
        { onInteraction: async () => answer },
        native,
        context,
      ),
      expected,
    );
  }
  assert.throws(
    () =>
      answerInteraction(describeInteraction(cases[0][0]), {
        choice: "acceptForSession",
      }),
    /invalid_interaction_choice/,
  );
  assert.throws(
    () =>
      answerInteraction(describeInteraction(cases[4][0]), { choice: "always" }),
    /invalid_interaction_choice/,
  );
  const original = { method: "future/form", params: { arbitrary: true } };
  assert.equal(describeInteraction(original).kind, "native");
  assert.deepEqual(
    await routeInteraction(
      {
        onInteraction: async () => {
          throw Error("must preserve escape hatch");
        },
        onRequest: async (request) => request.params,
      },
      original,
      context,
    ),
    { arbitrary: true },
  );
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    routeInteraction(
      { onInteraction: async () => ({ choice: "allow" }) },
      cases[0][0],
      { ...context, signal: c.signal },
    ),
  );
});

test("progress keeps raw messages and marks usage scope rather than inventing totals", () => {
  const native = {
    type: "native.notification",
    runId: "r",
    threadId: "t",
    turnId: "u",
    notification: {
      method: "claude.message",
      params: {
        type: "stream_event",
        event: {
          delta: {
            type: "thinking_delta",
            thinking: "A public reasoning update",
          },
        },
      },
    },
  };
  assert.deepEqual(projectProgress(native), [
    native,
    { type: "reasoning.delta", runId: "r", text: "A public reasoning update" },
  ]);
  const usage = {
    ...native,
    notification: {
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { total: { inputTokens: 15, outputTokens: 4 } } },
    },
  };
  assert.equal(projectProgress(usage)[1].scope, "session");
  assert.equal(projectProgress(usage)[1].inputTokens, 15);
});

test("tool progress projects actual Claude, Pi, Hermes and OpenClaw event shapes with stable call IDs", () => {
  const cases = [
    [
      "claude.message",
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "call", name: "read", input: {} }],
        },
      },
      "started",
    ],
    [
      "claude.message",
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "call", content: "done" },
          ],
        },
      },
      "finished",
    ],
    [
      "claude.message",
      { type: "tool_progress", tool_use_id: "call", tool_name: "read" },
      "updated",
    ],
    [
      "pi/tool_execution_start",
      {
        event: {
          type: "tool_execution_start",
          toolCallId: "call",
          toolName: "read",
          args: {},
        },
      },
      "started",
    ],
    [
      "pi/tool_execution_end",
      {
        event: {
          type: "tool_execution_end",
          toolCallId: "call",
          toolName: "read",
          entry: {},
        },
      },
      "finished",
    ],
    [
      "event",
      {
        type: "tool.complete",
        payload: { tool_id: "call", name: "read", result: "done" },
      },
      "finished",
    ],
    [
      "agent",
      {
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "call",
          name: "read",
          result: "done",
        },
      },
      "finished",
    ],
  ];
  for (const [method, params, phase] of cases) {
    const event = {
      type: "native.notification",
      runId: "r",
      notification: { method, params },
    };
    const projected = projectProgress(event);
    assert.equal(projected[0], event);
    assert.equal(projected.length, 2);
    assert.equal(projected[1].type, "native.tool");
    assert.equal(projected[1].callId, "call");
    assert.equal(projected[1].phase, phase);
  }
});

test("session manager never drops a binding on unsupported/failed deletion and blocks concurrent native mutations", async () => {
  const bindings = new MemoryBindingStore();
  await bindings.set("s", { threadId: "native", fingerprint: "f" });
  const unsupported = new SessionManager(bindings, () => false, {});
  await assert.rejects(unsupported.delete("s"), /unsupported/);
  assert.ok(await bindings.get("s"));
  let release;
  const ready = new Promise((r) => (release = r));
  const manager = new SessionManager(bindings, () => false, {
    fork: async () => {
      await ready;
      return "fork-native";
    },
    delete: async () => {
      throw Error("denied");
    },
  });
  const fork = manager.fork("s", "target");
  await assert.rejects(manager.delete("s"), /busy/);
  assert.throws(() => manager.assertIdle("target"), /busy/);
  release();
  await fork;
  assert.equal((await bindings.get("target")).threadId, "fork-native");
  await assert.rejects(manager.delete("s"), /denied/);
  assert.ok(await bindings.get("s"));
});

test("Codex/ACP/Hermes/OpenClaw native session RPCs preserve history and fork identities", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-management-"));
  const gateway = await startOpenClawFixture();
  const agents = [
    new CodexAgent(command("codex-server")),
    new AcpAgent({ ...command("acp-server"), cwd, compaction: "kimi" }),
    new HermesAgent({
      ...command("hermes-gateway"),
      cwd,
      env: { HERMES_HOME: join(cwd, "hermes") },
      exclusiveProfile: true,
    }),
    new OpenClawAgent(gateway),
  ];
  t.after(async () => {
    for (const a of agents) await a.close();
    await gateway.close();
  });
  for (const a of agents) {
    const e = await Array.fromAsync(a.run({ ...base, cwd }));
    assert.equal(outcome(e).status, "completed", JSON.stringify(outcome(e)));
    const history = await a.sessions.history("s", { cwd });
    assert.equal(history.source, "native");
    assert.ok(history.items.length);
    assert.ok((await a.sessions.list({ cwd })).items.length);
    const fork = await a.sessions.fork("s", "fork", {
      cwd,
      ...(a instanceof OpenClawAgent ? { entryId: "entry-1" } : {}),
    });
    assert.notEqual(
      fork.nativeSessionId,
      e.find((v) => v.type === "session.bound").threadId,
    );
    const continued = await Array.fromAsync(
      a.run({ ...base, cwd, sessionId: "fork" }),
    );
    assert.equal(
      outcome(continued).status,
      "completed",
      JSON.stringify(outcome(continued)),
    );
    assert.equal(
      continued.find((v) => v.type === "session.bound").threadId,
      fork.nativeSessionId,
    );
    assert.equal((await a.sessions.delete("fork", { cwd })).deleted, true);
    assert.equal(
      (await a.sessions.bindings()).some((v) => v.sessionId === "fork"),
      false,
    );
  }
});

test("Pi native durable history/list/fork and policy callback use the shared interfaces", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-pi-common-"));
  const agent = new PiAgent({ cwd, model, streamFn: fixture([]) });
  t.after(() => agent.close());
  let called = 0,
    approvals = 0;
  const events = await Array.fromAsync(
    agent.run({
      ...base,
      cwd,
      input: "call edit",
      tools: [
        {
          name: "edit",
          description: "Edit",
          inputSchema: { type: "object" },
          execute: async () => {
            called++;
            return { success: true, contentItems: [] };
          },
        },
      ],
      onInteraction: async (request) => {
        approvals++;
        assert.equal(request.kind, "approval");
        return { choice: "deny" };
      },
    }),
  );
  assert.equal(outcome(events).status, "completed");
  assert.equal(called, 0);
  assert.ok(approvals);
  assert.ok((await agent.sessions.history("s")).items.length);
  assert.ok((await agent.sessions.list()).items.length);
  await agent.sessions.fork("s", "fork");
  assert.ok((await agent.sessions.history("fork")).items.length);
  await assert.rejects(agent.sessions.delete("fork"), /unsupported/);
});

test("Claude session management uses the actual SDK store operations, including native deletion", async (t) => {
  const cwd = await realpath(
      await mkdtemp(join(tmpdir(), "agent-host-claude-store-")),
    ),
    nativeId = randomUUID(),
    messageId = randomUUID();
  const store = new InMemorySessionStore(),
    bindings = new MemoryBindingStore();
  await store.append(
    { projectKey: cwd.replace(/[^a-zA-Z0-9]/g, "-"), sessionId: nativeId },
    [
      {
        type: "user",
        uuid: messageId,
        parentUuid: null,
        sessionId: nativeId,
        cwd,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "native history" },
      },
    ],
  );
  await bindings.set("s", { threadId: nativeId, fingerprint: "f" });
  const agent = new ClaudeAgent({ bindings, native: { sessionStore: store } });
  t.after(() => agent.close());
  assert.ok((await agent.sessions.history("s", { cwd })).items.length);
  const fork = await agent.sessions.fork("s", "fork", { cwd });
  assert.notEqual(fork.nativeSessionId, nativeId);
  assert.equal((await agent.sessions.delete("fork", { cwd })).deleted, true);
  assert.ok((await agent.sessions.history("s", { cwd })).items.length);
});

test("Claude compact requires a native boundary and steer enters the open native input stream", async (t) => {
  let observed;
  const query = ({ prompt, options }) => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      const iterator = prompt[Symbol.asyncIterator]();
      const initial = (await iterator.next()).value;
      yield {
        type: "system",
        subtype: "init",
        session_id: options.resume ?? options.sessionId,
      };
      if (String(initial.message.content).startsWith("/compact")) {
        yield {
          type: "system",
          subtype: "compact_boundary",
          session_id: options.resume,
        };
      } else if (initial.message.content === "steer") {
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "ready" },
          },
        };
        observed = (await iterator.next()).value;
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
      };
    },
  });
  const agent = new ClaudeAgent({ query });
  t.after(() => agent.close());
  assert.equal(
    outcome(
      await Array.fromAsync(agent.run({ ...base, mode: "compact", input: "" })),
    ).error,
    "session_not_found",
  );
  for await (const event of agent.run({ ...base, input: "steer" }))
    if (event.type === "assistant.delta") await agent.steer("s", "correction");
  assert.equal(observed.priority, "now");
  assert.equal(observed.message.content, "correction");
  assert.equal(
    outcome(
      await Array.fromAsync(agent.run({ ...base, mode: "compact", input: "" })),
    ).status,
    "completed",
  );
  const missing = new ClaudeAgent({ query: createClaudeQueryFixture() });
  t.after(() => missing.close());
  await Array.fromAsync(missing.run(base));
  assert.equal(
    outcome(
      await Array.fromAsync(
        missing.run({ ...base, mode: "compact", input: "" }),
      ),
    ).error,
    "compaction_not_confirmed",
  );
});

test("HTTP exposes common interactions/settings/native sessions; rejected settings have no task side effects", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-http-common-"));
  const runtime = createNativeRuntime(
    {
      id: "codex",
      kernel: "codex",
      cwd,
      options: command("codex-server"),
      allowedSettings: { effort: { values: ["low", "high"] } },
    },
    cwd,
  );
  const server = await startAgentHostServer({
    stateDirectory: cwd,
    runtimes: [runtime],
    token: "fixture-token-at-least-16",
  });
  t.after(() => server.close());
  const client = new AgentHostClient({
    baseUrl: server.url,
    token: "fixture-token-at-least-16",
  });
  await assert.rejects(
    client.start({
      runtimeId: "codex",
      sessionId: "rejected",
      input: "hello",
      settings: { command: "evil" },
    }),
    /setting_not_allowed/,
  );
  assert.equal((await client.sessions()).length, 0);
  const task = await client.start({
    runtimeId: "codex",
    sessionId: "s",
    input: "approval",
    settings: { effort: "high" },
  });
  const result = await task.wait({
    pollMs: 5,
    onInteraction: async () => ({ choice: "decline" }),
  });
  assert.equal(result.status, "completed");
  assert.match(result.answer, /decline/);
  const sessions = client.nativeSessions("codex");
  assert.ok((await sessions.history("s")).items.length);
  await sessions.fork("s", "f");
  assert.ok((await client.sessions()).some((s) => s.id === "f"));
  await sessions.delete("f");
  await assert.rejects(
    client.start({
      runtimeId: "codex",
      sessionId: "f",
      input: "must not recreate",
    }),
    /native_session_deleted/,
  );
});

test("CLI init is exclusive, doctor is local by default, and run resumes using its printed session ID", async () => {
  const exec = promisify(execFile),
    cwd = await mkdtemp(join(tmpdir(), "agent-host-cli-common-")),
    cli = resolve("dist/service/cli.js"),
    config = join(cwd, "host.json");
  await exec(process.execPath, [
    cli,
    "init",
    "--config",
    config,
    "--cwd",
    cwd,
    "--command",
    process.execPath,
    "--args",
    JSON.stringify([resolve("test/fixtures/codex-server.mjs")]),
  ]);
  await assert.rejects(
    exec(process.execPath, [cli, "init", "--config", config]),
    /EEXIST/,
  );
  const doctor = JSON.parse(
    (await exec(process.execPath, [cli, "doctor", "--config", config])).stdout,
  );
  assert.equal(doctor[0].local.available, true);
  assert.equal(doctor[0].native, undefined);
  const run = await exec(process.execPath, [
    cli,
    "run",
    "--config",
    config,
    "--session",
    "personal",
    "--json",
    "hello",
  ]);
  assert.match(run.stderr, /Session: personal/);
  const events = run.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(outcome(events).status, "completed");
  const resumed = await exec(process.execPath, [
    cli,
    "run",
    "--config",
    config,
    "--session",
    "personal",
    "--json",
    "hello",
  ]);
  assert.equal(
    resumed.stdout
      .trim()
      .split("\n")
      .map(JSON.parse)
      .find((e) => e.type === "session.bound").resumed,
    true,
  );
  let native = 0;
  const report = await diagnoseRuntime({
    id: "fake",
    kernel: "fake",
    cwd,
    configurationKey: "x",
    inspect: async () => ({ available: true }),
    discover: async () => {
      native++;
      return {};
    },
    close() {},
    run() {
      throw Error("must not run");
    },
  });
  assert.equal(native, 0);
  assert.equal(report.local.available, true);
});

test("OpenClaw routes only session/run-scoped native command approvals and cancels pending handlers", async (t) => {
  const gateway = await startOpenClawFixture(),
    agent = new OpenClawAgent(gateway);
  t.after(async () => {
    agent.close();
    await gateway.close();
  });
  let calls = 0;
  const events = await Array.fromAsync(
    agent.run({
      ...base,
      input: "APPROVAL",
      onInteraction: async (request) => {
        calls++;
        assert.equal(request.kind, "approval");
        return { choice: "deny" };
      },
    }),
  );
  assert.equal(outcome(events).status, "completed");
  assert.equal(calls, 1);
  assert.equal(
    gateway.calls.filter((c) => c.method === "exec.approval.resolve").length,
    1,
  );
  const control = new AbortController();
  let signal;
  const cancelled = await Array.fromAsync(
    agent.run({
      ...base,
      sessionId: "cancel",
      input: "APPROVAL",
      signal: control.signal,
      onInteraction: async (_r, c) => {
        signal = c.signal;
        control.abort();
        return new Promise(() => {});
      },
    }),
  );
  assert.equal(outcome(cancelled).status, "cancelled");
  assert.equal(signal.aborted, true);
});

test("Hermes forwards image and PDF bytes through native attachment operations", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-hermes-media-")),
    home = join(cwd, "home");
  const agent = new HermesAgent({
    ...command("hermes-gateway"),
    env: { HERMES_HOME: home },
    exclusiveProfile: true,
  });
  t.after(() => agent.close());
  const attachments = [
    { name: "test.png", mediaType: "image/png", data: "aGVsbG8=" },
    { name: "test.pdf", mediaType: "application/pdf", data: "JVBERg==" },
  ];
  const events = await Array.fromAsync(
    agent.run({ ...base, cwd, attachments }),
  );
  assert.equal(outcome(events).status, "completed");
  const calls = (await readFile(join(home, "methods.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    calls.find((c) => c.method === "image.attach_bytes").params.content_base64,
    attachments[0].data,
  );
  assert.equal(
    calls.find((c) => c.method === "pdf.attach").params.content_base64,
    attachments[1].data,
  );
});

test("Claude native PDF blocks are preserved alongside images", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-pdf-"));
  let received;
  const query = ({ prompt, options }) => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      received = (await prompt[Symbol.asyncIterator]().next()).value.message
        .content;
      yield { type: "system", subtype: "init", session_id: options.sessionId };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
      };
    },
  });
  const runtime = createNativeRuntime(
    { id: "claude", kernel: "claude", cwd, options: { query } },
    cwd,
  );
  t.after(() => runtime.close());
  const events = await Array.fromAsync(
    runtime.run({
      ...base,
      runId: "pdf",
      signal: new AbortController().signal,
      mode: "turn",
      tools: [],
      onRequest: async () => undefined,
      attachments: [
        {
          name: "test.pdf",
          mediaType: "application/pdf",
          data: "JVBERg==",
          path: join(cwd, "test.pdf"),
        },
        {
          name: "test.png",
          mediaType: "image/png",
          data: "aGVsbG8=",
          path: join(cwd, "test.png"),
        },
      ],
    }),
  );
  assert.equal(outcome(events).status, "completed");
  assert.equal(
    received.find((c) => c.type === "document").source.data,
    "JVBERg==",
  );
  assert.equal(
    received.find((c) => c.type === "image").source.data,
    "aGVsbG8=",
  );
});

test("new Codex permission grants keep the requested scope and payload visible", () => {
  const permissions = {
    network: { enabled: true },
    fileSystem: { write: ["/workspace/project"] },
  };
  const request = describeInteraction({
    method: "item/permissions/requestApproval",
    params: { permissions },
  });
  assert.deepEqual(request.permissions, permissions);
  assert.deepEqual(answerInteraction(request, { choice: "turn" }), {
    permissions,
    scope: "turn",
  });
  assert.deepEqual(answerInteraction(request, { action: "cancel" }), {
    permissions: {},
    scope: "turn",
  });
});

test("Pi HTTP native no-op compaction completes with an explicit unchanged receipt", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-pi-compact-"));
  const runtime = createNativeRuntime(
    { id: "pi", kernel: "pi", cwd, options: { model, streamFn: fixture([]) } },
    cwd,
  );
  t.after(() => runtime.close());
  const turn = {
    ...base,
    cwd,
    runId: "pi-compact",
    mode: "turn",
    tools: [],
    signal: new AbortController().signal,
    onRequest: async () => undefined,
  };
  await Array.fromAsync(runtime.run(turn));
  const events = await Array.fromAsync(
    runtime.run({ ...turn, input: "", mode: "compact" }),
  );
  assert.equal(outcome(events).status, "completed");
  assert.deepEqual(events.find((e) => e.type === "control.result").result, {
    ok: true,
    compacted: false,
  });
});

test("native media types are passed only through negotiated ACP ports and Codex audio input", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-extra-media-"));
  for (const kernel of ["codex", "opencode", "kimi"]) {
    const log = join(cwd, kernel + ".jsonl");
    const options = {
      ...command(kernel === "codex" ? "codex-server" : "acp-server"),
      env: {
        CODEX_TEST_LOG: log,
        ACP_TEST_LOG: log,
        ACP_TEST_AUDIO: "1",
        ACP_TEST_RESOURCE: "1",
      },
    };
    const runtime = createNativeRuntime(
      { id: kernel, kernel, cwd, options },
      join(cwd, kernel),
    );
    t.after(() => runtime.close());
    const attachments = [
      {
        name: "test.wav",
        mediaType: "audio/wav",
        data: "UklGRg==",
        path: join(cwd, "test.wav"),
      },
    ];
    if (kernel === "opencode")
      attachments.push({
        name: "test.pdf",
        mediaType: "application/pdf",
        data: "JVBERg==",
        path: join(cwd, "test.pdf"),
      });
    if (kernel === "kimi")
      attachments.push({
        name: "test.txt",
        mediaType: "text/plain",
        data: Buffer.from("Kimi text resource").toString("base64"),
        path: join(cwd, "test.txt"),
      });
    const events = await Array.fromAsync(
      runtime.run({
        ...base,
        runId: "media",
        mode: "turn",
        tools: [],
        signal: new AbortController().signal,
        onRequest: async () => undefined,
        attachments,
      }),
    );
    assert.equal(outcome(events).status, "completed");
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const input =
      kernel === "codex"
        ? calls.find((c) => c.method === "turn/start").params.input
        : calls.find((c) => c.method === "session/prompt").params.prompt;
    assert.equal(
      input.find((c) => c.type === "audio")[
        kernel === "codex" ? "url" : "data"
      ],
      kernel === "codex" ? "data:audio/wav;base64,UklGRg==" : "UklGRg==",
    );
    if (kernel === "opencode")
      assert.equal(
        input.find((c) => c.type === "resource").resource.blob,
        "JVBERg==",
      );
    if (kernel === "kimi") {
      assert.equal(
        input.find((c) => c.type === "resource").resource.text,
        "Kimi text resource",
      );
      const rejected = await Array.fromAsync(
        runtime.run({
          ...base,
          runId: "binary-media",
          mode: "turn",
          tools: [],
          signal: new AbortController().signal,
          onRequest: async () => undefined,
          attachments: [
            {
              name: "test.pdf",
              mediaType: "application/pdf",
              data: "JVBERg==",
              path: join(cwd, "test.pdf"),
            },
          ],
        }),
      );
      assert.equal(outcome(rejected).status, "failed");
      assert.match(outcome(rejected).error, /native_blob_resource_unsupported/);
    }
  }
});

test("ACP text attachments use lossless UTF-8 resources while binary and other encodings retain their bytes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-text-resources-"));
  const log = join(cwd, "calls.jsonl");
  const runtime = createNativeRuntime(
    {
      id: "opencode",
      kernel: "opencode",
      cwd,
      options: {
        ...command("acp-server"),
        env: { ACP_TEST_LOG: log, ACP_TEST_RESOURCE: "1" },
      },
    },
    join(cwd, "state"),
  );
  t.after(() => runtime.close());
  const text = '\ufeff附件\r\n{"receipt":"orchard-7316"}\n';
  const cases = [
    ["text/plain; charset=utf-8", Buffer.from(text), true],
    ["text/csv", Buffer.from(text), true],
    ["application/json", Buffer.from(text), true],
    ["application/ld+json", Buffer.from(text), true],
    ["text/plain", Buffer.from([0xff, 0xfe, 0x61]), false],
    ["text/plain; charset=iso-8859-1", Buffer.from([0xe9]), false],
    ["application/octet-stream", Buffer.from(text), false],
    ["application/pdf", Buffer.from("%PDF-1.4"), false],
  ];
  const attachments = cases.map(([mediaType, bytes], index) => ({
    name: `资料 ${index}`,
    path: join(cwd, `资料 ${index}`),
    mediaType,
    data: bytes.toString("base64"),
  }));
  const events = await Array.fromAsync(
    runtime.run({
      ...base,
      runId: "text",
      mode: "turn",
      tools: [],
      signal: new AbortController().signal,
      onRequest: async () => undefined,
      attachments,
    }),
  );
  assert.equal(outcome(events).status, "completed");
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const resources = calls
    .find((c) => c.method === "session/prompt")
    .params.prompt.filter((c) => c.type === "resource")
    .map((c) => c.resource);
  assert.equal(resources.length, cases.length);
  cases.forEach(([mimeType, bytes, isText], index) => {
    assert.equal(resources[index].mimeType, mimeType);
    assert.ok(resources[index].uri.startsWith("file:"));
    assert.deepEqual(
      isText
        ? Buffer.from(resources[index].text, "utf8")
        : Buffer.from(resources[index].blob, "base64"),
      bytes,
    );
    assert.equal(
      isText ? resources[index].blob : resources[index].text,
      undefined,
    );
  });
});

test("Claude native helpers use an explicitly configured native home without changing process environment", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-claude-home-"));
  const configured = join(cwd, "native-home"),
    previous = process.env.CLAUDE_CONFIG_DIR;
  const agent = new ClaudeAgent({ env: { CLAUDE_CONFIG_DIR: configured } });
  t.after(() => agent.close());
  assert.deepEqual((await agent.sessions.list({ cwd })).items, []);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, previous);
});

test("OpenClaw steering follows the replacement native run and buffers its early frames", async (t) => {
  const gateway = await startOpenClawFixture();
  const agent = new OpenClawAgent({ ...gateway, waitSliceMs: 20 });
  t.after(async () => {
    agent.close();
    await gateway.close();
  });
  const events = [];
  const pending = (async () => {
    for await (const e of agent.run({ ...base, input: "HANG" })) events.push(e);
  })();
  let result;
  for (let n = 0; n < 100; n++) {
    try {
      result = await agent.steer("s", "NEW INSTRUCTION");
      break;
    } catch (e) {
      if (e.message !== "run_not_found") throw e;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  assert.ok(result?.runId);
  await pending;
  assert.equal(outcome(events).status, "completed");
  assert.equal(
    events.findLast((e) => e.type === "model.response").text,
    "NEW INSTRUCTION",
  );
  assert.ok(
    gateway.calls.some(
      (c) => c.method === "agent.wait" && c.params.runId === result.runId,
    ),
  );
});

test("trusted Pi runtime hooks and caller thinking selection reach the native durable engine", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-pi-settings-"));
  let models = 0,
    policies = 0,
    before = 0,
    events = 0,
    calls = 0;
  const runtime = createNativeRuntime(
    {
      id: "pi",
      kernel: "pi",
      cwd,
      options: { model, streamFn: fixture([]) },
      allowedSettings: { thinkingLevel: { values: ["off"] } },
      runOptions: {
        onBeforeTool: async () => {
          policies++;
          return { block: "owner policy" };
        },
        onModelRequest: () => {
          models++;
        },
        onNativeEvent: () => {
          events++;
        },
        beforeTurn: async () => {
          before++;
        },
      },
    },
    cwd,
  );
  t.after(() => runtime.close());
  const output = await Array.fromAsync(
    runtime.run({
      ...base,
      input: "call edit",
      runId: "hooks",
      mode: "turn",
      signal: new AbortController().signal,
      settings: { thinkingLevel: "off" },
      onRequest: async () => undefined,
      tools: [
        {
          name: "edit",
          description: "Edit",
          inputSchema: { type: "object" },
          execute: async () => {
            calls++;
            return { success: true, contentItems: [] };
          },
        },
      ],
    }),
  );
  assert.equal(outcome(output).status, "completed");
  assert.equal(calls, 0);
  assert.ok(models && policies && before && events);
});

test("Hermes persists the new native storage ID after compaction rotation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-hermes-rotation-"));
  const bindings = new MemoryBindingStore();
  const options = {
    ...command("hermes-gateway"),
    bindings,
    cwd,
    env: { HERMES_HOME: cwd, HERMES_TEST_ROTATE: "1" },
    exclusiveProfile: true,
  };
  let agent = new HermesAgent(options);
  t.after(() => agent.close());
  await Array.fromAsync(agent.run({ ...base, cwd }));
  const previous = (await bindings.get("s")).threadId;
  const compact = await agent.compact("s");
  assert.equal(compact.ok, true);
  assert.equal((await bindings.get("s")).threadId, previous + "-compressed");
  await agent.close();
  agent = new HermesAgent(options);
  const output = await Array.fromAsync(agent.run({ ...base, cwd }));
  assert.equal(outcome(output).status, "completed");
  assert.equal(
    output.find((e) => e.type === "session.bound").threadId,
    previous + "-compressed",
  );
});
