import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
/** Image entrypoints can start before their private configuration is uploaded. */
export async function waitForBootstrap(
  config: string,
  token: string,
  ready: string,
  signal: AbortSignal,
) {
  for (;;) {
    signal.throwIfAborted();
    try {
      const metadata = await stat(ready);
      if (!metadata.isFile() || metadata.size > 1024)
        throw new Error("invalid_bootstrap_manifest");
      const manifest = JSON.parse(await readFile(ready, "utf8")) as Record<
        string,
        unknown
      >;
      const [configuration, credential] = await Promise.all([
        readFile(config),
        readFile(token),
      ]);
      if (
        manifest.version !== 1 ||
        manifest.configSha256 !== hash(configuration) ||
        manifest.tokenSha256 !== hash(credential)
      )
        throw new Error("bootstrap_bundle_mismatch");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(250, undefined, { signal });
  }
}
