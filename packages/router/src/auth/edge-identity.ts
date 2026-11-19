import type { IncomingHttpHeaders } from "node:http";
import { readFileSync } from "node:fs";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { digest } from "../execution/protocol.js";
import { WorkError } from "../execution/work.js";
import { personId, type PersonRegistry } from "../ledger/registry.js";

/** The authenticated owner of a request (ADR 0005 section 18.2). */
export interface OwnerPrincipal {
  personId: string; ownerId: string;
  via: "edge" | "edge-service" | "bearer";
  email?: string;
  /** Epoch milliseconds; set for edge principals (the JWT `exp`). */
  expiresAt?: number;
  /** A service token without owner access: it reads as the owner and writes only what `restrictOperator` admits. */
  operator?: true;
  /** Set on an operator for the one request that `authorizeOperator` allowed beyond the operator's default. */
  granted?: true;
}
/**
 * `method` is set for HTTP requests; a request without it (socket re-checks) is treated as safe. `originalUrl` is the
 * full request path as received (Express `originalUrl`); an operator's unsafe request without it is refused.
 * `headers` are the request's own headers: `authorizeOperator` reads the product's token from them.
 */
export interface OwnerRequest { headers: IncomingHttpHeaders; method?: string | undefined; originalUrl?: string | undefined }
/** Decides an operator's request that the default refuses; only `true` allows it. See `ServiceDependencies.authorizeOperator`. */
export type OperatorAuthorizer = (principal: OwnerPrincipal, request: OwnerRequest) => Promise<boolean> | boolean;
export interface OwnerAuthenticator {
  authenticate(request: OwnerRequest): Promise<OwnerPrincipal>;
  /** Cross-site check for a browser WebSocket upgrade made with an edge principal's ticket. */
  allowsOrigin?(request: OwnerRequest): boolean;
}

/** A WorkError whose extra fields are part of the JSON error body (for example `email`). */
export class IdentityError extends WorkError {
  constructor(message: string, status: number, readonly details: Record<string, unknown> = {}) { super(message, status); }
}

const origin = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && !value.endsWith("/");
}, "https_origin_without_path_required");
const email = z.string().min(3).max(320).refine((value) => value.includes("@") && value === value.normalize("NFC").toLowerCase(), "lowercased_email_required");
const ownerId = z.string().max(255).regex(/^@[a-z0-9._=\-/+]+:[a-zA-Z0-9.-]+(?::[0-9]+)?$/).refine((value) => !value.startsWith("@_ar_"), "agent_owner_forbidden");
export const edgeIdentityConfigSchema = z.object({
  provider: z.literal("cloudflare-access"),
  teamDomain: origin,
  audiences: z.array(z.string().min(1).max(256)).min(1).max(10),
  clockSkewSeconds: z.number().int().min(0).max(300).default(60),
  bearer: z.enum(["allow", "deny"]).default("allow"),
  owners: z.record(email, z.union([ownerId, z.object({ owner: ownerId, sub: z.string().min(1).max(256) }).strict()])).default({}),
  /** A service token acts as its owner for reads. `access: "owner"` also gives it every write; the default is the operator's few. */
  serviceTokens: z.record(z.string().min(1).max(256), z.union([ownerId, z.object({ owner: ownerId, access: z.enum(["operator", "owner"]).default("operator") }).strict()])).default({}),
  /** Browser origins allowed for unsafe edge requests. Default: the origin of the service's public URL. */
  origins: z.array(z.string().url().refine((value) => new URL(value).origin === value, "origin_required")).min(1).max(10).optional(),
}).strict();
export type EdgeIdentityConfig = z.input<typeof edgeIdentityConfigSchema>;
type ParsedConfig = z.output<typeof edgeIdentityConfigSchema>;

/** Reads the operator file (`{ "edgeIdentity": { … } }`). A bad file fails the start. */
export function loadEdgeIdentityConfig(path: string): ParsedConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { edgeIdentity?: unknown };
  return edgeIdentityConfigSchema.parse(raw.edgeIdentity);
}
/** Start-time check that every configured owner id belongs to this server. */
export function assertEdgeOwners(config: EdgeIdentityConfig, serverName: string) {
  const owners = [...Object.values(config.owners ?? {}), ...Object.values(config.serviceTokens ?? {})].map((value) => typeof value === "string" ? value : value.owner);
  for (const owner of owners) if (!owner.endsWith(`:${serverName}`)) throw new Error("edge_identity_owner_not_local");
}

export const EDGE_HEADER = "cf-access-jwt-assertion";
const MAX_ASSERTION = 8 * 1024;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Content types a cross-site form or no-cors fetch can send without a CORS preflight. */
const SIMPLE_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);
/** The writes of a service token without owner access: a chat message, opening a DM, marking read, a socket ticket. */
const OPERATOR_WRITES = /^\/_agent-router\/v1\/web\/(?:socket-tickets|chats\/dm|chats\/[^/]+\/(?:messages|read))$/;
/**
 * A service token is not the owner's sign-in. Without owner access it may read (no protocol upgrade: a tunnel is not
 * a read) and make the requests of `OPERATOR_WRITES`; everything else needs the owner.
 */
