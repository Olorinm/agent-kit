import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CODEX_CLIENT_ID,
  credentialView,
  injectGoogleAuth,
  injectOpenAiAuth,
  needsRefresh,
  parseGoogleCredential,
  parseModelCredential,
  parseOpenAiCredential,
  refreshOpenAiToken,
} from "../src/credentials.mjs";
import { allowEgress, modelCredentials } from "../src/egress.mjs";

const b64 = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
const acct1 = "11111111-1111-4111-8111-111111111111";
const acct2 = "22222222-2222-4222-8222-222222222222";

test("parseOpenAiCredential validates chatgpt and api_key modes and never exposes secrets in views", () => {
  const token = jwt({ exp: 2_000_000_000, client_id: "app_custom", "https://api.openai.com/auth": { chatgpt_account_id: acct1 } });
  const parsed = parseOpenAiCredential({ service: "openai", mode: "chatgpt", accessToken: token, refreshToken: "rt_secret" });
  assert.deepEqual(parsed, {
    service: "openai",
    mode: "chatgpt",
    accessToken: token,
    refreshToken: "rt_secret",
    accountId: acct1,
    clientId: "app_custom",
    expiresAt: 2_000_000_000_000,
  });
  const view = credentialView("codex-main", { ...parsed, updatedAt: "2026-11-22T00:00:00.000Z" });
  assert.deepEqual(view, {
    id: "codex-main",
    service: "openai",
    mode: "chatgpt",
    accountId: acct1,
    expiresAt: new Date(2_000_000_000_000).toISOString(),
    renewable: true,
    updatedAt: "2026-11-22T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(view).includes("rt_secret"), false);
  assert.equal(JSON.stringify(view).includes(token), false);

  const fallbackClient = parseOpenAiCredential({ service: "openai", mode: "chatgpt", accessToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: acct1 } }) });
  assert.equal(fallbackClient.clientId, DEFAULT_CODEX_CLIENT_ID);

  const apiKey = parseOpenAiCredential({ service: "openai", mode: "api_key", apiKey: "sk-live-secret" });
  const apiView = credentialView("key-1", { ...apiKey, updatedAt: "2026-11-22T00:00:00.000Z" });
  assert.equal(JSON.stringify(apiView).includes("sk-live-secret"), false);
  assert.deepEqual(apiView, { id: "key-1", service: "openai", mode: "api_key", renewable: false, updatedAt: "2026-11-22T00:00:00.000Z" });

  for (const bad of [
    null, {}, { service: "unknown", mode: "api_key", apiKey: "sk-1" },
    { service: "openai", mode: "chatgpt", accessToken: token, accountId: acct2 },
    { service: "openai", mode: "chatgpt", accessToken: "opaque-no-account" },
    { service: "openai", mode: "chatgpt", accessToken: token, extra: "bad" },
    { service: "openai", mode: "api_key", apiKey: "sk with space" },
  ]) assert.throws(() => parseOpenAiCredential(bad), { message: "invalid_model_credential" });
});

test("modelCredentials validates service-to-id mappings and blocks guest auth.openai.com egress", () => {
  assert.equal(modelCredentials(undefined), undefined);
  assert.deepEqual(modelCredentials({}), {});
  assert.deepEqual(modelCredentials({ openai: "codex-prod.1" }), { openai: "codex-prod.1" });
  assert.deepEqual(modelCredentials({ google: "gemini-main" }), { google: "gemini-main" });
  assert.deepEqual(modelCredentials({ openai: "codex-main", google: "gemini-main" }), { openai: "codex-main", google: "gemini-main" });
  for (const bad of [null, "codex", [], { openai: "" }, { openai: "../bad" }, { google: "" }, { google: ["gemini-main"] }, { unknown: "a" }, JSON.parse('{"__proto__":"a"}')])
    assert.throws(() => modelCredentials(bad), { message: "invalid_model_credentials" });
  // Guest cannot contact auth.openai.com directly once the gateway owns OpenAI credentials.
  assert.equal(allowEgress("https://auth.openai.com/oauth/token", "POST", ["openai"], undefined), true);
  assert.equal(allowEgress("https://auth.openai.com/oauth/token", "POST", ["openai"], { openai: "codex-main" }), false);
  assert.equal(allowEgress("https://chatgpt.com/backend-api/codex/responses", "POST", ["openai"], { openai: "codex-main" }), true);
});

