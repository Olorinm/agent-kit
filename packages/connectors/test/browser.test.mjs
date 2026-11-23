import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ConnectorError, ConnectorService, Sealer, Store, browserConnector } from "../dist/index.js";
import { parseCommand } from "../dist/connectors/browser/command.js";
import { agentBrowserBinary, allowedUrl, runAgentBrowser, siteOf } from "../dist/connectors/browser/runtime.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf_token_0123456789abcdefghij";
const alice = { agentId: "agent-a", owner: "@alice", connections: ["web"], tokenId: "t" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("the connector runs its native platform binary and bundled skills with a private HOME", async t => {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("agent-browser/package.json");
  const { nativeTarget, platformPackageBinary } = require("agent-browser/scripts/native.js");
  const target = nativeTarget();
  if (!target) return t.skip("agent-browser does not publish for this platform");
  const executable = platformPackageBinary(dirname(manifest), target);
  assert.ok(executable, "expected the pinned optional platform package");
  const directory = mkdtempSync(join(tmpdir(), "agent-browser-native-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = agentBrowserBinary(directory);
  assert.ok(binary === executable || dirname(binary) === directory);
  assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), "agent-browser " + require(manifest).version);
  const result = await runAgentBrowser(() => binary)(["skills", "get", "core"], { cwd: directory,
    env: { HOME: directory, PATH: process.env.PATH }, timeout: 10_000, signal: AbortSignal.timeout(10_000) });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /snapshot/);
});

/** Fake agent-browser: one remote page per session, recording every invocation with its environment. */
function fakeCli() {
  const calls = [];
  const browser = { url: "about:blank", cookies: [], tabs: [{ tabId: "t1", targetId: "TARGET1", active: true }], uploads: [] };
  const runner = async (args, { cwd, env, input }) => {
    calls.push({ args, cwd, env, input });
    const json = (data) => ({ code: 0, stdout: JSON.stringify({ success: true, data, error: null }), stderr: "" });
    const [command, ...rest] = args[0] === "--json" ? args.slice(1) : args;
    if (command === "--help" || args.includes("--help")) return { code: 0, stdout: `Usage: agent-browser ${args[0]}`, stderr: "" };
    if (command === "skills") return { code: 0, stdout: "# agent-browser core skill", stderr: "" };
    if (command === "close" || (command === "stream" && rest[0] === "disable")) return { code: 0, stdout: "✓", stderr: "" };
    if (command === "state" && rest[0] === "load") { browser.cookies = JSON.parse(readFileSync(rest[1], "utf8")).cookies; return { code: 0, stdout: "✓", stderr: "" }; }
    if (command === "state" && rest[0] === "save") { writeFileSync(rest[1], JSON.stringify({ cookies: browser.cookies, origins: [] })); return { code: 0, stdout: "✓", stderr: "" }; }
    if (command === "open") { browser.url = rest[0]; return { code: 0, stdout: `✓ Page\n  ${rest[0]}`, stderr: "" }; }
    if (command === "get" && rest[0] === "url") return { code: 0, stdout: `${browser.url}\n`, stderr: "" };
    if (command === "get" && rest[0] === "attr") return { code: 0, stdout: rest[1] === "@private" ? "http://10.0.0.5/x.pdf\n" : "/files/a.pdf\n", stderr: "" };
    if (command === "snapshot") return { code: 0, stdout: '- textbox "Email" [ref=e1]', stderr: "" };
    if (command === "fill") { browser.cookies = [{ name: "sid", value: "secret-cookie", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true }]; return { code: 0, stdout: "✓ Done", stderr: "" }; }
    if (command === "click") browser.onClick?.();
    if (command === "click") return rest[0] === "#missing" ? { code: 1, stdout: "", stderr: "✗ Element not found: #missing" } : { code: 0, stdout: "✓ Done", stderr: "" };
    if (command === "screenshot" || command === "pdf") {
      const path = rest.filter((arg) => !arg.startsWith("-")).at(-1);
      writeFileSync(path, command === "pdf" ? Buffer.from("%PDF-1.7") : PNG);
      return { code: 0, stdout: `✓ Saved to ${path}`, stderr: "" };
    }
    if (command === "upload") { browser.uploads.push({ selector: rest[0], files: rest.slice(1).map((p) => ({ path: p, exists: existsSync(p) })) }); return { code: 0, stdout: "✓ Done", stderr: "" }; }
    if (command === "eval" && input.includes("DataTransfer")) { browser.uploads.push({ placed: input.includes("YWJj") }); return json({ result: { ok: true } }); }
    if (command === "tab" && rest[0] === "list") return json({ tabs: browser.tabs });
    if (command === "tab" && rest[0] === "new") { browser.tabs = [...browser.tabs.map((t) => ({ ...t, active: false })), { tabId: "t2", targetId: "TARGET2", active: true }]; return { code: 0, stdout: "✓", stderr: "" }; }
    if (command === "tab" && rest[0] === "close") { browser.tabs = browser.tabs.filter((t) => t.targetId !== rest[1]); return { code: 0, stdout: "✓", stderr: "" }; }
    return { code: 0, stdout: "✓ Done", stderr: "" };
  };
  return { calls, browser, runner };
}

