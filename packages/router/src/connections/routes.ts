import express from "express";
import { rateLimit } from "express-rate-limit";
import { join } from "node:path";
import { z } from "zod";
import type { ManagedService } from "../service/managed.js";
import { WorkError } from "../execution/work.js";
import { ServiceHttp } from "../http.js";
import { privateFile } from "../services/feishu/cli.js";
import { checkChannels } from "../service/check.js";
import { connectionIssues, type AgentChannelConfig } from "../service/channels.js";
import { connectionFields } from "../channels/api.js";
import { ConnectionConfiguration } from "./configuration.js";
import { ConnectionSetup } from "./connections.js";

const root = "/_agent-router/v1";
/** Request bodies of the connection routes; `api-reference.ts` publishes them as JSON Schema. */
export const checkRequest = z.object({}).strict();
export const connectRequest = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("feishu"),
      appId: z.string().regex(/^cli_[a-zA-Z0-9_]{1,128}$/).optional(),
      domain: z.enum(["feishu", "lark"]).default("feishu"),
    })
    .strict(),
  z.object({ kind: z.literal("weixin") }).strict(),
  z
    .object({
      kind: z.literal("telegram"),
      token: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("grove-mail"),
      serviceId: z.string().min(1).max(48),
      inboxId: z.email(),
      apiKey: z.string().min(1).max(4096),
      ownerEmail: z.email(),
    })
    .strict(),
]);
export const pairingRequest = z.object({ code: z.string().regex(/^\d{1,12}$/) }).strict();
/** Both lists are replaced; each has the limits of the connection configuration. */
export const accessRequest = z
  .object({
    groupIds: connectionFields.groupIds.unwrap(),
    peerAddresses: connectionFields.peerAddresses.unwrap(),
  })
  .strict();
/** A connection of the agent's configuration. The built-in web and room surfaces are not configured connections. */
function configured(config: AgentChannelConfig | undefined, id: string) {
  const connection = config?.connections.find((connection) => connection.id === id);
  if (!connection) throw new WorkError("connection_not_found", 404);
  return connection;
}
const access = ({ groupIds, peerAddresses, ownerAddresses }: AgentChannelConfig["connections"][number]) => ({
  groupIds,
  peerAddresses,
  ownerAddresses,
});

