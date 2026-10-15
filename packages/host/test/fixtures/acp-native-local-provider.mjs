/**
 * Opt-in actual-CLI probe profile with a deterministic loopback model provider.
 * No real model or personal credentials are used. Run through probe-native-http.
 */
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export default async function () {
  const root = await mkdtemp(join(tmpdir(), "agent-host-acp-local-provider-"));
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const messages = body.messages ?? [];
    const content = JSON.stringify(messages);
    const marker =
      content.match(/test marker ([a-f0-9]{16})/i)?.[1] ?? "LOCAL-FIXTURE";
    const reply = content.includes("## Objective")
      ? [
          "## Objective",
          `Retain test marker ${marker}`,
          "## Requirements",
          "Reply with the test marker only.",
          "## Decisions",
          "Use the remembered marker.",
          "## Work State",
          "### Completed",
          `Remembered ${marker}`,
          "### Active",
          "None.",
          "### Blocked",
          "None.",
          "## Next Move",
          `Reply ${marker}`,
          "## Relevant Files",
          "None.",
          "## Important Context",
          `Test marker ${marker}`,
        ].join("\n")
      : marker;
    // Only call a tool exposed in this actual native model request.
    const tool =
      body.tools?.find((entry) =>
        entry.function?.name?.includes("probe_action"),
      ) ??
      (content.includes("tools.agent_host.probe_action")
        ? body.tools?.find((entry) => entry.function?.name === "execute")
        : undefined);
    const wantsTool =
      content.includes("Call probe_action once") &&
      !messages.some((message) => message.role === "tool");
    const toolCall =
      wantsTool && tool
        ? {
            id: "probe-call-1",
            type: "function",
            function: {
              name: tool.function.name,
              arguments:
                tool.function.name === "execute"
                  ? JSON.stringify({
                      code: "return await tools.agent_host.probe_action({});",
                    })
                  : "{}",
            },
          }
        : undefined;
    const message = toolCall
      ? { role: "assistant", tool_calls: [toolCall] }
      : { role: "assistant", content: reply };
    const finish = toolCall ? "tool_calls" : "stop";
    const envelope = {
      id: "fixture-completion",
      object: body.stream ? "chat.completion.chunk" : "chat.completion",
      created: 1,
      model: body.model ?? "fixture",
      choices: [
        {
          index: 0,
          ...(body.stream
            ? {
                delta: toolCall
                  ? {
                      role: "assistant",
                      tool_calls: [{ index: 0, ...toolCall }],
                    }
                  : message,
              }
            : { message }),
          finish_reason: body.stream ? null : finish,
        },
      ],
    };
    const usage = { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 };
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(envelope)}\n\n`);
      response.write(
        `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...envelope, usage }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const profiles = [];
  for (const kernel of ["opencode", "kimi"]) {
    const directory = join(root, kernel);
    const cwd = join(directory, "workspace");
    await mkdir(cwd, { recursive: true });
    const env = {
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_DATA_HOME: join(directory, "data"),
      XDG_CACHE_HOME: join(directory, "cache"),
    };
    for (const key of Object.keys(process.env))
      if (
        /API_KEY|TOKEN|SECRET|PASSWORD|^OPENAI|^ANTHROPIC|^GOOGLE|^GEMINI|^KIMI|^AWS_/.test(
          key,
        )
      )
        env[key] = undefined;
    let model, command, args;
    if (kernel === "opencode") {
      model = "host-fixture/probe";
      await writeFile(
        join(cwd, "opencode.json"),
        JSON.stringify({
          model,
          providers: {
            "host-fixture": {
              name: "Local test fixture",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL },
              models: {
                probe: {
                  capabilities: {
                    tools: true,
                    input: ["text"],
                    output: ["text"],
                  },
                  limit: { context: 128000, output: 4096 },
                },
              },
            },
          },
        }),
      );
      command = resolve("node_modules/@opencode/cli/bin/opencode.exe");
      args = ["acp"];
    } else {
      const nativeHome = join(directory, "kimi");
      await mkdir(nativeHome, { recursive: true });
      env.KIMI_CODE_HOME = nativeHome;
      model = "fixture";
      await writeFile(
        join(nativeHome, "config.toml"),
        `defaultModel = "fixture"\n[models.fixture]\nname = "fixture"\nprotocol = "openai"\nbaseUrl = "${baseURL}"\napiKey = "local-fixture-no-secret"\nmaxContextSize = 128000\n`,
      );
      command = process.execPath;
      args = [
        resolve("node_modules/@moonshot-ai/kimi-code/dist/main.mjs"),
        "acp",
      ];
    }
    profiles.push({
      id: kernel,
      kernel,
      cwd,
      model,
      options: { command, args, env, elicitation: { form: {} } },
    });
  }
  console.log(
    JSON.stringify({ kind: "native-harness-local-provider-fixture", root }),
  );
  return {
    modelProvider: "deterministic",
    profiles,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