function fakeBrowserRun(browser) {
  const log = [];
  const alive = new Set();
  let created = 0;
  return { log, alive, api: {
    create: async (account) => { log.push(["create", account.accountId, account.token]); const id = `session-${++created}`; alive.add(id); return id; },
    alive: async (_account, id) => { log.push(["alive", id]); return alive.has(id); },
    liveView: async (_account, id, target, ms) => { log.push(["liveView", id, target, ms]); return `https://live.browser.run/ui/view?mode=tab&jwt=secret-${target}`; },
    target: async (_account, _id, target) => browser.tabs.some((tab) => tab.targetId === target),
  } };
}

/** Fake CDP guard: records captures and handoffs; `closed` can be flipped to simulate a dropped connection. */
function fakeGuards() {
  const log = [];
  const state = { handoff: { active: true }, download: { name: "a.pdf", mediaType: "application/pdf", size: 6, contentBase64: Buffer.from("%PDF-x").toString("base64") } };
  let created = 0;
  const factory = async (account, sessionId) => {
    const guard = { closed: false, id: ++created,
      captureDownload: async (targetId, trigger, options) => { log.push(["capture", guard.id, targetId, options.maxBytes]); await trigger(); return state.download; },
      handoff: async (targetId, instructions, ms) => { log.push(["handoff", targetId, instructions, ms]); return "cf-handoff-1"; },
      handoffState: async (targetId, handoffId) => { log.push(["handoffState", targetId, handoffId]); return state.handoff; },
      restrict: (permits) => { guard.permits = permits; guard.blocked = []; },
      takeBlocked: () => guard.blocked.splice(0),
      close: () => { guard.closed = true; log.push(["close", guard.id]); } };
    guard.blocked = [];
    log.push(["connect", guard.id, sessionId, account.token === TOKEN]);
    state.current = guard;
    return guard;
  };
  return { log, state, factory };
}