export function restrictOperator(principal: OwnerPrincipal, request: OwnerRequest) {
  if (!operatorDefault(principal, request)) throw new WorkError("owner_sign_in_required", 403);
}
/** True for every request of a principal that is not an operator, and for an operator's request that needs no grant. */
function operatorDefault(principal: OwnerPrincipal, request: OwnerRequest): boolean {
  if (!principal.operator || request.method === undefined) return true;
  const method = request.method.toUpperCase();
  return SAFE_METHODS.has(method) ? request.headers.upgrade === undefined
    : method === "POST" && OPERATOR_WRITES.test((request.originalUrl ?? "").split("?")[0]!);
}
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const unavailable = (error: unknown) => !(error instanceof errors.JOSEError) || error instanceof errors.JWKSTimeout ||
  error instanceof errors.JWKSInvalid || error.code === "ERR_JOSE_GENERIC";

/**
 * Verifies the Cloudflare Access application JWT (`Cf-Access-Jwt-Assertion`) and maps it to a configured owner.
 * Only the signed assertion counts: the plain email header and the `CF_Authorization` cookie are never read.
 */
export class CloudflareAccessAuthenticator implements OwnerAuthenticator {
  readonly config: ParsedConfig;
  readonly namespace: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly cache = new Map<string, { principal: OwnerPrincipal; until: number }>();
  private readonly origins: Set<string>;
  constructor(config: EdgeIdentityConfig, private readonly options: { persons?: PersonRegistry; now?: () => number;
    /** Allowed browser origins when the config names none (the service's public origin). */
    origins?: string[];
    /** Asked about an operator's request that `restrictOperator` refuses; without it every such request is refused. */
    authorizeOperator?: OperatorAuthorizer;
    /** Test override for `<teamDomain>/cdn-cgi/access/certs`. */
    certsUrl?: URL } = {}) {
    this.config = edgeIdentityConfigSchema.parse(config);
    this.namespace = new URL(this.config.teamDomain).host;
    this.origins = new Set(this.config.origins ?? options.origins ?? []);
    this.jwks = createRemoteJWKSet(options.certsUrl ?? new URL("/cdn-cgi/access/certs", this.config.teamDomain),
      { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 3_600_000 });
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  /** The request's assertion, or undefined when there is none. Duplicate or oversized headers are invalid. */
  static assertion(request: OwnerRequest): string | undefined {
    const value = request.headers[EDGE_HEADER];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || value.length > MAX_ASSERTION) throw new WorkError("edge_identity_invalid", 401);
    return value;
  }
  /**
   * Cloudflare adds the JWT to every proxied request that carries the Access cookie, including cross-site ones, so an
   * edge principal is ambient authority. A browser always sends `Origin` on a cross-site or same-origin unsafe request
   * and on a WebSocket upgrade; it must be a configured origin or this request's own host over HTTPS. Plain HTTP
   * counts only for a loopback host (local development).
   */
  allowsOrigin(request: OwnerRequest): boolean {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !origin || origin === "null") return false;
    if (this.origins.has(origin)) return true;
    try {
      const url = new URL(origin);
      return (url.protocol === "https:" || url.protocol === "http:" && LOOPBACK.has(url.hostname)) && url.host === request.headers.host;
    } catch { return false; }
  }
  /** CSRF guard for edge principals: unsafe methods need an allowed `Origin` and a body type a form cannot send. */
  guard(request: OwnerRequest) {
    if (request.method === undefined || SAFE_METHODS.has(request.method.toUpperCase())) return;
    if (!this.allowsOrigin(request)) throw new WorkError("origin_not_allowed", 403);
    const length = request.headers["content-length"], chunked = request.headers["transfer-encoding"] !== undefined;
    if (!chunked && (length === undefined || length === "0")) return;
    const type = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
    // A raw attachment upload carries the file's own type (text/plain, …) and `X-File-Name`. That header is not
    // CORS-safelisted, so a cross-site page can only send it after a preflight, which Router never grants.
    if (request.headers["x-file-name"] !== undefined) return;
    if (!type || SIMPLE_TYPES.has(type)) throw new WorkError("content_type_not_allowed", 415);
  }
  async authenticate(request: OwnerRequest): Promise<OwnerPrincipal> {
    const token = CloudflareAccessAuthenticator.assertion(request);
    if (!token) throw new WorkError("edge_identity_invalid", 401);
    return this.admit(await this.verify(token), request);
  }
  /**
   * `restrictOperator` with the product's say: a request the default refuses passes when `authorizeOperator` returns
   * exactly `true`. The answer holds for this request only: the principal returned is a copy marked `granted`, and the
   * cached one is never changed. A hook that throws refuses, and its error is not passed on.
   */
  async admit(principal: OwnerPrincipal, request: OwnerRequest): Promise<OwnerPrincipal> {
    if (operatorDefault(principal, request)) return principal;
    const authorize = this.options.authorizeOperator;
    let allowed: unknown = false;
    if (authorize && typeof request.originalUrl === "string") {
      try { allowed = await authorize({ ...principal }, request); } catch { allowed = false; }
    }
    if (allowed !== true) throw new WorkError("owner_sign_in_required", 403);
    return { ...principal, granted: true };
  }
  async verify(token: string): Promise<OwnerPrincipal> {
    const hash = digest(["edge-assertion", token]), now = this.now(), cached = this.cache.get(hash);
    if (cached && cached.until > now) return cached.principal;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, { algorithms: ["RS256"], issuer: this.config.teamDomain, audience: this.config.audiences,
        clockTolerance: this.config.clockSkewSeconds, requiredClaims: ["exp", "iat"], currentDate: new Date(now) }));
    } catch (error) {
      if (unavailable(error)) throw new WorkError("identity_provider_unavailable", 503);
      throw new WorkError("edge_identity_invalid", 401);
    }
    if (payload.type !== undefined && payload.type !== "app") throw new WorkError("edge_identity_invalid", 401);
    const principal = this.map(payload);
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(hash, { principal, until: Math.min(principal.expiresAt!, now + 60_000) });
    this.remember(principal, payload);
    return principal;
  }
  private map(payload: JWTPayload): OwnerPrincipal {
    const expiresAt = payload.exp! * 1000;
    if (typeof payload.email === "string" && payload.email) {
      const address = payload.email.normalize("NFC").toLowerCase();
      const entry = Object.hasOwn(this.config.owners, address) ? this.config.owners[address] : undefined;
      if (!entry) throw new IdentityError("owner_not_configured", 403, { email: address });
      const owner = typeof entry === "string" ? entry : entry.owner;
      if (typeof entry !== "string" && entry.sub !== payload.sub) throw new IdentityError("owner_subject_mismatch", 403, { email: address });
      return { personId: personId(owner), ownerId: owner, via: "edge", email: address, expiresAt };
    }
    if (typeof payload.common_name === "string" && payload.common_name) {
      const id = payload.common_name, entry = Object.hasOwn(this.config.serviceTokens, id) ? this.config.serviceTokens[id] : undefined;
      if (!entry) throw new WorkError("service_token_not_configured", 403);
      const owner = typeof entry === "string" ? entry : entry.owner;
      return { personId: personId(owner), ownerId: owner, via: "edge-service", expiresAt, ...(typeof entry === "string" || entry.access !== "owner" ? { operator: true as const } : {}) };
    }
    throw new WorkError("edge_identity_invalid", 401);
  }
  /** First sight per cache entry: the person exists and the login identity is linked (ADR 0005 18.2 step 5). */
  private remember(principal: OwnerPrincipal, payload: JWTPayload) {
    const persons = this.options.persons;
    if (!persons) return;
    if (principal.email) {
      const person = persons.ensurePerson(principal.ownerId, principal.email.split("@")[0]!);
      persons.link(person, "cloudflare-access", this.namespace, principal.email, "login");
    } else {
      const person = persons.ensurePerson(principal.ownerId, principal.ownerId.slice(1).split(":")[0]!);
      persons.link(person, "cloudflare-access", this.namespace, `service:${String(payload.common_name)}`, "config");
    }
  }
}

