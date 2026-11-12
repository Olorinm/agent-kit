#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { loadConfiguration } from "./config.js";
import { EnvironmentError } from "./errors.js";

const help = `agent-environment — cloud execution environments

Usage: agent-environment COMMAND --config FILE --provider ID [options]

  capabilities                         Show provider capabilities
  create --template ID                 Create an environment; returns a reusable ref
  list                                 List provider environments
  info --id ID                         Read state without waking the environment
  resume --id ID                       Resume/reattach an existing environment
  pause --id ID                        Request pause (snapshot may still be pending)
  destroy --id ID                      Delete this environment; verify it is missing
  timeout --id ID --seconds N          Update environment lifetime
  exec --id ID [--cwd PATH] -- CMD...   Stream stdout/stderr, preserve exit status
  read --id ID --path PATH --out FILE  Download exact file bytes
  write --id ID --path PATH --file FILE Upload exact file bytes
  files --id ID --path PATH            Recursively list files

Create accepts --seconds N (default 3600), --on-timeout kill|pause,
and --metadata FILE (JSON strings; do not put secrets in metadata).
Exec accepts --seconds 0 to disable its command timeout.
Credentials are read from private files referenced by the config.
This is an operator CLI. Product account authorization belongs to its caller.
`;
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" }, config: { type: "string" }, provider: { type: "string" },
      id: { type: "string" }, template: { type: "string" }, seconds: { type: "string" },
      "on-timeout": { type: "string" }, cwd: { type: "string" }, path: { type: "string" },
      out: { type: "string" }, file: { type: "string" }, metadata: { type: "string" },
    },
  });
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  const need = (key: keyof typeof values): string => {
    const value = values[key];
    if (typeof value !== "string" || !value) throw new EnvironmentError("missing_argument", "--" + key + " is required.");
    return value;
  };
  const commands = ["capabilities", "create", "list", "info", "resume", "pause", "destroy", "timeout", "exec", "read", "write", "files"];
  const command = positionals[0]!;
  if (!commands.includes(command)) throw new EnvironmentError("unknown_command", "Unknown command. Use --help.");
  if (command !== "exec" && positionals.length > 1)
    throw new EnvironmentError("invalid_argument", "Unexpected positional arguments. Use --help.");
  const manager = await loadConfiguration(need("config"));
  const provider = manager.provider(need("provider"));
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  const duration = values.seconds === undefined ? undefined : Number(values.seconds);
  if (command === "capabilities") { output(provider.capabilities); return; }
  if (command === "create") {
    output(await provider.create({
      template: need("template"), timeoutSeconds: duration,
      onTimeout: values["on-timeout"] as "kill" | "pause" | undefined,
      metadata: values.metadata ? JSON.parse(await readFile(values.metadata, "utf8")) : undefined,
    })); return;
  }
  if (command === "list") { output(await provider.list()); return; }
  const id = need("id");
  if (command === "info") output(await provider.info(id));
  else if (command === "resume") output(await provider.resume(id, duration));
  else if (command === "pause") { await provider.pause(id); output({ id, accepted: true, operation: "pause" }); }
  else if (command === "destroy") { await provider.destroy(id); output({ id, state: "missing" }); }
  else if (command === "timeout") { await provider.setTimeout(id, Number(need("seconds"))); output({ id, updated: true }); }
  else if (command === "files") output(await provider.listFiles(id, need("path")));
  else if (command === "read") {
    await writeFile(need("out"), await provider.readFile(id, need("path")), { flag: "wx", mode: 0o600 });
    output({ saved: values.out });
  } else if (command === "write") {
    await provider.writeFile(id, need("path"), await readFile(need("file")));
    output({ saved: values.path });
  } else if (command === "exec") {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    let exitCode: number | null | undefined;
    try {
      for await (const chunk of provider.exec(id, positionals.slice(1), {
        cwd: values.cwd, timeoutSeconds: duration, signal: abort.signal,
        onExit: exit => { exitCode = exit.exitCode; },
      })) (chunk.stream === "stdout" ? process.stdout : process.stderr).write(chunk.text);
      process.exitCode = exitCode ?? 1;
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  }
}
main().catch(error => {
  // SDK/HTTP errors may contain request data. Do not print them into operator logs.
  const message = error instanceof EnvironmentError
    ? { error: error.code, message: error.message, outcomeUnknown: error.outcomeUnknown }
    : error instanceof Error && error.name === "AbortError"
      ? { error: "cancelled", message: "Command cancelled." }
      : { error: "operation_failed", message: "Operation failed; check configuration and provider status." };
  process.stderr.write(JSON.stringify(message) + "\n");
  process.exitCode = message.error === "cancelled" ? 130 : 1;
});