function setup({ tokenMode = 0o600, token = TOKEN } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-connectors-browser-"));
  writeFileSync(join(directory, "cf-token"), token); chmodSync(join(directory, "cf-token"), tokenMode);
  const cli = fakeCli(), run = fakeBrowserRun(cli.browser), guards = fakeGuards();
  const store = new Store(join(directory, "state"));
  const connections = [{ id: "web", kind: "browser", owner: "@alice", settings: { accountId: ACCOUNT, tokenFile: "cf-token" } }];
  const options = { baseDirectory: directory, directory: join(directory, "homes"), browserRun: run.api, runner: cli.runner, guard: guards.factory };
  const service = new ConnectorService({ connectors: [browserConnector(options)], connections, store, sealer: new Sealer(Buffer.alloc(32, 7)) });
  return { ...cli, run, guards, service, store, directory, options, connections,
    cleanup: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const call = (service, tool, input, caller = alice) => service.call(caller, `web__${tool}`, input, new AbortController().signal);
const ab = (service, ...args) => call(service, "agent_browser_read", { args });
const abFor = (service, task, ...args) => call(service, "agent_browser_read", { args, ...(task ? { task } : {}) });
const access = (service, input) => service.access("web", new AbortController().signal, input);
const commands = (s) => s.calls.map((c) => c.args.join(" "));

test("commands run directly against the connection's Browser Run session; the token reaches the CLI only as a CDP header", async (t) => {
  const s = setup(); t.after(s.cleanup);
  assert.equal((await ab(s.service, "open", "https://example.com/login")).status, "completed");
  const snap = await ab(s.service, "snapshot", "-i");
  assert.equal(snap.status, "completed");
  assert.match(snap.result.output, /\[ref=e1\]/);
  assert.equal((await ab(s.service, "fill", "@e1", "a@example.com")).status, "completed");
  assert.deepEqual(s.run.log.filter((e) => e[0] === "create"), [["create", ACCOUNT, TOKEN]], "one remote browser per connection, reused across calls");
  for (const c of s.calls) assert.ok(!c.args.some((arg) => arg.includes(TOKEN)), "the token is never an argument");
  const browserCall = s.calls.find((c) => c.args[0] === "open");
  assert.equal(browserCall.env.AGENT_BROWSER_CDP_HEADERS, JSON.stringify({ Authorization: `Bearer ${TOKEN}` }));
  assert.equal(browserCall.env.AGENT_BROWSER_CDP, `wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser/session-1`);
  assert.equal(browserCall.env.AGENT_BROWSER_SESSION, "b");
  assert.ok(browserCall.env.AGENT_BROWSER_CONFIG.endsWith("config.json"), "an explicit empty configuration, never discovery");
  assert.equal(browserCall.env.HOME, browserCall.cwd.replace(/\/work$/, ""), "a private home per connection");
  assert.equal(statSync(browserCall.env.HOME).mode & 0o777, 0o700);
  assert.ok(commands(s).includes("stream disable"), "the daemon's local screencast is turned off");
  // Storage is saved after every command, sealed; the plaintext cookie value never reaches the store.
  assert.equal(commands(s).filter((line) => line.startsWith("state save")).length, 2, "after open and fill; a snapshot only inspects");
  const raw = s.store.credential("web");
  assert.ok(raw && !raw.toString().includes("secret-cookie"));
  const status = await s.service.connections(new AbortController().signal);
  assert.deepEqual(status[0].account, { status: "connected", sites: ["example.com"] });
});

test("only allowlisted commands and flags run; anything touching credentials, scripts, traffic or other browsers is refused first", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const refused = [
    [["cookies"], "agent_browser_command_not_allowed"], [["cookies", "get"], "agent_browser_command_not_allowed"], [["cookies", "set", "a", "b"], "agent_browser_command_not_allowed"],
    [["storage", "local"], "agent_browser_command_not_allowed"], [["state", "save", "x.json"], "agent_browser_command_not_allowed"],
    [["state", "load", "x.json"], "agent_browser_command_not_allowed"], [["eval", "document.cookie"], "agent_browser_command_not_allowed"],
    [["network", "route", "*"], "agent_browser_command_not_allowed"], [["network", "requests"], "agent_browser_command_not_allowed"],
    [["connect", "9222"], "agent_browser_command_not_allowed"], [["install"], "agent_browser_command_not_allowed"], [["upgrade"], "agent_browser_command_not_allowed"],
    [["auth", "list"], "agent_browser_command_not_allowed"], [["batch", "open https://x.com"], "agent_browser_command_not_allowed"],
    [["stream", "enable"], "agent_browser_command_not_allowed"], [["dashboard", "start"], "agent_browser_command_not_allowed"],
    [["addinitscript", "x"], "agent_browser_command_not_allowed"], [["plugin", "add", "x"], "agent_browser_command_not_allowed"],
    [["set", "headers", "{}"], "agent_browser_command_not_allowed"], [["set", "credentials", "u", "p"], "agent_browser_command_not_allowed"],
    [["get", "cdp-url"], "agent_browser_command_not_allowed"], [["diff", "url", "a", "b"], "agent_browser_command_not_allowed"],
    [["close", "--all"], "agent_browser_flag_not_allowed"], [["wait", "--fn", "window.x"], "agent_browser_flag_not_allowed"],
    [["wait", "--download", "x"], "agent_browser_flag_not_allowed"], [["read", "https://example.com"], "agent_browser_arguments_invalid"],
    [["read", "--llms", "full"], "agent_browser_flag_not_allowed"], [["skills", "path"], "agent_browser_command_not_allowed"],
    [["--cdp", "ws://127.0.0.1:9222", "snapshot"], "agent_browser_flag_not_allowed"], [["snapshot", "--cdp-headers", "{}"], "agent_browser_flag_not_allowed"],
    [["--profile", "Default", "open", "https://x.com"], "agent_browser_flag_not_allowed"], [["--state", "auth.json", "wait", "1"], "agent_browser_flag_not_allowed"],
    [["--session", "other", "snapshot"], "agent_browser_flag_not_allowed"], [["open", "https://x.com", "--proxy", "http://p"], "agent_browser_flag_not_allowed"],
    [["--executable-path", "/bin/sh", "open"], "agent_browser_flag_not_allowed"], [["--extension", "/tmp/x", "open"], "agent_browser_flag_not_allowed"],
    [["--config", "x.json", "snapshot"], "agent_browser_flag_not_allowed"], [["open", "https://x.com", "--init-script", "a.js"], "agent_browser_flag_not_allowed"],
    [["open", "https://x.com", "--headers", "{}"], "agent_browser_flag_not_allowed"], [["screenshot", "--screenshot-dir", "/tmp"], "agent_browser_flag_not_allowed"],
    [["--download-path", "/tmp", "click", "@e1"], "agent_browser_flag_not_allowed"], [["-p", "browserbase", "open"], "agent_browser_flag_not_allowed"],
    [["--allow-file-access", "open", "file:///etc/passwd"], "agent_browser_flag_not_allowed"], [["--json=true", "snapshot"], "agent_browser_arguments_invalid"],
    [["snapshot", "-d", "--cdp"], "agent_browser_arguments_invalid"], [["wait", "@e1", "--state", "./auth.json"], "agent_browser_arguments_invalid"],
    [["fill", "@e1"], "agent_browser_arguments_invalid"], [["--json"], "agent_browser_command_required"], [["frobnicate"], "agent_browser_command_not_allowed"],
  ];
  for (const [args, error] of refused) {
    const result = await ab(s.service, ...args);
    assert.equal(result.status, "failed", args.join(" "));
    assert.equal(result.error, error, args.join(" "));
  }
  assert.equal((await ab(s.service, "cookies")).detail.reason, "credentials");
  assert.equal(s.calls.length, 0, "no refused command starts a CLI process");
  assert.equal(s.run.log.length, 0, "or attaches a browser");
  for (const args of [["--json", "snapshot", "-i", "-c", "-d", "3"], ["click", "@e1", "--new-tab"], ["wait", "--load", "networkidle"], ["wait", "@e1", "--state", "hidden"],
    ["find", "role", "button", "click", "--name", "Submit"], ["get", "text", "@e1"], ["is", "visible", "@e1"], ["press", "Enter"], ["scroll", "down", "500"],
    ["tab", "list"], ["tab", "t2"], ["dialog", "accept"], ["set", "viewport", "1280", "800"], ["read", "--filter", "Pricing"], ["select", "@e2", "a", "b"], ["back"]])
    assert.equal((await ab(s.service, ...args)).status, "completed", args.join(" "));
});

test("navigation targets are checked: bare hosts get https://, private and non-http URLs are refused before a browser starts", async (t) => {
  const s = setup(); t.after(s.cleanup);
  for (const args of [["open", "http://127.0.0.1:8080/"], ["open", "localhost:3000"], ["goto", "http://169.254.169.254/latest/meta-data"], ["navigate", "http://10.0.0.5/"],
    ["open", "file:///etc/passwd"], ["open", "chrome://version"], ["open", "https://user:pw@example.com/"], ["open", "http://[::1]/"], ["tab", "new", "http://192.168.1.1/"],
    ["open", "data:text/html,<p>"], ["open", "javascript:alert(1)"]]) {
    const result = await ab(s.service, ...args);
    assert.equal(result.status, "failed", args.join(" "));
    assert.match(result.error, /^browser_url_(not_allowed|invalid)$/, args.join(" "));
  }
  assert.equal(s.calls.length, 0);
  assert.equal((await ab(s.service, "open", "example.com/search?q=hotel")).status, "completed");
  assert.ok(commands(s).includes("open https://example.com/search?q=hotel"), "the checked URL is the one passed on");
  assert.equal((await ab(s.service, "tab", "new", "https://docs.example.com")).status, "completed");
});

test("screenshots and PDFs are written to a private per-call directory and returned as files; the Agent's path names only the file", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const shot = await ab(s.service, "screenshot", "--full", "../../etc/evil.png");
  assert.equal(shot.status, "completed");
  assert.deepEqual(shot.result.files.map(({ contentBase64: _, ...f }) => f), [{ name: "evil.png", mediaType: "image/png", size: PNG.length }]);
  const ran = s.calls.find((c) => c.args[0] === "screenshot");
  const path = ran.args.at(-1);
  assert.ok(path.startsWith(join(s.options.directory, "1", "calls")) && path.endsWith("/evil.png"), "the CLI writes inside the connection's call directory");
  assert.ok(!existsSync(path), "and the call directory is removed afterwards");
  assert.equal(shot.result.output, "✓ Saved to evil.png", "local paths are not reported");
  const plain = await ab(s.service, "screenshot", "@e1");
  assert.equal(plain.result.files[0].name, "screenshot.png", "a selector-only screenshot still gets a private output path");
  assert.deepEqual(s.calls.filter((c) => c.args[0] === "screenshot").at(-1).args.slice(0, 2), ["screenshot", "@e1"]);
  const pdf = await ab(s.service, "pdf", "report");
  assert.deepEqual([pdf.result.files[0].name, pdf.result.files[0].mediaType], ["report.pdf", "application/pdf"]);
});