const bearerOf = (request: OwnerRequest) => {
  const value = request.headers.authorization;
  return (typeof value === "string" ? value.match(/^Bearer ([^\s]+)$/i)?.[1] : undefined) ?? "";
};
/**
 * Order of checks (ADR 0005 18.2): with an edge config and an assertion present, the edge result decides and a bad JWT
 * never falls back to the bearer path. Otherwise the bearer path applies unless `bearer:"deny"`.
 */
export class CompositeAuthenticator implements OwnerAuthenticator {
  constructor(private readonly bearer: (token: string) => Promise<OwnerPrincipal>, private readonly edge?: CloudflareAccessAuthenticator) {}
  async authenticate(request: OwnerRequest): Promise<OwnerPrincipal> {
    const token = bearerOf(request);
    if (this.edge) {
      const assertion = CloudflareAccessAuthenticator.assertion(request);
      const deny = this.edge.config.bearer === "deny";
      if (assertion) {
        const principal = await this.edge.admit(await this.edge.verify(assertion), request);
        if (token && !deny) {
          const other = await this.bearer(token).catch(() => undefined);
          if (other?.ownerId !== principal.ownerId) throw new WorkError("principal_conflict", 401);
          // A matching bearer cannot be sent cross-site without a CORS preflight: no CSRF guard needed.
          return principal;
        }
        this.edge.guard(request);
        return principal;
      }
      if (deny) throw new WorkError("edge_identity_required", 401);
    }
    if (!token) throw new WorkError("account_login_required", 401);
    return this.bearer(token);
  }
  allowsOrigin(request: OwnerRequest): boolean { return this.edge?.allowsOrigin(request) ?? true; }
}
