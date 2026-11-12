/** Opt-in native probes. The operator owns profiles, scenarios, policies and fixtures. */
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
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
    out: { type: "string" },
    only: { type: "string" },
    cases: { type: "string" },
  },
});
if (!values.profiles || !values.out)
  throw Error("Use --profiles trusted-setup.mjs --out local-report.json");
const output = resolve(values.out);
await mkdir(dirname(output), { recursive: true });
const setup = await (
  await import(pathToFileURL(resolve(values.profiles)))
).default();
const report = {
  kind: "live-native-scenarios",
  timestamp: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  results: [],
};
try {
  for (const profile of setup.profiles.filter(
    (p) => !values.only || values.only.split(",").includes(p.kernel),
  )) {
    const cases = (await setup.scenarios(profile)).filter(
      (c) => !values.cases || values.cases.split(",").includes(c.name),
    );
    if (!cases.length) continue;
    await mkdir(profile.cwd, { recursive: true });
    const stateDirectory = join(profile.cwd, ".probe-scenarios", randomUUID());
    const token = randomBytes(32).toString("hex");
    const server = await startAgentHostServer({
      stateDirectory,
      token,
      runtimes: [createNativeRuntime(profile, stateDirectory)],
      port: 0,
    });
    const client = new AgentHostClient({ baseUrl: server.url, token });
    try {
      for (const scenario of cases) {
        const events = [],
          interactions = [];
        const result = { kernel: profile.kernel, case: scenario.name };
        report.results.push(result);
        let task;
        try {
          const sessionId = `scenario-${randomUUID()}`;
          task = await client
            .session({
              runtimeId: profile.id,
              sessionId,
              timeoutMs: scenario.timeoutMs ?? 120000,
              instructions: scenario.instructions,
              tools: scenario.tools,
              settings: scenario.settings,
            })
            .run(scenario.input, undefined, scenario.attachments);
          const run = await task.wait({
            pollMs: 50,
            onEvent: ({ event }) => events.push(event),
            onInteraction: async (request, context) => {
              const answer = await (
                scenario.onInteraction ??
                setup.onInteraction ??
                (async () => ({ action: "cancel" }))
              )(request, { ...context, profile, events, task, interactions });
              interactions.push({ request, answer });
              return answer;
            },
          });
          if (run.status !== (scenario.expectedStatus ?? "completed"))
            throw Error(run.outcome?.error ?? run.status);
          // Every case needs an explicit assertion; model completion alone proves nothing.
          if (typeof scenario.verify !== "function")
            throw Error("scenario_assertion_required");
          await scenario.verify({
            run,
            events,
            interactions,
            client,
            sessionId,
          });
          result.status = "passed";
        } catch (error) {
          await task?.cancel().catch(() => {});
          result.status = "failed";
          result.error = String(error.message ?? error).slice(0, 500);
        }
        result.interactions = interactions.map(({ request, answer }) => ({
          method: request.native.method,
          kind: request.kind,
          decision:
            answer.action ??
            answer.choice ??
            (answer.answers ? "answers" : "native"),
        }));
        await writeFile(output, JSON.stringify(report, null, 2), {
          mode: 0o600,
        });
        console.log(JSON.stringify(result));
      }
    } finally {
      await server.close();
    }
  }
} finally {
  await setup.close?.();
}
if (!report.results.length || report.results.some((r) => r.status !== "passed"))
  process.exitCode = 1;