test("download clicks with agent-browser while the CDP guard captures the file; it is returned under the requested name", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await ab(s.service, "open", "https://example.com/account");
  const result = await ab(s.service, "download", "@e5", "../invoice.pdf");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.result.files.map(({ contentBase64, ...f }) => ({ ...f, text: Buffer.from(contentBase64, "base64").toString() })),
    [{ name: "invoice.pdf", mediaType: "application/pdf", size: 6, text: "%PDF-x" }]);
  assert.deepEqual(s.guards.log.find((e) => e[0] === "capture"), ["capture", 1, "TARGET1", 10_000_000]);
  assert.ok(commands(s).includes("click @e5"), "the element is clicked by agent-browser");
  assert.ok(!commands(s).some((line) => line.startsWith("download")), "agent-browser's own download is not used");
  s.guards.state.current.closed = true;
  const failed = await ab(s.service, "download", "@e5", "x.pdf");
  assert.equal(failed.status, "completed", "a dropped guard is reconnected before the command runs");
  assert.deepEqual(s.guards.log.filter((e) => e[0] === "connect").map((e) => e.slice(0, 3)), [["connect", 1, "session-1"], ["connect", 2, "session-1"]]);
});

test("no command runs when the CDP guard cannot connect", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const service = new ConnectorService({ connectors: [browserConnector({ ...s.options, guard: async () => { throw new ConnectorError("browser_run_unavailable", { reason: "cdp_connect_failed" }); } })],
    connections: s.connections, store: s.store, sealer: new Sealer(Buffer.alloc(32, 7)) });
  const result = await ab(service, "open", "https://example.com/");
  assert.deepEqual([result.status, result.error], ["failed", "browser_run_unavailable"]);
  assert.ok(!commands(s).some((line) => line.startsWith("open")), "the navigation never ran unguarded");
});

test("upload is refused as a read, needs the owner's grant as a write, and places exactly the approved bytes", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await ab(s.service, "open", "https://upload.example.com/form");
  const asRead = await ab(s.service, "upload", "@e3", "cv.pdf");
  assert.deepEqual([asRead.status, asRead.error], ["failed", "agent_browser_command_requires_write_tool"]);
  const input = { args: ["upload", "@e3", "cv.pdf"], site: "https://upload.example.com", files: [{ name: "cv.pdf", mediaType: "application/pdf", contentBase64: "YWJj" }] };
  const pending = await call(s.service, "agent_browser_write", input);
  assert.equal(pending.status, "approval_required");
  assert.equal(pending.summary, '上传到 upload.example.com\nagent-browser upload @e3 cv.pdf\n文件（1 KB）："cv.pdf"');
  assert.equal(s.browser.uploads.length, 0, "nothing is sent before approval");
  assert.ok(!s.service.tools({ ...alice, readOnly: true }).some((tool) => tool.name === "web__agent_browser_write"), "read-only callers never see the write tool");
  const view = await s.service.operation(pending.operationId);
  const grant = { tokenId: "g1", owner: "@alice", operationId: pending.operationId, digest: view.digest, expiresAt: new Date(Date.now() + 60_000) };
  await assert.rejects(s.service.approve({ ...grant, owner: "@bob" }, new AbortController().signal), /grant_does_not_match_operation/);
  const done = await s.service.approve(grant, new AbortController().signal);
  assert.equal(done.status, "completed");
  const [selected, placed] = s.browser.uploads;
  assert.equal(selected.selector, "@e3");
  assert.ok(selected.files[0].exists && selected.files[0].path.endsWith("/cv.pdf"), "agent-browser selects the input with the file's name");
  assert.deepEqual(placed, { placed: true }, "the approved bytes are placed by the fixed page script");
  await assert.rejects(s.service.approve({ ...grant, tokenId: "g2" }, new AbortController().signal), /operation_completed/);
  assert.equal(s.browser.uploads.length, 2, "an approval uploads exactly once");
});

