import { TosClient } from "@volcengine/tos-sdk";
import type { Artifact, ArtifactContent, ArtifactMetadata, ArtifactPutInput, ArtifactReadUrlOptions, ArtifactStore } from "./artifact-store.js";
import { workspaceObjectPrefix, validateArtifactPath } from "./path.js";
import { resolveArtifactContentType } from "./content-type.js";

export interface TOSArtifactStoreOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
  /** Trusted regional HTTPS endpoint; defaults to the public endpoint. */
  endpoint?: string;
}

/** OMA's ArtifactStore contract over the official Volcengine TOS SDK. */
export class TOSArtifactStore implements ArtifactStore {
  readonly bucket: string;
  private readonly client: TosClient;
  private readonly publicEndpoint: string;
  constructor(options: TOSArtifactStoreOptions) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) || !/^cn-[a-z]+$/.test(options.region))
      throw new Error("Invalid TOS coordinates");
    this.bucket = options.bucket;
    this.publicEndpoint = `tos-${options.region}.volces.com`;
    const endpoint = options.endpoint ?? this.publicEndpoint;
    if (![this.publicEndpoint, `tos-${options.region}.ivolces.com`].includes(endpoint.replace(/^https:\/\//, "")))
      throw new Error("Invalid TOS regional endpoint");
    this.client = new TosClient({ ...options, endpoint, secure: true, requestTimeout: 30_000, maxRetryCount: 0 });
  }
  private key(tenantId: string, workspaceId: string, path: string) {
    const key = workspaceObjectPrefix(tenantId, workspaceId) + validateArtifactPath(path);
    if (Buffer.byteLength(key) > 1023) throw new Error("Invalid artifact path");
    return key;
  }
  async put(input: ArtifactPutInput): Promise<Artifact> {
    const body = Buffer.from(input.body);
    await this.client.putObject({ key: this.key(input.tenantId, input.workspaceId, input.path), body,
      contentType: resolveArtifactContentType(input.path, input.contentType) });
    return { path: input.path, size: body.length };
  }
  async get(tenantId: string, workspaceId: string, path: string): Promise<ArtifactContent | null> {
    const key = this.key(tenantId, workspaceId, path);
    try {
      const result = await this.client.getObjectV2({ key, dataType: "buffer" });
      return { path, body: new Uint8Array(result.data.content),
        contentType: resolveArtifactContentType(path, result.headers["content-type"]) };
    } catch (error) {
      // The server SDK can return an unparsed stream for a GET error. A bare
      // 404 is not proof that only this key is missing (the bucket may be gone).
      if (status(error) !== 404 && code(error) !== "NoSuchKey") throw error;
      await this.client.headBucket(this.bucket);
      return null;
    }
  }
  async stat(tenantId: string, workspaceId: string, path: string): Promise<ArtifactMetadata | null> {
    const key = this.key(tenantId, workspaceId, path);
    try {
      const { data } = await this.client.headObject({ key });
      const size = Number(data["content-length"]);
      if (!Number.isSafeInteger(size) || size < 0 || data["content-length"] === undefined) throw new Error("Invalid object size");
      return { path, size, contentType: resolveArtifactContentType(path, typeof data["content-type"] === "string" ? data["content-type"] : undefined),
        etag: data.etag, updatedAt: new Date(data["last-modified"]) };
    } catch (error) {
      // HEAD cannot distinguish a missing bucket from a missing key. Check the
      // bucket before treating its 404 as an absent file.
      if (status(error) !== 404) throw error;
      await this.client.headBucket(this.bucket);
      return null;
    }
  }
  async exists(tenantId: string, workspaceId: string, path: string) { return !!await this.stat(tenantId, workspaceId, path); }
  async delete(tenantId: string, workspaceId: string, path: string) {
    const key = this.key(tenantId, workspaceId, path);
    if (!await this.exists(tenantId, workspaceId, path)) return false;
    await this.client.deleteObject({ key }); return true;
  }
  async list(tenantId: string, workspaceId: string, prefix = ""): Promise<Artifact[]> {
    const root = workspaceObjectPrefix(tenantId, workspaceId);
    const search = prefix ? this.key(tenantId, workspaceId, prefix.replace(/\/$/, "")) + "/" : root;
    let token: string | undefined;
    const seen = new Set<string>(), result: Artifact[] = [];
    for (;;) {
      const { data } = await this.client.listObjectsType2({ prefix: search, maxKeys: 1000, continuationToken: token, listOnlyOnce: true });
      for (const item of data.Contents ?? []) {
        if (!item.Key.startsWith(search)) throw new Error("Object outside Workspace");
        const path = item.Key.slice(root.length);
        if (path.endsWith("/") || path.split("/")[0] === ".oma-workspace-checks") continue;
        result.push({ path, size: item.Size, updatedAt: new Date(item.LastModified) });
      }
      if (!data.IsTruncated) return result;
      token = data.NextContinuationToken;
      if (!token || seen.has(token)) throw new Error("Invalid continuation token");
      seen.add(token);
    }
  }
  async createSignedReadUrl(tenantId: string, workspaceId: string, path: string, expires: number, options: ArtifactReadUrlOptions = {}) {
    const key = this.key(tenantId, workspaceId, path);
    if (!Number.isInteger(expires) || expires < 1 || expires > 900) throw new Error("Invalid read URL expiry");
    const filename = path.split("/").at(-1)!;
    const disposition = options.download ? `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}` : undefined;
    return this.client.getPreSignedUrl({ key, method: "GET", expires, alternativeEndpoint: `${this.bucket}.${this.publicEndpoint}`,
      ...(disposition ? { response: { contentDisposition: disposition } } : {}) });
  }
  async verifyWorkspaceProbe(prefix: string, name: string, expected: string) {
    const [owner, workspace, end, ...rest] = prefix.split("/");
    if (!owner || !workspace || end !== "" || rest.length || workspaceObjectPrefix(owner, workspace) !== prefix || !/^[a-f0-9]{32}$/.test(name))
      throw new Error("Invalid Workspace probe");
    try {
      const result = await this.client.getObjectV2({ key: `${prefix}.oma-workspace-checks/${name}`, dataType: "buffer" });
      if (!result.data.content.equals(Buffer.from(expected))) throw new Error("Probe mismatch");
    } catch { throw new Error("Workspace mount verification failed"); }
  }
}
function code(error: unknown) { return error && typeof error === "object" && "code" in error ? error.code : undefined; }
function status(error: unknown) { return error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined; }
