import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { model, fixture } from "./fixtures/pi-stream.mjs";
import { PiAgent } from "../dist/pi/index.js";
import { FileBindingStore } from "../dist/index.js";
import { defineExtension, MemoryStorage } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const base = {
  sessionId: "document",
  input: "hello",
  instructions: "Stable instructions",
};
test("Pi durable: native JSONL survives restart, tools execute through product policy, and latest context reaches the native model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-pi-"));
  const observed = [];
  let calls = 0;
  const options = {
    cwd,
    sessionRoot: join(cwd, "sessions"),
    model,
    streamFn: fixture(observed),
    bindings: new FileBindingStore(join(cwd, "bindings")),
  };
  const tools = [
    {
      name: "edit",
      description: "Edit",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async (input) => {
        calls++;
        assert.equal(input.text, "CEDAR");
        return {
          success: false,
          contentItems: [{ type: "inputText", text: "User rejected edit" }],
        };
      },
    },
  ];
  let agent = new PiAgent(options);
  const run = (extra = {}) =>
    Array.fromAsync(agent.run({ ...base, cwd, tools, ...extra }));
  try {
    const first = await run({ input: "call edit", context: "Version one" });
    assert.equal(
      first.at(-1).outcome.status,
      "completed",
      JSON.stringify(first),
    );
    assert.equal(calls, 1);
    assert.equal(first.filter((e) => e.type === "tool.finished").length, 1);
    assert.match(
      first.find((e) => e.type === "model.response").text,
      /rejected/,
    );
    await agent.close();
    agent = new PiAgent(options);
    const resumed = await run({ context: "Version two" });
    assert.equal(resumed.at(-1).outcome.status, "completed");
    assert.equal(resumed.find((e) => e.type === "session.bound").resumed, true);
    assert.match(JSON.stringify(observed.at(-1).messages), /Version one/);
    assert.match(
      JSON.stringify(observed.at(-1).messages.at(-1)),
      /Version two/,
    );
    assert.equal(await agent.forkSession("document", "fork"), "forked");
    const mismatch = await run({ instructions: "Changed" });
    assert.match(mismatch.at(-1).outcome.error, /configuration_changed/);
  } finally {
    await agent.close();
  }
});

test("Pi 1.2 nested tools preserve native parent identity, receipts, policy and failed image output", async () => {
  const observed = [],
    calls = [],
    policies = [];
  const image = "data:image/png;base64,aGVsbG8=";
  const parent = defineExtension({
    name: "host-nested-probe",
    tools: [
      {
        name: "orchestrate",
        description: "Call a product tool through Pi",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        replay: "unsafe",
        execute: async (input, api, context) => {
          const result = await api.executeTool("edit", input, context, {
            key: "product-edit",
          });
          return {
            output: [
              {
                type: "text",
                text: result.isError ? "Product rejected" : "Product accepted",
              },
            ],
          };
        },
      },
    ],
  });
  const agent = new PiAgent({
    model,
    streamFn: fixture(observed, "orchestrate"),
  });
  try {
    const events = await Array.fromAsync(
      agent.run({
        ...base,
        cwd: process.cwd(),
        input: "call edit",
        extensions: [parent],
        tools: [
          {
            name: "edit",
            description: "Edit",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
            execute: async (input) => {
              calls.push(input);
              return {
                success: false,
                contentItems: [
                  { type: "inputText", text: "Rejected" },
                  { type: "inputImage", imageUrl: image },
                ],
              };
            },
          },
        ],
        onBeforeTool: async (call) => {
          policies.push(call);
        },
      }),
    );
    assert.equal(
      events.at(-1).outcome.status,
      "completed",
      JSON.stringify(events),
    );
    assert.equal(calls.length, 1);
    assert.equal(policies.length, 2);
    const nestedPolicy = policies.find((call) => call.name === "edit");
    assert.equal(nestedPolicy.parent.callId, "edit-1");
    const finished = events.find(
      (event) => event.type === "tool.finished" && event.tool === "edit",
    );
    assert.equal(finished.result.success, false);
    assert.deepEqual(finished.result.contentItems, [
      { type: "inputText", text: "Rejected" },
      { type: "inputImage", imageUrl: image },
    ]);
    const native = events.find(
      (event) =>
        event.type === "native.notification" &&
        event.notification.params.event.type === "tool_execution_end" &&
        event.notification.params.event.toolName === "edit",
    ).notification.params.event;
    assert.equal(native.parentToolCallId, "edit-1");
    assert.equal(native.parentTaskId, nestedPolicy.parent.taskId);
    assert.equal(native.result.taskId, native.taskId);
    assert.equal(native.entry, undefined);
  } finally {
    await agent.close();
  }
});

