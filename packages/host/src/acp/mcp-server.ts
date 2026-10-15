import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const prefix = process.env.AGENT_HOST_TOOL_ENV_PREFIX ?? "AGENT_HOST_TOOL";
const connectionFile = process.env.AGENT_HOST_TOOL_CONNECTION_FILE?.trim();
const initialEndpoint = process.env[`${prefix}_ENDPOINT`]
  ?.trim()
  .replace(/\/+$/, "");
const initialToken = process.env[`${prefix}_TOKEN`]?.trim();
if (!connectionFile && (!initialEndpoint || !initialToken)) {
  throw new Error(
    "Agent Host ACP Host Tool MCP bridge configuration is missing.",
  );
}

const server = new Server(
  { name: "agent-host", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return await bridgeRequest<{ tools: Tool[] }>("/tools", { method: "GET" });
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return await bridgeRequest<CallToolResult>("/call", {
    method: "POST",
    body: JSON.stringify({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
      callId: `acp-mcp-${randomUUID()}`,
    }),
  });
});

await server.connect(new StdioServerTransport());

async function bridgeRequest<T>(path: string, init: RequestInit): Promise<T> {
  // A native MCP process may outlive its Host. Read the current private connection
  // for every request while leaving the native stdio specification unchanged.
  let connection: unknown;
  try {
    connection = connectionFile
      ? JSON.parse(await readFile(connectionFile, "utf8"))
      : { endpoint: initialEndpoint, token: initialToken };
  } catch {
    throw new Error("Agent Host MCP connection is unavailable.");
  }
  if (
    !connection ||
    typeof connection !== "object" ||
    !("endpoint" in connection) ||
    typeof connection.endpoint !== "string" ||
    !("token" in connection) ||
    typeof connection.token !== "string" ||
    !connection.endpoint.trim() ||
    !connection.token.trim()
  )
    throw new Error("Agent Host MCP connection is unavailable.");
  const endpoint = connection.endpoint.trim().replace(/\/+$/, "");
  const token = connection.token.trim();
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const payload = (await response.json().catch(() => undefined)) as
    T | { error?: unknown } | undefined;
  if (!response.ok || !payload) {
    const error =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `http_${response.status}`;
    throw new Error(`Agent Host Host Tool bridge failed: ${error}`);
  }
  return payload as T;
}
