/**
 * The owner-facing HTTP API as data: every route Router serves, one sentence each, and the JSON Schema of its request
 * body where the route validates one with zod. `test/api-reference.test.ts` compares this table with the routes that
 * are registered on the Express app, so a route cannot be added, renamed or removed without changing it here.
 */
import { z } from "zod";
import { restrictOperator } from "./auth/edge-identity.js";
import { HOST_LINK_ENROLL_PATH, HOST_LINK_SOCKET_PATH, hostLinkCodeRequest, hostLinkEnrollRequest } from "./execution/host-links.js";
import { accessRequest, checkRequest, connectRequest, pairingRequest } from "./connections/routes.js";
import { pairingCodeRequest } from "./ledger/identity-web.js";
import { addGroupMemberRequest, createGroupRequest, updateGroupRequest } from "./ledger/rooms-web.js";
import { answerRequest, dmRequest, emptyRequest as emptyWebRequest, purgeRequest, readRequest, redactRequest, resetRequest, sendRequest,
  steerRequest } from "./ledger/web.js";
import { callResultRequest, createAgentRequest, emptyRequest, forkSessionRequest, nativeSessionRequest, reconcileRunRequest,
  steerSessionRequest, workEventRequest } from "./service/managed.js";

export interface RouterApiRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Express style, with `:params` and the `/_agent-router/v1` prefix. */
  path: string;
  summary: string;
  /** JSON Schema of the JSON request body. */
  body?: unknown;
  /** A service token without owner access (the default `operator` level) may make this request. */
  operator?: true;
  /** What a grant must cover for an operator to make this request beyond its default; see `RouterRouteScope`. */
  scope: RouterRouteScope;
}
/**
 * The classes of owner requests, for a product that issues scoped grants through `authorizeOperator`. Router assigns
 * one to each of its routes and enforces none of them: the product decides which scopes a grant holds.
 * - `read`: reads. Every `GET` and the event socket, and the two writes that change nothing of substance: requesting
 *   a socket ticket and moving a read marker.
 * - `chat`: taking part in conversations as the owner: opening a DM, sending and redacting a message, uploading an
 *   attachment, steering or cancelling a turn, starting a new context window.
 * - `approve`: deciding on behalf of the owner: answering a card (approval, question, confirmation) or a Host call.
 * - `manage`: creating, deleting and changing agents, their connections and allowlists, connection jobs, checks,
 *   groups, and the `communication` routes for sessions, work events, tasks and runs.
 * - `owner`: only the signed-in owner, never a grant: purging a chat's history, pairing codes and identity links.
 *
 * Two host link routes are not owner requests and never reach `authorizeOperator`: enrollment is authenticated by a
 * pairing code and the link socket by a device credential. Their scopes are the strictest (`owner`) for the write
 * and `read` for the upgrade, like every `GET`.
 */
export type RouterRouteScope = "read" | "chat" | "approve" | "manage" | "owner";

const root = "/_agent-router/v1", agent = `${root}/agents/:agentId`, communication = `${agent}/communication`, web = `${root}/web`;
/** The event socket is opened with a ticket, which an operator may request; `restrictOperator` covers HTTP requests. */
export const SOCKET_PATH = `${web}/socket`;
function operator(method: string, path: string): boolean {
  if (path === SOCKET_PATH) return true;
  try { restrictOperator({ personId: "", ownerId: "", via: "edge-service", operator: true }, { headers: {}, method, originalUrl: path }); return true; }
  catch { return false; }
}
const route = (method: RouterApiRoute["method"], path: string, scope: RouterRouteScope, summary: string, body?: z.ZodType): RouterApiRoute => ({ method, path, summary,
  ...(body ? { body: z.toJSONSchema(body, { io: "input", unrepresentable: "any" }) } : {}), ...(operator(method, path) ? { operator: true as const } : {}), scope });

