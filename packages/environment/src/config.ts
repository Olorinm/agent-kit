import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EnvironmentManager } from "./manager.js";
import { createAlibabaProvider, createVolcengineProvider } from "./providers.js";
import { EnvironmentError } from "./errors.js";

export async function loadConfiguration(path: string): Promise<EnvironmentManager> {
  const document = JSON.parse(await readFile(path, "utf8")) as {
    providers: Array<{ id: string; kind: string; domain?: string; apiUrl?: string; sandboxUrl?: string; serviceUrl?: string;
      apiKeyFile: string; requestTimeoutMs?: number; allowHttp?: boolean; pausedRetention?: string }>;
  };
  if (!Array.isArray(document.providers)) throw new EnvironmentError("invalid_config", "providers must be an array.");
  const providers = [];
  for (const item of document.providers) {
    if (!["alibaba", "volcengine"].includes(item.kind) || typeof item.apiKeyFile !== "string")
      throw new EnvironmentError("invalid_config", "Each provider needs kind and apiKeyFile.");
    const secretPath = resolve(dirname(resolve(path)), item.apiKeyFile);
    const metadata = await stat(secretPath);
    if (!metadata.isFile() || process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
      throw new EnvironmentError("insecure_key_file", "API key files must be private regular files (0600).");
    const options = {
      id: item.id, domain: item.domain, apiUrl: item.apiUrl,
      sandboxUrl: item.sandboxUrl, serviceUrl: item.serviceUrl,
      apiKey: (await readFile(secretPath, "utf8")).trim(),
      requestTimeoutMs: item.requestTimeoutMs, allowHttp: item.allowHttp,
      pausedRetention: item.pausedRetention,
    };
    providers.push(item.kind === "alibaba" ? createAlibabaProvider(options) : createVolcengineProvider(options));
  }
  return new EnvironmentManager(providers);
}
