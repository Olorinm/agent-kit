import type { HostAdmission, HostStartInput } from "./host.js";

/** Who an input is from when the owner did not write it (`WorkSessions.submit` `sender`). */
export interface WorkSender { kind: "agent"; id: string; name: string }
/** What a work submission keeps for its turn (`work_session_inputs`). */
export type WorkInput = HostStartInput & { sender?: WorkSender; json?: true };

/** Who delivered input is from, as its model reads it: the partner that sent it, the schedule, or the product. */
const from = (admission: HostAdmission, sender?: WorkSender) =>
  sender ? { partner: sender.name } : admission.kind === "schedule" ? "schedule" : "system";

/**
 * What a model reads for input that no human wrote: one JSON object. `from` is Router's; the rest is the product's,
 * either its text as `message` or, for a `json` submission, the members of its object. The product's part is JSON
 * values, so nothing it contains can pass for `from`.
 */
export function delivered(admission: HostAdmission, input: string, sender?: WorkSender, json?: boolean,
  skills?: Array<{ name: string; path: string }>): string {
  const { from: _reserved, ...body } = json ? JSON.parse(input) as Record<string, unknown> : { message: input };
  return JSON.stringify({ from: from(admission, sender), ...body, ...(skills ? { skills, skillLoading: "verified_references" } : {}) });
}
/** Whether a text is a JSON object, as a `json` submission must be. */
export function jsonObject(text: string): boolean {
  try { const value: unknown = JSON.parse(text); return typeof value === "object" && value !== null && !Array.isArray(value); } catch { return false; }
}

/** The delivered object as a standalone native tool output, for a runtime that accepts one: a tool result, never a human message. */
export function toolDelivery(admission: HostAdmission, input: string, sender?: WorkSender, json?: boolean,
  skills?: Array<{ name: string; path: string }>): Record<string, unknown> {
  return { namespace: "mau", name: admission.kind === "schedule" ? "proactive_work" : "work_sessions", retain: false,
    output: delivered(admission, input, sender, json, skills) };
}
