import { AcpAgent, type AcpAgentOptions } from "../acp/session.js";
import {
  getKernelCapabilities,
  type AgentCapabilities,
  type IntegrationMode,
} from "../capabilities.js";

export interface HermesGatewayAgentOptions extends Omit<
  AcpAgentOptions,
  "command" | "compaction"
> {
  command?: string;
}

/**
 * Hermes 0.22's official ACP viewer of its canonical Gateway authority.
 * Hermes owns daemon discovery, authentication, durable admissions and shared approvals.
 * Closing this client detaches the viewer; it does not shut down the shared Gateway.
 * Configuration and lifecycle operations remain negotiated through native ACP.
 */
export class HermesGatewayAgent extends AcpAgent {
  constructor(options: HermesGatewayAgentOptions = {}) {
    super({
      ...options,
      command: options.command ?? "hermes",
      args: options.args ?? ["acp"],
    });
  }
}

/** Describes the canonical ACP surface separately from the legacy TUI RPC surface. */
export function getHermesGatewayCapabilities(
  mode: IntegrationMode = "embedded",
): AgentCapabilities {
  const result = getKernelCapabilities("opencode", mode);
  result.kernel = "hermes";
  const f = result.features;
  for (const name of [
    "sessions.resume",
    "sessions.list",
    "sessions.history",
    "sessions.fork",
  ] as const)
    f[name] = {
      status: "conditional",
      reason: "native_negotiation_required",
      details:
        "Hermes canonical Gateway via official ACP; requires the corresponding native resume/load/list/fork capability. Closing the viewer does not stop the shared Gateway.",
    };
  for (const name of ["sessions.delete", "controls.steer"] as const)
    f[name] = {
      status: "unsupported",
      reason: "native_not_supported",
      details: "Hermes 0.22.1 ACP does not expose this native operation.",
    };
  f["controls.compact"] = {
    status: "unsupported",
    reason: "native_not_supported",
    details:
      "Native /compress executes through ACP, but its end_turn response omits the compression receipt. The Host cannot confirm a completed compaction.",
  };
  f["tools.product"] = {
    status: "conditional",
    reason: "native_negotiation_required",
    details:
      "Official ACP editor MCP attachment; Hermes requires canonical acp-editor-policy-v1 and acp-session-mcp-v1 on resume. Restart continuation requires a stable MCP specification, supplied by the HTTP service's private connection-file bridge or an embedded toolBridgeProvider. Execution stays in the daemon.",
  };
  for (const name of ["input.audio", "input.documents"] as const)
    f[name] = {
      status: "unsupported",
      reason: "native_not_supported",
      details:
        "Hermes 0.22.1 ACP advertises image input, but no audio or embedded-resource prompt capability. Files remain available in the workspace.",
    };
  f["extensions.nativeOptions"] = {
    status: "supported",
    details:
      "Native ACP model selection, permissions, image input and raw events. Hermes rejects ACP config/mode mutation; fastMode, provider and reasoningEffort require the TUI RPC integration or Gateway-owned profile configuration.",
  };
  return result;
}
