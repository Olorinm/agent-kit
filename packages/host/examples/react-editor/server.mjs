import { startEditor } from "../http-editor/server.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const token =
  process.env.AGENT_HOST_TOKEN ??
  (
    await readFile(
      process.env.AGENT_HOST_TOKEN_FILE ?? ".local/host/token",
      "utf8",
    )
  ).trim();
const editor = await startEditor({
  token,
  hostUrl: process.env.AGENT_HOST_URL,
  directory: process.env.EDITOR_DIRECTORY,
  port: Number(process.env.EDITOR_PORT ?? 37431),
  assetsDirectory: fileURLToPath(new URL("./dist/", import.meta.url)),
});
console.log("React editor:", editor.url);
process.once("SIGINT", () => void editor.close());
process.once("SIGTERM", () => void editor.close());
