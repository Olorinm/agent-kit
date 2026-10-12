import { randomUUID } from "node:crypto";
import type { ServiceRuntime } from "./runtime.js";
import type { TurnOutcome } from "../agent.js";

export interface DiagnosticReport {
  runtimeId: string;
  kernel: string;
  local: { available: boolean; reason?: string };
  native?: {
    ok: boolean;
    error?: string;
    capabilities?: unknown;
    details?: unknown;
  };
  probe?: TurnOutcome;
  actions: string[];
}
/** No provider call without probe:true. Native discovery may start a process/connect to its Gateway. */
export async function diagnoseRuntime(
  runtime: ServiceRuntime,
  options: { native?: boolean; probe?: boolean; timeoutMs?: number } = {},
): Promise<DiagnosticReport> {
  const local = (await runtime.inspect?.()) ?? { available: true };
  const report: DiagnosticReport = {
    runtimeId: runtime.id,
    kernel: runtime.kernel,
    local,
    actions: [],
  };
  if (!local.available) {
    report.actions.push(
      local.reason?.startsWith("workspace")
        ? "Create the configured workspace directory."
        : local.reason === "pi_model_selection_required"
          ? "Set a provider/model in this runtime profile."
          : "Install the native Kernel and set command to its executable path.",
    );
    return report;
  }
  if (runtime.kernel === "openclaw")
    report.actions.push(
      "Product tools require a local Gateway with the bundled agent-host plugin. A remote Gateway needs its own workspace/environment integration.",
    );
  if (options.native || options.probe) {
    if (runtime.discover)
      try {
        const result = await runtime.discover();
        report.native = {
          ok: true,
          capabilities: result.capabilities,
          details: result.native,
        };
      } catch (error) {
        report.native = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        report.actions.push(
          "Check native installation, login, Gateway connectivity and profile configuration.",
        );
      }
    else
      report.actions.push(
        "This Kernel exposes no read-only readiness handshake; use --probe to verify native execution explicitly.",
      );
  }
  if (options.probe) {
    const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    try {
      for await (const event of runtime.run({
        sessionId: `doctor-${randomUUID()}`,
        runId: randomUUID(),
        input:
          "Reply exactly AGENT_HOST_READY. Do not use tools or modify files.",
        instructions: "This is a connectivity check.",
        tools: [],
        signal,
        mode: "turn",
        onRequest: async () => undefined,
      }))
        if (event.type === "turn.finished") report.probe = event.outcome;
      report.probe ??= {
        status: "failed",
        error: "native_terminal_missing",
        outcomeUnknown: true,
      };
    } catch (error) {
      report.probe = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (report.probe.status !== "completed")
      report.actions.push(
        "Run the Kernel's own CLI in this workspace to check login and model access; Agent Host preserves its native configuration.",
      );
  }
  return report;
}
