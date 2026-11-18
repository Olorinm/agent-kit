import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ConnectorError } from "../../connector.js";

const API = "https://api.cloudflare.com/client/v4";

export interface BrowserRunAccount { accountId: string; token: string }

/** Cloudflare Browser Run session management over its HTTP API; the browser itself is driven by agent-browser. */
export interface BrowserRun {
  /** Starts a remote browser and returns its session ID. */
  create(account: BrowserRunAccount, signal: AbortSignal): Promise<string>;
  /** Whether a session is still running. */
  alive(account: BrowserRunAccount, sessionId: string, signal: AbortSignal): Promise<boolean>;
  /** Mints a Live View URL for one page target ("tab" mode). The URL grants control until it expires. */
  liveView(account: BrowserRunAccount, sessionId: string, targetId: string, expiresInMs: number, signal: AbortSignal): Promise<string>;
  /** Whether a page target (tab) still exists. */
  target(account: BrowserRunAccount, sessionId: string, targetId: string, signal: AbortSignal): Promise<boolean>;
}

/** The CDP endpoint agent-browser attaches to; the bearer token travels only in AGENT_BROWSER_CDP_HEADERS. */
export function cdpEndpoint(account: BrowserRunAccount, sessionId: string) {
  return `${API.replace(/^https:/, "wss:")}/accounts/${encodeURIComponent(account.accountId)}/browser-run/devtools/browser/${encodeURIComponent(sessionId)}`;
}

