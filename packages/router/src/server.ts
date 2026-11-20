/** Public embedding API. Router remains independently runnable via agent:service. */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { ManagedService, createManagedApp, type ServiceConfig, type ServiceDependencies } from "./service/managed.js";
import { ConnectionConfiguration, type ConnectionOptions, type HostBindingProvider } from "./connections/configuration.js";
import { createConnections } from "./connections/routes.js";

export function createRouter(config: ServiceConfig, options: {
  connections?: string | Partial<ConnectionOptions>;
  hosts?: HostBindingProvider;
  dependencies?: Omit<ServiceDependencies, "configure">;
} = {}) {
  const connections = new ConnectionConfiguration(config.stateDir, options.connections ?? {}, options.hosts);
  const service = new ManagedService(config, { ...options.dependencies, configure: connections.factory });
  connections.attach(service);
  const routes = createConnections(service, connections);
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  return {
    service, connections, app: createManagedApp(service, routes.router),
    /** Host links: pairing codes, the linked machines and their state changes (`HostLinks`). */
    hostLinks: service.hostLinks,
    /** Event socket upgrade (ADR 0005 8.4) and host link socket upgrade; true when handled. */
    upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => service.hostLinks.upgrade(req, socket, head) || service.web.upgrade(req, socket, head),
    start: () => {
      if (closed) return Promise.reject(new Error("router_closed"));
      return starting ??= service.start();
    },
    close: () => {
      closed = true;
      return closing ??= (async () => { await starting?.catch(() => {}); await routes.close(); await service.close(); })();
    },
  };
}
export { ManagedService, type ManagedAgent, type ServiceConfig, type ServiceDependencies, type ServiceExtension } from "./service/managed.js";
export type { AgentRuntime } from "./agents/runtime.js";
export { ConnectionConfiguration, type HostBindingProvider } from "./connections/configuration.js";
export type { CardOrigin, CardView } from "./ledger/control.js";
export { WorkError as RouterError } from "./execution/work.js";
export { HostLinks, HOST_LINK_SOCKET_PATH, HOST_LINK_ENROLL_PATH, type HostLink, type HostLinkEvent } from "./execution/host-links.js";
export { HttpAgentHost, HostRuns, HOST_OFFLINE, type HostTransport, type HostPort, type HostStartInput, type HostAdmission, type NativeSessionInput, type HostRun, type HostCall } from "./execution/host.js";
export { ServiceHttp, ChannelHttpError } from "./http.js";
export type { HostTool, HostToolResult, HostTools } from "./execution/tools.js";
export { checkChannels } from "./service/check.js";
export { edgeIdentityConfigSchema, loadEdgeIdentityConfig, type EdgeIdentityConfig, type OperatorAuthorizer, type OwnerPrincipal, type OwnerRequest } from "./auth/edge-identity.js";
export { loadServiceConfig } from "./service/config.js";
export { routerApiReference, routerRouteScope, type RouterApiRoute, type RouterRouteScope } from "./api-reference.js";

export { RunObservation, type CommunicationTask, type RunReference, type TaskFilter } from "./execution/observation.js";
export { WorkSessions, type WorkSessionSubmission, type WorkEventResult, type WorkSessionWaitOptions, type WorkDependencyWait,
  type WorkReplyReceipt, type WorkPendingCard, type WorkSender, type WorkDisplay, type OwnerRequestInput, type OwnerRequestResult, type Settlement } from "./execution/sessions.js";
