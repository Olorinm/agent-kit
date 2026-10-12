/** Real MCP server for opt-in engine probes; requests input and records native responses. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const receipt = process.argv[2];
if (!receipt) throw Error("A private receipt file is required");
const server = new Server(
  { name: "native-elicitation-probe", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["form", "url"].map((mode) => ({
    name: `request_${mode}`,
    description: `Request one native ${mode} interaction and return its exact response. No external effects.`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (!["request_form", "request_url"].includes(params.name))
    throw Error("unknown_probe_tool");
  const result = await server.elicitInput(
    params.name === "request_form"
      ? {
          mode: "form",
          message: "Native integration test form",
          requestedSchema: {
            type: "object",
            properties: {
              code: { type: "string", title: "Receipt code" },
              count: { type: "integer", minimum: 1, maximum: 9 },
              confirm: { type: "boolean" },
              labels: {
                type: "array",
                items: { type: "string", enum: ["Maple", "Cedar"] },
              },
            },
            required: ["code", "count", "confirm", "labels"],
          },
        }
      : {
          mode: "url",
          message: "Synthetic URL interaction; no navigation or login required",
          url: "https://example.invalid/agent-host-probe",
          elicitationId: randomUUID(),
        },
  );
  await appendFile(
    receipt,
    JSON.stringify({ tool: params.name, result }) + "\n",
    { mode: 0o600 },
  );
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
await server.connect(new StdioServerTransport());
