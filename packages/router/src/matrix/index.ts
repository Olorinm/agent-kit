#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { A2ABackend } from "./backend.js";
import { MatrixConnector, type Contact } from "../agents/connector.js";
import { createConnectorApp } from "../agents/gateway.js";
import { DurableStore } from "../communication/store.js";
import { SdkMatrixTransport } from "./transport.js";
import { mxid } from "./protocol.js";
import { ProfileStore, connectorAddress } from "./profile.js";
import { authError, profileClient } from "./auth.js";

function secret(name: string, required = true): string {
  const value = process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`]!, "utf8").trim() : process.env[name] ?? "";
  if (required && value.length < 16) throw new Error(`${name}_required`);
  return value;
}
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name}_required`); return value; }

/** The standalone connector: one Matrix account, its gateway and an optional A2A execution endpoint. */
export async function runConnector(): Promise<void> {
  const profiles = process.env.MATRIX_PROFILE || !process.env.MATRIX_HOMESERVER_URL ? new ProfileStore() : undefined;
  const release = profiles?.lock();
  let store: DurableStore | undefined, backend: A2ABackend | undefined, connector: MatrixConnector | undefined;
  let server: ReturnType<ReturnType<typeof createConnectorApp>["listen"]> | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { server?.close(); server?.closeAllConnections(); await connector?.stop(); await backend?.close(); store?.close(); }
    finally { release?.(); }
  };
  try {
    const profile = profiles?.require();
    const url = new URL(profile?.homeserver ?? required("MATRIX_HOMESERVER_URL"));
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (profile || process.env.MATRIX_ALLOW_HTTP === "true"))) throw new Error("matrix_https_required");
    const userId = mxid.parse(profile?.userId ?? required("MATRIX_USER_ID"));
    store = new DurableStore(profiles?.databasePath ?? process.env.MATRIX_STORE_PATH ?? "state/matrix.sqlite", userId);
    const cardUrl = profile ? profile.backend?.cardUrl : process.env.A2A_AGENT_CARD_URL;
    store.bindExecution(cardUrl);
    backend = cardUrl ? new A2ABackend(cardUrl, profile?.backend?.token ?? secret("A2A_ENDPOINT_TOKEN", false),
      profile ? profile.backend!.allowLocal : process.env.A2A_ALLOW_LOCAL === "true") : undefined;
    const token = profile?.accessToken ?? secret("MATRIX_ACCESS_TOKEN");
    const transport = new SdkMatrixTransport(url.toString(), token, userId, profile && profiles ? profileClient(profile, profiles) : undefined);
    connector = new MatrixConnector(userId, store, transport, backend, Number(process.env.MATRIX_POLL_MS ?? "1000"));
    for (const address of (profile ? "" : process.env.MATRIX_ALLOWED_SENDERS ?? "").split(",").filter(Boolean)) {
      if (!store.get("policies", address)) await connector.updateContact({ address, note: "Provisioned receive and execution permission", receive: "allow", execution: "allow" } satisfies Contact);
    }
    const address = profile ? connectorAddress(profile.connectorUrl) : undefined;
    const port = address ? Number(address.port || "80") : Number(process.env.PORT ?? "8787");
    const publicBaseUrl = address?.origin ?? (process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
    const app = createConnectorApp(connector, profile?.gatewayToken ?? secret("CONNECTOR_API_TOKEN"), publicBaseUrl);
    await connector.start();
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, address?.hostname.replace(/^\[|\]$/g, "") ?? process.env.HOST ?? "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    process.stdout.write(JSON.stringify({ event: "matrix.listening", userId, port, ...(profiles ? { profile: profiles.name } : {}) }) + "\n");
    const onSignal = () => { void stop().catch(() => { process.exitCode = 1; }); };
    process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  } catch (error) { await stop(); throw profiles ? authError(error) : error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (Number(process.versions.node.split(".")[0]) < 24) { process.stderr.write("The communication service requires Node.js 24 or newer.\n"); process.exitCode = 1; }
  else if (process.argv.includes("--version")) process.stdout.write(JSON.stringify({ version: "0.7.0-alpha.2", component: "connector" }) + "\n");
  else if (process.argv.includes("--help")) process.stdout.write("Agent Router communication service (Node 24). Start it with agent-router connect; use agent-router --help for agent commands.\n");
  else runConnector().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "startup_failed"}\n`); process.exitCode = 1; });
}
