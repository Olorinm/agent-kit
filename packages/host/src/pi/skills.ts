import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { parseDocument } from "yaml";

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

const maxHeaderBytes = 32 * 1024;

function missing(error: unknown) {
  return ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");
}

async function readHeader(file: string): Promise<string | undefined> {
  try {
    if (!(await lstat(file)).isFile()) return;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return;
      const buffer = Buffer.alloc(maxHeaderBytes);
      let length = 0;
      while (length < buffer.length) {
        const size = Math.min(2048, buffer.length - length);
        const { bytesRead } = await handle.read(buffer, length, size);
        length += bytesRead;
        const text = buffer.toString("utf8", 0, length);
        if (!text.startsWith("---")) return;
        const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(bytesRead ? text : text + "\n");
        if (header || !bytesRead) return header?.[1];
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function installedSkills(directory: string, shell: boolean): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (missing(error)) return [];
    throw error;
  });
  const skills: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = join(directory, entry.name, "SKILL.md");
    const header = await readHeader(file);
    if (!header) continue;
    const metadata = parseDocument(header);
    if (metadata.errors.length || metadata.get("disable-model-invocation") === true) continue;
    const name = metadata.get("name") ?? entry.name;
    const description = metadata.get("description");
    if (typeof name !== "string" || typeof description !== "string" || !description.trim()) continue;
    skills.push([
      "  <skill>",
      `    <name>${escapeXml(name)}</name>`,
      `    <description>${escapeXml(description.trim())}</description>`,
      `    <location>${escapeXml(file)}</location>`,
      "  </skill>",
    ].join("\n"));
  }
  if (skills.length === 0) return undefined;
  return [
    shell ? "Use Bash to read a listed SKILL.md when its description matches the task." :
      "Read a listed SKILL.md when its description matches the task.",
    "Resolve its relative paths from the directory containing SKILL.md.",
    "<available_skills>", ...skills, "</available_skills>",
  ].join("\n");
}

/** Durable embeds the model loop. Its optional skills section follows Pi Coding Agent's index format. */
export function installedSkillExtension(directory: string, shell: boolean) {
  let index: Promise<string | undefined> | undefined;
  return defineExtension({
    name: "agent-host-skills",
    sections: [section("available_skills", ({ shown }) =>
      shown.available_skills ?? (index ??= installedSkills(directory, shell).catch((error) => {
        index = undefined;
        throw error;
      })), { tag: false })],
  });
}
