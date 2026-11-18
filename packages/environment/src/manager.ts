import { EnvironmentError } from "./errors.js";
import type { CreateEnvironment, EnvironmentProvider, EnvironmentRef, ResumeOptions } from "./types.js";

/** Stateless resource dispatcher. Consumers persist refs in their own durable bindings. */
export class EnvironmentManager {
  private readonly providers = new Map<string, EnvironmentProvider>();
  constructor(providers: EnvironmentProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) throw new EnvironmentError("duplicate_provider", "Provider IDs must be unique.");
      this.providers.set(provider.id, provider);
    }
  }
  provider(id: string): EnvironmentProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new EnvironmentError("unknown_provider", "Provider is not configured.");
    return provider;
  }
  create(provider: string, request: CreateEnvironment) { return this.provider(provider).create(request); }
  info(ref: EnvironmentRef) { return this.provider(ref.provider).info(ref.id); }
  resume(ref: EnvironmentRef, seconds?: number, options?: ResumeOptions) { return this.provider(ref.provider).resume(ref.id, seconds, options); }
  pause(ref: EnvironmentRef) { return this.provider(ref.provider).pause(ref.id); }
  destroy(ref: EnvironmentRef) { return this.provider(ref.provider).destroy(ref.id); }
}
