import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HostError } from "./protocol.js";

function inside(root: string, path: string): string {
  const base = realpathSync(root);
  if (isAbsolute(path) || path.includes("\0"))
    throw new HostError(403, "workspace_path_outside_root");
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new HostError(403, "workspace_path_outside_root");
  let current = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    // Disallow symlinks altogether, including dangling ones, in this optional file API.
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new HostError(403, "workspace_symlink_not_allowed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}
const revision = (content: Buffer) =>
  createHash("sha256").update(content).digest("hex");
export function readWorkspaceFile(root: string, path: string, encoding: "utf8" | "base64" = "utf8") {
  const target = inside(root, path);
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HostError(400, "workspace_not_a_file");
    if (stat.size > (encoding === "base64" ? 30 * 1024 * 1024 : 1_000_000))
      throw new HostError(413, "workspace_file_too_large");
    const content = readFileSync(fd);
    return {
      path,
      content: content.toString(encoding),
      ...(encoding === "base64" ? { encoding } : {}),
      revision: revision(content),
    };
  } finally {
    closeSync(fd);
  }
}
export function listWorkspaceFiles(root: string, path: string) {
  return readdirSync(inside(root, path), { withFileTypes: true })
    .slice(0, 1_000)
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({
      path: join(path, entry.name).split(sep).join("/"),
      directory: entry.isDirectory(),
    }));
}
export function writeWorkspaceFile(
  root: string,
  path: string,
  content: string,
  expectedRevision?: string | null,
  encoding: "utf8" | "base64" = "utf8",
) {
  const bytes = Buffer.from(content, encoding);
  if (bytes.length > (encoding === "base64" ? 30 * 1024 * 1024 : 1_000_000))
    throw new HostError(413, "workspace_file_too_large");
  const target = inside(root, path);
  if (target === realpathSync(root))
    throw new HostError(400, "workspace_file_path_required");
  const previous = existsSync(target)
    ? readWorkspaceFile(root, path, "base64").revision
    : null;
  if (expectedRevision !== undefined && expectedRevision !== previous)
    throw new HostError(409, "workspace_revision_conflict");
  mkdirSync(dirname(target), { recursive: true });
  inside(root, path);
  if (path.startsWith(".agent-host/")) ignoreHostFiles(root);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { path, content, revision: revision(bytes), ...(encoding === "base64" ? { encoding } : {}) };
}

/** Turn inputs are immutable, content-addressed files inside the selected runtime workspace. */
export function saveRunAttachment(root: string, sessionId: string, item: { name: string; data: string }) {
  const bytes = Buffer.from(item.data, "base64");
  const sanitized = item.name.replace(/[^\p{L}\p{N}_.-]/gu, "_").replace(/^\.+/, "_") || "attachment";
  let name = ""; for (const character of sanitized) { if (Buffer.byteLength(name + character) > 200) break; name += character; }
  const path = `.agent-host/attachments/${sessionId}/${revision(bytes)}/${name}`;
  const target = inside(root, path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  inside(root, path);
  ignoreHostFiles(root);
  try {
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readWorkspaceFile(root, path, "base64").revision !== revision(bytes))
      throw new HostError(409, "attachment_content_conflict");
  }
  return target;
}
function ignoreHostFiles(root: string) {
  const ignore = inside(root, ".agent-host/.gitignore");
  try { writeFileSync(ignore, "*\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
