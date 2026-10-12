#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { startAgentHostServer } from "./server.js";
import { configSchema, createConfiguredRuntimes } from "./config.js";
import { diagnoseRuntime } from "./diagnostics.js";
import { terminalInteraction } from "./terminal.js";
import { routeInteraction } from "../interactions.js";
import { TaskStore } from "./store.js";
import { kernels } from "../capabilities.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "token-file": { type: "string" },
      help: { type: "boolean", short: "h" },
      kernel: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      command: { type: "string" },
      args: { type: "string" },
      runtime: { type: "string" },
      session: { type: "string" },
      settings: { type: "string" },
      json: { type: "boolean" },
      native: { type: "boolean" },
      probe: { type: "boolean" },
      timeout: { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(`Usage:
  agent-host init --kernel codex [--config host.json] [--cwd .] [--model ID]
  agent-host doctor --config host.json [--native] [--probe]
  agent-host run --config host.json [--runtime ID] [--session ID] [--settings JSON] [--json] "Your task"
  agent-host serve --config host.json [--host 127.0.0.1] [--port 37420] [--token-file path]
Native credentials stay in the Kernel's existing configuration. --native starts a native handshake; --probe executes a short model request and may incur provider usage. run prints a session ID to continue later. Noninteractive permission requests are declined.`);
    return;
  }
  const operation = positionals[0];
  const filename = resolve(values.config ?? "host.json");
  if (operation === "init") {
    const kernel = z.enum(kernels).parse(values.kernel ?? "codex");
    const profile = {
      id: kernel,
      kernel,
      cwd: resolve(values.cwd ?? process.cwd()),
      ...(values.model ? { model: values.model } : {}),
      ...(values.command ? { command: values.command } : {}),
      ...(values.args ? { args: JSON.parse(values.args) } : {}),
      ...(kernel === "openclaw" ? { gatewayUrl: "ws://127.0.0.1:18789" } : {}),
    };
    if (kernel === "hermes" && !values.command)
      throw new Error(
        "Hermes requires --command and --args for its TUI Gateway. See docs/quickstart.md.",
      );
    if (kernel === "pi" && !values.model)
      throw new Error("Pi requires --model provider/model.");
    const config = { stateDirectory: ".agent-host", runtimes: [profile] };
    configSchema.parse(config);
    await writeFile(filename, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      `Created ${filename}. Run agent-host doctor --config ${JSON.stringify(filename)}.`,
    );
    return;
  }
  if (!["serve", "run", "doctor"].includes(operation ?? ""))
    throw new Error("Unknown command; use agent-host --help");
  const config = configSchema.parse(
    JSON.parse(await readFile(filename, "utf8")),
  );
  const stateDirectory = resolve(dirname(filename), config.stateDirectory);
  const runtimes = createConfiguredRuntimes(config, filename);
  if (operation === "doctor") {
    const ownership = values.probe
      ? new TaskStore(join(stateDirectory, "tasks.sqlite"))
      : undefined;
    try {
      const reports = [];
      for (const runtime of runtimes)
        if (!values.runtime || values.runtime === runtime.id)
          reports.push(
            await diagnoseRuntime(runtime, {
              native: values.native,
              probe: values.probe,
              timeoutMs: values.timeout ? Number(values.timeout) : undefined,
            }),
          );
      if (!reports.length) throw new Error("runtime_not_found");
      console.log(JSON.stringify(reports, null, 2));
      if (
        reports.some(
          (r) =>
            !r.local.available ||
            r.native?.ok === false ||
            r.probe?.status === "failed",
        )
      )
        process.exitCode = 1;
    } finally {
      try {
        await Promise.all(runtimes.map((r) => r.close()));
      } finally {
        ownership?.close();
      }
    }
    return;
  }
  if (operation === "run") {
    const runtime = values.runtime
      ? runtimes.find((r) => r.id === values.runtime)
      : runtimes[0];
    if (!runtime) throw new Error("runtime_not_found");
    const input = positionals.slice(1).join(" ");
    if (!input.trim()) throw new Error("task_text_required");
    const sessionId = values.session ?? `cli-${randomUUID()}`,
      controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("run_deadline_exceeded")),
      values.timeout
        ? z.coerce.number().int().min(100).max(86_400_000).parse(values.timeout)
        : 3_600_000,
    );
    timeout.unref();
    const stop = () => controller.abort(new Error("user_cancelled"));
    process.once("SIGINT", stop);
    console.error(`Session: ${sessionId}`);
    const ownership = new TaskStore(join(stateDirectory, "tasks.sqlite"));
    try {
      const ready = await runtime.inspect?.();
      if (ready && !ready.available) throw new Error(ready.reason);
      const settings = values.settings
        ? z.record(z.string(), z.json()).parse(JSON.parse(values.settings))
        : undefined;
      for await (const event of runtime.run({
        sessionId,
        runId: randomUUID(),
        input,
        instructions: "",
        tools: [],
        signal: controller.signal,
        mode: "turn",
        settings,
        onRequest: (request, context) =>
          routeInteraction(
            { onInteraction: terminalInteraction },
            request,
            context,
          ),
      })) {
        if (values.json) console.log(JSON.stringify(event));
        else if (event.type === "assistant.delta")
          process.stdout.write(event.text);
        else if (event.type === "turn.finished") {
          console.log();
          if (event.outcome.status !== "completed")
            console.error(event.outcome.error ?? event.outcome.status);
        }
        if (
          event.type === "turn.finished" &&
          event.outcome.status !== "completed"
        )
          process.exitCode = 1;
      }
    } finally {
      clearTimeout(timeout);
      process.removeListener("SIGINT", stop);
      try {
        await Promise.all(runtimes.map((r) => r.close()));
      } finally {
        ownership.close();
      }
    }
    return;
  }
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const tokenFile = values["token-file"]
    ? resolve(values["token-file"])
    : join(stateDirectory, "token");
  let token = process.env.AGENT_HOST_TOKEN;
  if (!token) {
    try {
      token = (await readFile(tokenFile, "utf8")).trim();
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        values["token-file"]
      )
        throw error;
      token = randomBytes(32).toString("hex");
      try {
        await writeFile(tokenFile, `${token}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        token = (await readFile(tokenFile, "utf8")).trim();
      }
    }
  }
  const host = await startAgentHostServer({
    ...config,
    stateDirectory,
    runtimes,
    token,
    host: values.host ?? config.host,
    port: values.port
      ? z.coerce.number().int().min(0).max(65535).parse(values.port)
      : config.port,
  });
  console.log(`Agent Host listening at ${host.url}`);
  console.log(
    process.env.AGENT_HOST_TOKEN
      ? "Authentication: AGENT_HOST_TOKEN"
      : `Authentication token file: ${tokenFile}`,
  );
  console.log(`State directory: ${stateDirectory}`);
  const stop = () => {
    const deadline = setTimeout(() => {
      console.error("Agent Host shutdown timed out");
      process.exit(1);
    }, 15_000);
    deadline.unref();
    void host.close().then(
      () => {
        clearTimeout(deadline);
      },
      (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
