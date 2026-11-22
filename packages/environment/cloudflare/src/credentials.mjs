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
    const expiresAt = typeof claims?.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : undefined;
    return {
      service: "openai",
      mode: "chatgpt",
      accessToken: body.accessToken,
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
