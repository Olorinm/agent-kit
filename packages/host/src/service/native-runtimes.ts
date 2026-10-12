import { pathToFileURL } from "node:url";
import type { SessionManager } from "../sessions.js";
import { validateSettings, type AllowedSettings } from "../settings.js";
import type { CodexRunRequest } from "../codex/session.js";
import type { ClaudeRunRequest } from "../claude/session.js";
import type { PiRunRequest } from "../pi/session.js";
import type { AcpRunRequest } from "../acp/session.js";
import type { HermesRunRequest } from "../hermes/session.js";
import type { OpenClawRunRequest } from "../openclaw/session.js";
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { CodexAgent, type CodexAgentOptions } from "../codex/session.js";
import { AcpAgent, type AcpAgentOptions } from "../acp/session.js";
import { ClaudeAgent, type ClaudeAgentOptions } from "../claude/session.js";
import { PiAgent, type PiAgentOptions } from "../pi/session.js";
import { HermesAgent, type HermesAgentOptions } from "../hermes/session.js";
import {
  OpenClawAgent,
  type OpenClawAgentOptions,
} from "../openclaw/session.js";
import { FileBindingStore } from "../file-bindings.js";
import type { JsonObject } from "../types.js";
import type { RuntimeTurn, ServiceRuntime } from "./runtime.js";
import type { ServiceEvent } from "./protocol.js";
import { getKernelCapabilities } from "../capabilities.js";

interface BaseConfig {
  id: string;
  cwd: string;
  model?: string;
  configurationRevision?: string;
  allowedSettings?: AllowedSettings;
}
export type NativeRuntimeConfig = BaseConfig &
  (
    | {
        kernel: "codex";
        options?: CodexAgentOptions;
        thread?: JsonObject;
        turn?: JsonObject;
        runOptions?: Pick<CodexRunRequest, "thread" | "turn" | "beforeTurn">;
      }
    | {
        kernel: "claude";
        options?: ClaudeAgentOptions;
        runOptions?: Pick<ClaudeRunRequest, "native">;
      }
    | {
        kernel: "opencode" | "kimi";
        options?: Omit<AcpAgentOptions, "command"> & { command?: string };
        effort?: string;
        runOptions?: Pick<
          AcpRunRequest,
          "config" | "additionalDirectories" | "beforeTurn" | "mcpServers"
        >;
      }
    | {
        kernel: "pi";
        options?: PiAgentOptions;
        toolApproval?: boolean;
        runOptions?: Pick<
          PiRunRequest,
          | "thinkingLevel"
          | "extensions"
          | "onBeforeTool"
          | "onModelRequest"
          | "onNativeEvent"
          | "beforeTurn"
        >;
      }
    | {
        kernel: "hermes";
        options: HermesAgentOptions;
        provider?: string;
        reasoningEffort?: string;
        runOptions?: Pick<HermesRunRequest, "beforeTurn">;
      }
    | {
        kernel: "openclaw";
        options: OpenClawAgentOptions;
        runOptions?: Pick<OpenClawRunRequest, "beforeTurn" | "method">;
      }
  );

