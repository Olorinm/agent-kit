import { randomBytes } from "node:crypto";

/** ADR 0005 sections 9 and 18.4. Shared by identity pairing and host link pairing. */
export const PAIRING = { codeLength: 8, ttlMs: 3_600_000, pendingPerPerson: 3, failures: 5, failureWindowMs: 3_600_000, lockoutMs: 3_600_000 };
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** Input is case-insensitive; hyphens and spaces are ignored; I/L read as 1 and O as 0. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}
/** A new code: `normalized` is what a store hashes, `code` is what a person reads and types. */
export function newPairingCode(now: number): { normalized: string; code: string; expires: number } {
  const normalized = [...randomBytes(PAIRING.codeLength)].map((byte) => ALPHABET[byte & 31]).join("");
  return { normalized, code: `${normalized.slice(0, 4)}-${normalized.slice(4)}`, expires: now + PAIRING.ttlMs };
}
export interface PairingFailures { failures: number; windowStart: number; lockedUntil: number }
/** The failure state that still counts at `now`; an elapsed window or lockout starts over. */
export function activeFailures(stored: PairingFailures | undefined, now: number): PairingFailures {
  if (!stored || (stored.lockedUntil && stored.lockedUntil <= now) || (!stored.lockedUntil && stored.windowStart + PAIRING.failureWindowMs <= now))
    return { failures: 0, windowStart: now, lockedUntil: 0 };
  return stored;
}
/** The state after one more failed attempt; reaching the limit sets `lockedUntil`. */
export function nextFailure(state: PairingFailures, now: number): PairingFailures {
  const failures = state.failures + 1;
  return { failures, windowStart: state.windowStart, lockedUntil: failures >= PAIRING.failures ? now + PAIRING.lockoutMs : 0 };
}
