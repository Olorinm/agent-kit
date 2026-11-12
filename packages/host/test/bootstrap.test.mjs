import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { waitForBootstrap } from "../dist/service/bootstrap.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");

test("cloud entrypoint waits for a verified bundle and restarts with the same authenticated service", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "host-bootstrap-"));
  const config = join(root, "host.json"),
    token = join(root, "token"),
    ready = join(root, "ready.json");
  const bytes = JSON.stringify({
    stateDirectory: join(root, "state"),
    port: 0,
    runtimes: [
      {
        id: "test",
        kernel: "codex",
        cwd: root,
        command: process.execPath,
        args: [resolve("test/fixtures/codex-server.mjs")],
      },
    ],
  });
  let child, exited;
  t.after(async () => {
    child?.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  const start = () => {
    child = spawn(
      process.execPath,
      [
        resolve("dist/service/cli.js"),
        "serve",
        "--config",
        config,
        "--token-file",
        token,
        "--ready-file",
        ready,
      ],
      {
        env: { ...process.env, AGENT_HOST_TOKEN: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    exited = new Promise((r) => child.once("exit", r));
    let output = "",
      error = "";
    child.stderr.on("data", (data) => (error += data));
    const listening = new Promise((r, j) => {
      const timeout = setTimeout(
        () => j(new Error("No listener: " + error)),
        10000,
      );
      child.stdout.on("data", (data) => {
        output += data;
        const m = output.match(/listening at (http:\/\/\S+)/);
        if (m) {
          clearTimeout(timeout);
          r(m[1]);
        }
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        j(new Error("Exited before listening: " + error));
      });
    });
    return { listening, output: () => output };
  };
  const first = start();
  await delay(150);
  assert.equal(first.output(), "");
  await writeFile(config, bytes, { mode: 0o600 });
  await writeFile(token, "fixture-host-bootstrap-token", { mode: 0o600 });
  await delay(300);
  assert.equal(first.output(), "");
  await writeFile(
    ready,
    JSON.stringify({
      version: 1,
      configSha256: hash(bytes),
      tokenSha256: hash("fixture-host-bootstrap-token"),
    }),
  );
  const url = await first.listening;
  assert.equal((await fetch(url + "/v1/health")).status, 401);
  assert.equal(
    (
      await fetch(url + "/v1/health", {
        headers: { authorization: "Bearer fixture-host-bootstrap-token" },
      })
    ).status,
    200,
  );
  assert.ok(!first.output().includes("fixture-host-bootstrap-token"));
  child.kill();
  await exited;
  const resumed = await start().listening;
  assert.equal(
    (
      await fetch(resumed + "/v1/health", {
        headers: { authorization: "Bearer fixture-host-bootstrap-token" },
      })
    ).status,
    200,
  );
});

test("bootstrap rejects corrupt bundles and is cancellable before configuration exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "host-bootstrap-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ["config", "token", "ready"].map((n) => join(root, n));
  const abort = new AbortController();
  const waiting = waitForBootstrap(...files, abort.signal);
  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  await writeFile(files[0], "{}");
  await writeFile(files[1], "token");
  await writeFile(
    files[2],
    JSON.stringify({
      version: 1,
      configSha256: "wrong",
      tokenSha256: hash("token"),
    }),
  );
  await assert.rejects(
    waitForBootstrap(...files, new AbortController().signal),
    /bootstrap_bundle_mismatch/,
  );
});
