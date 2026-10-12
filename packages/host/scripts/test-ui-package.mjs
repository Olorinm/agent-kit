import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { chromium, expect } from "@playwright/test";
import { checkUiBrowser } from "./test-ui-browser.mjs";

const root = process.cwd();
await mkdir(".local", { recursive: true });
const consumer = await mkdtemp(resolve(".local/ui-consumer-"));
let host, editor, browser;
try {
  function npm(args, cwd = root) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  }
  const coreManifest = JSON.parse(await readFile("package.json", "utf8"));
  const uiManifest = JSON.parse(
    await readFile("packages/react/package.json", "utf8"),
  );
  assert.equal(coreManifest.dependencies.react, undefined);
  assert.equal(coreManifest.dependencies["@olorinm/agent-ui"], undefined);
  assert.equal(uiManifest.dependencies["@olorinm/agent-host"], undefined);
  npm([
    "pack",
    "--workspace",
    "@olorinm/agent-ui",
    "--pack-destination",
    consumer,
    "--silent",
  ]);
  npm(["pack", "--pack-destination", consumer, "--silent"]);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "./olorinm-agent-ui-" + uiManifest.version + ".tgz",
      "./olorinm-agent-host-" + coreManifest.version + ".tgz",
      "react@19.3.0",
      "react-dom@19.3.0",
      "@types/react@19.3.0",
      "@types/react-dom@19.3.0",
      "esbuild@0.28.2",
    ],
    consumer,
  );
  const require = createRequire(join(consumer, "package.json"));
  const installedUi = JSON.parse(
    await readFile(
      join(consumer, "node_modules/@olorinm/agent-ui/package.json"),
      "utf8",
    ),
  );
  for (const entry of Object.values(installedUi.exports)) {
    const path = typeof entry === "string" ? entry : entry.import;
    await readFile(join(consumer, "node_modules/@olorinm/agent-ui", path));
    if (typeof entry !== "string")
      await readFile(
        join(consumer, "node_modules/@olorinm/agent-ui", entry.types),
      );
  }
  await writeFile(
    join(consumer, "contract.ts"),
    `
import type { InteractionHandler, Interaction, InteractionAnswer } from "@olorinm/agent-host/interactions";
import {useAgentInteractions, createRunView, appendRunEvent} from "@olorinm/agent-ui/agent-host";
import type {HostInteraction, HostInteractionAnswer} from "@olorinm/agent-ui/agent-host";
import type {EventPage} from "@olorinm/agent-host/client";
declare const handler: ReturnType<typeof useAgentInteractions>["onInteraction"];
const assignHandler: InteractionHandler = handler;
declare const request: Interaction;
const assignRequest: HostInteraction = request;
declare const answer: HostInteractionAnswer;
const assignAnswer: InteractionAnswer = answer;
declare const page: EventPage;
for(const item of page.events) appendRunEvent(createRunView(item.event.runId), item);
void [assignHandler,assignRequest,assignAnswer];
`,
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "--jsx",
      "react-jsx",
      join(consumer, "contract.ts"),
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const { build } = require("esbuild");
  await cp(
    "packages/react/test/browser-fixture.tsx",
    join(consumer, "fixture.tsx"),
  );
  await build({
    entryPoints: [join(consumer, "fixture.tsx")],
    outfile: join(consumer, "fixture.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    metafile: true,
  }).then((result) => {
    assert.ok(
      Object.keys(result.metafile.inputs).some((path) =>
        path.includes("node_modules/@olorinm/agent-ui/dist"),
      ),
    );
    assert.ok(
      Object.keys(result.metafile.inputs).every(
        (path) =>
          !path.includes("web/src/") && !path.includes("packages/react/src"),
      ),
    );
  });
  await writeFile(
    join(consumer, "fixture.html"),
    '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./fixture.css"><div id="root"></div><script src="./fixture.js"></script>',
  );
  await cp("examples/react-editor", join(consumer, "examples/react-editor"), {
    recursive: true,
    filter: (path) => !["dist", "node_modules"].includes(basename(path)),
  });
  await cp("examples/http-editor", join(consumer, "examples/http-editor"), {
    recursive: true,
    filter: (path) => basename(path) !== "node_modules",
  });
  await import(
    pathToFileURL(join(consumer, "examples/react-editor/build.mjs"))
  );
  await writeFile(
    join(consumer, "server-import.mjs"),
    'export {startAgentHostServer,createNativeRuntime} from "@olorinm/agent-host/server";',
  );
  const { startAgentHostServer, createNativeRuntime } = await import(
    pathToFileURL(join(consumer, "server-import.mjs"))
  );
  const { startEditor } = await import(
    pathToFileURL(join(consumer, "examples/http-editor/server.mjs"))
  );
  const workspace = join(consumer, "workspace");
  await mkdir(workspace);
  const token = "ui-contract-test-owner-token";
  host = await startAgentHostServer({
    stateDirectory: join(consumer, "state"),
    token,
    runtimes: [
      createNativeRuntime(
        {
          id: "codex-fixture",
          kernel: "codex",
          cwd: workspace,
          options: {
            command: process.execPath,
            args: [resolve("test/fixtures/codex-server.mjs")],
          },
        },
        workspace,
      ),
    ],
  });
  editor = await startEditor({
    hostUrl: host.url,
    token,
    directory: workspace,
    port: 0,
    assetsDirectory: join(consumer, "examples/react-editor/dist"),
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(join(consumer, "fixture.html")).href);
  await checkUiBrowser(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const browserAuth = [];
  page.on("request", (request) => {
    if (request.headers().authorization) browserAuth.push(request.url());
  });
  await page.goto(editor.url);
  await expect(
    page.getByRole("heading", { name: "Document editor", exact: true }),
  ).toBeVisible();
  const input = page.getByRole("textbox", {
    name: "Ask the agent",
    exact: true,
  });
  const send = async (text) => {
    await input.fill(text);
    await page.getByRole("button", { name: "Send message" }).click();
  };
  const done = async () => {
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeVisible({ timeout: 15000 });
  };
  await send("hello");
  await done();
  await expect(
    page.locator(".role-assistant .thread-text-block").last(),
  ).toContainText("hello");
  await send("approval");
  await page
    .getByRole("button", { name: "Allow for session", exact: true })
    .click();
  await done();
  await expect(
    page.locator(".role-assistant .thread-text-block").last(),
  ).toContainText("acceptForSession");
  await send("question");
  await page.getByRole("button", { name: "1. Blue Blue" }).click();
  await done();
  await expect(
    page.locator(".role-assistant .thread-text-block").last(),
  ).toContainText("Blue");
  await send("tool");
  await page.getByRole("button", { name: "Apply edit", exact: true }).click();
  await done();
  await expect(page.getByTestId("document")).toHaveText("Updated by Agent");
  await send("tool");
  await page
    .getByRole("button", { name: "Keep original", exact: true })
    .click();
  await done();
  await expect(page.getByTestId("document")).toHaveText("Updated by Agent");
  await send("wait");
  await page.getByRole("button", { name: "Stop running" }).click();
  await done();
  await page.getByLabel("Attach files").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment fixture"),
  });
  await page.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(
    page.getByRole("button", { name: "Remove notes.txt" }),
  ).toHaveCount(0);
  await page.getByLabel("Attach files").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment fixture"),
  });
  await send("Use my attachment");
  await done();
  await expect(page.locator("article.role-user").last()).toContainText(
    "notes.txt",
  );
  await page.screenshot({
    path: join(consumer, "editor-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Switch theme" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(consumer, "editor-mobile-dark.png"),
    fullPage: true,
  });
  assert.deepEqual(
    browserAuth,
    [],
    "owner token must never enter browser requests",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Independent UI archive, native contract types, browser controls and HTTP editor passed:",
    consumer,
  );
} finally {
  await browser?.close();
  await editor?.close();
  await host?.close();
  // Retain screenshots/archives, not a fresh dependency tree after every run.
  await rm(join(consumer, "node_modules"), { recursive: true, force: true });
}
