/**
 * The owner-facing HTTP API as data: every route Router serves, one sentence each, and the JSON Schema of its request
 * body where the route validates one with zod. `test/api-reference.test.ts` compares this table with the routes that
 * are registered on the Express app, so a route cannot be added, renamed or removed without changing it here.
 */
import { z } from "zod";
import { restrictOperator } from "./auth/edge-identity.js";
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
}

const root = "/_agent-router/v1", agent = `${root}/agents/:agentId`, communication = `${agent}/communication`, web = `${root}/web`;
/** The event socket is opened with a ticket, which an operator may request; `restrictOperator` covers HTTP requests. */
export const SOCKET_PATH = `${web}/socket`;
function operator(method: string, path: string): boolean {
  if (path === SOCKET_PATH) return true;
  try { restrictOperator({ personId: "", ownerId: "", via: "edge-service", operator: true }, { headers: {}, method, originalUrl: path }); return true; }
  catch { return false; }
}
const route = (method: RouterApiRoute["method"], path: string, summary: string, body?: z.ZodType): RouterApiRoute => ({ method, path, summary,
  ...(body ? { body: z.toJSONSchema(body, { io: "input", unrepresentable: "any" }) } : {}), ...(operator(method, path) ? { operator: true as const } : {}) });

export const routerApiReference: RouterApiRoute[] = [
  route("GET", "/health/live", "Liveness of the process; needs no authentication."),
  route("GET", `${root}/account`, "The authenticated owner and how the request was authenticated."),
  route("GET", `${root}/agents`, "List the owner's agents."),
  route("POST", `${root}/agents`, "Create an agent, or return the existing agent of that name.", createAgentRequest),
  route("GET", agent, "Read one agent."),
  route("DELETE", agent, "Delete an agent with its store, connections and saved channel credentials."),

  route("GET", `${root}/connection-options`, "List the mail services an owner can connect."),
  route("GET", `${agent}/configuration`, "The agent, its Host runtime, its configured connections and the live channel status."),
  route("POST", `${agent}/connections`, "Connect one platform (Feishu, Weixin, Telegram or email); most answer with a setup job.", connectRequest),
  route("DELETE", `${agent}/connections/:connectionId`, "Disconnect a configured connection and delete the credentials Router saved for it; its history stays."),
  route("GET", `${agent}/connections/:connectionId/access`, "The allowed groups, allowed peers and owner addresses of a configured connection."),
  route("PUT", `${agent}/connections/:connectionId/access`, "Replace the allowed groups and allowed peers of a configured connection.", accessRequest),
  route("GET", `${agent}/connection-jobs`, "List the agent's recent connection setup jobs."),
  route("GET", `${agent}/connection-jobs/:id`, "Read one connection setup job, with its consent link while the owner has something to open or scan."),
  route("POST", `${agent}/connection-jobs/:id/pairing`, "Supply the pairing code Weixin shows during a setup job.", pairingRequest),
  route("POST", `${agent}/check`, "Run read-only checks of the Host and of every connection.", checkRequest),

  route("GET", communication, "Channel and Host status of the agent: connections, inbox, outbox and pending calls."),
  route("GET", `${communication}/sessions`, "List the agent's work sessions."),
  route("GET", `${communication}/sessions/:sessionId`, "Read one work session."),
  route("POST", `${communication}/sessions/:sessionId/native`, "Read, rename, archive, unarchive or delete the Host's native session behind a work session.", nativeSessionRequest),
  route("POST", `${communication}/sessions/:sessionId/fork`, "Fork a work session into a new session id.", forkSessionRequest),
  route("POST", `${communication}/sessions/:sessionId/steer`, "Add input to the running turn of a work session.", steerSessionRequest),
  route("POST", `${communication}/work-events`, "Submit owner work to the agent; repeating an event id returns the same task.", workEventRequest),
  route("GET", `${communication}/work-events/:eventId`, "Read the state and answer of a submitted work event."),
  route("POST", `${communication}/work-events/:eventId/cancel`, "Cancel a submitted work event.", emptyRequest),
  route("GET", `${communication}/tasks`, "List the agent's tasks, filtered by connection, target or conversation."),
  route("POST", `${communication}/tasks/:taskId/cancel`, "Cancel a task.", emptyRequest),
  route("GET", `${communication}/runs/:claimId`, "Read one Host run of a task."),
  route("GET", `${communication}/runs/:claimId/events`, "Page through the events of a Host run."),
  route("POST", `${communication}/runs/:claimId/calls/:callId/result`, "Answer a pending call (question or approval) of a Host run.", callResultRequest),
  route("POST", `${communication}/runs/:claimId/reconcile`, "Bind a run whose outcome is unknown to the Host run that executed it.", reconcileRunRequest),
  route("POST", `${communication}/runs/:claimId/close`, "Close a run whose outcome is unknown without running it again.", emptyRequest),
  route("POST", `${communication}/calls/:callId/result`, "Answer a pending Host call by its call id.", callResultRequest),

  route("GET", `${web}/me`, "The signed-in person, linked identities and the limits of the web API."),
  route("POST", `${web}/socket-tickets`, "Issue a single-use ticket (60 seconds) for the event socket.", emptyWebRequest),
  route("GET", SOCKET_PATH, "WebSocket upgrade for the event socket, authenticated by `?ticket=`; not a plain HTTP request."),
  route("GET", `${web}/chats`, "Page through the owner's chat index."),
  route("POST", `${web}/chats/dm`, "Open the owner's direct chat with an agent, creating it when missing.", dmRequest),
  route("GET", `${web}/chats/:chatId`, "Read one chat with its members."),
  route("GET", `${web}/chats/:chatId/events`, "Page through the history of a chat."),
  route("POST", `${web}/chats/:chatId/read`, "Move the owner's read marker of a chat.", readRequest),
  route("POST", `${web}/chats/:chatId/messages`, "Send an owner message to a direct chat or a group.", sendRequest),
  route("POST", `${web}/chats/:chatId/events/:eventId/redact`, "Redact one of the owner's messages.", redactRequest),
  route("GET", `${web}/chats/:chatId/turns/:turnId`, "Read the detail of one turn."),
  route("POST", `${web}/chats/:chatId/turns/:turnId/cancel`, "Cancel a running turn.", emptyWebRequest),
  route("POST", `${web}/chats/:chatId/turns/:turnId/steer`, "Add text to a running turn.", steerRequest),
  route("GET", `${web}/chats/:chatId/cards/:cardId`, "Read a question or approval card."),
  route("POST", `${web}/chats/:chatId/cards/:cardId/answer`, "Answer a question or approval card.", answerRequest),
  route("POST", `${web}/chats/:chatId/reset`, "Start a new context window in a chat; the history stays.", resetRequest),
  route("POST", `${web}/chats/:chatId/purge`, "Delete the history of a chat; `confirm` repeats the chat id.", purgeRequest),
  route("POST", `${web}/groups`, "Create a group of the owner and some of the owner's agents.", createGroupRequest),
  route("PATCH", `${web}/groups/:roomId`, "Rename, archive or unarchive a group.", updateGroupRequest),
  route("POST", `${web}/groups/:roomId/members`, "Add one of the owner's agents to a group.", addGroupMemberRequest),
  route("DELETE", `${web}/groups/:roomId/members/:agentId`, "Remove an agent from a group."),
  route("GET", `${web}/identities`, "List the owner's linked channel identities."),
  route("DELETE", `${web}/identities/:identityId`, "Unlink a channel identity."),
  route("POST", `${web}/identities/pairing-codes`, "Create a pairing code that links a channel account through `/link <code>`.", pairingCodeRequest),
  route("GET", `${web}/identities/pairing-codes`, "List the pending pairing codes."),
  route("DELETE", `${web}/identities/pairing-codes/:codeId`, "Cancel a pending pairing code."),
  route("POST", `${web}/attachments`, "Upload one attachment as the raw request body, with `Content-Length`, `Content-Type` and `X-File-Name` headers."),
  route("GET", `${web}/attachments/:attachmentId`, "Download an attachment; a single byte range is supported."),
];
