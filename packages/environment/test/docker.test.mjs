import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createDockerProvider } from "../dist/index.js";

// A stand-in for the docker CLI. It keeps containers in a JSON file and runs
// `exec` commands on this machine, so streams and file bytes are real.
const fake = `#!/usr/bin/env node
const fs = require("node:fs"), { spawn } = require("node:child_process"), path = require("node:path");
const dir = path.dirname(process.argv[1]), file = path.join(dir, "state.json");
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { containers: {}, images: [], port: 40000 };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
const valued = ["--name", "--label", "--publish", "--env", "--filter", "--type", "--tag", "--workdir"];
const command = args.shift(), options = {}, rest = [];
while (args.length) {
  const arg = args.shift();
  if (rest.length || !arg.startsWith("--")) { rest.push(arg); if (command !== "inspect") { rest.push(...args.splice(0)); } }
  else if (valued.includes(arg)) (options[arg] ??= []).push(args.shift());
  else options[arg] = true;
}
const pairs = list => Object.fromEntries((list ?? []).map(x => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]));
const fail = message => { process.stderr.write("Error response from daemon: " + message + "\\n"); process.exit(1); };
const inspect = c => ({ Name: "/" + c.name, State: { Status: c.status }, Config: { Labels: c.labels },
  NetworkSettings: { Ports: Object.fromEntries(c.ports.map(p => [p + "/tcp", c.status === "running" ? [{ HostIp: "127.0.0.1", HostPort: String(c.host[p]) }] : null])) } });
if (command === "image") process.exit(state.images.includes(rest[1]) ? 0 : 1);
else if (command === "build") { state.images.push(options["--tag"][0]); state.dockerfile = fs.readFileSync(0, "utf8"); save(); }
else if (command === "create") {
  const name = options["--name"][0];
  state.containers[name] = { name, status: "created", labels: pairs(options["--label"]), env: pairs(options["--env"]),
    ports: (options["--publish"] ?? []).map(x => Number(x.split(":").at(-1))), host: {}, image: rest[0], command: rest.slice(1), init: options["--init"] === true };
  save();
} else if (command === "start" || command === "stop") {
  const c = state.containers[rest[0]]; if (!c) fail("No such container: " + rest[0]);
  c.status = command === "start" ? "running" : "exited";
  if (command === "start") for (const p of c.ports) c.host[p] = state.port++;
  save();
} else if (command === "rm") {
  if (!state.containers[rest[0]]) fail("No such container: " + rest[0]);
  delete state.containers[rest[0]]; save();
} else if (command === "ps") {
  const wanted = Object.entries(pairs((options["--filter"] ?? []).map(x => x.slice("label=".length))));
  for (const c of Object.values(state.containers)) if (wanted.every(([k, v]) => c.labels[k] === v)) console.log(c.name);
} else if (command === "inspect") {
  const found = rest.map(name => state.containers[name] ?? fail("No such container: " + name));
  console.log(JSON.stringify(found.map(inspect)));
} else if (command === "exec") {
  const c = state.containers[rest[0]], env = pairs(options["--env"]);
  if (c?.status !== "running") fail("container " + rest[0] + " is not running");
  if (rest[1] === "sh" && rest[2] === "-c" && rest[3].includes("/proc/")) {
    try { process.kill(Number(fs.readFileSync(path.join(dir, "pid-" + rest[5]), "utf8")), "SIGKILL"); } catch {}
  } else {
    const child = spawn(rest[1], rest.slice(2), { cwd: options["--workdir"]?.[0], env: { ...process.env, ...c.env, ...env }, stdio: "inherit" });
    if (env.AGENT_ENVIRONMENT_EXEC) fs.writeFileSync(path.join(dir, "pid-" + env.AGENT_ENVIRONMENT_EXEC), String(child.pid));
    child.once("close", (code, signal) => process.exit(signal ? 137 : code));
  }
} else fail("unknown command " + command);
`;
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "agent-environment-docker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dockerPath = join(dir, "docker");
  await writeFile(dockerPath, fake, { mode: 0o755 });
  const lines = async name => (await readFile(join(dir, name), "utf8")).trim().split("\n").map(x => JSON.parse(x));
  return {
    dir, dockerPath, provider: createDockerProvider({ id: "local", dockerPath, ...options }),
    calls: async command => (await lines("calls.jsonl")).filter(x => x[0] === command),
    state: async () => JSON.parse(await readFile(join(dir, "state.json"), "utf8")),
    patch: async change => { const file = join(dir, "state.json"), state = JSON.parse(await readFile(file, "utf8")); change(state); await writeFile(file, JSON.stringify(state)); },
  };
}
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const skip = process.platform === "win32" && "the stand-in docker is a POSIX script";

