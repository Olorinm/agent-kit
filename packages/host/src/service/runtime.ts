import type { SessionManager } from "../sessions.js";
import type { SettingsSelection, AllowedSettings } from "../settings.js";
import type { AgentEvent, InteractionContext, ProductTool } from "../agent.js";
import type { JsonValue } from "../types.js";
import type { RuntimeDescription, ServiceEvent } from "./protocol.js";
import type { AgentCapabilities } from "../capabilities.js";

export interface RuntimeTurn {
  settings?: SettingsSelection;
  sessionId: string;
  runId: string;
  input: string;
  attachments?: Array<{
    name: string;
    mediaType: string;
    data: string;
    path: string;
  }>;
  instructions: string;
  context?: string;
  tools: ProductTool[];
  signal: AbortSignal;
  mode: "turn" | "compact";
  onRequest(
    request: { method: string; params?: JsonValue },
    context: InteractionContext,
  ): Promise<JsonValue | undefined>;
}
/** Optional service composition over the existing adapters; it never implements a model loop. */
export interface ServiceRuntime {
  id: string;
  kernel: string;
  cwd: string;
  model?: string;
  /** Must change when native runtime configuration changes. Contains no credentials. */
  configurationKey: string;
  /** Omission means unknown support, even if kernel matches a built-in name. */
  capabilities?: AgentCapabilities;
  run(request: RuntimeTurn): AsyncIterable<ServiceEvent | AgentEvent>;
  steer?(sessionId: string, input: string): Promise<unknown>;
  supportsCompaction?: boolean;
  maxConcurrentRuns?: number;
  inputs?: RuntimeDescription["inputs"];
  sessions?: SessionManager;
  allowedSettings?: AllowedSettings;
  validateSettings?(settings: SettingsSelection): void;
  discover?(): Promise<{ capabilities: AgentCapabilities; native?: JsonValue }>;
  inspect?(): Promise<Pick<RuntimeDescription, "available" | "reason">>;
  close(): void | Promise<void>;
}
