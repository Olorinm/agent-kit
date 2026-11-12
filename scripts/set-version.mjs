#!/usr/bin/env node
// Every package shares one version. Usage: node scripts/set-version.mjs 0.8.0-alpha.2
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? "")) {
  console.error("Usage: node scripts/set-version.mjs <version>");
  process.exit(1);
}
const previous = JSON.parse(readFileSync(new URL("../packages/host/package.json", import.meta.url), "utf8")).version;
// Install instructions name the current release.
for (const file of ["README.md", "packages/host/docs/quickstart.md", "packages/router/docs/guides/install.md", "packages/router/scripts/install.sh"]) {
  const path = new URL("../" + file, import.meta.url);
  writeFileSync(path, readFileSync(path, "utf8").replaceAll(previous, version));
}
for (const name of ["host", "router", "connectors", "environment"]) {
  for (const file of ["package.json", "package-lock.json"]) {
    const path = new URL(`../packages/${name}/${file}`, import.meta.url);
    const document = JSON.parse(readFileSync(path, "utf8"));
    document.version = version;
    if (document.packages?.[""]) document.packages[""].version = version;
    writeFileSync(path, JSON.stringify(document, null, 2) + "\n");
  }
}
console.log(`All packages are now ${version}. Add a "## [${version}]" section to CHANGELOG.md.`);
