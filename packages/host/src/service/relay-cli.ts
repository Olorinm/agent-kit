#!/usr/bin/env node
/**
 * Runs a connector CLI command through the Agent Host, e.g. `agent-host-relay gws gmail +triage`.
 * Installed in the sandbox under the CLI's own name. Credentials and approvals stay with the
 * product: this client only forwards the arguments of the shell command that invoked it.
 */
import { basename } from "node:path";

// The connector exposes `<connection>__<prefix>_read` and `<connection>__<prefix>_write`.
const prefixes: Record<string, string> = { gws: "gws", "lark-cli": "cli" };
const writeRequired = /_command_requires_write_tool\b/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const fail = (message: string, code = 2): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

async function relay(url: string, tool: string, input: Json): Promise<unknown> {
  const response = await fetch(new URL("/v1/relay", url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: process.env.CODEX_THREAD_ID, callId: process.env.CODEX_TOOL_CALL_ID, tool, input }),
  });
  const body = await response.json().catch(() => ({})) as { result?: { success?: boolean; contentItems?: Array<{ text?: string }> }; error?: string };
  if (!response.ok) fail(`relay refused: ${body.error ?? response.status}`);
  const text = body.result?.contentItems?.map((item) => item.text ?? "").join("") ?? "";
  try { return JSON.parse(text); } catch { return text; }
}

function print(outcome: unknown): number {
  const value = outcome as { status?: string; error?: string; result?: unknown; detail?: unknown } | string;
  if (typeof value === "string") { process.stdout.write(value.endsWith("\n") ? value : `${value}\n`); return 0; }
  if (value?.status && value.status !== "completed") {
    process.stderr.write(`${value.error ?? value.status}${value.detail ? ` ${JSON.stringify(value.detail)}` : ""}\n`);
    return 1;
  }
  const result = (value?.result ?? value) as { output?: unknown; attachments?: unknown } | undefined;
  const output = typeof result?.output === "string" ? result.output : JSON.stringify(result, null, 2);
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  if (Array.isArray(result?.attachments) && result.attachments.length)
    process.stderr.write(`attachments: ${JSON.stringify(result.attachments)}\n`);
  return 0;
}

async function main() {
  const invoked = basename(process.argv[1] ?? "");
  const argv = process.argv.slice(2);
  const command = prefixes[invoked] ? invoked : argv.shift() ?? "";
  const prefix = prefixes[command];
  if (!prefix) fail(`usage: agent-host-relay <${Object.keys(prefixes).join("|")}> [args...]`);
  if (!process.env.CODEX_THREAD_ID || !process.env.CODEX_TOOL_CALL_ID)
    fail(`${command} runs through the product's connector; call it from the Agent's shell.`);
  const url = process.env.AGENT_HOST_RELAY_URL ?? "http://127.0.0.1:37420";
  const catalog = JSON.stringify(await relay(url, "connected_apps", { action: "tools" }));
  const names = [...new Set([...catalog.matchAll(new RegExp(`"name":"([A-Za-z0-9_-]+__${prefix})_read"`, "g"))].map((match) => match[1]!))];
  if (!names.length) fail(`${command} is not connected for this Agent. Ask the owner to connect it in Mau.`);
  if (names.length > 1) fail(`${command} has several connections (${names.join(", ")}); this client supports one.`);
  const call = (mode: "read" | "write") => relay(url, "connected_apps", { action: "call", name: `${names[0]}_${mode}`, arguments: { args: argv } });
  let outcome = await call("read");
  // A command the connector classifies as a write is retried on the write tool, which asks the owner.
  if (writeRequired.test(JSON.stringify(outcome))) outcome = await call("write");
  process.exitCode = print(outcome);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error), 1));
