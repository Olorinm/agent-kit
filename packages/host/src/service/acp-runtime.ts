import { pathToFileURL } from "node:url";
import type { AcpAgent, AcpRunRequest } from "../acp/session.js";
import type { AgentCapabilities } from "../capabilities.js";
import type { JsonObject } from "../types.js";
import type { ServiceRuntime } from "./runtime.js";

/** Shared ACP transport wiring; each native harness owns its negotiated behavior. */
export function createAcpServiceRuntime(
  agent: AcpAgent,
  config: {
    cwd: string;
    model?: string;
    effort?: string;
    runOptions?: Pick<
      AcpRunRequest,
      "config" | "additionalDirectories" | "beforeTurn" | "mcpServers"
    >;
    capabilities(): AgentCapabilities;
  },
) {
  const run: ServiceRuntime["run"] = async function* (request) {
    const promptCapabilities = agent.getCapabilities(await agent.connect())
      .promptCapabilities as JsonObject | undefined;
    const media: JsonObject[] = [];
    for (const item of request.attachments ?? []) {
      if (item.mediaType.startsWith("image/"))
        media.push({
          type: "image",
          data: item.data,
          mimeType: item.mediaType,
        });
      else if (
        item.mediaType.startsWith("audio/") &&
        promptCapabilities?.audio === true
      )
        media.push({
          type: "audio",
          data: item.data,
          mimeType: item.mediaType,
        });
      else if (promptCapabilities?.embeddedContext === true)
        media.push({ type: "resource", resource: embeddedResource(item) });
    }
    yield* agent.run({
      ...config.runOptions,
      ...request,
      input: media.length
        ? [{ type: "text", text: request.input }, ...media]
        : request.input,
      cwd: config.cwd,
      model:
        typeof request.settings?.model === "string"
          ? request.settings.model
          : config.model,
      effort:
        typeof request.settings?.effort === "string"
          ? request.settings.effort
          : config.effort,
      config:
        (request.settings?.config as JsonObject | undefined) ??
        config.runOptions?.config,
    });
  };
  const discover: NonNullable<ServiceRuntime["discover"]> = async () => {
    const client = await agent.connect();
    const native = agent.getCapabilities(client);
    const operations = agent.getOperationSupport(client);
    const capabilities = config.capabilities();
    const session = native.sessionCapabilities as JsonObject | undefined;
    for (const [feature, enabled] of [
      [
        "input.images",
        (native.promptCapabilities as JsonObject)?.image === true,
      ],
      [
        "input.audio",
        (native.promptCapabilities as JsonObject)?.audio === true,
      ],
      [
        "input.documents",
        (native.promptCapabilities as JsonObject)?.embeddedContext === true,
      ],
      ["sessions.resume", operations.resume],
      ["sessions.history", operations.history],
      ["sessions.delete", operations.delete],
      ["sessions.fork", Boolean(session?.fork)],
      ["sessions.list", Boolean(session?.list)],
    ] as const)
      capabilities.features[feature] = {
        status: enabled ? "supported" : "unsupported",
        details: capabilities.features[feature].details,
        ...(enabled ? {} : { reason: "native_not_supported" as const }),
      };
    if (
      !operations.resume &&
      (native.loadSession === true || session?.resume != null)
    )
      capabilities.features["sessions.resume"] = {
        status: "unsupported",
        reason: "configuration_required",
        details: "Session resumption is disabled by the service-owner profile.",
      };
    if (!operations.compact)
      capabilities.features["controls.compact"] = {
        status: "unsupported",
        reason: "native_not_supported",
        details:
          "No configured native compaction path with a verifiable completion receipt.",
      };
    return {
      capabilities,
      native: { ...native, initialization: agent.getInitialization(client) },
    };
  };
  return {
    run,
    discover,
    sessions: agent.sessions,
    close: () => agent.close(),
  };
}

/** Text resources bypass provider binary-file modality restrictions without losing bytes. */
function embeddedResource(item: {
  path: string;
  mediaType: string;
  data: string;
}) {
  const resource = {
    uri: pathToFileURL(item.path).href,
    mimeType: item.mediaType,
  };
  const [mime = "", ...parameters] = item.mediaType.toLowerCase().split(";");
  const charset = parameters.join(";").match(/charset\s*=\s*"?([^;"\s]+)/)?.[1];
  if (
    (!charset || ["utf-8", "utf8", "us-ascii"].includes(charset)) &&
    (mime.startsWith("text/") ||
      /^(application\/(json|xml|yaml|x-yaml|javascript)|application\/.+\+(json|xml))$/.test(
        mime,
      ))
  ) {
    try {
      return {
        ...resource,
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          Buffer.from(item.data, "base64"),
        ),
      };
    } catch {
      // Invalid UTF-8 remains binary; never silently replace invalid bytes.
    }
  }
  return { ...resource, blob: item.data };
}
