import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenClawAgent } from "../dist/openclaw/index.js";
import { MemoryBindingStore, FileBindingStore } from "../dist/index.js";
import { startOpenClawFixture } from "./fixtures/openclaw-gateway.mjs";
const request = {
  sessionId: "product-session",
  instructions: "Stable",
  context: "Current context",
  input: "hello",
  model: "provider/model",
};
test("OpenClaw native forks survive restart and retain configuration checks across nested forks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-fork-bindings-"));
  const gateway = await startOpenClawFixture();
  const bindings = new FileBindingStore(directory);
  let agent = new OpenClawAgent({ ...gateway, bindings });
  t.after(async () => {
    agent.close();
    await gateway.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10 });
  });
  const run = async (input) => {
    const events = await Array.fromAsync(agent.run({ ...request, ...input }));
    return {
      outcome: events.at(-1).outcome,
      binding: events.find((e) => e.type === "session.bound"),
    };
  };
  assert.equal((await run({})).outcome.status, "completed");
  const child = await agent.sessions.fork(request.sessionId, "child", {
    entryId: "entry-1",
  });
  agent.close();
  agent = new OpenClawAgent({
    ...gateway,
    bindings: new FileBindingStore(directory),
  });
  const resumed = await run({ sessionId: "child" });
  assert.equal(
    resumed.outcome.status,
    "completed",
    JSON.stringify(resumed.outcome),
  );
  assert.equal(resumed.binding.threadId, child.nativeSessionId);
  const grandchild = await agent.sessions.fork("child", "grandchild", {
    entryId: "entry-1",
  });
  assert.equal(
    (await run({ sessionId: "grandchild" })).binding.threadId,
    grandchild.nativeSessionId,
  );
  for (const changed of [
    { instructions: "Changed" },
    { sessionKey: "another-key" },
  ]) {
    assert.equal(
      (await run({ sessionId: "child", ...changed })).outcome.error,
      "session_configuration_changed",
    );
  }
});
test("OpenClaw correlates early events and overlapping agent/chat streams without replaying stale history", async () => {
  const gateway = await startOpenClawFixture(),
    agent = new OpenClawAgent(gateway);
  try {
    const events = await Array.fromAsync(agent.run(request));
    assert.equal(events.at(-1).outcome.status, "completed");
    assert.equal(
      events.find((e) => e.type === "model.response").text,
      "native reply",
    );
    assert.equal(
      events
        .filter((e) => e.type === "assistant.delta")
        .map((e) => e.text)
        .join(""),
      "native reply",
    );
    const empty = await Array.fromAsync(
      agent.run({ ...request, input: "EMPTY" }),
    );
    assert.equal(
      empty.some((e) => e.type === "model.response"),
      false,
    );
    assert.equal(
      gateway.calls.some((c) => c.method === "chat.history"),
      false,
    );
  } finally {
    agent.close();
    await gateway.close();
  }
});
test("OpenClaw native plugin scopes product tools, deduplicates calls, rejects edits and reopens native keys", async () => {
  const gateway = await startOpenClawFixture(),
    bindings = new MemoryBindingStore();
  let agent = new OpenClawAgent({ ...gateway, bindings }),
    calls = 0,
    allow = false;
  const tools = [
    {
      name: "host.edit_document",
      description: "Edit",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      async execute() {
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
      agent.run({ ...request, input: "TOOL", tools }),
    );
    assert.equal(
      first.at(-1).outcome.status,
      "completed",
      JSON.stringify(first.at(-1)),
    );
    assert.equal(calls, 1);
    assert.match(
      first.find((e) => e.type === "model.response").text,
      /rejected/,
    );
    const key = first.find((e) => e.type === "session.bound").threadId;
    agent.close();
    allow = true;
    agent = new OpenClawAgent({ ...gateway, bindings });
    const second = await Array.fromAsync(
      agent.run({ ...request, input: "TOOL", tools }),
    );
    assert.equal(
      second.at(-1).outcome.status,
      "completed",
      JSON.stringify(second.at(-1)),
    );
    assert.equal(calls, 2);
    assert.equal(second.find((e) => e.type === "session.bound").threadId, key);
    assert.equal(second.find((e) => e.type === "session.bound").resumed, true);
  } finally {
    agent.close();
    await gateway.close();
  }
});
test("OpenClaw product image results remain native image blocks outside text-only catalog wrappers", async () => {
  const gateway = await startOpenClawFixture();
  const agent = new OpenClawAgent(gateway);
  try {
    const events = await Array.fromAsync(
      agent.run({
        ...request,
        input: "TOOL",
        tools: [
          {
            name: "picture",
            description: "Return an image",
            inputSchema: { type: "object" },
            execute: async () => ({
              success: true,
              contentItems: [
                { type: "inputImage", imageUrl: "data:image/png;base64,AAH/" },
              ],
            }),
          },
        ],
      }),
    );
    assert.equal(events.at(-1).outcome.status, "completed");
    assert.deepEqual(
      JSON.parse(events.find((e) => e.type === "model.response").text),
      [{ type: "image", mimeType: "image/png", data: "AAH/" }],
    );
  } finally {
    agent.close();
    await gateway.close();
  }
});

test("OpenClaw unknown cancellation blocks another turn on the same native producer", async () => {
  const gateway = await startOpenClawFixture({ ignoreCancel: true }),
    agent = new OpenClawAgent({ ...gateway, cancellationGraceMs: 20 });
  try {
    const controller = new AbortController();
    let result;
    for await (const e of agent.run({
      ...request,
      input: "HANG",
      signal: controller.signal,
    })) {
      if (e.type === "session.bound") setTimeout(() => controller.abort(), 20);
      if (e.type === "turn.finished") result = e.outcome;
    }
    assert.equal(result.status, "cancelled");
    assert.equal(result.outcomeUnknown, true);
    const retry = await Array.fromAsync(agent.run(request));
    assert.match(retry.at(-1).outcome.error, /outcome_unresolved/);
    assert.equal(
      gateway.calls.filter((c) => c.method === "chat.send").length,
      1,
    );
  } finally {
    agent.close();
    await gateway.close();
  }
});
test("OpenClaw product tools fail explicitly without the native plugin", async () => {
  const gateway = await startOpenClawFixture({ pluginEnabled: false }),
    agent = new OpenClawAgent(gateway);
  try {
    const events = await Array.fromAsync(
      agent.run({
        ...request,
        tools: [
          {
            name: "edit_document",
            description: "Edit",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    assert.equal(events.at(-1).outcome.status, "failed");
    assert.equal(
      gateway.calls.some((c) => c.method === "chat.send"),
      false,
    );
  } finally {
    agent.close();
    await gateway.close();
  }
});

test("OpenClaw persists the canonical native key and refuses to recreate deleted native history", async () => {
  const gateway = await startOpenClawFixture({ canonicalize: true }),
    bindings = new MemoryBindingStore();
  let agent = new OpenClawAgent({ ...gateway, bindings });
  try {
    const first = await Array.fromAsync(
      agent.run({ ...request, sessionKey: "product-key" }),
    );
    assert.equal(first.at(-1).outcome.status, "completed");
    assert.equal(
      first.find((e) => e.type === "session.bound").threadId,
      "agent:main:product-key",
    );
    agent.close();
    agent = new OpenClawAgent({ ...gateway, bindings });
    const next = await Array.fromAsync(
      agent.run({ ...request, sessionKey: "product-key" }),
    );
    assert.equal(next.at(-1).outcome.status, "completed");
    gateway.deleteSession("agent:main:product-key");
    const before = gateway.calls.length;
    const missing = await Array.fromAsync(
      agent.run({ ...request, sessionKey: "product-key" }),
    );
    assert.match(missing.at(-1).outcome.error, /native_session_missing/);
    assert.equal(
      gateway.calls
        .slice(before)
        .some((c) => ["sessions.patch", "chat.send"].includes(c.method)),
      false,
    );
  } finally {
    agent.close();
    await gateway.close();
  }
});

for (const ignoreCancel of [false, true]) {
  test(`OpenClaw error after abort requires a native cancellation receipt (${ignoreCancel})`, async () => {
    const gateway = await startOpenClawFixture({
      cancelStatus: "error",
      ignoreCancel,
    });
    const agent = new OpenClawAgent({ ...gateway, cancellationGraceMs: 40 });
    try {
      const controller = new AbortController();
      const events = [];
      for await (const event of agent.run({
        ...request,
        method: "agent",
        input: "HANG",
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === "session.bound")
          setTimeout(() => controller.abort(), 20);
      }
      assert.equal(events.at(-1).outcome.status, "cancelled");
      assert.equal(events.at(-1).outcome.outcomeUnknown === true, ignoreCancel);
      assert.equal(
        events.filter((event) => event.type === "turn.finished").length,
        1,
      );
      assert.equal(
        gateway.calls.filter((call) => call.method === "chat.abort").length,
        1,
      );
    } finally {
      agent.close();
      await gateway.close();
    }
  });
}
