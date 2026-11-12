// Adapted from BroZhong/open-managed-agents at e04695152219a91c2ecdff41955dfc3fab73b438.
// Source: server/packages/store/src/workspace-path.ts. See NOTICE for provenance.
/**
 * A literal, decoded-once POSIX relative file path. Do not URI-decode here:
 * a name containing `%2f` is distinct from a directory separator. Normalizing paths
 * here would introduce aliases.
 */
export function validateArtifactPath(path: string): string {
  if (!path || /[\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..") || path.split("/")[0] === ".oma-workspace-checks") {
    throw new Error("Invalid artifact path");
  }
  try { encodeURIComponent(path); } catch { throw new Error("Invalid artifact path"); }
  return path;
}
