import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EnvironmentManager } from "./manager.js";
import { EnvironmentError } from "./errors.js";
import { createCloudflareProvider } from "./cloudflare.js";
import type { EnvironmentProvider } from "./types.js";

/** One entry of the `providers` array, with its key file already read. */
export interface ProviderConfiguration {
  id: string;
  kind: string;
  apiUrl?: string;
  apiKey: string;
  requestTimeoutMs?: number;
  allowHttp?: boolean;
}
export type ProviderFactory = (options: ProviderConfiguration) => EnvironmentProvider;

/** Provider kinds accepted in configuration files. Add a provider by adding its factory here. */
const factories: Record<string, ProviderFactory> = {
  cloudflare: options => createCloudflareProvider({ ...options, apiUrl: options.apiUrl ?? "" }),
};

export async function loadConfiguration(path: string): Promise<EnvironmentManager> {
  const document = JSON.parse(await readFile(path, "utf8")) as {
    providers: Array<{ id: string; kind: string; apiUrl?: string; apiKeyFile: string; requestTimeoutMs?: number; allowHttp?: boolean }>;
  };
  if (!Array.isArray(document.providers)) throw new EnvironmentError("invalid_config", "providers must be an array.");
  const providers = [];
  for (const item of document.providers) {
    const factory = Object.hasOwn(factories, item.kind) ? factories[item.kind] : undefined;
    if (!factory || typeof item.apiKeyFile !== "string")
      throw new EnvironmentError("invalid_config", "Each provider needs a supported kind and apiKeyFile.");
    const secretPath = resolve(dirname(resolve(path)), item.apiKeyFile);
    const metadata = await stat(secretPath);
    if (!metadata.isFile() || process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
      throw new EnvironmentError("insecure_key_file", "API key files must be private regular files (0600).");
    providers.push(factory({
      id: item.id, kind: item.kind, apiUrl: item.apiUrl,
      apiKey: (await readFile(secretPath, "utf8")).trim(),
      requestTimeoutMs: item.requestTimeoutMs, allowHttp: item.allowHttp,
    }));
  }
  return new EnvironmentManager(providers);
}