/** Mounted AFTER the managed service's existing account authentication and Agent ownership checks. */
export function createConnections(
  service: ManagedService,
  configuration: ConnectionConfiguration,
) {
  const app = express.Router(),
    connections = new ConnectionSetup(service, configuration);
  // The outer service limits requests before authentication. Keep the account
  // budget local as well: configuration reads private files and can replace workers.
  app.use(
    root,
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (_req, res) => String(res.locals.owner),
      message: { error: "rate_limit_exceeded" },
    }),
  );
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get(root + "/connection-options", (_req, res) => {
    res.json({
      mailServices: configuration.options.mailServices.map(({ id, label }) => ({
        id,
        label,
      })),
    });
  });
  app.get(root + "/agents/:agentId/configuration", async (req, res) => {
    const agent = service.owned(String(req.params.agentId), res.locals.owner),
      runtime = await service.runtime(agent.id);
    res.json({
      ...configuration.summary(agent),
      communication: runtime.extension?.status() ?? null,
    });
  });
  app.post(root + "/agents/:agentId/connections", async (req, res) => {
    const body = connectRequest.parse(req.body);
    const agent = service.owned(String(req.params.agentId), res.locals.owner);
    if (
      configuration
        .configuration(agent)
        ?.connections.some((connection) => connection.kind === body.kind)
    )
      throw new WorkError("platform_already_connected", 409);
    const connectionId = body.kind === "grove-mail" ? "mail" : body.kind;
    if (
      configuration
        .configuration(agent)
        ?.connections.some((connection) => connection.id === connectionId)
    )
      throw new WorkError("connection_id_already_used", 409);
    if (
      body.kind === "feishu" ||
      body.kind === "weixin" ||
      body.kind === "telegram"
    ) {
      res
        .status(202)
        .json(
          connections.begin(
            res.locals.owner,
            agent.id,
            body.kind as "feishu" | "weixin" | "telegram",
            body.kind === "weixin" ? {} : body,
          ),
        );
      return;
    }
    if (body.kind !== "grove-mail") throw new WorkError("invalid_request", 400);
    const mail = configuration.options.mailServices.find(
      (mail) => mail.id === body.serviceId,
    );
    if (!mail) throw new WorkError("mail_service_not_configured", 403);
    try {
      const inbox = await new ServiceHttp(mail.url, body.apiKey).request(
        "/v0/inboxes/" + encodeURIComponent(body.inboxId),
      );
      if (inbox.inbox_id !== body.inboxId) throw new Error();
    } catch {
      throw new WorkError("mail_inbox_access_failed", 400);
    }
    const file = join(configuration.agentDirectory(agent.id), "mail-key");
    privateFile(file, body.apiKey);
    res.json(
      await configuration.edit(res.locals.owner, agent.id, (config) => {
        config.connections.push({
          id: "mail",
          kind: "grove-mail",
          url: mail.url,
          inboxId: body.inboxId,
          apiKeyFile: file,
          ownerAddresses: [body.ownerEmail],
          peerAddresses: [],
          groupIds: [],
          initialCursor: 0,
          attachmentOrigins: mail.attachmentOrigins,
        });
      }),
    );
  });
  app.delete(root + "/agents/:agentId/connections/:connectionId", async (req, res) => {
    const agent = service.owned(String(req.params.agentId), res.locals.owner);
    res.json(
      await configuration.remove(
        res.locals.owner,
        agent.id,
        String(req.params.connectionId),
      ),
    );
  });
  app.get(root + "/agents/:agentId/connections/:connectionId/access", (req, res) => {
    const agent = service.owned(String(req.params.agentId), res.locals.owner);
    res.json(
      access(
        configured(
          configuration.configuration(agent),
          String(req.params.connectionId),
        ),
      ),
    );
  });
  app.put(root + "/agents/:agentId/connections/:connectionId/access", async (req, res) => {
    const body = accessRequest.parse(req.body);
    const agent = service.owned(String(req.params.agentId), res.locals.owner),
      id = String(req.params.connectionId);
    await configuration.edit(res.locals.owner, agent.id, (config) => {
      const connection = configured(config, id);
      Object.assign(connection, body);
      const [refused] = connectionIssues(connection);
      if (refused) throw new WorkError(refused, 400);
    });
    res.json(access(configured(configuration.configuration(agent), id)));
  });
  app.get(root + "/agents/:agentId/connection-jobs", (req, res) =>
    res.json({
      data: connections.list(res.locals.owner, String(req.params.agentId)),
    }),
  );
  app.get(root + "/agents/:agentId/connection-jobs/:id", (req, res) =>
    res.json(
      connections.status(
        res.locals.owner,
        String(req.params.agentId),
        String(req.params.id),
      ),
    ),
  );
  app.post(root + "/agents/:agentId/connection-jobs/:id/pairing", (req, res) => {
    const { code } = pairingRequest.parse(req.body);
    connections.pairing(
      res.locals.owner,
      String(req.params.agentId),
      String(req.params.id),
      code,
    );
    res.status(204).end();
  });
  app.post(root + "/agents/:agentId/check", async (req, res) => {
    checkRequest.parse(req.body);
    const agent = service.owned(String(req.params.agentId), res.locals.owner);
    const config = configuration.configuration(agent) ?? {
      agentId: agent.id,
      connections: [],
    };
    const runtime = await service.runtime(agent.id),
      live = runtime.extension?.status() as
        | {
            connections?: Array<{
              id: string;
              started: boolean;
              error?: string;
            }>;
          }
        | undefined;
    const checks = await checkChannels(
      {
        directory: configuration.agentDirectory(agent.id),
        agents: [config],
      },
      undefined,
      config.host?.binding
        ? configuration.provider(config.host.binding).http(agent.id, config.host.binding)
        : undefined,
    );
    for (const check of checks)
      if (check.connectionId) {
        const running = live?.connections?.find(
          (connection) => connection.id === check.connectionId,
        );
        if (!running?.started || running.error) {
          check.status = "needs_action";
          check.detail = "Connection is not running cleanly";
        } else if (check.kind === "weixin") {
          check.status = "verified";
          check.detail =
            "Connection started; send a real message to verify a reply";
        }
      }
    res.json({ checks });
  });
  return {
    router: app,
    close: async () => {
      await connections.close();
    },
  };
}