test("injectOpenAiAuth replaces placeholder headers and enforces account and mode boundaries", () => {
  const realToken = jwt({ exp: 2_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: acct1 } });
  const cred = { service: "openai", mode: "chatgpt", accessToken: realToken, accountId: acct1 };
  const injected = injectOpenAiAuth("https://chatgpt.com/backend-api/codex/responses",
    new Headers({ Authorization: "Bearer placeholder", "ChatGPT-Account-ID": acct2, "X-Keep": "1" }), cred, { openai: [acct1] });
  assert.equal(injected.error, undefined);
  assert.equal(injected.headers.get("authorization"), `Bearer ${realToken}`);
  assert.equal(injected.headers.get("chatgpt-account-id"), acct1);
  assert.equal(injected.headers.get("x-keep"), "1");
  assert.equal(injectOpenAiAuth("https://api.openai.com/v1/responses", new Headers(), cred, { openai: [acct1] }).error, "model_api_key_not_allowed");
  assert.equal(injectOpenAiAuth("https://chatgpt.com/backend-api/codex/responses", new Headers(), cred, { openai: [acct2] }).error, "model_account_not_allowed");

  const keyCred = { service: "openai", mode: "api_key", apiKey: "sk-real" };
  const keyInjected = injectOpenAiAuth("https://api.openai.com/v1/responses", new Headers({ Authorization: "Bearer sk-placeholder", "ChatGPT-Account-ID": acct1 }), keyCred, undefined);
  assert.equal(keyInjected.headers.get("authorization"), "Bearer sk-real");
  assert.equal(keyInjected.headers.get("chatgpt-account-id"), null);
  assert.equal(injectOpenAiAuth("https://chatgpt.com/backend-api/codex/responses", new Headers(), keyCred, undefined).error, "model_account_not_allowed");
  assert.equal(injectOpenAiAuth("https://api.openai.com/v1/responses", new Headers(), keyCred, { openai: [acct1] }).error, "model_api_key_not_allowed");
});

test("refreshOpenAiToken rotates tokens and rejects mismatched accounts", async () => {
  const now = 1_800_000_000_000;
  const expiring = { service: "openai", mode: "chatgpt", accessToken: "old", refreshToken: "rt_1", accountId: acct1, clientId: DEFAULT_CODEX_CLIENT_ID, expiresAt: now + 60_000 };
  assert.equal(needsRefresh(expiring, now), true);
  assert.equal(needsRefresh({ ...expiring, expiresAt: now + 600_000 }, now), false);

  const nextToken = jwt({ exp: Math.floor(now / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: acct1 } });
  const calls = [];
  const refreshed = await refreshOpenAiToken(expiring, async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return Response.json({ access_token: nextToken, refresh_token: "rt_2" });
  }, now);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://auth.openai.com/oauth/token");
  assert.equal(calls[0][1].refresh_token, "rt_1");
  assert.equal(refreshed.accessToken, nextToken);
  assert.equal(refreshed.refreshToken, "rt_2");
  assert.equal(refreshed.expiresAt, (Math.floor(now / 1000) + 3600) * 1000);

  const wrongAccountToken = jwt({ exp: Math.floor(now / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: acct2 } });
  await assert.rejects(() => refreshOpenAiToken(expiring, async () => Response.json({ access_token: wrongAccountToken }), now),
    { message: "model_credential_account_mismatch" });
});

test("parseGoogleCredential accepts a Gemini API key only and its view never contains the key", () => {
  const input = { service: "google", mode: "api_key", apiKey: "AIza-fixture-owner-key" };
  const parsed = parseGoogleCredential(input);
  assert.deepEqual(parsed, input);
  assert.deepEqual(parseModelCredential(input), input);
  const view = credentialView("gemini-main", { ...parsed, updatedAt: "2026-11-23T00:00:00.000Z" });
  assert.deepEqual(view, { id: "gemini-main", service: "google", mode: "api_key", renewable: false, updatedAt: "2026-11-23T00:00:00.000Z" });
  assert.equal(JSON.stringify(view).includes("AIza-fixture-owner-key"), false);
  // The service decides the parser: an OpenAI body stays an OpenAI credential, and neither parser takes the other's.
  assert.deepEqual(parseModelCredential({ service: "openai", mode: "api_key", apiKey: "sk-fixture" }), { service: "openai", mode: "api_key", apiKey: "sk-fixture" });
  assert.throws(() => parseOpenAiCredential(input), { message: "invalid_model_credential" });
  assert.throws(() => parseGoogleCredential({ service: "openai", mode: "api_key", apiKey: "sk-fixture" }), { message: "invalid_model_credential" });
  for (const bad of [
    null, [], "AIza-fixture", {}, { service: "google" }, { service: "google", mode: "api_key" },
    { service: "google", mode: "chatgpt", accessToken: "token" }, { service: "google", mode: "oauth", apiKey: "AIza-fixture" },
    { service: "google", mode: "api_key", apiKey: "" }, { service: "google", mode: "api_key", apiKey: "with space" },
    { service: "google", mode: "api_key", apiKey: "line\nbreak" }, { service: "google", mode: "api_key", apiKey: 1 },
    { service: "google", mode: "api_key", apiKey: "k".repeat(4097) }, { service: "google", mode: "api_key", apiKey: "AIza-fixture", accountId: "a" },
    { service: "unknown", mode: "api_key", apiKey: "sk-1" }, { service: "Google", mode: "api_key", apiKey: "AIza-fixture" },
  ]) {
    assert.throws(() => parseModelCredential(bad), { message: "invalid_model_credential" }, JSON.stringify(bad));
    if (bad?.service === "google") assert.throws(() => parseGoogleCredential(bad), { message: "invalid_model_credential" }, JSON.stringify(bad));
  }
});