test("upload refuses another site, mismatched files and non-upload commands", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await ab(s.service, "open", "https://other.example.net/");
  const connector = browserConnector(s.options), tool = connector.tools.find((x) => x.name === "agent_browser_write");
  const context = { connection: s.connections[0], credentials: { get: () => ({ version: 1 }), put: () => {} }, signal: new AbortController().signal };
  const file = { name: "cv.pdf", mediaType: "application/pdf", contentBase64: "YWJj" };
  await assert.rejects(tool.execute(context, { args: ["upload", "@e3", "cv.pdf"], site: "https://upload.example.com", files: [file] }), { code: "browser_upload_site_mismatch" });
  await assert.rejects(tool.execute(context, { args: ["upload", "@e3", "other.pdf"], site: "https://other.example.net", files: [file] }), { code: "agent_browser_upload_files_mismatch" });
  await assert.rejects(tool.execute(context, { args: ["click", "@e3"], site: "https://other.example.net", files: [file] }), { code: "agent_browser_write_supports_upload_only" });
  for (const bad of [{ site: "https://upload.example.com/path" }, { site: "http://upload.example.com" }, { files: [{ ...file, name: "../a" }] }, { files: [{ ...file, mediaType: "not a type" }] }])
    assert.equal(tool.input.safeParse({ args: ["upload", "@e3", "cv.pdf"], site: "https://upload.example.com", files: [file], ...bad }).success, false);
  assert.equal(s.browser.uploads.length, 0);
});

test("a failed command is reported with its output and the session is checked again before the next command", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const failed = await ab(s.service, "click", "#missing");
  assert.deepEqual([failed.status, failed.error, failed.detail.output], ["failed", "agent_browser_failed", "✗ Element not found: #missing"]);
  await ab(s.service, "snapshot");
  assert.deepEqual(s.run.log.filter((e) => e[0] !== "liveView").map((e) => e[0]), ["create", "alive"], "the saved session is verified, then reused");
});

test("close saves the sign-ins and disconnects; a lapsed remote browser is replaced and the saved storage restored", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await ab(s.service, "fill", "@e1", "x");
  assert.equal((await ab(s.service, "close")).status, "completed");
  await ab(s.service, "snapshot");
  assert.deepEqual(s.run.log.map((e) => e.slice(0, 2)), [["create", ACCOUNT], ["alive", "session-1"]], "an alive session is reattached without a new browser");
  assert.ok(!commands(s).some((line) => line.startsWith("state load")), "and keeps its own cookies");
  s.run.alive.clear();
  await ab(s.service, "close");
  s.browser.cookies = [];
  await ab(s.service, "snapshot");
  assert.equal(s.run.log.filter((e) => e[0] === "create").length, 2);
  assert.ok(commands(s).some((line) => line.startsWith("state load")), "a new browser receives the sealed storage");
  assert.equal(s.browser.cookies[0].value, "secret-cookie");
  const files = s.calls.filter((c) => c.args[0] === "state").map((c) => c.args[2]);
  assert.ok(files.every((path) => !existsSync(path)), "storage files never outlive the command");
});

