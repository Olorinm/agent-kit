import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AcpHostToolBridgeServer } from "../dist/acp/index.js";

function bridge(label) {
  return {
    descriptors: [
      {
        name: "record",
        description: "Record a test value",
        inputSchema: { type: "object" },
      },
    ],
    async call() {
      return { content: [{ type: "text", text: label }] };
    },
  };
}

test("a stable native MCP process reconnects after Host replacement without changing its frozen specification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-host-stable-mcp-"));
  const connectionDirectory = join(root, "private-connections");
  const first = new AcpHostToolBridgeServer("agent-host", "AGENT_HOST_TOOL", {
    connectionDirectory,
  });
  const second = new AcpHostToolBridgeServer("agent-host", "AGENT_HOST_TOOL", {
    connectionDirectory,
  });
  const client = new Client({ name: "native-fixture", version: "1" });
  t.after(async () => {
    await client.close();
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  });
  const originalBridge = bridge("original");
  const original = await first.prepare({
    scope: "same-native-session",
    bridge: originalBridge,
  });
  original.activate(originalBridge);
  const spec = original.mcpServer;
  const connectionFile = spec.env.find(
    ({ name }) => name === "AGENT_HOST_TOOL_CONNECTION_FILE",
  ).value;
  assert.equal(
    spec.env.some(
      ({ name }) => name.endsWith("_TOKEN") || name.endsWith("_ENDPOINT"),
    ),
    false,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(connectionFile)).mode & 0o777, 0o600);
    assert.equal((await stat(connectionDirectory)).mode & 0o777, 0o700);
  }
  const oldConnection = JSON.parse(await readFile(connectionFile, "utf8"));
  await client.connect(
    new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: {
        ...process.env,
        ...Object.fromEntries(spec.env.map(({ name, value }) => [name, value])),
      },
    }),
  );
  assert.equal((await client.listTools()).tools[0].name, "record");
  assert.equal(
    (await client.callTool({ name: "record", arguments: {} })).content[0].text,
    "original",
  );
  first.close();

  const successorBridge = bridge("successor");
  const successor = await second.prepare({
    scope: "same-native-session",
    bridge: successorBridge,
  });
  successor.activate(successorBridge);
  assert.deepEqual(successor.mcpServer, spec);
  const newConnection = JSON.parse(await readFile(connectionFile, "utf8"));
  assert.notEqual(newConnection.token, oldConnection.token);
  const stale = await fetch(`${newConnection.endpoint}/tools`, {
    headers: { authorization: `Bearer ${oldConnection.token}` },
  });
  assert.equal(stale.status, 403);
  first.close(); // A late old-owner close must not remove the successor reference.
  assert.equal(
    (await client.callTool({ name: "record", arguments: {} })).content[0].text,
    "successor",
  );

  const forkBridge = bridge("fork");
  const fork = await second.prepare({
    scope: "same-native-session",
    bridge: forkBridge,
  });
  assert.throws(() => fork.activate(forkBridge), /session_already_active/);
  assert.equal(
    (await client.callTool({ name: "record", arguments: {} })).content[0].text,
    "successor",
  );
  successor.deactivate(successorBridge);
  fork.activate(forkBridge);
  assert.equal(
    (await client.callTool({ name: "record", arguments: {} })).content[0].text,
    "fork",
  );

  await writeFile(connectionFile, "private-secret-invalid-json", {
    mode: 0o600,
  });
  await assert.rejects(client.listTools(), (error) => {
    assert.match(String(error), /connection is unavailable/);
    assert.doesNotMatch(String(error), /private-secret/);
    return true;
  });
});
