import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("the verified offline bundle installs complete upstream skills beside user-authored skills", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agent-environment-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = fileURLToPath(new URL("../examples/official-skills.tgz", import.meta.url));
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  const launcher = await readFile(new URL("../examples/start-host.sh", import.meta.url), "utf8");
  assert.ok(launcher.includes("skills_digest=" + digest));
  execFileSync("tar", ["xzf", archive, "-C", directory]);
  assert.deepEqual(await readFile(join(directory, "install.mjs")), await readFile(new URL("../scripts/install-skills.mjs", import.meta.url)));
  const home = join(directory, "home"), source = join(directory, "skills");
  const custom = join(home, ".agents/skills/lark-doc");
  await mkdir(custom, { recursive: true });
  await writeFile(join(custom, "SKILL.md"), "owner's own guide");
  const names = await readdir(source);
  assert.deepEqual(names.sort(), JSON.parse(await readFile(join(directory, "sources.json"), "utf8")).flatMap(source => source.skills).sort());
  assert.deepEqual((await readdir(join(directory, "licenses"))).sort(), ["googleworkspace.txt", "larksuite.txt", "vercel-labs.txt"]);
  const installer = join(directory, "install.sh");
  execFileSync("sh", [installer, home, digest, ...names.map(name => join(source, name))]);
  assert.equal(await readFile(join(custom, "SKILL.md"), "utf8"), "owner's own guide");
  for (const root of [".agents/skills", ".claude/skills", ".gemini/config/skills", ".hermes/skills"]) {
    for (const name of ["lark-shared", "gws-shared", "gws-gmail", "gws-gmail-send", "agent-browser"])
      assert.deepEqual(await readFile(join(home, root, name, "SKILL.md")), await readFile(join(source, name, "SKILL.md")));
    const refs = join("lark-doc", "references");
    if (root !== ".agents/skills") assert.deepEqual(await readdir(join(home, root, refs)), await readdir(join(source, refs)));
  }
  const extra = join(directory, "mau-sandbox");
  await mkdir(extra);
  await writeFile(join(extra, "SKILL.md"), "version one");
  execFileSync("sh", [installer, home, "one", extra]);
  await writeFile(join(extra, "SKILL.md"), "version two");
  execFileSync("sh", [installer, home, "two", extra]);
  assert.equal(await readFile(join(home, ".claude/skills/mau-sandbox/SKILL.md"), "utf8"), "version two");
});

test("restore keeps the selected groups, the addendum, owner edits and symlink targets; concurrent installs agree across roots", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agent environment skills "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = fileURLToPath(new URL("../examples/official-skills.tgz", import.meta.url));
  execFileSync("tar", ["xzf", archive, "-C", directory]);
  const home = join(directory, "guest home"), active = join(home, ".agents/skills");
  await mkdir(home);
  const install = (...args) => promisify(execFile)("sh", [join(directory, "install.sh"), home, "v2", ...args]);
  await install("--restore", "--default-browser");
  assert.deepEqual(await readdir(active), ["agent-browser"]);
  await install("--prune", "--only", "agent-browser", "gws");
  const extra = join(directory, "mau-sandbox");
  await mkdir(extra); await writeFile(join(extra, "SKILL.md"), "Mau");
  await install(extra);
  await writeFile(join(active, "gws-gmail/SKILL.md"), "local edits with the release marker intact");
  await writeFile(join(active, "gws-shared/owner.txt"), "notes");
  const outside = join(directory, "untouched");
  await mkdir(outside); await symlink(outside, join(active, "lark-contact"));

  await install("--prune", "--only", "agent-browser");
  // Simulate a process killed between staging the old tree and publishing its replacement.
  const journal = join(home, ".local/state/agent-environment-skills/pending-0");
  await mkdir(journal); await writeFile(join(journal, "name"), "agent-browser");
  await rename(join(active, "agent-browser"), join(journal, "prior"));
  await install("--restore");
  assert.deepEqual((await readdir(active)).sort(), ["agent-browser", "gws-gmail", "gws-shared", "lark-contact", "mau-sandbox"]);
  assert.equal(await readFile(join(active, "gws-shared/owner.txt"), "utf8"), "notes");
  assert.equal(await readFile(join(active, "gws-gmail/SKILL.md"), "utf8"), "local edits with the release marker intact");
  await Promise.all([install("--prune", "--only", "agent-browser", "lark"), install("--prune", "--only", "agent-browser", "gws")]);
  const saved = JSON.parse(await readFile(join(home, ".local/state/agent-environment-skills/selection.json"), "utf8"));
  await install("--restore");
  for (const root of [".agents/skills", ".claude/skills", ".gemini/config/skills", ".hermes/skills"]) {
    const names = await readdir(join(home, root));
    assert.equal(names.includes("lark-shared"), saved.includes("lark"));
    assert.equal(names.includes("gws-gmail-send"), saved.includes("gws"));
    assert.ok(names.includes("agent-browser") && names.includes("mau-sandbox"));
  }
  assert.deepEqual(await readdir(outside), []);
  const empty = join(directory, "other home"); await mkdir(empty); await symlink(outside, join(empty, ".agents"));
  execFileSync("sh", [join(directory, "install.sh"), empty, "v2", "--restore", "--default-browser"]);
  assert.deepEqual(await readdir(outside), []);
});

test("a caller that knows the environment's connections asks for their groups and prunes the rest", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agent-environment-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = fileURLToPath(new URL("../examples/official-skills.tgz", import.meta.url));
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  execFileSync("tar", ["xzf", archive, "-C", directory]);
  const home = join(directory, "home"), installer = join(directory, "install.sh");
  const own = join(home, ".claude/skills/lark-doc");
  await mkdir(own, { recursive: true });
  await writeFile(join(own, "SKILL.md"), "owner's own guide");
  // Everything first, as the start script does before Mau knows the connections.
  execFileSync("sh", [installer, home, digest, ...(await readdir(join(directory, "skills"))).map(name => join(directory, "skills", name))]);
  assert.ok((await readdir(join(home, ".claude/skills"))).includes("gws-gmail"));
  // No Google connection: the gws skills go, the lark ones stay, and the owner's own guide is untouched.
  execFileSync("sh", [installer, home, digest, "--prune", "--only", "agent-browser", "lark"]);
  const installed = await readdir(join(home, ".claude/skills"));
  assert.ok(installed.includes("lark-shared") && installed.includes("agent-browser") && installed.includes("lark-doc"));
  assert.ok(!installed.some(name => name.startsWith("gws-")));
  assert.equal(await readFile(join(own, "SKILL.md"), "utf8"), "owner's own guide");
  for (const root of [".agents/skills", ".gemini/config/skills", ".hermes/skills"]) {
    const names = await readdir(join(home, root));
    assert.ok(names.includes("lark-shared") && !names.some(name => name.startsWith("gws-")), root);
  }
});