test("handoff uses Cloudflare's structured handoff on the current tab, reports Done, and is revoked by replacing the tab", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const blank = await call(s.service, "handoff_start", { instructions: "Please log in", timeoutSeconds: 120 });
  assert.ok(!("pageHost" in blank.result), "a page that is not a site has no host");
  s.browser.url = "https://accounts.example.test:8443/login?next=%2F";
  const linked = await call(s.service, "handoff_start", { instructions: "Sign in at https://evil.example/login\nor www.evil.example now", timeoutSeconds: 120 });
  assert.equal(linked.result.instructions, "Sign in at [链接已移除] or [链接已移除] now", "the banner keeps no link of the Agent's and stays on one line");
  assert.deepEqual(s.guards.log.filter((e) => e[0] === "handoff").at(-1), ["handoff", "TARGET1", "Sign in at [链接已移除] or [链接已移除] now", 120_000]);
  const started = await call(s.service, "handoff_start", { instructions: "Please log in", timeoutSeconds: 120 });
  assert.equal(started.status, "completed");
  assert.equal(started.result.pageHost, "accounts.example.test:8443", "the owner is told which site the tab shows");
  assert.equal(started.result.handoffId, "cf-handoff-1", "the id is Cloudflare's handoff id");
  assert.equal(started.result.instructions, "Please log in");
  assert.match(started.result.liveViewUrl, /^https:\/\/live\.browser\.run\/.*TARGET1/);
  assert.deepEqual(s.run.log.find((e) => e[0] === "liveView"), ["liveView", "session-1", "TARGET1", 180_000]);
  assert.deepEqual(s.guards.log.filter((e) => e[0] === "handoff").at(-1), ["handoff", "TARGET1", "Please log in", 120_000]);
  const open = await call(s.service, "handoff_status", { handoffId: "cf-handoff-1" });
  assert.deepEqual([open.result.active, open.result.done], [true, false]);
  s.guards.state.handoff = { active: false, success: true };
  const done = await call(s.service, "handoff_status", { handoffId: "cf-handoff-1" });
  assert.deepEqual([done.result.active, done.result.done, done.result.success], [false, true, true], "Done in the live view completes it");
  assert.equal((await call(s.service, "handoff_status", { handoffId: "other" })).error, "browser_handoff_not_found");
  assert.equal((await call(s.service, "handoff_cancel", { handoffId: "other" })).error, "browser_handoff_not_found");
  assert.ok(!commands(s).some((line) => line.startsWith("tab close")), "an unknown handoff id closes nothing");
  assert.equal((await call(s.service, "handoff_cancel", { handoffId: "cf-handoff-1" })).result.cancelled, true);
  assert.deepEqual(commands(s).filter((line) => line.startsWith("tab ") && !line.includes("list")), ["tab new", "tab close TARGET1"]);
  assert.equal((await call(s.service, "handoff_status", { handoffId: "cf-handoff-1" })).error, "browser_handoff_not_found", "a cancelled handoff is forgotten");
});

test("help and the CLI's own skills run without a browser", async (t) => {
  const s = setup(); t.after(s.cleanup);
  assert.match((await ab(s.service, "skills", "get", "core")).result.output, /core skill/);
  assert.equal((await ab(s.service, "click", "@e1", "--help")).result.output, "Usage: agent-browser click");
  assert.deepEqual(s.calls.map((c) => c.args), [["skills", "get", "core"], ["click", "--help"]]);
  assert.ok(s.calls.every((c) => !c.env.AGENT_BROWSER_CDP && !c.env.AGENT_BROWSER_CDP_HEADERS));
  assert.equal(s.run.log.length, 0);
  assert.equal((await ab(s.service, "cookies", "--help")).error, "agent_browser_command_not_allowed");
});

test("token file must be private and well formed", async (t) => {
  const open = setup({ tokenMode: 0o644 }); t.after(open.cleanup);
  assert.equal((await ab(open.service, "snapshot")).error, "browser_token_file_must_be_private");
  assert.equal(open.run.log.length, 0);
  const bad = setup({ token: "has space in it 0123456789" }); t.after(bad.cleanup);
  assert.equal((await ab(bad.service, "snapshot")).error, "browser_token_file_invalid");
});

test("parseCommand keeps agent-browser syntax and marks file outputs", () => {
  assert.deepEqual(parseCommand(["--json", "screenshot", "shot.jpg"]).outputs, [{ index: 2, name: "shot.jpg" }]);
  assert.deepEqual(parseCommand(["screenshot", "#main", "a/b/c"]).outputs, [{ index: 2, name: "c.png" }]);
  assert.deepEqual(parseCommand(["upload", "input[type=file]", "a.pdf", "dir/b.png"]).files, ["a.pdf", "b.png"]);
  assert.equal(parseCommand(["quit"]).kind, "close");
  assert.equal(parseCommand(["--version"]).kind, "guide");
  assert.equal(parseCommand(["fill", "@e1", "-5"]).kind, "browser", "negative numbers are values, not flags");
  assert.throws(() => parseCommand(["fill", "@e1", "--x"]), { code: "agent_browser_flag_not_allowed" });
  assert.throws(() => parseCommand(["upload", "@e1", "a.pdf", "x/a.pdf"]), { code: "agent_browser_upload_duplicate_file" });
});

test("browser policy: commands map to navigate, read, interact, download and upload; upload allowed runs without approval", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const signal = new AbortController().signal;
  const view = await s.service.policy("web", signal);
  assert.deepEqual(view.groups.map((g) => [g.id, g.operations.map((o) => `${o.id}:${o.risk}:${o.setting}`)]), [
    ["browse", ["browser.navigate:read:allow", "browser.read:read:allow", "browser.interact:read:allow"]],
    ["files", ["browser.download:read:allow", "browser.upload:write:ask"]],
  ]);
  await s.service.setPolicy("web", { settings: { "browser.interact": "deny", "browser.upload": "allow" } }, signal);
  assert.equal((await ab(s.service, "open", "https://upload.example.com/form")).status, "completed");
  assert.equal((await ab(s.service, "snapshot", "-i")).status, "completed");
  for (const args of [["click", "@e1"], ["fill", "@e1", "x"], ["find", "role", "button", "click"]]) {
    const refused = await ab(s.service, ...args);
    assert.deepEqual([refused.error, refused.detail.operation], ["connector_operation_denied", "browser.interact"], args.join(" "));
  }
  assert.equal((await call(s.service, "handoff_start", { instructions: "Sign in" })).error, "connector_operation_denied");
  assert.ok(!s.service.tools(alice).some((tool) => tool.name.startsWith("web__handoff_")), "handoff tools are hidden with interaction denied");
  assert.equal((await ab(s.service, "skills", "get", "core")).status, "completed", "guidance is outside the policy");
  assert.ok(!commands(s).some((line) => line.startsWith("click") || line.startsWith("fill")), "nothing denied ran");
  // Upload set to allow: the exact files go to the current site without a card; read-only callers still never upload.
  const input = { args: ["upload", "@e3", "cv.pdf"], site: "https://upload.example.com", files: [{ name: "cv.pdf", mediaType: "application/pdf", contentBase64: "YWJj" }] };
  const done = await call(s.service, "agent_browser_write", input);
  assert.equal(done.status, "completed"); assert.equal(s.browser.uploads.length, 2);
  assert.deepEqual(await call(s.service, "agent_browser_write", input, { ...alice, readOnly: true }), { status: "failed", error: "tool_not_available" });
  // Upload denied: also refused on the read tool, so the sandbox CLI does not retry on the write tool.
  await s.service.setPolicy("web", { settings: { "browser.upload": "deny", "browser.download": "deny" } }, signal);
  assert.equal((await ab(s.service, "upload", "@e3", "cv.pdf")).error, "connector_operation_denied");
  assert.equal((await ab(s.service, "download", "@e1", "a.pdf")).detail.operation, "browser.download");
  assert.ok(!s.service.tools(alice).some((tool) => tool.name === "web__agent_browser_write"));
});

