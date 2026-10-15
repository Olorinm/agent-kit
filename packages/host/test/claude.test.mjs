import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeAgent, createClaudeMcpServer } from "../dist/claude/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryBindingStore } from "../dist/index.js";
import { createClaudeQueryFixture } from "./fixtures/claude-query.mjs";
const base = {
  sessionId: "document",
  cwd: process.cwd(),
  instructions: "Stable instructions",
  context: "Current contents",
  input: "hello",
};

test("Claude MCP preserves JSON Schema constraints and rejects invalid input before the product runs", async () => {
  let calls = 0;
  const schema = {
    type: "object",
    properties: { text: { type: "string", minLength: 3, pattern: "^[A-Z]" } },
    required: ["text"],
    additionalProperties: false,
  };
  const server = createClaudeMcpServer({
    name: "schema-probe",
    tools: [{ name: "edit", description: "Edit", inputSchema: schema }],
    async call() {
      calls++;
      return { content: [] };
    },
  });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-consumer", version: "1" });
  await server.instance.connect(right);
  await client.connect(left);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools[0].inputSchema.properties.text.minLength, 3);
    const invalid = await client.callTool({
      name: "edit",
      arguments: { text: "x" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(calls, 0);
  } finally {
    await client.close();
  }
});
function agent(t, options = {}) {
  const a = new ClaudeAgent({ query: createClaudeQueryFixture(), ...options });
  t.after(() => a.close());
  return a;
}
const run = (agent, request = {}) =>
  Array.fromAsync(agent.run({ ...base, ...request }));
function terminal(events) {
  assert.equal(
    events.filter((event) => event.type === "turn.finished").length,
    1,
  );
  return events.at(-1).outcome;
}

test("Claude keeps stable instructions separate from current context across native resume", async (t) => {
  const observed = [];
  const bindings = new MemoryBindingStore();
  const query = createClaudeQueryFixture(observed);
  const a = agent(t, { bindings, query });
  assert.equal(terminal(await run(a)).status, "completed");
  const session = await bindings.get(base.sessionId);
  await a.close();
  const events = await run(agent(t, { bindings, query }), {
    context: "Updated contents",
  });
  assert.equal(observed[1].resume, session.threadId);
  assert.equal(observed[1].systemPrompt.append, "Stable instructions");
  assert.equal(
    events.find((event) => event.type === "model.response").text,
    "Updated contents\n\nhello",
  );
  assert.equal(
    events.find((event) => event.type === "session.bound").resumed,
    true,
  );
});
test("Claude in-process MCP tool reaches the product exactly once", async (t) => {
  let calls = 0;
  const events = await run(agent(t), {
    input: "fixture tool",
    tools: [
      {
        name: "edit_document",
        description: "Edit",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        async execute(input) {
          calls++;
          assert.equal(input.text, "Saved via Claude");
          return {
            success: true,
            contentItems: [{ type: "inputText", text: "Saved" }],
          };
        },
      },
    ],
  });
  assert.equal(calls, 1);
  assert.equal(
    events.filter((event) => event.type === "tool.started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "tool.finished").length,
    1,
  );
  assert.equal(terminal(events).status, "completed");
});
test("Claude native permissions and elicitation remain separate callbacks", async (t) => {
  for (const kind of ["permission", "question"]) {
    const events = await run(agent(t), {
      input: `fixture ${kind}`,
      async onRequest(request, context) {
        assert.equal(context.sessionId, base.sessionId);
        return request.method === "permission"
          ? { behavior: "deny", message: "Rejected" }
          : { action: "accept", content: { title: "Maple" } };
      },
    });
    assert.equal(terminal(events).status, "completed");
    assert.match(
      events.find((event) => event.type === "model.response").text,
      kind === "permission" ? /Rejected/ : /Maple/,
    );
  }
});
test("Claude cancellation releases a pending native interaction even if the UI never responds", async (t) => {
  const controller = new AbortController();
  const events = await run(agent(t), {
    input: "fixture permission",
    signal: controller.signal,
    async onRequest() {
      controller.abort();
      return new Promise(() => {});
    },
  });
  assert.equal(terminal(events).status, "cancelled");
  assert.equal(terminal(events).outcomeUnknown, true);
});
test("Claude activates Auto before input and explicitly falls back to Ask", async (t) => {
  const observed = [];
  const events = await run(
    agent(t, { query: createClaudeQueryFixture(observed) }),
    { native: { permissionMode: "auto" } },
  );
  assert.deepEqual(
    observed
      .filter((value) => value.activation)
      .map((value) => value.activation),
    ["auto", "default"],
  );
  assert.equal(terminal(events).status, "completed");
});
test("Claude cannot silently change a bound native configuration", async (t) => {
  const a = agent(t);
  await run(a);
  const events = await run(a, { instructions: "Different stable policy" });
  assert.equal(terminal(events).error, "session_configuration_changed");
  assert.equal(
    events.some((event) => event.type === "session.bound"),
    false,
  );
});

function queryProbe(probe) {
  return ({ prompt, options }) => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      const session_id = options.resume ?? options.sessionId;
      yield {
        type: "system",
        subtype: "init",
        session_id,
        permissionMode: "default",
      };
      await prompt[Symbol.asyncIterator]().next();
      await probe(options);
      yield {
        type: "result",
        subtype: "success",
        session_id,
        is_error: false,
        result: "done",
      };
    },
  });
}

