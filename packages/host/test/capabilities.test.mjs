import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKernelCapabilities } from "../dist/capabilities.js";
import {
  createNativeRuntime,
  startAgentHostServer,
} from "../dist/service/index.js";
import { AgentHostClient } from "../dist/service/client.js";

test("new clients keep protocol-v1 servers usable without inventing their undeclared capabilities", async () => {
  const runtime = {
    id: "old",
    kernel: "codex",
    cwd: ".",
    available: true,
    controls: { steer: true, compact: false },
  };
  const client = new AgentHostClient({
    baseUrl: "http://fixture.invalid",
    fetch: async (url) =>
      Response.json(
        String(url).endsWith("/inspect") ? runtime : { runtimes: [runtime] },
      ),
  });
  const listed = (await client.runtimes())[0];
  assert.equal(
    listed.capabilities.features["controls.steer"].status,
    "supported",
  );
  assert.equal(
    listed.capabilities.features["sessions.resume"].status,
    "unknown",
  );
  assert.equal(listed.capabilities.features["input.images"].status, "unknown");
  assert.deepEqual(
    (await client.inspect("old")).capabilities,
    listed.capabilities,
  );
});

test("capability discovery distinguishes native limits, negotiation and Host omissions without launching an Agent", () => {
  const pi = getKernelCapabilities("pi");
  assert.equal(pi.features["sessions.delete"].reason, "native_not_supported");
  assert.equal(pi.features["sessions.fork"].status, "supported");
  assert.equal(
    getKernelCapabilities("pi", "http").features["sessions.fork"].reason,
    "host_not_integrated",
  );
  assert.equal(
    getKernelCapabilities("kimi").features["input.images"].reason,
    "native_negotiation_required",
  );
  assert.equal(
    getKernelCapabilities("openclaw").features["tools.product"].reason,
    "configuration_required",
  );
  assert.equal(
    getKernelCapabilities("openclaw").features["interactions.approval"].reason,
    "host_not_integrated",
  );
  pi.features["sessions.fork"].status = "unsupported";
  assert.equal(
    getKernelCapabilities("pi").features["sessions.fork"].status,
    "supported",
  );
  assert.throws(() => getKernelCapabilities("made-up"), /unknown_kernel/);
});

test("HTTP advertises the same capability vocabulary without guessing custom runtime support from its name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-host-capabilities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = createNativeRuntime(
    {
      id: "native",
      kernel: "codex",
      cwd: root,
      options: { command: "intentionally-missing-executable" },
    },
    root,
  );
  const custom = {
    id: "custom",
    kernel: "codex",
    cwd: root,
    configurationKey: "custom",
    async *run() {
      throw new Error("must_not_execute");
    },
    close() {},
  };
  const host = await startAgentHostServer({
    runtimes: [native, custom],
    stateDirectory: root,
    token: "capabilities-owner-token",
  });
  t.after(() => host.close());
  const client = new AgentHostClient({
    baseUrl: host.url,
    token: "capabilities-owner-token",
  });
  const [standard, other] = await client.runtimes();
  assert.equal(standard.available, false);
  assert.equal(standard.reason, "command_not_found");
  assert.deepEqual(
    standard.capabilities,
    getKernelCapabilities("codex", "http"),
  );
  assert.equal(other.capabilities.features["input.images"].status, "unknown");
  assert.equal(
    other.capabilities.features["sessions.resume"].reason,
    "runtime_not_declared",
  );
  assert.equal(other.controls.steer, false);
  assert.equal(
    other.capabilities.features["controls.steer"].status,
    "unsupported",
  );
  assert.equal(
    other.capabilities.features["input.attachments"].status,
    "unsupported",
  );
  await assert.rejects(
    client.start({
      sessionId: "unsupported-media",
      runtimeId: "custom",
      input: "",
      attachments: [
        {
          name: "file.bin",
          mediaType: "application/octet-stream",
          data: "AA==",
        },
      ],
    }),
    /attachments_unsupported/,
  );
  assert.deepEqual(await client.sessions(), []);
  await assert.rejects(access(join(root, ".agent-host/attachments")));
  assert.deepEqual(
    (await client.inspect("native")).capabilities,
    standard.capabilities,
  );
});