test("create builds the template once and passes labels, ports, environment and the start-script entrypoint", { skip }, async t => {
  const f = await fixture(t, { ports: [37420, 2222] });
  const ref = await f.provider.create({
    template: "node24", timeoutSeconds: 600, onTimeout: "pause", env: { KEY: "a=b c" }, metadata: { owner: "one", note: "x y" },
    modelServices: ["openai"], modelAccounts: { openai: ["account"] },
  });
  await f.provider.create({ template: "node24" });
  assert.equal(ref.provider, "local");
  const state = await f.state(), [create] = await f.calls("create"), image = state.images[0];
  assert.match(image, /^agent-environment-node24:[a-f0-9]{12}$/);
  assert.match(state.dockerfile, /^FROM node:24-trixie-slim\n/);
  assert.equal((await f.calls("build")).length, 1);
  assert.deepEqual(create, ["create", "--name", `agent-environment-local-${ref.id}`, "--init",
    "--label", "agent-environment.provider=local", "--label", `agent-environment.id=${ref.id}`, "--label", "agent-environment.template=node24",
    "--label", "agent-environment.metadata.owner=one", "--label", "agent-environment.metadata.note=x y",
    "--publish", "127.0.0.1::37420", "--publish", "127.0.0.1::2222", "--env", "KEY=a=b c", image,
    "sh", "-c", "while [ ! -f /opt/agent-environment/start.sh ]; do sleep 1; done; exec sh /opt/agent-environment/start.sh"]);
  assert.deepEqual(await f.provider.info(ref.id), { provider: "local", id: ref.id, state: "running", template: "node24", metadata: { owner: "one", note: "x y" } });
});
test("create refuses unknown templates, invalid lifetimes and anything beyond the environment limit", { skip }, async t => {
  const f = await fixture(t, { maxEnvironments: 1 });
  await assert.rejects(f.provider.create({ template: "other" }), { code: "invalid_create" });
  await assert.rejects(f.provider.create({ template: "node24", timeoutSeconds: 10 }), { code: "invalid_create" });
  await assert.rejects(f.provider.create({ template: "node24", metadata: { "a=b": "x" } }), { code: "invalid_create" });
  const [first, second] = await Promise.allSettled([f.provider.create({ template: "node24" }), f.provider.create({ template: "node24" })]);
  assert.equal(first.status, "fulfilled"); assert.equal(second.reason.code, "trial_capacity_reached");
  await f.provider.pause(first.value.id);
  await assert.rejects(f.provider.create({ template: "node24" }), { code: "trial_capacity_reached" });
  await f.provider.destroy(first.value.id);
  await f.provider.create({ template: "node24" });
  assert.throws(() => createDockerProvider({ id: "has space" }), { code: "invalid_argument" });
  assert.throws(() => createDockerProvider({ id: "local", ports: [0] }), { code: "invalid_argument" });
});
test("list filters by metadata labels and by provider; container states map to environment states", { skip }, async t => {
  const f = await fixture(t), other = createDockerProvider({ id: "other", dockerPath: f.dockerPath });
  const one = await f.provider.create({ template: "node24", metadata: { owner: "one", kind: "a" } });
  const two = await f.provider.create({ template: "node24", metadata: { owner: "two", kind: "a" } });
  const foreign = await other.create({ template: "node24", metadata: { owner: "one" } });
  assert.deepEqual((await f.provider.list()).map(x => x.id).sort(), [one.id, two.id].sort());
  assert.deepEqual((await f.provider.list({ owner: "one" })).map(x => x.id), [one.id]);
  assert.equal((await f.provider.list({ kind: "a" })).length, 2);
  assert.deepEqual(await f.provider.list({ owner: "one", kind: "b" }), []);
  assert.ok((await f.calls("ps")).some(x => x.includes("label=agent-environment.metadata.owner=one")));
  assert.equal((await f.provider.info(foreign.id)).state, "missing");
  await f.provider.pause(one.id); await f.provider.pause(one.id);
  assert.equal((await f.provider.info(one.id)).state, "paused");
  assert.equal((await f.calls("stop")).length, 1);
  assert.equal((await f.provider.resume(one.id)).state, "running");
  assert.equal((await f.provider.resume(one.id, 900, { modelServices: ["anthropic"] })).state, "running");
  assert.equal((await f.calls("start")).length, 4);
  await f.patch(state => { state.containers[`agent-environment-local-${two.id}`].status = "created"; });
  assert.equal((await f.provider.info(two.id)).state, "unknown");
  await assert.rejects(f.provider.resume(two.id), { code: "resume_requires_paused" });
  await assert.rejects(f.provider.pause(two.id), { code: "environment_not_running" });
  await f.provider.setTimeout(one.id, 600);
  await assert.rejects(f.provider.setTimeout(one.id, 1), { code: "invalid_lifetime" });
  await f.provider.destroy(two.id); await f.provider.destroy(two.id);
  assert.deepEqual(await f.provider.info(two.id), { provider: "local", id: two.id, state: "missing", metadata: {} });
  await assert.rejects(f.provider.resume(two.id), { code: "environment_missing" });
  await assert.rejects(f.provider.setTimeout(two.id, 600), { code: "environment_missing" });
  await assert.rejects(f.provider.info("not-an-id"), { code: "invalid_id" });
  assert.equal(f.provider.capabilities.automaticPause, false);
});
test("exec streams separate output with split UTF-8, working directory, environment and exit status", { skip }, async t => {
  const f = await fixture(t), { id } = await f.provider.create({ template: "node24", env: { FROM_CREATE: "created" } });
  const script = `const b=Buffer.from("\\uFEFF中文");process.stdout.write(b.subarray(0,2));
setTimeout(()=>{process.stdout.write(b.subarray(2));process.stderr.write(process.cwd()+"|"+process.env.FROM_CREATE+"|"+process.env.EXTRA);process.exitCode=7;},100);`;
  let out = "", err = "", exit;
  for await (const chunk of f.provider.exec(id, [process.execPath, "-e", script], { cwd: resolve(f.dir), env: { EXTRA: "a=b" }, onExit: e => exit = e.exitCode }))
    if (chunk.stream === "stdout") out += chunk.text; else err += chunk.text;
  assert.equal(out, "\uFEFF中文"); assert.match(err, /\|created\|a=b$/); assert.equal(exit, 7);
  assert.equal(f.provider.hasUncertainExecution(id), false);
  await assert.rejects(collect(f.provider.exec(id, [])), { code: "invalid_argv" });
  await assert.rejects(collect(f.provider.exec(id, ["true"], { timeoutSeconds: -1 })), { code: "invalid_exec_timeout" });
  await assert.rejects(collect(f.provider.exec(id, ["true"], { signal: AbortSignal.abort() })), { code: "execution_aborted" });
  await f.provider.pause(id);
  await assert.rejects(collect(f.provider.exec(id, ["true"])), { code: "environment_not_running" });
  assert.equal(f.provider.hasUncertainExecution(id), false);
});
test("a timed out or cancelled command is stopped, uncertain, and blocks pause until reconciled", { skip }, async t => {
  const f = await fixture(t), { id } = await f.provider.create({ template: "node24" });
  const forever = [process.execPath, "-e", "console.log(process.pid);setInterval(()=>{},1000)"];
  const gone = async pid => { for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { return true; } await sleep(100); } return false; };
  let pid = "";
  await assert.rejects(async () => { for await (const chunk of f.provider.exec(id, forever, { timeoutSeconds: 1, onExit: () => assert.fail("no exit") })) pid += chunk.text; },
    { code: "execution_uncertain", outcomeUnknown: true });
  assert.equal(await gone(Number(pid)), true);
  assert.equal(f.provider.hasUncertainExecution(id), true);
  await assert.rejects(f.provider.pause(id), { code: "execution_uncertain" });
  f.provider.resetExecutionUncertainty(id);
  const abort = new AbortController(); pid = "";
  await assert.rejects(async () => { for await (const chunk of f.provider.exec(id, forever, { timeoutSeconds: 0, signal: abort.signal })) { pid += chunk.text; abort.abort(); } },
    { code: "execution_uncertain" });
  assert.equal(await gone(Number(pid)), true);
  f.provider.resetExecutionUncertainty(id);
  const running = f.provider.exec(id, forever, { timeoutSeconds: 0 })[Symbol.asyncIterator]();
  pid = (await running.next()).value.text;
  await assert.rejects(f.provider.pause(id), { code: "environment_busy" });
  await assert.rejects(f.provider.destroy(id), { code: "environment_busy" });
  await running.return();
  assert.equal(await gone(Number(pid)), true);
  assert.equal(f.provider.hasUncertainExecution(id), true);
  await f.provider.destroy(id);
  assert.equal(f.provider.hasUncertainExecution(id), false);
});
test("files keep exact bytes and the gateway's error codes", { skip }, async t => {
  const f = await fixture(t), { id } = await f.provider.create({ template: "node24" });
  const data = Uint8Array.from([0, 255, 128, 42, 10]), path = join(f.dir, "files/中文/a.bin");
  await f.provider.writeFile(id, path, data);
  assert.deepEqual(await f.provider.readFile(id, path), data);
  await f.provider.writeFile(id, join(f.dir, "files/b.txt"), "text");
  const listed = await f.provider.listFiles(id, join(f.dir, "files"));
  assert.deepEqual(listed.map(x => [x.path, x.size]).sort(), [[join(f.dir, "files/b.txt"), 4], [path, 5]].sort());
  await f.provider.removeFile(id, path);
  await assert.rejects(f.provider.readFile(id, path), { code: "file_not_found", outcomeUnknown: false });
  assert.deepEqual(await f.provider.listFiles(id, join(f.dir, "absent"), true), []);
  await assert.rejects(f.provider.listFiles(id, join(f.dir, "absent")), { code: "file_not_found" });
  await assert.rejects(f.provider.writeFile(id, "relative", "x"), { code: "invalid_path" });
  await assert.rejects(f.provider.writeFile(id, path, new Uint8Array(16 * 1024 * 1024 + 1)), { code: "file_too_large" });
  const [call] = await f.calls("exec");
  assert.deepEqual([call.slice(0, 5), call[6]], [["exec", "--interactive", `agent-environment-local-${id}`, "node", "-e"], "write"]);
});
test("httpEndpoint returns the published loopback address of a running environment", { skip }, async t => {
  const f = await fixture(t), { id } = await f.provider.create({ template: "node24" });
  const first = await f.provider.httpEndpoint(id, 37420);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/); assert.deepEqual(first.headers, {});
  await assert.rejects(f.provider.httpEndpoint(id, 8080), { code: "port_not_published" });
  await assert.rejects(f.provider.httpEndpoint(id, 0), { code: "invalid_port" });
  await f.provider.pause(id);
  await assert.rejects(f.provider.httpEndpoint(id, 37420), { code: "environment_not_running" });
  await f.provider.resume(id);
  assert.notEqual((await f.provider.httpEndpoint(id, 37420)).url, first.url);
});
test("a docker entry needs no key file and works through the CLI; a missing docker command is reported", { skip }, async t => {
  const f = await fixture(t), config = join(f.dir, "providers.json"), cli = resolve(import.meta.dirname, "../dist/cli.js");
  await writeFile(config, JSON.stringify({ providers: [{ id: "local", kind: "docker", dockerPath: f.dockerPath, maxEnvironments: 1, ports: [8080] }] }));
  const invoke = args => new Promise((done, reject) => {
    const p = spawn(process.execPath, [cli, args[0], "--config", config, "--provider", "local", ...args.slice(1)]); let stdout = "", stderr = "";
    p.stdout.on("data", c => stdout += c); p.stderr.on("data", c => stderr += c); p.once("error", reject);
    p.once("close", code => done({ code, stdout, stderr }));
  });
  assert.deepEqual(JSON.parse((await invoke(["capabilities"])).stdout), { automaticPause: false, pause: true, processMemoryResume: false, persistence: "provider-template" });
  const { id } = JSON.parse((await invoke(["create", "--template", "node24"])).stdout);
  assert.equal(JSON.parse((await invoke(["create", "--template", "node24"])).stderr).error, "trial_capacity_reached");
  const run = await invoke(["exec", "--id", id, "--", process.execPath, "-e", "console.log('out');process.exit(3)"]);
  assert.deepEqual([run.code, run.stdout], [3, "out\n"]);
  assert.deepEqual((await f.state()).containers[`agent-environment-local-${id}`].ports, [8080]);
  const absent = createDockerProvider({ id: "local", dockerPath: join(f.dir, "absent") });
  await assert.rejects(absent.list(), { code: "docker_unavailable" });
});