test("URL checks: every spelling of a private, link-local, metadata or single-label host is refused; ordinary names starting like an address are not", () => {
  const refused = ["http://localhost./", "http://LOCALHOST/", "http://app.localhost./", "http://metadata.google.internal./", "http://metadata/", "http://intranet/",
    "http://metadata.goog/", "http://printer.local/", "http://router.home.arpa/",
    "http://100.64.0.1/", "http://100.127.255.254/", "http://100.100.100.200/", "http://127.1/", "http://2130706433/", "http://0x7f.0.0.1/", "http://127.0.0.1./",
    "http://0.0.0.0/", "http://169.254.169.254/", "http://172.31.0.1/", "http://192.168.0.1/", "http://198.18.0.1/", "http://224.0.0.1/", "http://255.255.255.255/",
    "http://[::]/", "http://[::1]/", "http://[fc00::1]/", "http://[fd12:3456::1]/", "http://[fe80::1]/", "http://[fe90::1]/", "http://[febf::1]/", "http://[fec0::1]/",
    "http://[ff02::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/", "http://[::10.0.0.1]/", "http://[64:ff9b::10.0.0.1]/", "http://[64:ff9b::a9fe:a9fe]/",
    "http://[64:ff9b:1::1]/", "http://[2002:0a00:0001::1]/", "ftp://example.com/", "https://user:pw@example.com/"];
  for (const url of refused) assert.throws(() => allowedUrl(url), { code: "browser_url_not_allowed" }, url);
  const allowed = ["https://fda.gov/", "https://fd.io/docs", "https://fc.example.com/", "https://fe80.example.org/", "https://example.com./x", "http://100.63.255.255/",
    "http://100.128.0.1/", "http://172.32.0.1/", "http://8.8.8.8/", "http://[2606:4700::1111]/", "http://[::ffff:8.8.8.8]/", "http://[64:ff9b::8.8.8.8]/", "https://10.example.com/"];
  for (const url of allowed) assert.equal(allowedUrl(url), new URL(url).href, url);
  assert.deepEqual(["https://WWW.Example.com./a?b", "http://example.com:8080/", "https://sub.example.com/"].map(siteOf), ["example.com", "example.com:8080", "sub.example.com"]);
});