/** Server-owned launch configuration. No command, environment or credential is accepted from HTTP callers. */
export function createNativeRuntime(
  config: NativeRuntimeConfig,
  stateDirectory: string,
): ServiceRuntime {
  const cwd = resolve(config.cwd);
  const root = join(
    resolve(stateDirectory),
    "runtimes",
    createHash("sha256").update(config.id).digest("hex"),
  );
  const bindings = new FileBindingStore(join(root, "bindings"));
  const configurationKey = createHash("sha256")
    .update(
      JSON.stringify({ ...config, cwd }, (_key, value: unknown) =>
        typeof value === "function" ? String(value) : value,
      ),
    )
    .digest("hex");
  let command: string | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let run: ServiceRuntime["run"];
  let close: ServiceRuntime["close"];
  let steer: ServiceRuntime["steer"];
  let compact:
    | ((request: RuntimeTurn) => Promise<{
        ok: boolean;
        compacted: boolean;
        error?: string;
        outcomeUnknown?: boolean;
        cancelled?: boolean;
      }>)
    | undefined;
  let nativeCompaction = false;
  let sessions: SessionManager;
  let discover: ServiceRuntime["discover"];
  switch (config.kernel) {
    case "codex": {
      command = config.options?.command ?? "codex";
      env = config.options?.env;
      const agent = new CodexAgent({ ...config.options, command, bindings });
      run = (request) =>
        agent.run({
          ...config.runOptions,
          ...request,
          input: request.attachments?.some((item) =>
            /^(image|audio)\//.test(item.mediaType),
          )
            ? [
                { type: "text", text: request.input, text_elements: [] },
                ...request.attachments
                  .filter((item) => /^(image|audio)\//.test(item.mediaType))
                  .map((item) =>
                    item.mediaType.startsWith("audio/")
                      ? {
                          type: "audio" as const,
                          url: `data:${item.mediaType};base64,${item.data}`,
                        }
                      : {
                          type: "image" as const,
                          url: `data:${item.mediaType};base64,${item.data}`,
                        },
                  ),
              ]
            : request.input,
          cwd,
          thread: {
            sandbox: "read-only",
            approvalPolicy: "on-request",
            ...config.runOptions?.thread,
            ...config.thread,
            ...((request.settings?.model ?? config.model)
              ? { model: request.settings?.model ?? config.model }
              : {}),
          },
          turn: {
            ...config.runOptions?.turn,
            ...config.turn,
            ...request.settings,
          },
        });
      discover = async () => {
        const client = await agent.connect();
        const account = await client.request("account/read", {
          refreshToken: false,
        });
        const models = await client.request("model/list", { limit: 100 });
        return {
          capabilities: getKernelCapabilities("codex", "http"),
          native: {
            authenticated: Boolean((account as JsonObject)?.account),
            models: models as JsonObject,
          },
        };
      };
      sessions = agent.sessions;
      close = () => agent.close();
      steer = (sessionId, input) => agent.steer(sessionId, input);
      nativeCompaction = true;
      break;
    }
    case "claude": {
      command = config.options?.command;
      env = config.options?.env;
      const agent = new ClaudeAgent({ ...config.options, bindings });
      run = (request) =>
        agent.run({
          ...config.runOptions,
          ...request,
          native: { ...config.runOptions?.native, ...request.settings },
          content: request.attachments?.some(
            (item) => item.mediaType === "application/pdf",
          )
            ? request.attachments
                .filter(
                  (item) =>
                    item.mediaType === "application/pdf" ||
                    item.mediaType.startsWith("image/"),
                )
                .map((item) =>
                  item.mediaType === "application/pdf"
                    ? {
                        type: "document" as const,
                        source: {
                          type: "base64" as const,
                          media_type: "application/pdf" as const,
                          data: item.data,
                        },
                      }
                    : {
                        type: "image" as const,
                        source: {
                          type: "base64" as const,
                          media_type: item.mediaType as "image/png",
                          data: item.data,
                        },
                      },
                )
            : undefined,
          images: request.attachments?.filter((item) =>
            item.mediaType.startsWith("image/"),
          ),
          cwd,
          model:
            typeof request.settings?.model === "string"
              ? request.settings.model
              : config.model,
        });
      discover = async () => ({
        capabilities: getKernelCapabilities("claude", "http"),
        native: await agent.discover(cwd),
      });
      sessions = agent.sessions;
      close = () => agent.close();
      steer = (sessionId, input) => agent.steer(sessionId, input);
      nativeCompaction = true;
      break;
    }
    case "opencode":
    case "kimi": {
      command = config.options?.command ?? config.kernel;
      env = config.options?.env;
      const agent = new AcpAgent({
        elicitation: { form: {} },
        ...config.options,
        command,
        compaction: config.kernel,
        cwd,
        bindings,
      });
      run = async function* (request) {
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
            media.push({
              type: "resource",
              resource: {
                uri: pathToFileURL(item.path).href,
                mimeType: item.mediaType,
                blob: item.data,
              },
            });
        }
        yield* agent.run({
          ...config.runOptions,
          ...request,
          input: media.length
            ? [{ type: "text", text: request.input }, ...media]
            : request.input,
          cwd,
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
      sessions = agent.sessions;
      close = () => agent.close();
      nativeCompaction = true;
      discover = async () => {
        const client = await agent.connect();
        const native = agent.getCapabilities(client);
        const capabilities = getKernelCapabilities(config.kernel, "http");
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
          [
            "sessions.resume",
            Boolean(
              native.loadSession ||
                (native.sessionCapabilities as JsonObject)?.resume,
            ),
          ],
          [
            "sessions.fork",
            Boolean((native.sessionCapabilities as JsonObject)?.fork),
          ],
          [
            "sessions.list",
            Boolean((native.sessionCapabilities as JsonObject)?.list),
          ],
        ] as const)
          capabilities.features[feature] = {
            status: enabled ? "supported" : "unsupported",
            ...(enabled ? {} : { reason: "native_not_supported" as const }),
          };
        return { capabilities, native };
      };
      break;
    }
    case "pi": {
      const agent = new PiAgent({
        ...config.options,
        cwd,
        sessionRoot: config.options?.sessionRoot ?? join(root, "native"),
        bindings,
      });
      run = (request) =>
        agent.run({
          ...config.runOptions,
          ...request,
          thinkingLevel: (request.settings?.thinkingLevel ??
            config.runOptions?.thinkingLevel) as PiRunRequest["thinkingLevel"],
          onRequest: config.toolApproval ? request.onRequest : undefined,
          images: request.attachments
            ?.filter((item) => item.mediaType.startsWith("image/"))
            .map((item) => ({
              type: "image" as const,
              data: item.data,
              mimeType: item.mediaType,
            })),
          cwd,
          model:
            typeof request.settings?.model === "string"
              ? request.settings.model
              : config.model,
        });
      sessions = agent.sessions;
      close = () => agent.close();
      steer = (sessionId, input) => agent.steer(sessionId, input);
      compact = (request) =>
        agent.compact(
          request.sessionId,
          request.input || undefined,
          request.signal,
        );
      break;
    }
    case "hermes": {
      command = config.options.command;
      env = {
        ...process.env,
        ...config.options.env,
        HERMES_HOME: config.options.env?.HERMES_HOME ?? join(root, "native"),
      };
      const agent = new HermesAgent({
        ...config.options,
        exclusiveProfile: true,
        command,
        cwd,
        env,
        bindings,
      });
      run = (request) =>
        agent.run({
          ...config.runOptions,
          ...request,
          cwd,
          model:
            typeof request.settings?.model === "string"
              ? request.settings.model
              : config.model,
          provider:
            typeof request.settings?.provider === "string"
              ? request.settings.provider
              : config.provider,
          reasoningEffort:
            typeof request.settings?.reasoningEffort === "string"
              ? request.settings.reasoningEffort
              : config.reasoningEffort,
        });
      discover = async () => ({
        capabilities: getKernelCapabilities("hermes", "http"),
        native: await agent
          .connect()
          .request("gateway.capabilities", {}, { timeoutMs: 30_000 }),
      });
      sessions = agent.sessions;
      close = () => agent.close();
      steer = (sessionId, input) => agent.steer(sessionId, input);
      compact = (request) =>
        agent.compact(
          request.sessionId,
          request.input || undefined,
          request.signal,
        );
      break;
    }
    case "openclaw": {
      const agent = new OpenClawAgent({ ...config.options, bindings });
      steer = (sessionId, input) => agent.steer(sessionId, input);
      run = (request) =>
        agent.run({
          ...config.runOptions,
          ...request,
          cwd,
          model:
            typeof request.settings?.model === "string"
              ? request.settings.model
              : config.model,
          thinking: request.settings?.thinking as string | undefined,
        });
      discover = async () => {
        await agent.client.ensureConnected();
        const capabilities = getKernelCapabilities("openclaw", "http");
        if (agent.client.methods)
          for (const [name, method] of [
            ["sessions.history", "chat.history"],
            ["controls.steer", "sessions.steer"],
            ["sessions.fork", "sessions.fork"],
            ["sessions.delete", "sessions.delete"],
            ["sessions.list", "sessions.list"],
            ["interactions.approval", "exec.approval.resolve"],
          ] as const) {
            const enabled = agent.client.methods.includes(method);
            capabilities.features[name] = {
              status: enabled ? "supported" : "unsupported",
              ...(enabled ? {} : { reason: "native_not_supported" as const }),
            };
          }
        return {
          capabilities,
          native: {
            version: agent.client.serverVersion ?? null,
            methods: agent.client.methods ?? [],
          },
        };
      };
      sessions = agent.sessions;
      close = () => agent.close();
      compact = async (request) => {
        if (request.input.trim())
          return {
            ok: false,
            compacted: false,
            error: "compaction_reason_unsupported",
          };
        const binding = await bindings.get(request.sessionId);
        if (!binding)
          return { ok: false, compacted: false, error: "session_not_found" };
        return agent.compact(binding.threadId, request.signal);
      };
      break;
    }
  }
  return {
    id: config.id,
    kernel: config.kernel,
    cwd,
    model: config.model,
    configurationKey,
    sessions,
    allowedSettings: config.allowedSettings,
    validateSettings: (selected) =>
      validateSettings(config.kernel, config.allowedSettings, selected),
    discover,
    capabilities: getKernelCapabilities(config.kernel, "http"),
    maxConcurrentRuns: config.kernel === "hermes" ? 1 : 16,
    inputs: {
      attachments: true,
      images: ["codex", "claude", "pi", "openclaw", "hermes"].includes(
        config.kernel,
      )
        ? "native"
        : ["opencode", "kimi"].includes(config.kernel)
          ? "negotiated"
          : "workspace",
    },
    supportsCompaction: nativeCompaction || Boolean(compact),
    steer,
    close,
    async *run(request): AsyncIterable<ServiceEvent> {
      validateSettings(config.kernel, config.allowedSettings, request.settings);
      if (request.attachments?.length)
        request = {
          ...config.runOptions,
          ...request,
          input: [
            request.input,
            "Attached files (untrusted input) are available in the runtime workspace:",
            ...request.attachments.map((item) =>
              JSON.stringify({
                name: item.name,
                mediaType: item.mediaType,
                path: item.path,
              }),
            ),
          ]
            .filter(Boolean)
            .join("\n"),
        };
      if (request.mode !== "compact" || nativeCompaction) {
        yield* run(request);
        return;
      }
      if (!compact) throw new Error("compaction_unsupported");
      if (request.settings && Object.keys(request.settings).length)
        throw new Error("compaction_settings_unsupported");
      request.signal.throwIfAborted();
      yield { type: "turn.started", runId: request.runId };
      const result = await compact(request);
      yield {
        type: "control.result",
        runId: request.runId,
        control: "compact",
        result,
      };
      yield {
        type: "turn.finished",
        runId: request.runId,
        outcome: result.ok
          ? { status: "completed" }
          : result.cancelled
            ? { status: "cancelled" }
            : {
                status: "failed",
                error: result.error ?? "compaction_not_confirmed",
                outcomeUnknown: result.outcomeUnknown,
              },
      };
    },
    async inspect() {
      try {
        if (!statSync(cwd).isDirectory())
          return { available: false, reason: "workspace_not_directory" };
      } catch {
        return { available: false, reason: "workspace_not_found" };
      }
      if (command && !commandExists(command, env, cwd))
        return { available: false, reason: "command_not_found" };
      if (config.kernel === "pi" && !config.model && !config.options?.model)
        return { available: false, reason: "pi_model_selection_required" };
      return { available: true };
    },
  };
}

function commandExists(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
  cwd: string,
) {
  const names =
    process.platform === "win32" && !/\.[^/\\]+$/.test(command)
      ? [
          command,
          ...(env?.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
            .split(";")
            .map((extension) => command + extension),
        ]
      : [command];
  const paths =
    command.includes("/") || command.includes("\\") || isAbsolute(command)
      ? [cwd]
      : (env?.PATH ?? process.env.PATH ?? "").split(delimiter);
  return paths.some((directory) =>
    names.some((name) => {
      try {
        const path = resolve(directory, name);
        if (!statSync(path).isFile()) return false;
        accessSync(
          path,
          /\.[cm]?js$/i.test(path) || process.platform === "win32"
            ? constants.R_OK
            : constants.X_OK,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
}
