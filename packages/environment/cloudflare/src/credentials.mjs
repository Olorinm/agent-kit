import { jwtPayload } from "./egress.mjs";

export const CREDENTIAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const REFRESH_SKEW_MS = 5 * 60_000;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CLIENT_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const SECRET = /^[^\s\x00-\x1f\x7f]{1,16384}$/;

/**
 * Validates and normalizes an OpenAI model credential uploaded by the trusted operator (Mau).
 * Stored only in the gateway Durable Object; secrets are never returned by any API.
 * @param {any} body
 * @returns {{ service: "openai"; mode: "chatgpt" | "api_key"; accessToken?: string; refreshToken?: string; accountId?: string; clientId?: string; apiKey?: string; expiresAt?: number }}
 */
export function parseOpenAiCredential(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.service !== "openai")
    throw new Error("invalid_model_credential");
  if (body.mode === "chatgpt") {
    for (const key of Object.keys(body))
      if (!["service", "mode", "accessToken", "refreshToken", "accountId", "clientId"].includes(key))
        throw new Error("invalid_model_credential");
    if (typeof body.accessToken !== "string" || !SECRET.test(body.accessToken))
      throw new Error("invalid_model_credential");
    if (body.refreshToken !== undefined && (typeof body.refreshToken !== "string" || !SECRET.test(body.refreshToken)))
      throw new Error("invalid_model_credential");
    if (body.accountId !== undefined && (typeof body.accountId !== "string" || !ACCOUNT_ID.test(body.accountId)))
      throw new Error("invalid_model_credential");
    if (body.clientId !== undefined && (typeof body.clientId !== "string" || !CLIENT_ID.test(body.clientId)))
      throw new Error("invalid_model_credential");
    const claims = jwtPayload(body.accessToken);
    const claimAccount = typeof claims?.["https://api.openai.com/auth"]?.chatgpt_account_id === "string" &&
      ACCOUNT_ID.test(claims["https://api.openai.com/auth"].chatgpt_account_id)
      ? claims["https://api.openai.com/auth"].chatgpt_account_id : undefined;
    if (claimAccount && body.accountId && claimAccount !== body.accountId)
      throw new Error("invalid_model_credential");
    const accountId = claimAccount ?? body.accountId;
    if (!accountId) throw new Error("invalid_model_credential");
    const claimClient = typeof claims?.client_id === "string" && CLIENT_ID.test(claims.client_id) ? claims.client_id : undefined;
    const plan = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
    const expiresAt = typeof claims?.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : undefined;
    return {
      service: "openai",
      mode: "chatgpt",
      accessToken: body.accessToken,
      ...(typeof plan === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(plan) ? { planType: plan } : {}),
      accountId,
      clientId: body.clientId ?? claimClient ?? DEFAULT_CODEX_CLIENT_ID,
      ...(body.refreshToken ? { refreshToken: body.refreshToken } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }
  if (body.mode === "api_key") {
    for (const key of Object.keys(body))
      if (!["service", "mode", "apiKey"].includes(key))
        throw new Error("invalid_model_credential");
    if (typeof body.apiKey !== "string" || !SECRET.test(body.apiKey) || body.apiKey.length > 4096)
      throw new Error("invalid_model_credential");
    return { service: "openai", mode: "api_key", apiKey: body.apiKey };
  }
  throw new Error("invalid_model_credential");
}

/** Public metadata view of a stored credential. Never contains tokens or API keys. */
export function credentialView(id, stored) {
  return {
    id,
    service: stored.service,
    mode: stored.mode,
    ...(stored.accountId ? { accountId: stored.accountId } : {}),
    ...(stored.expiresAt !== undefined ? { expiresAt: new Date(stored.expiresAt).toISOString() } : {}),
    ...(stored.planType ? { planType: stored.planType } : {}),
    renewable: Boolean(stored.refreshToken),
    updatedAt: stored.updatedAt,
  };
}

export function needsRefresh(stored, now = Date.now()) {
  return stored.mode === "chatgpt" && Boolean(stored.refreshToken) &&
    stored.expiresAt !== undefined && stored.expiresAt - now <= REFRESH_SKEW_MS;
}

/**
 * Refreshes a ChatGPT OAuth access token directly from the gateway (outside the sandbox).
 * Preserves account binding so a refresh response can never switch accounts.
 * @template {{ service: "openai"; mode: "chatgpt" | "api_key"; accessToken?: string; refreshToken?: string; accountId?: string; clientId?: string; apiKey?: string; expiresAt?: number; updatedAt: string }} T
 * @param {T} stored @param {typeof fetch} [fetchImpl] @param {number} [now]
 * @returns {Promise<T>}
 */
export async function refreshOpenAiToken(stored, fetchImpl = fetch, now = Date.now()) {
  if (stored.mode !== "chatgpt" || !stored.refreshToken) throw new Error("model_credential_not_renewable");
  const response = await fetchImpl("https://auth.openai.com/oauth/token", {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: stored.clientId ?? DEFAULT_CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      scope: "openid profile email",
    }),
  });
  if (!response.ok) throw new Error("model_credential_refresh_failed");
  const data = await response.json();
  if (!data || typeof data !== "object" || typeof data.access_token !== "string" || !SECRET.test(data.access_token))
    throw new Error("model_credential_refresh_failed");
  const claims = jwtPayload(data.access_token);
  const claimAccount = typeof claims?.["https://api.openai.com/auth"]?.chatgpt_account_id === "string"
    ? claims["https://api.openai.com/auth"].chatgpt_account_id : undefined;
  if (claimAccount && claimAccount !== stored.accountId)
    throw new Error("model_credential_account_mismatch");
  const expiresAt = typeof claims?.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000
    : typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? now + data.expires_in * 1000
    : stored.expiresAt;
  const refreshToken = typeof data.refresh_token === "string" && SECRET.test(data.refresh_token)
    ? data.refresh_token : stored.refreshToken;
  return {
    ...stored,
    accessToken: data.access_token,
    refreshToken,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * Replaces the guest's placeholder Authorization header with the gateway-held OpenAI credential,
 * enforcing mode and modelAccounts constraints before the request leaves the gateway.
 */
export function injectOpenAiAuth(url, headers, cred, allowedAccounts) {
  const host = new URL(url).hostname;
  const allowed = allowedAccounts && Object.hasOwn(allowedAccounts, "openai") ? allowedAccounts.openai : undefined;
  if (cred.mode === "chatgpt") {
    if (host === "api.openai.com") return { error: "model_api_key_not_allowed" };
    if (host !== "chatgpt.com") return {};
    if (allowed && !allowed.includes(cred.accountId)) return { error: "model_account_not_allowed" };
    const next = new Headers(headers);
    next.set("Authorization", `Bearer ${cred.accessToken}`);
    next.set("ChatGPT-Account-ID", cred.accountId);
    return { headers: next };
  }
  if (cred.mode === "api_key") {
    if (host === "chatgpt.com") return { error: "model_account_not_allowed" };
    if (host !== "api.openai.com") return {};
    if (allowed) return { error: "model_api_key_not_allowed" };
    const next = new Headers(headers);
    next.set("Authorization", `Bearer ${cred.apiKey}`);
    next.delete("ChatGPT-Account-ID");
    return { headers: next };
  }
  return { error: "model_credential_invalid" };
}

/** Only takes public metadata. The native CLI reads its account from the ID token. */
export function placeholderAuth(meta) {
  if (meta.mode === "api_key") return JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-gateway-managed" });
  if (meta.mode !== "chatgpt" || !ACCOUNT_ID.test(meta.accountId ?? "")) throw new Error("invalid_credential_metadata");
  const claims = { exp: 4102444800, "https://api.openai.com/auth": { chatgpt_account_id: meta.accountId,
    ...(meta.planType ? { chatgpt_plan_type: meta.planType } : {}) } };
  const payload = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const jwt = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.cGxhY2Vob2xkZXI`;
  return JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: "2099-01-01T00:00:00Z",
    tokens: { id_token: jwt, access_token: jwt, refresh_token: "gateway-managed", account_id: meta.accountId } });
}

/** Runs in the Debian guest. All home-directory I/O happens after dropping privileges. */
export const installGuestAuth = String.raw`
const fs = require("node:fs"), crypto = require("node:crypto");
const [name, content] = process.argv.slice(1);
const entry = fs.readFileSync("/etc/passwd", "utf8").split("\n").map(line => line.split(":")).find(fields => fields[0] === name);
if (!entry) process.exit(75);
const [uid, gid] = entry.slice(2, 4).map(Number);
if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0 || entry[5] !== "/home/" + name)
  throw Error("invalid_guest_account");
process.setgroups([]); process.setgid(gid); process.setuid(uid);
const c = fs.constants, dirFlags = c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW;
const fdPath = fd => "/proc/self/fd/" + fd;
const homeRoot = fs.openSync("/home", dirFlags);
const home = fs.openSync(fdPath(homeRoot) + "/" + name, dirFlags);
if (fs.fstatSync(home).uid !== uid) throw Error("invalid_guest_home");
const dir = fdPath(home) + "/.codex";
try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (err) { if (err.code !== "EEXIST") throw err; }
const fd = fs.openSync(dir, dirFlags);
if (fs.fstatSync(fd).uid !== uid) throw Error("invalid_codex_home");
const destination = fdPath(fd) + "/auth.json";
const prior = fs.lstatSync(destination, { throwIfNoEntry: false });
if (prior && !prior.isFile()) throw Error("invalid_codex_auth");
const temp = fdPath(fd) + "/.mau-auth-" + crypto.randomUUID();
const out = fs.openSync(temp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
try {
  try { fs.writeFileSync(out, content + "\n"); fs.fsyncSync(out); } finally { fs.closeSync(out); }
  fs.renameSync(temp, destination); fs.fsyncSync(fd);
} finally { fs.rmSync(temp, { force: true }); }
`;
