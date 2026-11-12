import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(new URL("./dist/", import.meta.url));
await mkdir(directory, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("./app.jsx", import.meta.url))],
  outfile: directory + "/app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: false,
});
await copyFile(
  new URL("./index.html", import.meta.url),
  directory + "/index.html",
);
