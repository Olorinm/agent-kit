import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("the verified offline bundle installs complete upstream skills beside user-authored skills", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agent-environment-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = fileURLToPath(new URL("../examples/official-skills.tgz", import.meta.url));
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  const launcher = await readFile(new URL("../examples/start-host.sh", import.meta.url), "utf8");
  assert.ok(launcher.includes("skills_digest=" + digest));
  execFileSync("tar", ["xzf", archive, "-C", directory]);
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
