import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = fs.readFileSync(new URL("../examples/start-host.sh", import.meta.url), "utf8");
/** The body of a quoted here-document in the start script, as the shell would write it. */
function embedded(delimiter) {
  const match = new RegExp(`<<'${delimiter}'\\n([\\s\\S]*?\\n)${delimiter}\\n`).exec(script);
  assert.ok(match, `${delimiter} here-document`);
  return match[1];
}
/** The CLI's launcher as the start script writes it, with the CLI and Chromium of this machine in place of the environment's. */
function command(t, cli, chromium) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "start-host-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "agent-browser");
  const body = embedded("LAUNCHER")
    .replace("exec /opt/local-browser/node_modules/agent-browser/bin/agent-browser ", `exec '${cli}' `)
    .replace("AGENT_BROWSER_EXECUTABLE_PATH=/usr/lib/chromium/chromium-headless-shell\n", `AGENT_BROWSER_EXECUTABLE_PATH='${chromium}'\n`);
  assert.ok(body.includes(`exec '${cli}' "$@"\n`) && body.includes(`AGENT_BROWSER_EXECUTABLE_PATH='${chromium}'\n`));
  fs.writeFileSync(file, body, { mode: 0o755 });
  // A home of its own: the CLI keeps its daemon socket in ~/.agent-browser.
  const env = { ...process.env, HOME: directory };
  delete env.AGENT_BROWSER_ARGS; delete env.XDG_RUNTIME_DIR;
  const run = (args, extra = {}) => spawnSync("sh", [file, ...args], { cwd: directory, encoding: "utf8", env: { ...env, ...extra } });
  /** Without blocking this process, which serves the page under test. */
  const start = (args) => new Promise(resolve => {
    const child = spawn("sh", [file, ...args], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("exit", status => resolve({ status, stdout, stderr }));
  });
  return { directory, run, start };
}

test("the start script installs the browser and the pinned CLI without holding Host back", () => {
  assert.equal(spawnSync("sh", ["-n", new URL("../examples/start-host.sh", import.meta.url).pathname]).status, 0);
  const install = script.indexOf("chromium-headless-shell fonts-liberation fonts-noto-cjk fonts-noto-color-emoji");
  // In a background subshell, between the Host installation and the wait for Mau's readiness manifest.
  assert.ok(install > script.indexOf('touch "$base/host-installed"') && install < script.indexOf('touch "$base/local-browser-installed"\n  ) &\n'));
  assert.ok(script.indexOf('touch "$base/local-browser-installed"\n  ) &\n') < script.indexOf('while [ ! -f "$host_dir/ready.json" ]'));
  // One agent-browser version for the remote browser and this one.
  const connectors = JSON.parse(fs.readFileSync(new URL("../../../connectors/package.json", import.meta.url), "utf8"));
  assert.ok(script.includes(`npm install --prefix /opt/local-browser --ignore-scripts --no-audit --no-fund agent-browser@${connectors.dependencies["agent-browser"]}\n`));
  // /usr/local/bin/agent-browser is Mau's client of the remote browser; nothing here goes on the Agent's PATH.
  assert.doesNotMatch(script.replace(/^\s*#.*$/gm, ""), /\/usr\/local\/bin/);
});

test("the launcher hands its arguments to the CLI with the environment's Chromium and container flags", t => {
  const stub = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "start-host-stub-")), "cli");
  t.after(() => fs.rmSync(path.dirname(stub), { recursive: true, force: true }));
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$AGENT_BROWSER_EXECUTABLE_PATH" "$AGENT_BROWSER_NO_VERSION_CHECK" "$#" "$@"\nprintf '%s' "$AGENT_BROWSER_ARGS"\n`, { mode: 0o755 });
  const { run } = command(t, stub, "/a/chromium");
  const passed = run(["fill", "#name", "two words", "--json"]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, "/a/chromium\n1\n4\nfill\n#name\ntwo words\n--json\n--no-sandbox\n--disable-dev-shm-usage");
  assert.ok(run(["open", "x"], { AGENT_BROWSER_ARGS: "--lang=zh-CN" }).stdout.endsWith("--no-sandbox\n--disable-dev-shm-usage\n--lang=zh-CN"));
});

// With the CLI's binary for this machine and a Chromium at hand:
// LOCAL_BROWSER_TEST_CLI=/path/to/agent-browser-<platform> LOCAL_BROWSER_TEST_CHROMIUM=/path/to/chromium-headless-shell npm test
const cli = process.env.LOCAL_BROWSER_TEST_CLI, chromium = process.env.LOCAL_BROWSER_TEST_CHROMIUM;
test("the launcher opens a local page, fills and clicks by ref, and takes a screenshot", { skip: !(cli && chromium) && "LOCAL_BROWSER_TEST_CLI and LOCAL_BROWSER_TEST_CHROMIUM are not set" }, async t => {
  const page = `<!doctype html><meta charset="utf-8"><title>验收</title><h1>你好</h1><form><input id="name" aria-label="Name" value="old"><button>Go</button></form>
<script>document.forms[0].onsubmit = e => { e.preventDefault(); const p = document.createElement("p"); p.className = "result"; p.textContent = "got " + document.getElementById("name").value; document.body.append(p); };</script>`;
  const server = http.createServer((request, response) => request.url === "/" ? response.end(page) : response.writeHead(404).end());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { directory, start } = command(t, cli, chromium);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const ok = async (...args) => { const result = await start(args); assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}${result.stdout}`); return result.stdout; };
  // The CLI leaves a daemon with the browser; close it while the command's directory is still there.
  try {
    assert.match(await ok("open", `http://localhost:${server.address().port}/`), /验收/);
    const snapshot = await ok("snapshot", "-i");
    const textbox = /textbox "Name" \[ref=(e\d+)\]/.exec(snapshot)?.[1], button = /button "Go" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
    assert.ok(textbox && button, snapshot);
    await ok("fill", `@${textbox}`, "伙伴");
    await ok("click", `@${button}`);
    await ok("wait", ".result");
    assert.equal(await ok("get", "text", ".result"), "got 伙伴\n");
    await ok("screenshot", "page.png");
    assert.deepEqual([...fs.readFileSync(path.join(directory, "page.png")).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally { await start(["close"]); }
});