test("Claude discovery exposes the native initialized engine version without account details", async (t) => {
  let closed = false;
  const a = agent(t, {
    query: () => ({
      initializationResult: async () => ({
        claude_code_version: "2.1.300",
        commands: [],
        models: [],
        account: { email: "private@example.test" },
      }),
      close() {
        closed = true;
      },
    }),
  });
  assert.deepEqual(await a.discover(process.cwd()), {
    commands: [],
    models: [],
    accountConfigured: true,
    claude_code_version: "2.1.300",
  });
  assert.equal(closed, true);
});

test("Claude keeps SDK subagent compaction, thinking and sandbox configuration native", async (t) => {
  const observed = [];
  const native = {
    agents: {
      researcher: {
        description: "Research",
        prompt: "Research",
        autoCompactWindow: 32000,
      },
    },
    thinking: { type: "disabled" },
    sandbox: { enabled: true, filesystem: { denyRead: ["/private"] } },
    settings: { sandbox: { network: { deniedDomains: ["example.test"] } } },
  };
  await run(agent(t, { query: createClaudeQueryFixture(observed) }), {
    native,
  });
  for (const key of Object.keys(native))
    assert.deepEqual(observed[0][key], native[key]);
});

test("Claude preserves permission metadata and native permission replies; only SDK product tools auto-allow", async (t) => {
  const metadata = {
    toolUseID: "native-tool",
    requestId: "native-request",
    agentID: "native-child",
    title: "Claude wants to edit this file",
    description: "An exact native disclosure",
    displayName: "Edit file",
    decisionReason: "An owner ask rule",
    blockedPath: "/outside/file",
    defaultToNo: true,
    suppressAlwaysAllowRule: true,
    matchedAskRule: { source: "project", toolName: "Edit" },
    suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Edit" }],
        behavior: "allow",
        destination: "session",
      },
    ],
  };
  const requests = [];
  const a = agent(t, {
    query: queryProbe(async (options) => {
      const permission = await options.canUseTool(
        "Edit",
        { file_path: "/outside/file" },
        { ...metadata, signal: options.abortController.signal },
      );
      assert.deepEqual(permission.updatedPermissions, metadata.suggestions);
      assert.deepEqual(permission.updatedInput, { file_path: "/outside/safe" });
      assert.equal(permission.toolUseID, metadata.toolUseID);
      for (const source of ["project", "sdk"]) {
        const reply = await options.canUseTool(
          "mcp__agent_host__edit",
          {},
          {
            ...metadata,
            signal: options.abortController.signal,
            mcpServer: { name: "agent_host", source },
          },
        );
        assert.equal(reply.behavior, source === "sdk" ? "allow" : "deny");
        if (source === "project") assert.equal(reply.interrupt, true);
      }
    }),
  });
  const events = await run(a, {
    tools: [
      { name: "edit", description: "Edit", inputSchema: { type: "object" } },
    ],
    async onRequest(request) {
      requests.push(request);
      return request.params.name === "Edit"
        ? {
            behavior: "allow",
            updatedInput: { file_path: "/outside/safe" },
            updatedPermissions: metadata.suggestions,
          }
        : { behavior: "deny", message: "Declined", interrupt: true };
    },
  });
  assert.equal(terminal(events).status, "completed");
  assert.equal(requests.length, 2);
  for (const [key, value] of Object.entries(metadata))
    assert.deepEqual(requests[0].params[key], value);
  assert.equal("signal" in requests[0].params, false);
});

test(
  "Claude native request cancellation releases only the withdrawn interaction",
  { timeout: 2000 },
  async (t) => {
    const a = agent(t, {
      query: queryProbe(async (options) => {
        for (const kind of ["permission", "elicitation"]) {
          const controller = new AbortController();
          const pending =
            kind === "permission"
              ? options.canUseTool(
                  "Bash",
                  {},
                  {
                    signal: controller.signal,
                    toolUseID: "call",
                    requestId: "approval",
                  },
                )
              : options.onElicitation(
                  {
                    mode: "form",
                    message: "Details",
                    requestedSchema: { type: "object" },
                  },
                  { signal: controller.signal, requestId: "form" },
                );
          controller.abort(new Error("native_request_withdrawn"));
          await assert.rejects(pending, /native_request_withdrawn/);
          assert.equal(options.abortController.signal.aborted, false);
        }
      }),
    });
    const received = [];
    const events = await run(a, {
      onRequest: async (request, context) => {
        received.push({ request, signal: context.signal });
        return new Promise(() => {});
      },
    });
    assert.equal(terminal(events).status, "completed");
    assert.equal(received.length, 2);
    assert.equal(received[1].request.params.requestId, "form");
    assert.ok(received.every(({ signal }) => signal.aborted));
  },
);