export const routerApiReference: RouterApiRoute[] = [
  route("GET", "/health/live", "read", "Liveness of the process; needs no authentication."),
  route("GET", `${root}/account`, "read", "The authenticated owner and how the request was authenticated."),
  route("GET", `${root}/agents`, "read", "List the owner's agents."),
  route("POST", `${root}/agents`, "manage", "Create an agent, or return the existing agent of that name.", createAgentRequest),
  route("GET", agent, "read", "Read one agent."),
  route("DELETE", agent, "manage", "Delete an agent with its store, connections and saved channel credentials."),

  route("GET", `${root}/connection-options`, "read", "List the mail services an owner can connect."),
  route("GET", `${agent}/configuration`, "read", "The agent, its Host runtime, its configured connections and the live channel status."),
  route("POST", `${agent}/connections`, "manage", "Connect one platform (Feishu, Weixin, Telegram or email); most answer with a setup job.", connectRequest),
  route("DELETE", `${agent}/connections/:connectionId`, "manage", "Disconnect a configured connection and delete the credentials Router saved for it; its history stays."),
  route("GET", `${agent}/connections/:connectionId/access`, "read", "The allowed groups, allowed peers and owner addresses of a configured connection."),
  route("PUT", `${agent}/connections/:connectionId/access`, "manage", "Replace the allowed groups and allowed peers of a configured connection.", accessRequest),
  route("GET", `${agent}/connection-jobs`, "read", "List the agent's recent connection setup jobs."),
  route("GET", `${agent}/connection-jobs/:id`, "read", "Read one connection setup job, with its consent link while the owner has something to open or scan."),
  route("POST", `${agent}/connection-jobs/:id/pairing`, "manage", "Supply the pairing code Weixin shows during a setup job.", pairingRequest),
  route("POST", `${agent}/check`, "manage", "Run read-only checks of the Host and of every connection.", checkRequest),

  route("GET", `${root}/host-links`, "read", "List the owner's host links: machines whose Agent Host connects to Router by itself."),
  route("POST", `${root}/host-links/pairing-codes`, "owner", "Create a single-use pairing code (one hour) that links a machine's Agent Host to an agent.", hostLinkCodeRequest),
  route("DELETE", `${root}/host-links/:linkId`, "manage", "Revoke a host link: its device credential stops working and its connection is closed."),
  route("POST", HOST_LINK_ENROLL_PATH, "owner", "Exchange a pairing code for a device credential; the code is the only authentication.", hostLinkEnrollRequest),
  route("GET", HOST_LINK_SOCKET_PATH, "read", "WebSocket upgrade for a linked Agent Host, authenticated by its device credential; not a plain HTTP request."),

  route("GET", communication, "read", "Channel and Host status of the agent: connections, inbox, outbox and pending calls."),
  route("GET", `${communication}/sessions`, "read", "List the agent's work sessions."),
  route("GET", `${communication}/sessions/:sessionId`, "read", "Read one work session."),
  route("POST", `${communication}/sessions/:sessionId/native`, "manage", "Read, rename, archive, unarchive or delete the Host's native session behind a work session.", nativeSessionRequest),
  route("POST", `${communication}/sessions/:sessionId/fork`, "manage", "Fork a work session into a new session id.", forkSessionRequest),
  route("POST", `${communication}/sessions/:sessionId/steer`, "manage", "Add input to the running turn of a work session.", steerSessionRequest),
  route("POST", `${communication}/work-events`, "manage", "Submit owner work to the agent; repeating an event id returns the same task.", workEventRequest),
  route("GET", `${communication}/work-events/:eventId`, "read", "Read the state and answer of a submitted work event."),
  route("POST", `${communication}/work-events/:eventId/cancel`, "manage", "Cancel a submitted work event.", emptyRequest),
  route("GET", `${communication}/tasks`, "read", "List the agent's tasks, filtered by connection, target or conversation."),
  route("POST", `${communication}/tasks/:taskId/cancel`, "manage", "Cancel a task.", emptyRequest),
  route("GET", `${communication}/runs/:claimId`, "read", "Read one Host run of a task."),
  route("GET", `${communication}/runs/:claimId/events`, "read", "Page through the events of a Host run."),
  route("POST", `${communication}/runs/:claimId/calls/:callId/result`, "approve", "Answer a pending call (question or approval) of a Host run.", callResultRequest),
  route("POST", `${communication}/runs/:claimId/reconcile`, "manage", "Bind a run whose outcome is unknown to the Host run that executed it.", reconcileRunRequest),
  route("POST", `${communication}/runs/:claimId/close`, "manage", "Close a run whose outcome is unknown without running it again.", emptyRequest),
  route("POST", `${communication}/calls/:callId/result`, "approve", "Answer a pending Host call by its call id.", callResultRequest),

  route("GET", `${web}/me`, "read", "The signed-in person, linked identities and the limits of the web API."),
  route("POST", `${web}/socket-tickets`, "read", "Issue a single-use ticket (60 seconds) for the event socket.", emptyWebRequest),
  route("GET", SOCKET_PATH, "read", "WebSocket upgrade for the event socket, authenticated by `?ticket=`; not a plain HTTP request."),
  route("GET", `${web}/chats`, "read", "Page through the owner's chat index."),
  route("POST", `${web}/chats/dm`, "chat", "Open the owner's direct chat with an agent, creating it when missing.", dmRequest),
  route("GET", `${web}/chats/:chatId`, "read", "Read one chat with its members."),
  route("GET", `${web}/chats/:chatId/events`, "read", "Page through the history of a chat."),
  route("POST", `${web}/chats/:chatId/read`, "read", "Move the owner's read marker of a chat.", readRequest),
  route("POST", `${web}/chats/:chatId/messages`, "chat", "Send an owner message to a direct chat or a group.", sendRequest),
  route("POST", `${web}/chats/:chatId/events/:eventId/redact`, "chat", "Redact one of the owner's messages.", redactRequest),
  route("GET", `${web}/chats/:chatId/turns/:turnId`, "read", "Read the detail of one turn."),
  route("POST", `${web}/chats/:chatId/turns/:turnId/cancel`, "chat", "Cancel a running turn.", emptyWebRequest),
  route("POST", `${web}/chats/:chatId/turns/:turnId/steer`, "chat", "Add text to a running turn.", steerRequest),
  route("GET", `${web}/chats/:chatId/cards/:cardId`, "read", "Read a question or approval card."),
  route("POST", `${web}/chats/:chatId/cards/:cardId/answer`, "approve", "Answer a question or approval card.", answerRequest),
  route("POST", `${web}/chats/:chatId/reset`, "chat", "Start a new context window in a chat; the history stays.", resetRequest),
  route("POST", `${web}/chats/:chatId/purge`, "owner", "Delete the history of a chat; `confirm` repeats the chat id.", purgeRequest),
  route("POST", `${web}/groups`, "manage", "Create a group of the owner and some of the owner's agents.", createGroupRequest),
  route("PATCH", `${web}/groups/:roomId`, "manage", "Rename, archive or unarchive a group.", updateGroupRequest),
  route("POST", `${web}/groups/:roomId/members`, "manage", "Add one of the owner's agents to a group.", addGroupMemberRequest),
  route("DELETE", `${web}/groups/:roomId/members/:agentId`, "manage", "Remove an agent from a group."),
  route("GET", `${web}/identities`, "read", "List the owner's linked channel identities."),
  route("DELETE", `${web}/identities/:identityId`, "owner", "Unlink a channel identity."),
  route("POST", `${web}/identities/pairing-codes`, "owner", "Create a pairing code that links a channel account through `/link <code>`.", pairingCodeRequest),
  route("GET", `${web}/identities/pairing-codes`, "read", "List the pending pairing codes."),
  route("DELETE", `${web}/identities/pairing-codes/:codeId`, "owner", "Cancel a pending pairing code."),
  route("POST", `${web}/attachments`, "chat", "Upload one attachment as the raw request body, with `Content-Length`, `Content-Type` and `X-File-Name` headers."),
  route("GET", `${web}/attachments/:attachmentId`, "read", "Download an attachment; a single byte range is supported."),
];

const patterns = routerApiReference.map((entry) => ({ method: entry.method as string, scope: entry.scope,
  pattern: new RegExp(`^${entry.path.split("/").map((part) => part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/")}$`) }));
/**
 * The scope of a concrete request: `path` is the request path without its query string, compared as received (no
 * decoding, case-sensitive, no trailing slash); a `:param` is one non-empty segment. `undefined` means the request is
 * not one of this table's routes as written, and a caller that authorizes by scope must refuse it: Express itself
 * also serves a route under another letter case or with a trailing slash.
 */
export function routerRouteScope(method: string, path: string): RouterRouteScope | undefined {
  return patterns.find((entry) => entry.method === method && entry.pattern.test(path))?.scope;
}
