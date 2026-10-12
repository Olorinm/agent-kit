import { CodexAgent, type CodexAgentOptions } from "./codex/session.js";
import { ClaudeAgent, type ClaudeAgentOptions } from "./claude/session.js";
import { PiAgent, type PiAgentOptions } from "./pi/session.js";
import { AcpAgent, type AcpAgentOptions } from "./acp/session.js";
import { HermesAgent, type HermesAgentOptions } from "./hermes/session.js";
import {
  OpenClawAgent,
  type OpenClawAgentOptions,
} from "./openclaw/session.js";
import type { Kernel } from "./capabilities.js";

export interface AgentsByKernel {
  codex: CodexAgent;
  claude: ClaudeAgent;
  pi: PiAgent;
  opencode: AcpAgent;
  kimi: AcpAgent;
  hermes: HermesAgent;
  openclaw: OpenClawAgent;
}
type ConfigByKernel = {
  codex: { options?: CodexAgentOptions };
  claude: { options?: ClaudeAgentOptions };
  pi: { options?: PiAgentOptions };
  opencode: {
    options?: Omit<AcpAgentOptions, "command"> & { command?: string };
  };
  kimi: { options?: Omit<AcpAgentOptions, "command"> & { command?: string } };
  hermes: { options: HermesAgentOptions };
  openclaw: { options: OpenClawAgentOptions };
};
export type AgentConfig<K extends Kernel = Kernel> = {
  [P in K]: { kernel: P } & ConfigByKernel[P];
}[K];

/** Selects the existing adapter without wrapping away native methods or options. */
export function createAgent<K extends Kernel>(
  config: AgentConfig<K>,
): AgentsByKernel[K];
export function createAgent(config: AgentConfig): AgentsByKernel[Kernel] {
  switch (config.kernel) {
    case "codex":
      return new CodexAgent(config.options);
    case "claude":
      return new ClaudeAgent(config.options);
    case "pi":
      return new PiAgent(config.options);
    case "opencode":
    case "kimi":
      return new AcpAgent({
        ...config.options,
        command: config.options?.command ?? config.kernel,
        compaction: config.kernel,
      });
    case "hermes":
      return new HermesAgent(config.options);
    case "openclaw":
      return new OpenClawAgent(config.options);
    default:
      throw new Error("unknown_kernel");
  }
}
