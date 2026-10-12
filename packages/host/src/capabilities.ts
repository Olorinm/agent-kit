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
  "input.audio",
  "input.documents",
  "input.video",
  "input.attachments",
  "tools.product",
  "tools.images",
  "interactions.approval",
  "interactions.questions",
  "interactions.elicitation",
  "sessions.resume",
  "sessions.list",
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
  for (const name of [
    "sessions.list",
    "sessions.history",
    "sessions.fork",
    "sessions.delete",
  ] as const)
    f[name] = supported(
      "Native operations through agent.sessions; Host records remain separate.",
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
    f["input.images"] = supported(
      "Native Claude image blocks for PNG, JPEG, GIF and WebP.",
    );
    f["controls.compact"] = supported(
      "Native /compact on the bound session; requires a compact_boundary receipt.",
    );
    f["controls.steer"] = supported(
      "Native streaming input with priority now; accepted input may be queued by Claude.",
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
      "Pi beforeTool policy callback; HTTP profiles opt in with toolApproval. No built-in permission dialog is invented.",
    );
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
    f["input.images"] = conditional(
      "configuration_required",
      "Native image.attach_bytes; Hermes selects native vision or its image-analysis tool according to model/provider configuration.",
    );
    f["tools.product"] = conditional(
      "configuration_required",
      "Requires an exclusively owned persistent HERMES_HOME profile for MCP registration.",
    );
    f["interactions.approval"] = supported();
    f["interactions.questions"] = supported();
    f["controls.steer"] = supported();
    f["controls.compact"] = conditional(
      "configuration_required",
      "Requires a bound native session and a confirmed native compressed receipt; durable sessions resume after restart.",
    );
  } else {
    f["input.images"] = supported(
      "Native OpenClaw Gateway attachments carry inline image bytes.",
    );
    f["tools.product"] = conditional(
      "configuration_required",
      "Requires a local OpenClaw Gateway and the bundled product-tool plugin.",
    );
    f["controls.compact"] = supported("Requires a native compaction receipt.");
    f["controls.steer"] = conditional(
      "native_negotiation_required",
      "Gateway sessions.steer interrupts and replaces the active native run; Host follows the returned run ID.",
    );
    f["interactions.approval"] = conditional(
      "configuration_required",
      "Gateway exec approval events require operator.approvals scope and session correlation.",
    );
    f["interactions.questions"] = {
      status: "unsupported",
      reason: "native_not_supported",
      details:
        "The tested Gateway has no structured question request/response API. Product tools can ask their own questions.",
    };
  }
  if (kernel === "opencode" || kernel === "kimi")
    for (const name of ["sessions.list", "sessions.fork"] as const)
      f[name] = conditional(
        "native_negotiation_required",
        "Requires the ACP session capability advertised at initialize.",
      );
  if (kernel === "kimi")
    f["sessions.delete"] = conditional(
      "native_negotiation_required",
      "Requires ACP sessionCapabilities.delete.",
    );
  if (kernel === "openclaw")
    f["sessions.fork"] = conditional(
      "native_negotiation_required",
      "Requires Gateway sessions.fork and a native entryId; inspect the connected Gateway methods.",
    );
  for (const name of ["input.audio", "input.documents", "input.video"] as const)
    f[name] = {
      status: "unsupported",
      reason: "native_not_supported",
      details:
        "The pinned native prompt interface has no matching inline content type; HTTP still preserves the file bytes in the workspace.",
    };
  if (kernel === "codex")
    f["input.audio"] = conditional(
      "configuration_required",
      "Native audio/localAudio input items. The selected native model must declare audio in model/list inputModalities; Codex omits audio content for models without it.",
    );
  if (kernel === "claude")
    f["input.documents"] = supported("Native PDF document content blocks.");
  if (kernel === "hermes")
    f["input.documents"] = conditional(
      "configuration_required",
      "Native pdf.attach renders pages with Hermes dependencies; file.attach preserves other files and its native file references.",
    );
  if (kernel === "opencode" || kernel === "kimi") {
    f["input.audio"] = conditional(
      "native_negotiation_required",
      "ACP promptCapabilities.audio; otherwise the original file remains available.",
    );
    f["input.documents"] = conditional(
      "native_negotiation_required",
      "ACP promptCapabilities.embeddedContext preserves embedded resource bytes.",
    );
  }
  if (kernel === "openclaw")
    for (const name of [
      "input.audio",
      "input.documents",
      "input.video",
    ] as const)
      f[name] = conditional(
        "configuration_required",
        "Native Gateway attachment pipeline; configured models and native media tools determine interpretation.",
      );
  if (kernel !== "codex")
    f["tools.images"] = supported(
      kernel === "pi"
        ? "Inline image data URIs are native image content. External URLs are explicitly rejected."
        : "Inline image data URIs are MCP image content. External URLs remain explicit resource links; they are not fetched.",
    );
  const nativeUnavailable: Partial<Record<Kernel, Array<CapabilityName>>> = {
    pi: ["interactions.questions", "interactions.elicitation"],
    opencode: ["controls.steer"],
    kimi: ["controls.steer"],
    hermes: ["interactions.elicitation"],
    openclaw: ["interactions.elicitation"],
  };
  for (const feature of nativeUnavailable[kernel] ?? [])
    f[feature] = {
      status: "unsupported",
      reason: "native_not_supported",
      details:
        "The pinned native interface has no corresponding request/control operation. Product tools or native extension hooks remain available; Host does not simulate this feature.",
    };
  if (mode === "http") {
    f["input.attachments"] = supported(
      "Bounded binary attachments are saved in the selected runtime workspace. This does not imply model interpretation of every file type.",
    );
    if (kernel === "opencode" || kernel === "kimi")
      f["controls.compact"].details +=
        " The service selects the matching native compaction path.";
  }
  return result;
}