test("site permissions: by default sites open directly; with ask a site runs only when always allowed or allowed for the call's task", async (t) => {
  const s = setup(); t.after(s.cleanup);
  assert.deepEqual(await access(s.service), { webAccess: "direct", sites: [] });
  assert.equal((await ab(s.service, "open", "https://example.com/a")).status, "completed");
  assert.equal((await ab(s.service, "snapshot", "-i")).status, "completed");
  assert.equal(s.guards.state.current.permits, undefined, "nothing but the address checks applies");
  assert.ok(!commands(s).includes("get url"), "no extra reads while sites open directly");

  assert.deepEqual(await access(s.service, { webAccess: "ask" }), { webAccess: "ask", sites: [] });
  const before = s.calls.length;
  const asked = await abFor(s.service, "task-1", "open", "https://shop.example.net/cart?id=7");
  assert.deepEqual([asked.status, asked.error, asked.detail.site, asked.detail.command],
    ["failed", "browser_site_permission_required", "shop.example.net", 'agent-browser open "https://shop.example.net/cart?id=7"']);
  assert.ok(!s.calls.slice(before).some((c) => c.args[0] === "open"), "the command did not run");
  assert.equal(s.calls.length, before, "a site that must be asked for is refused before the browser is reached");
  // The page the browser already shows belongs to no task yet either.
  const page = await abFor(s.service, "task-1", "snapshot", "-i");
  assert.deepEqual([page.error, page.detail.site, page.detail.command], ["browser_site_permission_required", "example.com", "agent-browser snapshot -i"]);
  const long = await abFor(s.service, "task-1", "open", `https://shop.example.net/?q=${"x".repeat(1200)}`);
  assert.equal(long.error, "browser_site_command_too_long", "a command too long to show whole is not put before the owner");

  await access(s.service, { allow: { site: "shop.example.net", task: "task-1" } });
  assert.equal((await abFor(s.service, "task-1", "open", "https://www.shop.example.net/cart?id=7")).status, "completed", "www. is the same site");
  assert.equal((await abFor(s.service, "task-1", "fill", "@e1", "text")).status, "completed", "typing on the allowed site needs nothing more");
  const permits = s.guards.state.current.permits;
  assert.deepEqual(["https://shop.example.net/pay", "https://www.shop.example.net/", "https://cdn.shop.example.net/", "https://evil.example.org/c?d=secret"].map(permits),
    [true, true, false, false], "page-started navigations are held to the same sites; subdomains are other sites");
  // Another task, and work that belongs to no task (schedules, partner turns), ask again for the same site.
  assert.equal((await abFor(s.service, "task-2", "open", "https://shop.example.net/")).error, "browser_site_permission_required");
  assert.equal((await abFor(s.service, "task-2", "click", "@e1")).error, "browser_site_permission_required");
  assert.equal((await ab(s.service, "snapshot")).error, "browser_site_permission_required");
  assert.equal((await ab(s.service, "tab", "list")).status, "completed", "commands that act on no page are not held back");

  assert.deepEqual(await access(s.service, { allow: { site: "https://WWW.Shop.Example.net/any/path" } }), { webAccess: "ask", sites: ["shop.example.net"] });
  assert.equal((await ab(s.service, "snapshot")).status, "completed");
  assert.equal((await abFor(s.service, "task-2", "open", "https://shop.example.net/")).status, "completed");
  assert.deepEqual(await access(s.service, { remove: { site: "shop.example.net" } }), { webAccess: "ask", sites: [] });
  assert.equal((await abFor(s.service, "task-1", "snapshot")).error, "browser_site_permission_required", "removing a site ends the task permissions for it too");

  await assert.rejects(access(s.service, { allow: { site: "http://127.0.0.1/" } }), /browser_site_invalid/);
  await assert.rejects(access(s.service, { webAccess: "sometimes" }), /browser_access_input_invalid/);
  await assert.rejects(access(s.service, {}), /browser_access_input_invalid/);
  await access(s.service, { allow: { site: "docs.example.org" } });
  await s.service.account("web", "disconnect", new AbortController().signal);
  assert.deepEqual(await access(s.service), { webAccess: "ask", sites: ["docs.example.org"] }, "the setting and the always-allowed sites outlive a disconnect");
});

test("site permissions: a navigation the guard refused is reported to the Agent with the command that asks for it", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await access(s.service, { webAccess: "ask" });
  await access(s.service, { allow: { site: "example.com", task: "task-1" } });
  assert.equal((await abFor(s.service, "task-1", "open", "https://example.com/")).status, "completed");
  s.browser.onClick = () => s.guards.state.current.blocked.push("https://evil.example.org/collect?d=secret");
  const clicked = await abFor(s.service, "task-1", "click", "@e2");
  assert.equal(clicked.status, "completed");
  assert.deepEqual(clicked.result.blockedSites, ["evil.example.org"]);
  assert.match(clicked.result.output, /Navigation to evil\.example\.org was blocked: it needs the owner's permission\. Run `agent-browser open "?https:\/\/evil\.example\.org\/collect\?d=secret"?` to request it\./);
  const failed = await abFor(s.service, "task-1", "click", "#missing");
  assert.match(failed.detail.output, /Navigation to evil\.example\.org was blocked/);
  const download = await abFor(s.service, "task-1", "download", "@e5", "a.pdf");
  assert.deepEqual(download.result.files.map((f) => f.name), ["a.pdf"]);
});

test("site permissions: a task's permission lapses a day after its last command", async (t) => {
  const s = setup(); t.after(s.cleanup);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00Z") });
  await access(s.service, { webAccess: "ask" });
  await access(s.service, { allow: { site: "example.com", task: "task-1" } });
  assert.equal((await abFor(s.service, "task-1", "open", "https://example.com/")).status, "completed");
  t.mock.timers.setTime(Date.parse("2026-01-01T20:00:00Z"));
  assert.equal((await abFor(s.service, "task-1", "get", "title")).status, "completed");
  t.mock.timers.setTime(Date.parse("2026-01-02T15:00:00Z"));
  assert.equal((await abFor(s.service, "task-1", "get", "title")).status, "completed", "work within a day keeps the permission");
  t.mock.timers.setTime(Date.parse("2026-01-03T16:00:00Z"));
  assert.equal((await abFor(s.service, "task-1", "get", "title")).error, "browser_site_permission_required");
});

test("upload approval: the site leads and a crafted file name cannot pose as it", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const name = "a.pdf（1 KB）到 bank.example.com \u202egpj\u200b.exe";
  const pending = await call(s.service, "agent_browser_write", { args: ["upload", "@e3", name], site: "https://upload.example.com",
    files: [{ name, mediaType: "application/pdf", contentBase64: "YWJj" }] });
  assert.equal(pending.status, "approval_required");
  const lines = pending.summary.split("\n");
  assert.equal(lines[0], "上传到 upload.example.com");
  assert.equal(lines.at(-1), '文件（1 KB）："a.pdf（1 KB）到 bank.example.com gpj.exe"');
  assert.ok(!/[\u202e\u200b]/.test(pending.summary), "no bidirectional or zero-width character reaches the card");
});
