import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgent } from "../dist/adapters.js";
import { FileBindingStore } from "../dist/index.js";
import {
  createNativeRuntime,
  startAgentHostServer,
} from "../dist/service/index.js";
import { AgentHostClient } from "../dist/service/client.js";

const command = resolve("test/fixtures/acp-control-server.mjs");
async function setup(t, kernel, receipt = "confirmed") {
  const root = await mkdtemp(join(tmpdir(), "agent-host-compact-"));
  const log = join(root, "native.jsonl");
  const options = {
    command,
    args: [],
    env: { ACP_CONTROL_LOG: log, ACP_CONTROL_RECEIPT: receipt },
    requestTimeoutMs: 2_000,
  };
  return {
    root,
    log,
    options,
    config: { id: kernel, kernel, cwd: root, options },
  };
}
const entries = async (log) =>
  (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
const outcome = (events) => {
  assert.equal(events.filter((e) => e.type === "turn.finished").length, 1);
  return events.at(-1).outcome;
};
for (const kernel of ["opencode", "kimi"]) {
  test(`${kernel} HTTP compaction resumes the same native binding after service restart`, async (t) => {
    const { root, config, log } = await setup(t, kernel);
    let host;
    const launch = async () => {
      host = await startAgentHostServer({
        runtimes: [createNativeRuntime(config, root)],
        stateDirectory: root,
        token: "compaction-owner-token",
      });
      return new AgentHostClient({
        baseUrl: host.url,
        token: "compaction-owner-token",
      });
    };
    t.after(async () => {
      await host?.close();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    const first = await launch();
    assert.equal((await first.inspect(kernel)).controls.compact, true);
    assert.equal(
      (await first.inspect(kernel)).capabilities.features["controls.compact"]
        .status,
      "conditional",
    );
    const settings = {
      sessionId: "product",
      runtimeId: kernel,
      instructions: "Keep instructions",
    };
    assert.equal(
      (await (await first.session(settings).run("hello")).wait({ pollMs: 10 }))
        .status,
      "completed",
    );
    await host.close();
    const next = await launch();
    const task = await next.session(settings).compact();
    const observed = [];
    const result = await task.wait({
      pollMs: 10,
      onEvent: ({ event }) => observed.push(event),
    });
    assert.equal(result.status, "completed", JSON.stringify(result));
    const binding = observed.find((e) => e.type === "session.bound");
    assert.equal(binding.resumed, true);
    assert.equal(binding.threadId, "native-control-session");
    const logEntries = await entries(log);
    assert.equal(
      logEntries.filter((e) => e.method === "session/new").length,
      1,
    );
    if (kernel === "kimi") {
      const prompts = logEntries.filter((e) => e.method === "session/prompt");
      assert.deepEqual(prompts.at(-1).params.prompt, [
        { type: "text", text: "/compact" },
      ]);
      assert.ok(
        observed.some(
          (e) =>
            e.type === "assistant.delta" &&
            e.text.includes("Compaction completed"),
        ),
      );
    } else {
      const call = logEntries.find((e) => e.method === "summarize");
      assert.equal(
        call.params.url,
        "/session/native-control-session/summarize",
      );
      assert.deepEqual(call.params.body, {
        providerID: "fixture",
        modelID: "model",
      });
    }
  });

  test(`${kernel} compaction refuses a missing binding and preserves native uncertainty`, async (t) => {
    const { root, options, log } = await setup(t, kernel, "missing");
    const agent = createAgent({
      kernel,
      options: {
        ...options,
        bindings: new FileBindingStore(join(root, "bindings")),
      },
    });
    t.after(async () => {
      await agent.close();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    const request = {
      sessionId: "product",
      cwd: root,
      instructions: "",
      input: "",
    };
    assert.equal(
      outcome(await Array.fromAsync(agent.run({ ...request, mode: "compact" })))
        .error,
      "session_not_found",
    );
    assert.equal(
      (await entries(log)).some((e) => e.method === "session/new"),
      false,
    );
    assert.equal(
      outcome(await Array.fromAsync(agent.run({ ...request, input: "hello" })))
        .status,
      "completed",
    );
    const rejected = outcome(
      await Array.fromAsync(agent.run({ ...request, mode: "compact" })),
    );
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.outcomeUnknown, true);
    assert.match(rejected.error, /not_confirmed/);
    const reason = outcome(
      await Array.fromAsync(
        agent.run({ ...request, mode: "compact", input: "custom reason" }),
      ),
    );
    assert.equal(reason.error, "compaction_reason_unsupported");
  });

  test(`${kernel} interrupted compaction settles with an unknown native outcome`, async (t) => {
    const { root, options } = await setup(t, kernel, "hang");
    const agent = createAgent({ kernel, options });
    t.after(async () => {
      await agent.close();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    const request = {
      sessionId: "product",
      cwd: root,
      instructions: "",
      input: "hello",
    };
    await Array.fromAsync(agent.run(request));
    const events = await Array.fromAsync(
      agent.run({
        ...request,
        input: "",
        mode: "compact",
        signal: AbortSignal.timeout(300),
      }),
    );
    const result = outcome(events);
    assert.equal(result.status, "failed");
    assert.equal(result.outcomeUnknown, true);
  });
}

test("Kimi accepts confirmed native compaction even when the summary grows", async (t) => {
  const { root, options } = await setup(t, "kimi", "larger");
  const agent = createAgent({ kernel: "kimi", options });
  t.after(async () => {
    await agent.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const request = {
    sessionId: "larger",
    cwd: root,
    instructions: "",
    input: "hello",
  };
  await Array.fromAsync(agent.run(request));
  assert.equal(
    outcome(
      await Array.fromAsync(
        agent.run({ ...request, input: "", mode: "compact" }),
      ),
    ).status,
    "completed",
  );
});