export class CloudflareBrowserRun implements BrowserRun {
  constructor(readonly keepAliveMs = 600_000) {}
  async create(account: BrowserRunAccount, signal: AbortSignal) {
    const created = await this.request(account, "POST", `/devtools/browser?keep_alive=${this.keepAliveMs}`, signal);
    const id = (created.body?.result ?? created.body)?.sessionId;
    if (!created.ok || typeof id !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new ConnectorError("browser_run_unavailable");
    return id;
  }
  async alive(account: BrowserRunAccount, sessionId: string, signal: AbortSignal) {
    const response = await this.request(account, "GET", `/devtools/browser/${encodeURIComponent(sessionId)}/json/version`, signal);
    if (response.ok) return true;
    if ([400, 404, 410].includes(response.status)) return false;
    throw new ConnectorError("browser_run_unavailable", { status: response.status });
  }
  async liveView(account: BrowserRunAccount, sessionId: string, targetId: string, expiresInMs: number, signal: AbortSignal) {
    const response = await this.request(account, "POST", `/devtools/browser/${encodeURIComponent(sessionId)}/live_view`, signal,
      { mode: "tab", targetId, expiresInMs });
    const url = (response.body?.result ?? response.body)?.devtoolsFrontendUrl;
    if (!response.ok || typeof url !== "string" || !url.startsWith("https://")) throw new ConnectorError("browser_live_view_unavailable", { status: response.status });
    return url;
  }
  async target(account: BrowserRunAccount, sessionId: string, targetId: string, signal: AbortSignal) {
    const response = await this.request(account, "GET", `/devtools/browser/${encodeURIComponent(sessionId)}/json/list/${encodeURIComponent(targetId)}`, signal);
    if (response.ok) return true;
    if ([400, 404, 410].includes(response.status)) return false;
    throw new ConnectorError("browser_run_unavailable", { status: response.status });
  }
  private async request(account: BrowserRunAccount, method: string, path: string, signal: AbortSignal, json?: unknown) {
    const response = await fetch(`${API}/accounts/${encodeURIComponent(account.accountId)}/browser-run${path}`, {
      method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { Authorization: `Bearer ${account.token}`, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    if (response.status === 401 || response.status === 403) throw new ConnectorError("browser_run_unauthorized", { status: response.status });
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { ok: response.ok, status: response.status, body };
  }
}

export interface CliResult { code: number; stdout: string; stderr: string }
export interface CliOptions { cwd: string; env: NodeJS.ProcessEnv; timeout: number; signal: AbortSignal; input?: string }
export type AgentBrowserRunner = (args: string[], options: CliOptions) => Promise<CliResult>;

/**
 * The pinned agent-browser package ships every platform's native binary in its tarball, without the executable bit.
 * Its install script only sets that bit (and rewrites a global npm link if one exists), so it is not run: the binary
 * is used directly when executable, otherwise copied once into this service's private directory with mode 0700.
 */
export function agentBrowserBinary(privateDirectory: string): string {
  const require = createRequire(import.meta.url);
  let root: string;
  try { root = dirname(require.resolve("agent-browser/package.json")); } catch { throw new ConnectorError("agent_browser_not_installed"); }
  const arch = { x64: "x64", arm64: "arm64" }[process.arch as string];
  const report = process.platform === "linux" ? process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined : undefined;
  const os = process.platform === "linux" ? (report?.header?.glibcVersionRuntime ? "linux" : "linux-musl") : process.platform;
  if (!arch || !["linux", "linux-musl", "darwin", "win32"].includes(os)) throw new ConnectorError("agent_browser_not_installed");
  const name = `agent-browser-${os}-${arch}${process.platform === "win32" ? ".exe" : ""}`, packaged = join(root, "bin", name);
  if (!existsSync(packaged)) throw new ConnectorError("agent_browser_not_installed");
  try { accessSync(packaged, constants.X_OK); return packaged; } catch { /* copied below */ }
  const copy = join(privateDirectory, name);
  if (!existsSync(copy) || statSync(copy).size !== statSync(packaged).size) {
    const partial = `${copy}.${process.pid}.partial`;
    copyFileSync(packaged, partial); chmodSync(partial, 0o700); renameSync(partial, copy);
  }
  return copy;
}

const MAX_OUTPUT = 32_000_000;

/** Runs the binary with an argument array: no shell, no user-wide configuration, stdin only when given. */
export const runAgentBrowser = (binary: () => string): AgentBrowserRunner => (args, options) => new Promise((resolve, reject) => {
  const child = spawn(binary(), args, { cwd: options.cwd, env: options.env, signal: options.signal,
    timeout: options.timeout, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const out: Buffer[] = [], err: Buffer[] = [];
  let size = 0, overflow = false;
  const collect = (into: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_OUTPUT) { overflow = true; child.kill(); return; }
    into.push(chunk);
  };
  child.stdout.on("data", collect(out));
  child.stderr.on("data", collect(err));
  child.on("error", () => reject(new Error("agent_browser_execution_failed")));
  child.on("close", (code, signal) => {
    if (overflow) { reject(new ConnectorError("agent_browser_output_too_large")); return; }
    if (code === null) { reject(new Error(signal ? "agent_browser_execution_interrupted" : "agent_browser_execution_failed")); return; }
    resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
  });
  child.stdin.end(options.input ?? "");
});

const METADATA_HOSTS = new Set(["metadata.goog", "metadata.tencentyun.com"]);
const PRIVATE_SUFFIXES = [".localhost", ".internal", ".local", ".home.arpa"];
/** Loopback, private, carrier-grade NAT, link-local, benchmark, multicast and reserved IPv4 ranges. */
function privateV4(a: number, b: number) {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19));
}
/** The eight groups of an IPv6 literal as the URL parser serializes it (hexadecimal groups, at most one `::`). */
function groupsV6(literal: string) {
  const [head = "", tail] = literal.split("::"), parse = (part: string) => part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const left = parse(head), right = tail === undefined ? [] : parse(tail);
  const groups = tail === undefined ? left : [...left, ...new Array<number>(Math.max(8 - left.length - right.length, 0)).fill(0), ...right];
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : undefined;
}
/** Unspecified, loopback, unique-local, link-local, site-local and multicast addresses, and those embedding a private IPv4. */
function privateV6(literal: string) {
  const g = groupsV6(literal);
  if (!g) return true;
  const embedded = (high: number) => privateV4(high >> 8, high & 0xff);
  const zero = (count: number) => g.slice(0, count).every((group) => group === 0);
  if ((g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xff80) === 0xfe80 || (g[0]! & 0xff00) === 0xff00) return true;
  // IPv4-compatible (::a.b.c.d, which includes :: and ::1) and IPv4-mapped (::ffff:a.b.c.d).
  if (zero(5) && (g[5] === 0 || g[5] === 0xffff)) return embedded(g[6]!);
  // NAT64: the well-known prefix carries an IPv4 address; the local-use prefix is private by definition.
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 1 || !g.slice(2, 6).every((group) => group === 0) || embedded(g[6]!);
  // 6to4 carries an IPv4 address in its second and third groups.
  if (g[0] === 0x2002) return embedded(g[1]!);
  return false;
}

/**
 * Refuses non-http(s) URLs, embedded credentials and loopback, private, link-local, metadata and single-label hosts.
 * Address checks apply to address literals only: the URL parser has already turned every IPv4 spelling (decimal, hex,
 * short forms, trailing dot) into dotted decimal and every IPv6 literal into bracketed hexadecimal groups.
 * Names are not resolved here: the remote browser resolves them on Cloudflare's network, so a lookup from this
 * process would prove nothing about the address the browser reaches.
 */
export function allowedUrl(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ConnectorError("browser_url_invalid"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new ConnectorError("browser_url_not_allowed");
  const host = parsed.hostname.toLowerCase().replace(/\.$/, ""), v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (host.startsWith("[") ? privateV6(host.slice(1, -1)) : v4 ? privateV4(Number(v4[1]), Number(v4[2]))
    : !host.includes(".") || METADATA_HOSTS.has(host) || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix)))
    throw new ConnectorError("browser_url_not_allowed");
  return parsed.href;
}

/**
 * The key a site permission is stored and matched under: the URL's host in lower case without a trailing dot or a
 * leading `www.`, plus a non-default port. Matching is exact on that key: no subdomain or registrable-domain
 * matching, which would need the public suffix list to avoid treating `a.github.io` and `b.github.io` as one site.
 */
export function siteOf(url: string) {
  const parsed = new URL(allowedUrl(url));
  return `${parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "")}${parsed.port ? `:${parsed.port}` : ""}`;
}

export function safeName(name: string) {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").replace(/^\.+/, "_").trim().slice(0, 120);
  return cleaned || "download";
}