test("Pi 1.2 nested native tools retain structured results and may be blocked before execution", async () => {
  for (const denied of [false, true]) {
    let executions = 0;
    const extension = defineExtension({
      name: `native-nested-${denied}`,
      tools: [
        {
          name: "parent",
          description: "Parent",
          parameters: { type: "object" },
          execute: async (_input, api, context) => {
            const result = await api.executeTool("child", {}, context);
            return { output: [{ type: "text", text: JSON.stringify(result) }] };
          },
        },
        {
          name: "child",
          description: "Child",
          callers: ["tools"],
          parameters: { type: "object" },
          structuredOutputSchema: {
            type: "object",
            properties: { value: { type: "integer" } },
            required: ["value"],
          },
          execute: async () => {
            executions++;
            return {
              output: [{ type: "text", text: "Model output" }],
              structuredOutput: { value: 42 },
            };
          },
        },
      ],
    });
    const observed = [],
      interactions = [];
    const agent = new PiAgent({ model, streamFn: fixture(observed, "parent") });
    try {
      const events = await Array.fromAsync(
        agent.run({
          ...base,
          cwd: process.cwd(),
          input: "call edit",
          extensions: [extension],
          onRequest: async (request) => {
            interactions.push(request);
            return denied && request.params.name === "child"
              ? { block: "Native child denied" }
              : {};
          },
        }),
      );
      assert.equal(events.at(-1).outcome.status, "completed");
      assert.equal(executions, denied ? 0 : 1);
      const child = events.find(
        (event) => event.type === "tool.finished" && event.tool === "child",
      );
      assert.equal(child.result.success, !denied);
      assert.match(
        JSON.stringify(child.result.contentItems),
        denied ? /Native child denied/ : /42/,
      );
      assert.ok(
        interactions.find((request) => request.params.name === "child").params
          .parent,
      );
      const offered = observed[0].messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.toolsAdded ?? []);
      assert.ok(offered.some((tool) => tool.name === "parent"));
      assert.equal(
        offered.some((tool) => tool.name === "child"),
        false,
      );
    } finally {
      await agent.close();
    }
  }
});

test("Pi 1.2 uses native tool search for deferred product tools and preserves policy argument changes", async () => {
  const observed = [],
    inputs = [],
    approvals = [];
  let generations = 0;
  const agent = new PiAgent({
    model,
    streamFn: (_model, context) => {
      observed.push(context);
      const step = generations++;
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content:
          step < 2
            ? [
                {
                  type: "toolCall",
                  id: `call-${step}`,
                  name: step === 0 ? "tool_search" : "edit",
                  arguments:
                    step === 0
                      ? { query: "edit document" }
                      : { text: "unreviewed" },
                },
              ]
            : [{ type: "text", text: "done" }],
        stopReason: step < 2 ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  try {
    const events = await Array.fromAsync(
      agent.run({
        ...base,
        cwd: process.cwd(),
        extensions: [createToolSearchExtension()],
        tools: [
          {
            name: "edit",
            description: "Edit document text",
            deferLoading: true,
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            execute: async (input) => {
              inputs.push(input);
              return {
                success: true,
                contentItems: [{ type: "inputText", text: input.text }],
              };
            },
          },
        ],
        onBeforeTool: async (call) =>
          call.name === "edit"
            ? { arguments: { text: "reviewed" } }
            : undefined,
        onRequest: async (request) => {
          approvals.push(request);
          return {};
        },
      }),
    );
    assert.equal(
      events.at(-1).outcome.status,
      "completed",
      JSON.stringify(events),
    );
    assert.deepEqual(inputs, [{ text: "reviewed" }]);
    assert.deepEqual(
      approvals.find((request) => request.params.name === "edit").params.input,
      { text: "reviewed" },
    );
    const offered = (context) =>
      context.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.toolsAdded ?? [])
        .map((tool) => tool.name);
    assert.ok(offered(observed[0]).includes("tool_search"));
    assert.equal(offered(observed[0]).includes("edit"), false);
    assert.ok(offered(observed[1]).includes("edit"));
  } finally {
    await agent.close();
  }
});

test(
  "Pi 1.2 fatal storage reads close the native session without retrying work",
  { timeout: 2000 },
  async () => {
    const storage = new MemoryStorage();
    let fail = false,
      reads = 0;
    const nativeScan = storage.scanConversations.bind(storage);
    storage.scanConversations = async (...args) => {
      reads++;
      if (fail) throw new Error("storage_read_failed");
      return nativeScan(...args);
    };
    const observed = [];
    const agent = new PiAgent({ storage, model, streamFn: fixture(observed) });
    try {
      assert.equal(
        (await Array.fromAsync(agent.run({ ...base, cwd: process.cwd() }))).at(
          -1,
        ).outcome.status,
        "completed",
      );
      fail = true;
      const before = reads;
      await assert.rejects(
        agent.sessions.list(),
        /storage_read_failed|Session failed/i,
      );
      assert.equal(reads, before + 1);
      const events = await Array.fromAsync(
        agent.run({ ...base, cwd: process.cwd() }),
      );
      assert.equal(events.at(-1).outcome.status, "failed");
      assert.equal(observed.length, 1);
      assert.equal(reads, before + 1);
    } finally {
      await agent.close();
    }
  },
);
test("Pi durable: pre-aborted input never calls a provider", async () => {
  let calls = 0;
  const agent = new PiAgent({
    model,
    streamFn: () => {
      calls++;
      throw Error("must not run");
    },
  });
  try {
    const events = await Array.fromAsync(
      agent.run({ ...base, cwd: process.cwd(), signal: AbortSignal.abort() }),
    );
    assert.equal(events.at(-1).outcome.status, "cancelled");
    assert.equal(calls, 0);
  } finally {
    await agent.close();
  }
});

test(
  "Pi durable cancels a tool waiting on the product without claiming completion",
  {
    timeout: 2000,
  },
  async () => {
    const controller = new AbortController();
    const observed = [];
    const agent = new PiAgent({
      model,
      streamFn: fixture(observed),
      abortSettleTimeoutMs: 40,
    });
    const started = Date.now();
    try {
      const events = await Array.fromAsync(
        agent.run({
          ...base,
          cwd: process.cwd(),
          input: "call edit",
          signal: controller.signal,
          tools: [
            {
              name: "edit",
              description: "Wait for a product decision",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
              },
              execute: async () => {
                controller.abort();
                return new Promise(() => {});
              },
            },
          ],
        }),
      );
      assert.notEqual(events.at(-1).outcome.status, "completed");
      assert.ok(Date.now() - started < 2000);
      assert.equal(events.filter((e) => e.type === "turn.finished").length, 1);
    } finally {
      await agent.close();
    }
  },
);
