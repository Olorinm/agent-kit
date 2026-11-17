import { z } from "zod";
import { noticeDeliveryId, type ChannelInput, type CommunicationCore, type OwnerRoute } from "../communication/core.js";
import { digest, key } from "../execution/protocol.js";
import { REQUEST_CALL_PREFIX, type AgentLedger, type CardRecord } from "./ledger.js";
import { WEB_CONNECTION } from "./surfaces.js";

/**
 * Owner requests (ADR 0005 20.3): a card the embedding product puts in the owner conversation that belongs to no run.
 * It is an ordinary ledger card (`source: "product"`), so every surface shows and answers it the way it shows and
 * answers a card of a run; its answer is kept on the card instead of being resolved at a Host.
 */
export const ownerRequestSchema = z.object({
  eventId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/),
  /** `approval`: exactly two choices, the first approves and the second rejects (the card closes `approved` / `rejected`). */
  kind: z.enum(["question", "approval"]).default("question"),
  title: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(8000),
  choices: z.array(z.object({ id: z.string().min(1).max(64), label: z.string().trim().min(1).max(60), style: z.enum(["primary", "danger"]).optional() }).strict()).min(1).max(6),
  expiresAt: z.iso.datetime(),
  connectionId: z.string().min(1).max(160).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.choices.map((choice) => choice.id)).size !== value.choices.length || new Set(value.choices.map((choice) => choice.label)).size !== value.choices.length)
    context.addIssue({ code: "custom", message: "owner_request_choices_not_distinct" });
  if (value.kind === "approval" && value.choices.length !== 2) context.addIssue({ code: "custom", message: "owner_request_approval_needs_two_choices" });
});
export type OwnerRequestInput = z.input<typeof ownerRequestSchema>;
export type OwnerRequest = z.output<typeof ownerRequestSchema>;

export const requestCallId = (eventId: string) => `${REQUEST_CALL_PREFIX}${eventId}`;
export const requestCardId = (eventId: string) => `cd_${digest(key("product-request", eventId)).slice(0, 40)}`;
/** The id of the request's card message on its route (its delivery when the route is an external connection). */
export const requestDeliveryId = (eventId: string) => noticeDeliveryId(requestCallId(eventId), `question:${requestCallId(eventId)}`);
/** The owner route of a request card, as the input its notices travel on. */
export const requestInput = (core: CommunicationCore, card: CardRecord): ChannelInput =>
  core.routed(card.callId, card.sessionKey, card.route as OwnerRoute);

/** Record the card and send it along the route, in the caller's transaction. A repeated call adds nothing. */
export function createRequest(ledger: AgentLedger, core: CommunicationCore, agentId: string, sessionKey: string, request: OwnerRequest, route: OwnerRoute): void {
  const callId = requestCallId(request.eventId), cardId = requestCardId(request.eventId);
  if (ledger.card(cardId)) return;
  const text = request.title ? `${request.title}\n\n${request.text}` : request.text, deadlineAt = Date.parse(request.expiresAt);
  const event = ledger.append(sessionKey, { kind: "card", role: "assistant", senderType: "agent", senderId: agentId, turnId: null,
    conversationId: route.conversationId ?? null, idempotencyKey: `card:${cardId}`,
    body: { card: { cardId, agentId, turnId: "", claimId: "", callId, kind: request.kind, source: "product", text,
      choices: request.choices.map((choice, index) => ({ choiceId: String(index), label: choice.label, ...(choice.style ? { style: choice.style } : {}) })),
      freeText: false, deadlineAt: new Date(deadlineAt).toISOString() } } }).event;
  ledger.addCard({ cardId, callId, runId: "", claimId: "", turnId: "", sessionKey, eventId: event.eventId, kind: request.kind, source: "product", deadlineAt, route });
  const buttons = request.choices.map((choice, index) => {
    const token = digest(key(callId, String(index))).slice(0, 32);
    ledger.addCardToken(token, cardId, String(index), { choice: choice.id });
    return { label: choice.label, token };
  });
  const input = core.routed(callId, sessionKey, route), native = core.capabilitiesOf(input)?.buttons;
  const body = native ? `${text}\n可点击选项，或直接回复选项名称。` : `${text}\n${buttons.map((button, index) => `${index + 1}. ${button.label}`).join("\n")}\n请回复选项名称或编号。`;
  // The card event is the web delivery; an external route also gets the message, and a notify connection the push.
  ledger.attachDelivery(core.notice(input, body, `question:${callId}`, { text: body, ...(native ? { buttons } : {}) }), event.eventId);
}

const CLOSED: Record<"expired" | "canceled", string> = { expired: "这个请求已过期。", canceled: "这个请求已撤回。" };
/**
 * Close an unanswered request as expired or withdrawn. The card's `card.update` is what the web shows; a card that
 * was sent to an external conversation is followed there by a line saying so, since a sent message cannot be recalled
 * on every channel.
 */
export function closeRequest(ledger: AgentLedger, core: CommunicationCore, card: CardRecord, status: "expired" | "canceled"): boolean {
  return ledger.atomic(() => {
    if (!ledger.cardStatus(card.cardId, status)) return false;
    const input = requestInput(core, card);
    if (input.connectionId !== WEB_CONNECTION && core.capabilitiesOf(input)) core.notice(input, CLOSED[status], `request-${status}`);
    return true;
  });
}
/** Requests whose deadline passed while nobody answered. Run by the channel loop and before a request is read or answered. */
export function expireRequests(ledger: AgentLedger, core: CommunicationCore, now = Date.now()): void {
  for (const card of ledger.overdueCards(now)) closeRequest(ledger, core, card, "expired");
}
/** What the owner is told when an answer arrives for a request that is closed. */
export const closedRequestReply = (card: CardRecord) => card.status === "canceled" ? CLOSED.canceled : card.status === "expired" ? CLOSED.expired : "这个请求已经回答过了。";
