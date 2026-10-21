const encoder = new TextEncoder();
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export async function equalSecret(a, b) {
  if (!a || !b) return false;
  const digest = async x => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(x)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function key(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signAccess(secret, id, port, expires) {
  const payload = `${id}:${port}:${expires}`;
  return `${expires}.${b64(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload)))}`;
}
export async function verifyAccess(secret, token, id, port, now = Date.now()) {
  if (!secret || !UUID.test(id) || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token ?? "");
  if (!match || Number(match[1]) < now || Number(match[1]) > now + 6 * 60_000) return false;
  return equalSecret(token, await signAccess(secret, id, port, Number(match[1])));
}
export function lifetime(seconds) {
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) throw new Error("invalid_lifetime");
  return seconds;
}
/** @returns {Record<string, string>} */
export function strings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length > 64 ||
      Object.entries(value).some(([k, v]) => typeof v !== "string" || k.length > 256 || v.length > 8192 || k.includes("\0") || v.includes("\0"))) {
    throw new Error("invalid_string_map");
  }
  return /** @type {Record<string, string>} */ (value);
}
export function createSpec(body) {
  if (body.template !== "node24") throw new Error("unknown_template");
  if (body.onTimeout !== undefined && !["kill", "pause"].includes(body.onTimeout)) throw new Error("invalid_timeout_policy");
  return {
    template: body.template,
    timeoutSeconds: lifetime(body.timeoutSeconds ?? 600),
    onTimeout: body.onTimeout ?? "pause",
    metadata: strings(body.metadata),
    env: strings(body.env),
  };
}
