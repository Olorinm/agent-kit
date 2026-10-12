/** Opt-in model-backed probe. Profiles are trusted JS owned by the operator; secrets never enter reports. */
import { parseArgs } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import {
  createNativeRuntime,
  startAgentHostServer,
} from "@olorinm/agent-host/server";
import { AgentHostClient } from "@olorinm/agent-host/client";
const { values } = parseArgs({
  options: {
    profiles: { type: "string" },
    checks: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    media: { type: "string" },
    controls: { type: "boolean" },
    interactions: { type: "boolean" },
  },
});
if (!values.profiles || !values.out)
  throw Error(
    "Usage: node probe-native-http.mjs --profiles local-profiles.mjs --out local-report.json [--only kernel] [--media image.png] [--controls]",
  );
const setup = await (
  await import(pathToFileURL(resolve(values.profiles)))
).default();
const report = {
  kind: "live-native-http",
  timestamp: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  results: [],
};
const output = resolve(values.out);
await mkdir(dirname(output), { recursive: true });
try {
  for (const profile of setup.profiles.filter(
    (p) => !values.only || values.only.split(",").includes(p.kernel),
  )) {
    const result = { kernel: profile.kernel, checks: {} };
    report.results.push(result);
    const root = join(profile.cwd, ".probe-host", randomUUID());
    await mkdir(profile.cwd, { recursive: true });
    const token = randomBytes(32).toString("hex");
    let server, client;
    const open = async () => {
      server = await startAgentHostServer({
        stateDirectory: root,
        token,
        runtimes: [createNativeRuntime(profile, root)],
        port: 0,
      });
      client = new AgentHostClient({ baseUrl: server.url, token });
    };
    const check = async (name, fn) => {
      if (
        values.checks &&
        ![
          "discovery",
          "turn",
          "resume-after-restart",
          ...values.checks.split(","),
        ].includes(name)
      )
        return;
      try {
        await fn();
        result.checks[name] = { status: "passed" };
      } catch (error) {
        result.checks[name] = {
          status: "failed",
          error: String(error.message ?? error).slice(0, 500),
        };
      }
      await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(
        JSON.stringify({
          kernel: profile.kernel,
          check: name,
          ...result.checks[name],
        }),
      );
    };
    const sessionId = `probe-${randomUUID()}`;
    const nonce = randomBytes(8).toString("hex");
    const run = async (input, attachments, session = sessionId) => {
      const task = await client.start({
        runtimeId: profile.id,
        sessionId: session,
        input,
        attachments,
        timeoutMs: 120000,
      });
      const events = [];
      const r = await task.wait({
        pollMs: 50,
        onEvent: ({ event }) => events.push(event),
        onInteraction: async (request) =>
          request.kind === "approval"
            ? { action: "decline" }
            : { action: "cancel" },
      });
      if (r.status !== "completed") throw Error(r.outcome?.error ?? r.status);
      return { r, events };
    };
    try {
      await open();
      await check("discovery", async () => {
        const d = await client.discover(profile.id);
        result.capabilities = d.capabilities;
        result.discoveryEvidence =
          d.native === undefined ? "static-description" : "native-handshake";
      });
      let nativeId;
      await check("turn", async () => {
        const { r, events } = await run(
          `Remember this test marker ${nonce}. Reply with that marker only. Do not use tools or modify files.`,
        );
        if (!r.answer.includes(nonce)) throw Error("marker_missing");
        nativeId = events.find((e) => e.type === "session.bound")?.threadId;
        if (!nativeId) throw Error("native_id_missing");
      });
      if (nativeId) {
        await server.close();
        await open();
        await check("resume-after-restart", async () => {
          const { r, events } = await run(
            "Repeat the test marker from my previous message. Do not use tools.",
          );
          if (!r.answer.includes(nonce)) throw Error("native_recall_failed");
          if (
            events.find((e) => e.type === "session.bound")?.threadId !==
            nativeId
          )
            throw Error("native_identity_changed");
        });
        await check("history", async () => {
          const page = await client
            .nativeSessions(profile.id)
            .history(sessionId);
          if (!page.items.length) throw Error("native_history_empty");
        });
        await check("list", async () => {
          const page = await client.nativeSessions(profile.id).list();
          if (!page.items.length) throw Error("native_list_empty");
        });
        await check("fork", async () => {
          let entryId;
          if (profile.kernel === "openclaw") {
            const history = await client
              .nativeSessions(profile.id)
              .history(sessionId);
            entryId = history.items.findLast(
              (m) => m.role === "user" && m.__openclaw?.id,
            )?.__openclaw.id;
            if (!entryId) throw Error("native_fork_entry_id_missing");
          }
          const fork = `fork-${randomUUID()}`;
          await client
            .nativeSessions(profile.id)
            .fork(sessionId, fork, entryId);
          const { r } = await run(
            "Repeat the test marker from the earlier conversation. No tools.",
            undefined,
            fork,
          );
          if (!r.answer.includes(nonce))
            throw Error("native_fork_recall_failed");
          if (profile.kernel !== "pi")
            await client.nativeSessions(profile.id).delete(fork);
        });
        if (values.controls)
          await check("compact", async () => {
            const task = await client.start({
              runtimeId: profile.id,
              sessionId,
              input: "",
              mode: "compact",
              timeoutMs: 120000,
            });
            const r = await task.wait({
              pollMs: 50,
              onInteraction: async () => ({ action: "cancel" }),
            });
            if (r.status !== "completed")
              throw Error(r.outcome?.error ?? r.status);
          });
        if (values.interactions) {
          const permission = async (i) => {
            const once = i.choices?.find((c) => c.allows && c.scope === "once");
            return once ? { choice: once.id } : { action: "cancel" };
          };
          for (const decision of [
            "accept",
            "reject",
            "cancel",
            ...(["codex", "claude", "pi", "hermes", "openclaw"].includes(
              profile.kernel,
            )
              ? ["steer"]
              : []),
          ])
            await check(`tool-${decision}`, async () => {
              let calls = 0,
                task;
              const extra = randomBytes(8).toString("hex");
              const product = client.session({
                runtimeId: profile.id,
                sessionId: `tool-${randomUUID()}`,
                timeoutMs: 120000,
                instructions:
                  "Use the product probe_action tool exactly once when asked. Do not use other tools, shell commands, or change files. Never retry a denied tool.",
                tools: [
                  {
                    name: "probe_action",
                    description:
                      "Return a test receipt without changing files or external state.",
                    inputSchema: {
                      type: "object",
                      properties: {},
                      additionalProperties: false,
                    },
                    execute: async (_input, ctx) => {
                      calls++;
                      if (decision === "cancel") {
                        await task.cancel();
                        await new Promise((resolve) => {
                          if (ctx.signal.aborted) resolve();
                          else
                            ctx.signal.addEventListener("abort", resolve, {
                              once: true,
                            });
                        });
                        throw Error("cancelled");
                      }
                      if (decision === "steer")
                        await task.steer(
                          `Include this additional marker in your final answer: ${extra}. Do not call any more tools.`,
                        );
                      return {
                        success: decision !== "reject",
                        contentItems: [
                          {
                            type: "inputText",
                            text:
                              decision === "reject"
                                ? "The product owner denied this action. Do not retry."
                                : `Test receipt ${nonce}`,
                          },
                        ],
                      };
                    },
                  },
                ],
              });
              task = await product.run(
                "Call probe_action once and then report its receipt or denial.",
              );
              const result = await task.wait({
                pollMs: 50,
                onInteraction: permission,
              });
              if (!calls) throw Error("product_callback_not_observed");
              if (decision === "cancel") {
                if (result.status !== "cancelled")
                  throw Error(result.outcome?.error ?? result.status);
              } else {
                if (result.status !== "completed")
                  throw Error(result.outcome?.error ?? result.status);
                if (decision === "steer" && !result.answer.includes(extra))
                  throw Error("native_steer_not_applied");
              }
            });
        }
        if (values.media)
          await check("image", async () => {
            const data = (await readFile(values.media)).toString("base64");
            const { r } = await run(
              "What is the dominant color of this attached image? Say the color only.",
              [{ name: "probe.png", mediaType: "image/png", data }],
            );
            if (!/red|红/i.test(r.answer))
              throw Error("vision_answer_mismatch");
          });
      }
    } catch (error) {
      result.checks.setup = {
        status: "failed",
        error: String(error.message ?? error).slice(0, 500),
      };
    } finally {
      await server?.close();
      await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    }
  }
} finally {
  await setup.close?.();
}
if (
  report.results.some((r) =>
    Object.values(r.checks).some((c) => c.status === "failed"),
  )
)
  process.exitCode = 1;
