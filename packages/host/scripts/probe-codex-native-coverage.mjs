/** Opt-in actual Codex executable + isolated loopback provider. No personal credentials or external model. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createNativeRuntime, startAgentHostServer } from "@olorinm/agent-host/server";
import { AgentHostClient } from "@olorinm/agent-host/client";

const { values } = parseArgs({ options: { command: { type: "string" }, out: { type: "string" } } });
const command = resolve(values.command ?? process.env.AGENT_HOST_CODEX ?? "node_modules/.bin/codex");
const reportPath = resolve(values.out ?? ".local/codex-native-coverage.json");
const root = await mkdtemp(join(tmpdir(), "agent-host-codex-native-"));
const cwd = join(root, "workspace"), nativeHome = join(root, "codex");
await mkdir(cwd, { recursive: true }); await mkdir(nativeHome, { recursive: true });
const skillPath = join(cwd, ".agents/skills/audit-fixture/SKILL.md");
await mkdir(dirname(skillPath), { recursive: true });
await writeFile(skillPath, "---\nname: audit-fixture\ndescription: Local deterministic verification only.\n---\nUse the exact AUDIT_SKILL_MARKER in the response.\n");
const calls = [], checks = [];
let childToolContext;
let childToolDone;
const childToolFinished = new Promise((resolve) => { childToolDone = resolve; });
let releaseLateChild;
const lateChildMayCall = new Promise((resolve) => { releaseLateChild = resolve; });
const provider = createServer(async (request, response) => {
  try {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (!request.url.includes("/responses")) { response.writeHead(404).end("{}"); return; }
    calls.push(body);
    const input = JSON.stringify(body.input ?? []);
    const isRoot = input.includes("ROOT_SPAWN");
    const isLateRoot = input.includes("ROOT_SPAWN_LATE");
    const isChild = !isRoot && input.includes("CHILD_CALL_PROBE");
    const isLateChild = isChild && input.includes("CHILD_CALL_PROBE_LATE");
    const isLiveFork = input.includes("ROOT_LIVE_FORK");
    const hasOutput = (callId) => (body.input ?? []).some((item) => item.type === "function_call_output" && item.call_id === callId);
    let item = { id: `message-${calls.length}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "AUDIT_OK", annotations: [] }] };
    if (isLiveFork && !hasOutput("fork-fixture")) {
      item = { id: "fork-item", type: "function_call", call_id: "fork-fixture", name: "live_fork_probe", arguments: "{}", status: "completed" };
    } else if (isRoot && !hasOutput("spawn-fixture")) {
      item = { id: "spawn-item", type: "function_call", call_id: "spawn-fixture", name: "spawn_agent", namespace: "collaboration",
        arguments: JSON.stringify({ task_name: isLateRoot ? "late_audit_child" : "audit_child",
          message: isLateRoot ? "CHILD_CALL_PROBE_LATE: call late_native_probe once." : "CHILD_CALL_PROBE: call native_probe once.",
          fork_turns: "none" }), status: "completed" };
    } else if (isChild && !hasOutput("child-fixture")) {
      if (isLateChild) await lateChildMayCall;
      item = { id: "child-item", type: "function_call", call_id: "child-fixture", name: isLateChild ? "late_native_probe" : "native_probe", arguments: "{}", status: "completed" };
    } else if (isRoot && !isLateRoot) {
      // Keep the parent turn active while the real child requests its inherited product tool.
      let timer;
      await Promise.race([childToolFinished, new Promise((r) => { timer = setTimeout(r, 5000); })]);
      clearTimeout(timer);
    }
    const payload = { id: `response-${calls.length}`, object: "response", created_at: 1, status: "completed",
      model: body.model, output: [item], usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit("response.created", { response: { ...payload, status: "in_progress", output: [] } });
    emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
    if (item.type === "message") {
      emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "AUDIT_OK" });
      emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "AUDIT_OK" });
      emit("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
    }
    emit("response.output_item.done", { output_index: 0, item }); emit("response.completed", { response: payload }); response.end();
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: { message: String(error.message) } })); }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
await writeFile(join(nativeHome, "config.toml"), `model = "fixture"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "Local test fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nmemories = false\nmulti_agent_v2 = true\nmulti_agent_v2_dynamic_tools = true\n`);
const env = { HOME: root, CODEX_HOME: nativeHome, TMPDIR: tmpdir() };
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^OPENAI|^ANTHROPIC|^GOOGLE|^GEMINI|^AWS_|^CODEX_/.test(key) && key !== "CODEX_HOME") env[key] = undefined;
const runtime = createNativeRuntime({ id: "codex", kernel: "codex", cwd,
  options: { command, env, requestTimeoutMs: 15000 }, thread: { approvalPolicy: "never", sandbox: "read-only" },
  nativeAccess: { methods: "all", notifications: "all", requestTimeoutMs: 15000 } }, join(root, "bindings"));
let server, client, threadId, userAgent, nativeSkillPath;
const check = async (name, fn) => {
  try { const details = await fn(); checks.push({ name, status: "passed", ...(details ? { details } : {}) }); }
  catch (error) { checks.push({ name, status: "failed", error: String(error.message), ...(error.nativeError ? { nativeError: error.nativeError } : {}) }); }
  console.log(JSON.stringify(checks.at(-1)));
};
const native = (method, params = {}) => client.nativeRequest("codex", method, params, AbortSignal.timeout(15000));
async function until(read, predicate) {
  const deadline = Date.now() + 15000;
  for (;;) { const result = await read(); if (predicate(result)) return result; assert(Date.now() < deadline, "native receipt timeout"); await new Promise((r) => setTimeout(r, 20)); }
}
try {
  server = await startAgentHostServer({ stateDirectory: join(root, "host"), token: "local-native-coverage-fixture", runtimes: [runtime], port: 0 });
  client = new AgentHostClient({ baseUrl: server.url, token: "local-native-coverage-fixture" });
  await check("native initialization through Host", async () => {
    const page = await client.nativeEvents("codex");
    assert(page.events.some((item) => item.event.type === "connected"));
    userAgent = (await client.discover("codex")).native?.initialize?.userAgent;
    assert(userAgent); return { userAgent };
  });
  await check("native skills discovery", async () => {
    const page = await native("skills/list", { cwds: [cwd], forceReload: true });
    nativeSkillPath = page.data.flatMap((item) => item.skills ?? []).find((skill) => skill.name === "audit-fixture")?.path;
    assert(nativeSkillPath);
  });
  await check("native thread creation", async () => { const r = await native("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only" }); threadId = r.thread.id; assert(threadId); return { historyMode: r.thread.historyMode }; });
  await check("native typed skill and additional context", async () => {
    const started = await native("turn/start", { threadId, input: [{ type: "text", text: "$audit-fixture", text_elements: [] }, { type: "skill", name: "audit-fixture", path: nativeSkillPath }],
      additionalContext: { probe: { kind: "untrusted", value: "AUDIT_UNTRUSTED_CONTEXT" } } });
    await until(() => client.nativeEvents("codex", 0, 1000), (page) => page.events.some(({ event }) => event.method === "turn/completed" && event.params?.turn?.id === started.turn.id && event.params.turn.status === "completed"));
    assert(JSON.stringify(calls).includes("AUDIT_SKILL_MARKER")); assert(JSON.stringify(calls).includes("AUDIT_UNTRUSTED_CONTEXT"));
  });
  await check("native metadata read", async () => { assert.equal((await native("thread/read", { threadId })).thread.id, threadId); });
  await check("native thread list", async () => { assert((await native("thread/list", { cwd, limit: 1 })).data.some((thread) => thread.id === threadId)); });
  await check("native turn pagination", async () => { assert.equal((await native("thread/turns/list", { threadId, limit: 1, itemsView: "full" })).data.length, 1); });
  await check("native item pagination", async () => { assert.equal((await native("thread/items/list", { threadId, limit: 1 })).data.length, 1); });
  await check("native rename", async () => { await native("thread/name/set", { threadId, name: "Native audit" }); });
  await check("native fork", async () => { assert.notEqual((await native("thread/fork", { threadId, excludeTurns: true })).thread.id, threadId); });
  await check("native resume", async () => { assert.equal((await native("thread/resume", { threadId, excludeTurns: true })).thread.id, threadId); });
  await check("native memory status", async () => { const status = await native("memory/status"); return { fields: Object.keys(status) }; });
  await check("native errors retain structured code", async () => { await assert.rejects(native("not/a/method"), (error) => typeof error.nativeError?.code === "number"); });
  const facade = client.nativeSessions("codex");
  await check("common Host typed input and submission identity", async () => {
    const input = { sessionId: "typed", runtimeId: "codex", requestKey: "typed-once", input: "$audit-fixture", context: "AUDIT_HOST_CONTEXT",
      inputItems: [{ type: "skill", name: "audit-fixture", path: nativeSkillPath }] };
    const task = await client.start(input); const again = await client.start(input);
    assert.equal(task.runId, again.runId); assert.equal((await client.findRun("codex", "typed-once")).id, task.runId);
    assert.equal((await task.wait({ signal: AbortSignal.timeout(15000), pollMs: 10 })).status, "completed");
    assert(JSON.stringify(calls).includes("AUDIT_HOST_CONTEXT"));
  });
  await check("common Host standalone tool output preserves native source", async () => {
    const marker = "AUDIT_NATIVE_TOOL_DELIVERY", start = calls.length;
    const task = await client.start({ runtimeId: "codex", sessionId: "tool-delivery", input: "",
      toolOutput: { namespace: "mau", name: "send_to_session", output: marker, retain: false } });
    assert.equal((await task.wait({ signal: AbortSignal.timeout(15000), pollMs: 10 })).status, "completed");
    const inputs = calls.slice(start).flatMap((request) => request.input ?? []);
    const output = inputs.find((item) => item.type === "function_call_output" && JSON.stringify(item.output).includes(marker));
    assert(output, "native delivery must reach the model as function_call_output");
    assert.equal(output.namespace, "mau"); assert.equal(output.name, "send_to_session");
    assert.equal(inputs.some((item) => item.role === "user" && JSON.stringify(item).includes(marker)), false);
    return { nativeType: "function_call_output", sourceNamespace: output.namespace, sourceName: output.name, userMessageRewrite: false };
  });
  await check("common Host session pagination and fork", async () => {
    assert.equal((await facade.history("typed", { limit: 1 })).items.length, 1);
    const unloaded = await facade.history("typed", { limit: 1, itemsView: "notLoaded" });
    assert.equal(unloaded.items[0].itemsView, "notLoaded"); assert.deepEqual(unloaded.items[0].items, []);
    assert.equal((await facade.items("typed", { limit: 1 })).items.length, 1);
    const fork = await facade.fork("typed", "forked"); assert(fork.nativeSessionId);
    await facade.rename("forked", "Forked audit"); await facade.archive("forked"); await facade.unarchive("forked");
  });
  await check("common Host can fork a live native source without interrupting or replaying it", async () => {
    let releaseTool, entered = false, toolCalls = 0;
    const gate = new Promise((resolve) => { releaseTool = resolve; });
    const tool = { name: "live_fork_probe", description: "Hold the source turn during a native fork", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() { toolCalls++; entered = true; await gate; return { success: true, contentItems: [{ type: "inputText", text: "LIVE_SOURCE_TOOL_DONE" }] }; } };
    const source = await client.session({ sessionId: "live-source", runtimeId: "codex", tools: [tool] }).run("ROOT_LIVE_FORK: call live_fork_probe once.");
    const sourceCompleted = source.wait({ signal: AbortSignal.timeout(15000), pollMs: 10 });
    sourceCompleted.catch(() => {});
    try {
      await until(async () => entered, Boolean);
      const before = (await facade.bindings()).bindings.find((binding) => binding.sessionId === "live-source");
      const fork = await facade.fork("live-source", "live-fork");
      assert(fork.nativeSessionId); assert.notEqual(fork.nativeSessionId, before.nativeSessionId);
      releaseTool();
      assert.equal((await sourceCompleted).status, "completed");
      const resumed = await client.session({ sessionId: "live-fork", runtimeId: "codex", tools: [tool] }).run("AUDIT_LIVE_FORK_RESUME");
      assert.equal((await resumed.wait({ signal: AbortSignal.timeout(15000), pollMs: 10 })).status, "completed");
      const after = (await facade.bindings()).bindings.find((binding) => binding.sessionId === "live-fork");
      assert.equal(after.nativeSessionId, fork.nativeSessionId); assert.equal(toolCalls, 1, "fork continuation replayed the source tool");
      return { forkWhileSourceToolPending: true, sourceCompleted: true, forkResumedSameNativeId: true, productToolCalls: 1 };
    } finally { releaseTool(); await sourceCompleted.catch(() => {}); }
  });
  await check("native spawned child tools use verified ancestry through Host", async () => {
    const tool = { name: "native_probe", description: "Local deterministic receipt", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, context) { assert.equal(childToolContext, undefined, "tool executed twice"); childToolContext = context; childToolDone(); return { success: true, contentItems: [{ type: "inputText", text: "CHILD_TOOL_OK" }] }; } };
    const task = await client.session({ sessionId: "parent", runtimeId: "codex", tools: [tool] }).run("ROOT_SPAWN: spawn one child task.");
    const result = await task.wait({ signal: AbortSignal.timeout(15000), pollMs: 10 }); assert.equal(result.status, "completed"); assert(childToolContext);
    const bindings = await facade.bindings(); const parent = bindings.bindings.find((binding) => binding.sessionId === "parent"); assert(parent);
    assert.notEqual(childToolContext.threadId, parent.nativeSessionId);
    const child = (await native("thread/read", { threadId: childToolContext.threadId })).thread;
    assert.equal(child.parentThreadId, parent.nativeSessionId); assert.equal(child.source.subAgent.thread_spawn.parent_thread_id, parent.nativeSessionId);
    return { verifiedSpawnParent: true, separateNativeThreadAndTurn: true, productToolCalls: 1 };
  });
  await check("old native child retains its original root when the parent starts another run", async () => {
    let expiredScopeCalls = 0, newParentContext, releaseNewParent;
    const newParentGate = new Promise((resolve) => { releaseNewParent = resolve; });
    const tool = { name: "late_native_probe", description: "Native callback after parent scope ends", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() { expiredScopeCalls++; throw new Error("completed parent tool scope must not execute"); } };
    const blocker = { name: "live_fork_probe", description: "Hold the new parent run while an old child continues", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, context) { newParentContext = context; await newParentGate; return { success: true, contentItems: [{ type: "inputText", text: "NEW_PARENT_TOOL_DONE" }] }; } };
    const session = client.session({ sessionId: "late-parent", runtimeId: "codex", tools: [tool, blocker] });
    const task = await session.run("ROOT_SPAWN_LATE: spawn one child task, then finish.");
    assert.equal((await task.wait({ signal: AbortSignal.timeout(15000), pollMs: 10 })).status, "completed");
    const parent = (await facade.bindings()).bindings.find((binding) => binding.sessionId === "late-parent");
    const originalTurn = (await native("thread/turns/list", { threadId: parent.nativeSessionId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })).data[0];
    const next = await session.run("ROOT_LIVE_FORK: call live_fork_probe once and wait for its result.");
    const nextCompleted = next.wait({ signal: AbortSignal.timeout(30000), pollMs: 10 }); nextCompleted.catch(() => {});
    try {
      await until(async () => newParentContext, Boolean);
      assert.notEqual(newParentContext.turnId, originalTurn.id);
      releaseLateChild();
      const page = await until(() => client.nativeRequests("codex"), (page) => page.requests.some((request) => request.status === "pending" && request.params?.tool === "late_native_probe"));
      const request = page.requests.find((request) => request.status === "pending" && request.params?.tool === "late_native_probe");
      assert.equal(request.method, "item/tool/call");
      const child = (await native("thread/read", { threadId: request.params.threadId })).thread;
      assert.equal(child.source.subAgent.thread_spawn.parent_thread_id, parent.nativeSessionId);
      const childTurn = (await native("thread/turns/list", { threadId: request.params.threadId, limit: 100, sortDirection: "desc", itemsView: "notLoaded" })).data.find((turn) => turn.id === request.params.turnId);
      assert.equal(childTurn.rootTurnId, originalTurn.id); assert.notEqual(childTurn.rootTurnId, newParentContext.turnId);
      await client.resolveNativeRequest("codex", request.id, { result: { success: true, contentItems: [{ type: "inputText", text: "LATE_CHILD_TOOL_OK" }] } });
      await until(() => client.nativeEvents("codex", 0, 1000), (page) => page.events.some(({ event }) => event.method === "turn/completed" && event.params?.threadId === request.params.threadId && event.params?.turn?.id === request.params.turnId && event.params.turn.status === "completed"));
      assert.equal(expiredScopeCalls, 0);
      releaseNewParent(); assert.equal((await nextCompleted).status, "completed");
      return { wrongParentScopeCalls: 0, rawNativeCallbackCompleted: true, childRetainedOriginalRootTurn: true, newParentCompleted: true };
    } finally { releaseNewParent(); await nextCompleted.catch(() => {}); }
  });
} finally {
  releaseLateChild();
  await server?.close(); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ kind: "native-codex-host-deterministic-provider", userAgent, platform: process.platform,
    arch: process.arch, node: process.version, checks, modelRequests: calls.length,
    limits: "Synthetic loopback model responses; no real account, remote cloud, model quality, OAuth or memory generation acceptance." }, null, 2) + "\n");
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (checks.some((entry) => entry.status === "failed")) process.exitCode = 1;
}