test("injectGoogleAuth removes every credential the guest sent and sends the held key instead", () => {
  const cred = { service: "google", mode: "api_key", apiKey: "AIza-owner" };
  const api = "https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture:streamGenerateContent";
  const sent = (url, headers) => {
    const injected = injectGoogleAuth(url, new Headers(headers), cred);
    assert.equal(injected.error, undefined);
    assert.equal(injected.headers.get("x-goog-api-key"), "AIza-owner");
    assert.equal(injected.headers.get("authorization"), null);
    assert.equal(injected.url.includes("someone-else"), false, injected.url);
    assert.equal([...injected.headers.values()].some(value => value.includes("someone-else")), false);
    return injected;
  };
  // The placeholder a managed guest sends, and each way a guest could carry a key or token of its own.
  assert.equal(sent(api + "?alt=sse", { "X-Goog-Api-Key": "gateway-managed", "Content-Type": "application/json" }).url, api + "?alt=sse");
  assert.equal(sent(api + "?alt=sse", { "x-goog-api-key": "AIza-someone-else" }).headers.get("content-type"), null);
  assert.equal(sent(api + "?alt=sse", { Authorization: "Bearer ya29.someone-else", "X-Keep": "1" }).headers.get("x-keep"), "1");
  assert.equal(sent(api + "?alt=sse&key=AIza-someone-else", {}).url, api + "?alt=sse");
  assert.equal(sent(api + "?key=AIza-someone-else&alt=sse&key=AIza-someone-else-2", {}).url, api + "?alt=sse");
  assert.equal(sent(api + "?key=AIza-someone-else", {}).url, api);
  assert.equal(sent(api + "?KEY=AIza-someone-else&access_token=ya29.someone-else&oauth_token=ya29.someone-else-2&alt=sse", {}).url, api + "?alt=sse");
  assert.equal(sent(api + "?alt=sse&key=AIza-someone-else", { "X-Goog-Api-Key": "AIza-someone-else", Authorization: "Bearer ya29.someone-else" }).url, api + "?alt=sse");
  // A URL without a credential is sent as it came.
  const untouched = "https://generativelanguage.googleapis.com/v1beta/files?pageSize=10&pageToken=a%20b";
  assert.equal(sent(untouched, {}).url, untouched);
  // Another host gets nothing.
  assert.deepEqual(injectGoogleAuth("https://api.openai.com/v1/responses", new Headers(), cred), {});
  assert.deepEqual(injectGoogleAuth("https://generativelanguage.googleapis.com.evil.test/v1beta/models", new Headers(), cred), {});
});

test("a credential is injected only for its own service: a wrong ID is refused, never sent to the other provider", () => {
  const google = { service: "google", mode: "api_key", apiKey: "AIza-owner" };
  const openaiKey = { service: "openai", mode: "api_key", apiKey: "sk-owner" };
  const chatgpt = { service: "openai", mode: "chatgpt", accessToken: "token-owner", accountId: acct1 };
  const mismatch = { error: "model_credential_service_mismatch" };
  for (const url of ["https://api.openai.com/v1/responses", "https://chatgpt.com/backend-api/codex/responses", "https://auth.openai.com/oauth/token"])
    for (const accounts of [undefined, { openai: [acct1] }])
      assert.deepEqual(injectOpenAiAuth(url, new Headers({ Authorization: "Bearer placeholder" }), google, accounts), mismatch, url);
  for (const cred of [openaiKey, chatgpt, { mode: "api_key", apiKey: "sk-unlabelled" }, { service: "anthropic", mode: "api_key", apiKey: "sk-ant" }, undefined, null])
    assert.deepEqual(injectGoogleAuth("https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent", new Headers({ "X-Goog-Api-Key": "gateway-managed" }), cred), mismatch, JSON.stringify(cred));
  // A credential stored before the service was checked on this path would carry no service: refused too.
  assert.deepEqual(injectOpenAiAuth("https://api.openai.com/v1/responses", new Headers(), { mode: "api_key", apiKey: "sk-unlabelled" }, undefined), mismatch);
  assert.equal(injectGoogleAuth("https://generativelanguage.googleapis.com/v1beta/models", new Headers(), { service: "google", mode: "chatgpt", accessToken: "t" }).error, "model_credential_invalid");
  assert.equal(injectGoogleAuth("https://generativelanguage.googleapis.com/v1beta/models", new Headers(), { service: "google", mode: "api_key" }).error, "model_credential_invalid");
});
