import type { Kernel } from "./capabilities.js";
import type { JsonValue } from "./types.js";

export type SettingsSelection = Record<string, JsonValue>;
export type AllowedSettings = Record<
  string,
  { values: JsonValue[]; description?: string }
>;
/** Only model/turn preferences are caller-selectable. Code, credentials and permissions stay in profiles. */
export const selectableSettings: Record<Kernel, readonly string[]> = {
  codex: ["model", "effort", "serviceTier", "outputSchema"],
  claude: [
    "model",
    "effort",
    "thinking",
    "maxTurns",
    "maxBudgetUsd",
    "outputFormat",
  ],
  pi: ["model", "thinkingLevel"],
  opencode: ["model", "effort", "config"],
  kimi: ["model", "effort", "config"],
  hermes: ["model", "provider", "reasoningEffort", "fastMode"],
  openclaw: ["model", "thinking", "fastMode"],
};
export function validateSettings(
  kernel: Kernel,
  allowed: AllowedSettings | undefined,
  selected: SettingsSelection = {},
): void {
  for (const [key, value] of Object.entries(selected)) {
    if (
      !selectableSettings[kernel].includes(key) ||
      !allowed?.[key]?.values.some((item) => stable(item) === stable(value))
    )
      throw new Error(`setting_not_allowed:${key}`);
  }
}
function stable(value: JsonValue): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}
