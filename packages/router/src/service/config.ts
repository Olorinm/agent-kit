import { readFileSync } from "node:fs";
import { loadEdgeIdentityConfig } from "../auth/edge-identity.js";
import type { ServiceConfig } from "./managed.js";
import { blobConfigFromEnv } from "../ledger/blobs.js";

/** Operator configuration shared by the standalone Router and embedding products. */
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const required = (key: string) => { const value = env[key]; if (!value) throw new Error(`${key}_required`); return value; };
  const flag = (key: string) => ["1", "true"].includes(env[key] ?? "");
  return {
    // The account namespace of owner and agent ids. The variable keeps the name deployments already set.
    serverName: required("MATRIX_SERVER_NAME"),
    publicUrl: required("AGENT_SERVICE_URL").replace(/\/$/, ""), stateDir: env.AGENT_SERVICE_STATE ?? "state/agent-service",
    ...(flag("AGENT_LEDGER_READ") ? { ledgerRead: true } : {}),
    ...(flag("AGENT_LEDGER_SEND") ? { ledgerSend: true } : {}),
    ...(flag("AGENT_LEDGER_CARDS") ? { ledgerCards: true } : {}),
    ...(flag("AGENT_LEDGER_CONTROL") ? { ledgerControl: true } : {}),
    ...(flag("AGENT_LEDGER_GROUPS") ? { ledgerGroups: true } : {}),
    ...(flag("AGENT_LEDGER_IDENTITY") ? { ledgerIdentity: true } : {}),
    ...(env.AGENT_TRUST_PROXY ? { trustedProxies: env.AGENT_TRUST_PROXY.split(",").map(v => v.trim()).filter(Boolean) } : {}),
    ...(env.AGENT_EDGE_IDENTITY_FILE ? { edgeIdentity: loadEdgeIdentityConfig(env.AGENT_EDGE_IDENTITY_FILE) } : {}),
    // ADR 0005 16.5: attachments and the blob store (R2 key files are read when the service starts).
    ...blobConfigFromEnv(env),
  };
}
