import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// install.sh HOME RELEASE [DIR...] | --prune --only [GROUP...] | --restore [--default-browser]
const [home, release, ...args] = process.argv.slice(2);
const bundle = path.dirname(fileURLToPath(import.meta.url)), sources = path.join(bundle, "skills");
const roots = [".agents/skills", ".claude/skills", ".gemini/config/skills", ".hermes/skills"];
const versionFile = ".agent-environment-version", treeFile = ".agent-environment-tree";
const exists = file => fs.lstatSync(file, { throwIfNoEntry: false });
const safeName = name => /^[a-z0-9][a-z0-9-]*$/.test(name);
const oldTrees = JSON.parse(fs.readFileSync(path.join(bundle, "previous-trees.json"), "utf8"));
const official = new Set(fs.readdirSync(sources).filter(safeName));
function directory(parent, parts) {
  for (const part of parts) {
    parent = path.join(parent, part);
    const entry = exists(parent);
    if (entry && !entry.isDirectory()) return;
    if (!entry) fs.mkdirSync(parent, { mode: 0o755 });
  }
  return parent;
}
function readMarker(dir, file) {
  const entry = path.join(dir, file);
  return exists(entry)?.isFile() ? fs.readFileSync(entry, "utf8").trim() : undefined;
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function signature(dir) {
  if (!exists(dir)?.isDirectory()) return;
  const entries = [];
  function visit(base, relative) {
    for (const name of fs.readdirSync(base).sort()) {
      if (!relative && [versionFile, treeFile].includes(name)) continue;
      const file = path.join(base, name), key = relative + name, entry = fs.lstatSync(file);
      if (entry.isDirectory()) { entries.push([key, "directory"]); if (!visit(file, key + "/")) return false; }
      else if (entry.isFile()) entries.push([key, entry.mode & 0o111, hash(fs.readFileSync(file))]);
      else return false; // User symlinks, sockets and other custom resources stay where they are.
    }
    return true;
  }
  return visit(dir, "") ? hash(JSON.stringify(entries)) : undefined;
}
const state = directory(home, [".local", "state", "agent-environment-skills"]);
if (!state) throw new Error("install-skills: invalid state directory");
const selection = path.join(state, "selection.json");
const selecting = args.includes("--only"), restoring = args.includes("--restore"), pruning = args.includes("--prune") || restoring;
const extra = args.filter(arg => !arg.startsWith("--"));
if (args.some(arg => arg.startsWith("--") && !["--only", "--prune", "--restore", "--default-browser"].includes(arg))
  || (restoring && (selecting || extra.length)) || (pruning && !selecting && !restoring && !extra.length)
  || (args.includes("--default-browser") && !restoring))
  throw new Error("install-skills: invalid selection options");
let groups;
if (selecting) groups = [...new Set(extra)].sort();
else if (restoring) {
  if (exists(selection)) {
    if (!exists(selection).isFile()) throw new Error("install-skills: invalid saved selection");
    groups = JSON.parse(fs.readFileSync(selection, "utf8"));
  } else if (args.includes("--default-browser")) groups = ["agent-browser"];
}
if (groups && (!Array.isArray(groups) || !groups.every(g => typeof g === "string" && safeName(g))))
  throw new Error("install-skills: invalid skill group");
const inGroup = (name, group) => name === group || name.startsWith(group + "-");
if (selecting && groups.some(group => ![...official].some(name => inGroup(name, group)))) throw new Error("install-skills: unknown skill group");
const wanted = new Map();
for (const source of selecting || restoring ? [...official].filter(name => !groups || groups.some(g => inGroup(name, g))).map(name => path.join(sources, name)) : extra.map(file => path.resolve(file))) {
  const name = path.basename(source);
  if (!safeName(name) || !exists(source)?.isDirectory() || !exists(path.join(source, "SKILL.md"))?.isFile()) throw new Error("invalid skill source: " + source);
  wanted.set(name, source);
}
function previousSignature(dir, name, source) {
  const version = readMarker(dir, versionFile);
  if (!version) return;
  const metadata = readMarker(dir, treeFile);
  if (metadata) {
    const match = /^(official|extra) ([a-f0-9]{64})$/.exec(metadata);
    return match && (source || match[1] === "official") ? match[2] : undefined;
  }
  // Upgrade from the original version-only marker, including skills removed from a newer upstream release.
  if (oldTrees.versions.includes(version)) return oldTrees.skills[name];
  if (source && name === "mau-sandbox" && exists(path.join(dir, "SKILL.md"))?.isFile() &&
      fs.readdirSync(dir).length === 2 && hash(fs.readFileSync(path.join(dir, "SKILL.md"))) === version) return signature(dir);
}

for (const [index, root] of roots.entries()) {
  const dest = directory(home, root.split("/"));
  if (!dest) continue; // Never install or prune through a user-provided symlink.
  const journal = path.join(state, "pending-" + index), old = path.join(journal, "prior"), next = path.join(journal, "next");
  if (exists(journal)) {
    if (!exists(journal).isDirectory()) throw new Error("invalid skill installation journal");
    if (fs.readdirSync(journal).some(file => !["name", "hash", "prior", "next"].includes(file))) throw new Error("unrecognized skill installation journal");
    if (exists(old)) {
      const name = readMarker(journal, "name");
      if (!name || !safeName(name)) throw new Error("invalid pending skill name");
      if (!exists(path.join(dest, name))) fs.renameSync(old, path.join(dest, name));
      else if (signature(old) !== readMarker(journal, "hash")) {
        fs.renameSync(journal, path.join(fs.mkdtempSync(path.join(state, "preserved-")), "changes"));
      }
    }
    fs.rmSync(journal, { recursive: true, force: true });
  }
  const names = new Set([...wanted.keys(), ...(pruning ? fs.readdirSync(dest).filter(safeName) : [])]);
  for (const name of names) {
    const source = wanted.get(name), target = path.join(dest, name), present = exists(target);
    if (present && (!present.isDirectory() || (source && readMarker(target, versionFile) === release))) continue;
    if (!source && !official.has(name) && !Object.hasOwn(oldTrees.skills, name) && readMarker(target, treeFile)?.split(" ")[0] !== "official") continue;
    const priorHash = present && previousSignature(target, name, source);
    if (present && (!priorHash || priorHash !== signature(target))) continue;
    fs.mkdirSync(journal, { mode: 0o700 });
    fs.writeFileSync(path.join(journal, "name"), name);
    if (priorHash) fs.writeFileSync(path.join(journal, "hash"), priorHash);
    if (source) {
      fs.cpSync(source, next, { recursive: true, verbatimSymlinks: true });
      const digest = signature(next);
      if (!digest) throw new Error("invalid bundled skill: " + name);
      fs.writeFileSync(path.join(next, versionFile), release + "\n");
      fs.writeFileSync(path.join(next, treeFile), (fs.realpathSync(path.dirname(source)) === sources ? "official " : "extra ") + digest + "\n");
    }
    if (present) {
      fs.renameSync(target, old);
      if (signature(old) !== priorHash) {
        // The owner edited it during staging. Preserve the edit in the active directory.
        fs.renameSync(old, target);
        fs.rmSync(journal, { recursive: true }); continue;
      }
    }
    if (source) fs.renameSync(next, target);
    fs.rmSync(journal, { recursive: true });
  }
}
if (selecting) {
  const temporary = fs.mkdtempSync(path.join(state, ".selection-"));
  fs.writeFileSync(path.join(temporary, "selection"), JSON.stringify(groups) + "\n", { mode: 0o600 });
  fs.renameSync(path.join(temporary, "selection"), selection);
  fs.rmdirSync(temporary);
}
