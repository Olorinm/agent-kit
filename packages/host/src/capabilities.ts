/** Integration support, independent of credentials, model access and live-probe evidence. */
export const kernels = [
  "codex",
  "claude",
  "pi",
  "opencode",
  "kimi",
  "hermes",
  "openclaw",
] as const;
export type Kernel = (typeof kernels)[number];
export type IntegrationMode = "embedded" | "http";
export const capabilityNames = [
  "input.text",
  "input.images",
  "input.attachments",
  "tools.product",
  "tools.images",
  "interactions.approval",
  "interactions.questions",
  "interactions.elicitation",
  "sessions.resume",
  "sessions.history",
  "sessions.fork",
  "sessions.delete",
  "controls.cancel",
  "controls.steer",
  "controls.compact",
  "extensions.nativeOptions",
  "events.native",
] as const;
export type CapabilityName = (typeof capabilityNames)[number];
export interface Capability {
  status: "supported" | "conditional" | "unsupported" | "unknown";
  reason?:
    | "host_not_integrated"
    | "native_not_supported"
    | "native_negotiation_required"
    | "configuration_required"
    | "runtime_not_declared";
  /** Conditions and native entry points are descriptive; no credentials are included. */
  details?: string;
}
export interface AgentCapabilities {
  version: 1;
  kernel: string;
  mode: IntegrationMode;
  features: Record<CapabilityName, Capability>;
}
const supported = (details?: string): Capability => ({
  status: "supported",
  ...(details ? { details } : {}),
});
const missing = (details?: string): Capability => ({
  status: "unsupported",
  reason: "host_not_integrated",
  ...(details ? { details } : {}),
});
const conditional = (
  reason: Capability["reason"],
  details: string,
): Capability => ({
  status: "conditional",
  reason,
  details,
});

/** Unknown custom runtimes must declare their own capabilities, regardless of their name. */
export function unknownCapabilities(
  kernel: string,
  mode: IntegrationMode,
): AgentCapabilities {
  return {
    version: 1,
    kernel,
    mode,
    features: Object.fromEntries(
      capabilityNames.map((name) => [
        name,
        { status: "unknown", reason: "runtime_not_declared" },
      ]),
    ) as AgentCapabilities["features"],
  };
}

/**
 * Describes the installed Host integration, without starting a Kernel or contacting a model.
 * "supported" means there is an implementation path, not that this model/account supports it.
 * Consult docs/kernel-support.md for exact native versions and verification evidence.
 */
export function getKernelCapabilities(
  kernel: Kernel,
  mode: IntegrationMode = "embedded",
): AgentCapabilities {
  if (!kernels.includes(kernel)) throw new Error(`unknown_kernel:${kernel}`);
  const result = unknownCapabilities(kernel, mode);
  const f = result.features;
  for (const name of capabilityNames) f[name] = missing();
  for (const name of [
    "input.text",
    "tools.product",
    "sessions.resume",
    "controls.cancel",
    "events.native",
  ] as const)
    f[name] = supported();
  f["sessions.history"] = missing(
    "Host run records are not a native transcript API.",
  );
  f["extensions.nativeOptions"] = supported(
    mode === "http"
      ? "Service-owner profiles configure native options; HTTP callers cannot supply executables or credentials."
      : "The native adapter retains its typed options and extension entry points.",
  );
  if (kernel === "codex") {
    f["input.images"] = supported(
      "Native text/image/skill/mention input items.",
    );
    f["tools.images"] = supported("Native inputImage results.");
    for (const name of [
      "interactions.approval",
      "interactions.questions",
      "interactions.elicitation",
      "controls.steer",
      "controls.compact",
    ] as const)
      f[name] = supported();
  } else if (kernel === "claude") {
    for (const name of [
      "interactions.approval",
      "interactions.questions",
      "interactions.elicitation",
    ] as const)
      f[name] = supported();
    f["input.images"] = missing(
      "ClaudeQueryHost accepts native SDK messages; ClaudeAgent.run currently accepts text.",
    );
    f["controls.compact"] = missing(
      "No dedicated common ClaudeAgent compaction operation.",
    );
    f["controls.steer"] = missing(
      "Native Query access remains available through ClaudeQueryHost.",
    );
  } else if (kernel === "pi") {
    f["input.images"] = supported(
      "PiRunRequest.images forwards native image content.",
    );
    f["controls.steer"] = supported();
    f["controls.compact"] = supported();
    f["sessions.fork"] = supported(
      "PiAgent.forkSession uses the native fork operation.",
    );
    f["sessions.delete"] = {
      status: "unsupported",
      reason: "native_not_supported",
      details:
        "The pinned Pi 1.1 durable API has no supported native delete operation.",
    };
    f["interactions.approval"] = conditional(
      "configuration_required",
      "An embedded onBeforeTool policy can block tool execution; it is not a native permission dialog.",
    );
    if (mode === "http") {
      f["sessions.fork"] = missing(
        "Native fork is currently exposed only by the embedded Pi adapter.",
      );
      f["interactions.approval"] = missing(
        "The standard service runtime does not wire Pi's onBeforeTool hook.",
      );
    }
  } else if (kernel === "opencode" || kernel === "kimi") {
    f["input.images"] = conditional(
      "native_negotiation_required",
      "ACP initialize must advertise promptCapabilities.image.",
    );
    f["sessions.resume"] = conditional(
      "native_negotiation_required",
      "Requires native session/resume or session/load; resumeSessions must not be disabled.",
    );
    f["interactions.approval"] = supported(
      "Native ACP permission options and response IDs are preserved.",
    );
    for (const name of [
      "interactions.questions",
      "interactions.elicitation",
    ] as const)
      f[name] = conditional(
        "configuration_required",
        "Requires a native elicitation request and a configured product handler; embedded clients must advertise supported elicitation modes.",
      );
    f["controls.compact"] = conditional(
      "configuration_required",
      kernel === "kimi"
        ? "Configure compaction: 'kimi'; requires an existing binding and a confirmed native /compact receipt."
        : "Configure compaction: 'opencode'; requires an existing binding and the same native profile's serve/summarize API.",
    );
  } else if (kernel === "hermes") {
    f["tools.product"] = conditional(
      "configuration_required",
      "Requires an exclusively owned persistent HERMES_HOME profile for MCP registration.",
    );
    f["interactions.approval"] = supported();
    f["interactions.questions"] = supported();
    f["controls.steer"] = supported();
    f["controls.compact"] = conditional(
      "configuration_required",
      "Requires a session opened in this process and a confirmed native compressed receipt.",
    );
  } else {
    f["tools.product"] = conditional(
      "configuration_required",
      "Requires a local OpenClaw Gateway and the bundled product-tool plugin.",
    );
    f["controls.compact"] = supported("Requires a native compaction receipt.");
    f["interactions.approval"] = missing(
      "Native shell approvals are not exposed as common callbacks.",
    );
    f["interactions.questions"] = missing(
      "Native questions are not exposed as common callbacks.",
    );
  }
  if (kernel !== "codex")
    f["tools.images"] = missing(
      "The current tool bridge converts image URLs to text or resource links.",
    );
  if (mode === "http") {
    f["input.images"] = missing(
      "The current HTTP run contract accepts text only.",
    );
    if (kernel === "opencode" || kernel === "kimi")
      f["controls.compact"].details +=
        " The service selects the matching native compaction path.";
  }
  return result;
}
