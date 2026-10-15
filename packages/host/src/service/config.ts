import { dirname, resolve } from "node:path";
import { z } from "zod";
import { idSchema } from "./protocol.js";
import type { HermesRunRequest } from "../hermes/session.js";
import type { OpenClawRunRequest } from "../openclaw/session.js";
import {
  createNativeRuntime,
  type NativeRuntimeConfig,
} from "./native-runtimes.js";
const profileSchema = z
  .object({
    id: idSchema,
    kernel: z.enum([
      "codex",
      "claude",
      "pi",
      "opencode",
      "kimi",
      "hermes",
      "openclaw",
    ]),
    cwd: z.string().min(1),
    model: z.string().optional(),
    transport: z.enum(["stdio", "acp"]).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    thread: z.record(z.string(), z.json()).optional(),
    turn: z.record(z.string(), z.json()).optional(),
    gatewayUrl: z.url().optional(),
    gatewayTokenEnv: z.string().optional(),
    provider: z.string().optional(),
    effort: z.string().optional(),
    fastMode: z
      .union([
        z.boolean(),
        z.enum(["fast", "normal", "auto", "cold", "ultrafast"]),
      ])
      .optional(),
    native: z.record(z.string(), z.json()).optional(),
    allowedSettings: z
      .record(
        z.string(),
        z
          .object({
            values: z.array(z.json()).min(1),
            description: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    toolApproval: z.boolean().optional(),
    thinkingLevel: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
    config: z.record(z.string(), z.json()).optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const allowed = {
      codex: ["command", "args", "env", "thread", "turn"],
      claude: ["command", "env", "native"],
      opencode: ["command", "args", "env", "effort", "config"],
      kimi: ["command", "args", "env", "effort", "config"],
      pi: ["thinkingLevel", "toolApproval"],
      hermes:
        profile.transport === "acp"
          ? ["command", "args", "env", "transport"]
          : [
              "command",
              "args",
              "env",
              "provider",
              "effort",
              "fastMode",
              "transport",
            ],
      openclaw: ["gatewayUrl", "gatewayTokenEnv", "fastMode"],
    }[profile.kernel];
    for (const key of Object.keys(profile))
      if (
        ![
          "id",
          "kernel",
          "cwd",
          "model",
          "allowedSettings",
          ...allowed,
        ].includes(key)
      )
        ctx.addIssue({
          code: "custom",
          message: `${key} is not supported by this ${profile.kernel} CLI profile`,
        });
    if (
      profile.kernel === "hermes" &&
      profile.transport !== "acp" &&
      !profile.command
    )
      ctx.addIssue({
        code: "custom",
        message: "Hermes requires its gateway command and arguments",
      });
    if (profile.kernel === "openclaw" && !profile.gatewayUrl)
      ctx.addIssue({ code: "custom", message: "OpenClaw requires gatewayUrl" });
    if (
      profile.gatewayUrl &&
      !["ws:", "wss:"].includes(new URL(profile.gatewayUrl).protocol)
    )
      ctx.addIssue({
        code: "custom",
        message: "OpenClaw gatewayUrl must use ws or wss",
      });
    if (profile.gatewayTokenEnv && !process.env[profile.gatewayTokenEnv])
      ctx.addIssue({
        code: "custom",
        message: "Configured Gateway token environment variable is empty",
      });
    if (profile.kernel === "pi" && !profile.model)
      ctx.addIssue({ code: "custom", message: "Pi requires provider/model" });
    if (
      profile.fastMode !== undefined &&
      ((profile.kernel === "hermes" && typeof profile.fastMode !== "string") ||
        (profile.kernel === "openclaw" &&
          typeof profile.fastMode === "string" &&
          !["auto", "ultrafast"].includes(profile.fastMode)))
    )
      ctx.addIssue({
        code: "custom",
        path: ["fastMode"],
        message: `Invalid native fastMode for ${profile.kernel}`,
      });
  });
export const configSchema = z
  .object({
    stateDirectory: z.string().default(".agent-host"),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(37420),
    allowedOrigins: z.array(z.string().url()).default([]),
    workspaceFiles: z.boolean().default(false),
    runtimes: z.array(profileSchema).min(1),
  })
  .strict();

export function createConfiguredRuntimes(
  config: z.output<typeof configSchema>,
  filename: string,
) {
  const stateDirectory = resolve(dirname(filename), config.stateDirectory);
  return config.runtimes.map((profile) => {
    const base = {
      id: profile.id,
      kernel: profile.kernel,
      cwd: resolve(dirname(filename), profile.cwd),
      model: profile.model,
      allowedSettings: profile.allowedSettings,
    };
    const options = {
      command: profile.command,
      args: profile.args,
      env: profile.env,
    };
    let native: NativeRuntimeConfig;
    switch (profile.kernel) {
      case "codex":
        native = {
          ...base,
          kernel: "codex",
          options,
          thread: profile.thread,
          turn: profile.turn,
        };
        break;
      case "claude":
        native = {
          ...base,
          kernel: "claude",
          options: {
            command: profile.command,
            env: profile.env,
            native: profile.native,
          },
        };
        break;
      case "opencode":
      case "kimi":
        native = {
          ...base,
          kernel: profile.kernel,
          options,
          effort: profile.effort,
          runOptions: { config: profile.config },
        };
        break;
      case "pi":
        native = {
          ...base,
          kernel: "pi",
          toolApproval: profile.toolApproval,
          runOptions: { thinkingLevel: profile.thinkingLevel },
        };
        break;
      case "hermes":
        if (profile.transport === "acp") {
          native = { ...base, kernel: "hermes", transport: "acp", options };
          break;
        }
        native = {
          ...base,
          kernel: "hermes",
          options: { ...options, command: profile.command! },
          provider: profile.provider,
          reasoningEffort: profile.effort,
          fastMode: profile.fastMode as HermesRunRequest["fastMode"],
        };
        break;
      case "openclaw":
        native = {
          ...base,
          kernel: "openclaw",
          fastMode: profile.fastMode as OpenClawRunRequest["fastMode"],
          options: {
            url: profile.gatewayUrl!,
            token: profile.gatewayTokenEnv
              ? process.env[profile.gatewayTokenEnv]
              : undefined,
          },
        };
        break;
    }
    return createNativeRuntime(native, stateDirectory);
  });
}
