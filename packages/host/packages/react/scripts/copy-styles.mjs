import { copyFile } from "node:fs/promises";
for (const name of ["styles", "thread", "disclosure", "cards"])
  await copyFile(
    new URL(`../src/${name}.css`, import.meta.url),
    new URL(`../dist/${name}.css`, import.meta.url),
  );
