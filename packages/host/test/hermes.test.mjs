import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HermesAgent } from "../dist/hermes/index.js";
import { FileBindingStore, MemoryBindingStore } from "../dist/index.js";
const fixture = resolve("test/fixtures/hermes-gateway.mjs");
const request = {
  sessionId: "product-session",
  cwd: process.cwd(),
  instructions: "Stable",
  input: "hello",
};
test("Hermes changes native fast mode per session without rewriting creation identity", async () => {
  const { agent, home } = await setup();
  try {
    const identities = [];
    for (const fastMode of ["normal", "auto", "cold", "fast", "ultrafast"]) {
      const events = await Array.fromAsync(agent.run({ ...request, fastMode }));
      assert.equal(events.at(-1).outcome.status, "completed");
      identities.push(events.find((e) => e.type === "session.bound").threadId);
    }
    assert.equal(new Set(identities).size, 1);
    const calls = (await readFile(join(home, "methods.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(calls.filter((c) => c.method === "session.create").length, 1);
    const settings = calls.filter(
      (c) => c.method === "config.set" && c.params.key === "fast",
    );
    assert.deepEqual(
      settings.map((c) => c.params.value),
      ["normal", "auto", "cold", "fast", "ultrafast"],
    );
    assert.ok(
      settings.every(
        (c) =>
          c.params.scope === "session" &&
          c.params.session_id.startsWith("live-"),
      ),
    );
  } finally {
    agent.close();
  }
});

test("Hermes never reports no-op, refused growth or aborted compression as completed", async () => {
  const { agent } = await setup();
  try {
    await Array.fromAsync(agent.run(request));
    for (const reason of ["noop", "refused_would_grow", "aborted"]) {
      const receipt = await agent.compact(request.sessionId, reason);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.compacted, false);
      assert.equal(receipt.error, `hermes_compression_${reason}`);
      assert.equal(receipt.cancelled, reason === "aborted" ? true : undefined);
    }
  } finally {
    agent.close();
  }
});

test("Hermes forks native history without transferring a duplicate transcript", async () => {
  const { agent, home } = await setup();
  try {
    await Array.fromAsync(agent.run(request));
    const fork = await agent.sessions.fork(request.sessionId, "fork");
    assert.match(fork.nativeSessionId, /^stored-fork-/);
    const calls = (await readFile(join(home, "methods.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      calls.some((c) => c.method === "session.branch"),
      false,
    );
    assert.ok(
      calls.find((c) => c.method === "session.branch_whole").params
        .idempotency_key,
    );
  } finally {
    agent.close();
  }
});
async function setup(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), "hermes-host-test-"));
  const options = {
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, HERMES_HOME: home },
    bindings: new FileBindingStore(join(home, "bindings")),
    exclusiveProfile: true,
    ...extra,
  };
  return { home, options, agent: new HermesAgent(options) };
}
test("Hermes uses stored IDs across restart, scopes native events and trusts compression receipts", async () => {
  const { options, agent } = await setup();
  let reopened;
  try {
    const first = await Array.fromAsync(agent.run(request));
    assert.equal(first.at(-1).outcome.status, "completed");
    assert.equal(
      first.find((e) => e.type === "model.response").text,
      "Native Hermes response",
    );
    const binding = first.find((e) => e.type === "session.bound");
    assert.match(binding.threadId, /^stored-/);
    assert.deepEqual(await agent.compact(request.sessionId, "pending"), {
      ok: false,
      compacted: false,
      error: "hermes_compression_pending",
    });
    assert.deepEqual(await agent.compact(request.sessionId, "focus"), {
      ok: true,
      compacted: true,
      nativeSessionId: binding.threadId,
    });
    agent.close();
    reopened = new HermesAgent(options);
    const second = await Array.fromAsync(reopened.run(request));
    assert.deepEqual(
      second.find((e) => e.type === "session.bound"),
      { ...binding, runId: second[0].runId, resumed: true },
    );
  } finally {
    agent.close();
    reopened?.close();
  }
});
test("Hermes bridges product tools and preserves modern approval/multi-question answers", async () => {
  const { agent } = await setup();
  let calls = 0,
    allow = false;
  const tools = [
    {
      name: "edit_document",
      description: "Edit",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async () => {
        calls++;
        return {
          success: allow,
          contentItems: [
            { type: "inputText", text: allow ? "saved" : "rejected" },
          ],
        };
      },
    },
  ];
  try {
    const first = await Array.fromAsync(
      agent.run({ ...request, tools, input: "CALL_TOOL" }),
    );
    assert.match(
      first.find((e) => e.type === "model.response").text,
      /rejected/,
    );
    assert.equal(calls, 1);
    allow = true;
    const second = await Array.fromAsync(
      agent.run({ ...request, tools, input: "CALL_TOOL" }),
    );
    assert.match(second.find((e) => e.type === "model.response").text, /saved/);
    assert.equal(calls, 2);
    const third = await Array.fromAsync(
      agent.run({
        ...request,
        tools,
        input: "INTERACTION",
        onRequest: async (rpc) =>
          rpc.method === "approval"
            ? { choice: "once" }
            : { answers: { one: "blue", two: "large" } },
      }),
    );
    assert.deepEqual(
      JSON.parse(third.find((e) => e.type === "model.response").text),
      {
        permission: { choice: "once" },
        response: { answers: { one: "blue", two: "large" } },
      },
    );
  } finally {
    agent.close();
  }
});
test("Hermes pre-abort starts nothing; cancellation settles or retires the producer", async () => {
  const { agent, home } = await setup({ cancellationGraceMs: 1_000 });
  try {
    const aborted = await Array.fromAsync(
      agent.run({ ...request, signal: AbortSignal.abort() }),
    );
    assert.equal(aborted.at(-1).outcome.status, "cancelled");
    await assert.rejects(readFile(join(home, "methods.jsonl")), /ENOENT/);
    const controller = new AbortController();
    const events = [];
    for await (const event of agent.run({
      ...request,
      input: "HANG",
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "session.bound")
        setTimeout(() => controller.abort(), 40);
    }
    assert.deepEqual(events.at(-1).outcome, { status: "cancelled" });
  } finally {
    agent.close();
  }
});
test("Hermes failed native restore never creates a replacement conversation", async () => {
  const { agent, options, home } = await setup();
  await options.bindings.set(request.sessionId, {
    threadId: "missing",
    fingerprint: "known",
  });
  try {
    const events = await Array.fromAsync(
      agent.run({ ...request, bindingFingerprint: "known" }),
    );
    assert.equal(events.at(-1).outcome.status, "failed");
    assert.doesNotMatch(
      await readFile(join(home, "methods.jsonl"), "utf8"),
      /session.create|prompt.submit/,
    );
  } finally {
    agent.close();
  }
});

test("Hermes resumes the native identity while changing session settings and preserves configuration guards", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-hermes-settings-"));
  const bindings = new MemoryBindingStore();
  const agent = new HermesAgent({
    command: process.execPath,
    args: [fixture],
    env: { HERMES_HOME: home },
    bindings,
  });
  try {
    const base = {
      ...request,
      model: "fixture-a",
      provider: "custom:test",
      reasoningEffort: "none",
    };
    const first = await Array.fromAsync(agent.run(base));
    assert.equal(first.at(-1).outcome.status, "completed");
    const second = await Array.fromAsync(
      agent.run({ ...base, model: "fixture-b", reasoningEffort: "high" }),
    );
    assert.equal(second.at(-1).outcome.status, "completed");
    assert.equal(
      second.find((e) => e.type === "session.bound").threadId,
      first.find((e) => e.type === "session.bound").threadId,
    );
    const calls = (await readFile(join(home, "methods.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const settings = calls.filter((c) => c.method === "config.set");
    assert.equal(settings.length, 2);
    assert.ok(
      settings.every(
        (c) =>
          c.params.scope === "session" &&
          c.params.session_id.startsWith("live-"),
      ),
    );
    assert.deepEqual(
      settings.map((c) => [c.params.key, c.params.value]),
      [
        ["model", "fixture-b --provider custom:test"],
        ["reasoning", "high"],
      ],
    );
    const rejected = await Array.fromAsync(
      agent.run({ ...base, reasoningEffort: "reject-me" }),
    );
    assert.equal(rejected.at(-1).outcome.status, "failed");
    assert.match(rejected.at(-1).outcome.error, /native_setting_rejected/);
    const guarded = await Array.fromAsync(
      agent.run({ ...base, instructions: "Changed product configuration" }),
    );
    assert.match(guarded.at(-1).outcome.error, /session_configuration_changed/);
    const confirmation = await Array.fromAsync(
      agent.run({ ...base, model: "confirm-me" }),
    );
    assert.match(
      confirmation.at(-1).outcome.error,
      /hermes_model_confirmation_required/,
    );
    assert.equal(
      (await bindings.get(base.sessionId)).threadId,
      first.find((e) => e.type === "session.bound").threadId,
    );
  } finally {
    await agent.close();
  }
});

test("Hermes rejects retired model-bound fingerprints without rewriting the session binding", async () => {
  const { options, agent } = await setup();
  const base = {
    ...request,
    model: "fixture-a",
    provider: "custom:test",
    reasoningEffort: "none",
  };
  let reopened;
  try {
    const initial = await Array.fromAsync(agent.run(base));
    const id = initial.find((e) => e.type === "session.bound").threadId;
    const legacy = createHash("sha256")
      .update(
        JSON.stringify({
          cwd: resolve(base.cwd),
          instructions: base.instructions,
          model: base.model,
          provider: base.provider,
          effort: base.reasoningEffort,
        }),
      )
      .digest("hex");
    await options.bindings.set(base.sessionId, {
      threadId: id,
      fingerprint: legacy,
    });
    await agent.close();
    reopened = new HermesAgent(options);
    const resumed = await Array.fromAsync(reopened.run(base));
    assert.equal(resumed.at(-1).outcome.status, "failed");
    assert.match(resumed.at(-1).outcome.error, /session_configuration_changed/);
    assert.equal((await options.bindings.get(base.sessionId)).fingerprint, legacy);

  } finally {
    await agent.close();
    await reopened?.close();
  }
});
