import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

function record(method, params) {
  if (process.env.ACP_CONTROL_LOG)
    appendFileSync(
      process.env.ACP_CONTROL_LOG,
      JSON.stringify({ method, params }) + "\n",
    );
}
const behavior = process.env.ACP_CONTROL_RECEIPT ?? "confirmed";
if (process.argv.includes("serve")) {
  const server = createServer(async (request, response) => {
    if (request.url === "/config/providers") {
      response.end(JSON.stringify({ default: { fixture: "model" } }));
      return;
    }
    if (
      request.method === "POST" &&
      /^\/session\/[^/]+\/summarize$/.test(request.url)
    ) {
      let body = "";
      for await (const chunk of request) body += chunk;
      record("summarize", { url: request.url, body: JSON.parse(body) });
      if (behavior === "hang") return;
      response.end(JSON.stringify(behavior !== "missing"));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1", () => {
    console.log(
      `opencode server listening on http://127.0.0.1:${server.address().port}`,
    );
  });
} else {
  const send = (value) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const update = (sessionId, text) =>
    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    });
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);
    record(method, params);
    const reply = (result) => send({ id, result });
    if (method === "initialize")
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    else if (method === "session/new")
      reply({ sessionId: "native-control-session" });
    else if (method === "session/load") reply({ sessionId: params.sessionId });
    else if (method === "session/cancel")
      update(params.sessionId, "Compaction cancelled");
    else if (method === "session/prompt") {
      const input = params.prompt.map((item) => item.text ?? "").join("\n");
      if (input === "/compact") {
        if (behavior === "missing") reply({ stopReason: "end_turn" });
        else {
          update(params.sessionId, "Context compaction started");
          reply({ stopReason: "end_turn" });
          if (behavior !== "hang")
            setTimeout(
              () =>
                update(
                  params.sessionId,
                  "Compaction completed. Tokens before: 1,000 Tokens after: 200",
                ),
              80,
            );
        }
      } else {
        update(params.sessionId, "Native reply");
        reply({ stopReason: "end_turn" });
      }
    } else send({ id, error: { code: -32601, message: method } });
  }
}
