// Opt-in, uses the owner's local Codex installation/authentication. Never run in CI.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { chromium, expect } from "@playwright/test";
import {
  startAgentHostServer,
  createNativeRuntime,
} from "../dist/service/index.js";
import { startEditor } from "../examples/http-editor/server.mjs";
await import("../examples/react-editor/build.mjs");
await mkdir(".local", { recursive: true });
const directory = await mkdtemp(resolve(".local/ui-native-"));
const token = randomUUID();
const host = await startAgentHostServer({
  stateDirectory: join(directory, "state"),
  token,
  runtimes: [
    createNativeRuntime(
      {
        id: "codex",
        kernel: "codex",
        cwd: directory,
        options: {
          command:
            process.env.AGENT_HOST_CODEX ?? resolve("node_modules/.bin/codex"),
          args: ["app-server"],
        },
        thread: { sandbox: "read-only", approvalPolicy: "on-request" },
      },
      directory,
    ),
  ],
});
const editor = await startEditor({
  hostUrl: host.url,
  token,
  directory: join(directory, "document"),
  port: 0,
  assetsDirectory: resolve("examples/react-editor/dist"),
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(editor.url);
  await page
    .getByRole("textbox", { name: "Ask the agent", exact: true })
    .fill("Reply exactly UI_NATIVE_OK. Do not call tools or change any files.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.locator("article.role-assistant .thread-text-block").last(),
  ).toContainText("UI_NATIVE_OK", { timeout: 120000 });
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeVisible({ timeout: 120000 });
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: join(directory, "native-editor.png"),
    fullPage: true,
  });
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(
      { kernel: "codex", passed: true, checkedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log("Live Codex -> HTTP -> React editor passed:", directory);
} finally {
  await browser.close();
  await editor.close();
  await host.close();
}
