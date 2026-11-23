# Native sessions and product-authored work

Router routes work into Host sessions. Codex continues to own its threads, turns,
history, memory generation, skills and approvals. Router does not implement a model loop
or a background scheduler.

## Public component boundary

`HostPort` and `HttpAgentHost` preserve the Host protocol for run submission, lookup,
typed input items, settings, compaction, native session management, runtime discovery,
and the trusted native request/notification/event/request-response extension. Native
responses are returned unchanged; `ChannelHttpError.nativeError` retains native error
code/data when supplied by Host. A method in this interface does not prove that every
kernel/version implements it. Consult Host's runtime discovery and native errors.

`HttpAgentHost.connect()` reads the Host health capability flags. Stable `requestKey`
submission requires an advertised `runIdempotency` capability. Without it, a keyed
submission fails before dispatch; Router never drops the key to start weaker work.

The raw native extension is for trusted embedding code. It is not exposed as an arbitrary
method endpoint to models or owner HTTP clients. Host must independently allow the method
in its server-owned runtime configuration.

## Product-authored work

After authenticating the owner, an embedding product can obtain the agent's session port:

```ts
router.service.owned(agentId, owner);
const sessions = (await router.service.runtime(agentId)).extension?.sessions;
if (!sessions) throw new Error("host_sessions_unavailable");
const event = await sessions.submit({
  eventId: "rule-42-occurrence-7",
  sessionId: "rule-42",
  input: "Check the authorized data and return a result.",
  admission: {
    kind: "schedule", owner, agentId, reference: "rule-42-v2",
    toolGrants: {},
  },
});
```

`WorkSessions` is scoped to one agent's Router store. Its public `sessionId` identifies a
Router context; it is not a raw native thread ID. A stored mapping selects the Host session
and runtime. `list` and `getSession` inspect this directory without waking an execution
environment. `read`, `history`, `native` (bounded session actions), `fork`, and `steer`
operate on that stored mapping. A supplied native thread ID cannot select another session.

`submit` writes the work event and server-authored admission in the same transaction as the
durable work item. Reusing an event ID with different input is rejected. `lookup`/`get`
return the saved task status and latest observed answer without contacting Host. `wait`
uses a cursor over these saved observations. It never resumes or wakes a native thread.
Owner-authored native input items and per-turn context are forwarded separately from the
session's stable instructions. Scheduled work requires explicit tool grants.

### Input that no human wrote

Delegated and scheduled work is never delivered as a human user message. The model reads one
JSON object: `from` says who the input is from, and the rest is the product's.

```json
{"from":{"partner":"desk"},"message":"Summarize the report."}
```

`from` is `{ "partner": name }` when the submission names a sender, `"schedule"` for
scheduled work and `"system"` otherwise. A product that has more to say than a text submits
`json: true` with the text of a JSON object as `input`: its members stand beside `from` in
place of `message`. Router writes `from` itself and drops a `from` the product's object has. What
each member means to a model is the product's to say once, in its instructions or a tool's
description; Router adds no sentence of its own.

Before each such turn Router asks the Host whether the runtime takes native input items
(`input.nativeItems` in the runtime description) and chooses how the object arrives:

- **A runtime that takes them (Codex):** as the output of a native `toolOutput`
  (`mau.work_sessions` or `mau.proactive_work`). Codex does not allow typed input and
  standalone tool output in the same turn. Router verifies requested skill names and paths
  against the native catalog and adds those references to the object (`skills`) for
  on-demand loading; this does not force native skill injection. Other typed items are
  rejected before a run is submitted (`native_tool_delivery_typed_input_unsupported`).
- **A runtime that reports them as unsupported:** as the text of the turn. Typed input
  items cannot be carried by a text delivery and are rejected with the same error.

A Host that does not describe its runtimes, or does not answer the question, is sent the
tool output. The admission still travels beside the input for the product's Host decorator,
in both forms.

The object is a statement to the model, not an enforced boundary: a text-only runtime has
no input channel that a message cannot imitate. What such a turn may do is decided by its
admission and the grants the product enforces, never by the text.

`submit` accepts `sender: { kind: "agent", id, name }` for input that is another agent's
message. Router records it as the sender of the input event (`sender_type: "agent"`), the web
chat API returns it as the event's `sender`, and the model reads its name in `from`.
A sender is refused on an owner admission (`work_sender_admission_mismatch`): the owner's own
work is the owner's.

`submit` accepts `display`, a JSON object the product defines, for whatever shows the input:
for example the message as its sender wrote it, when `input` is the text written for the
model. Router records it on the input event, and the web chat API returns it as the event's
`display`, beside `text`, `origin` and `sender`. Router does not interpret it, and it never
reaches the model: it is not part of the input, the context, the admission or the Host
request, and no session fingerprint depends on it. It is limited to 64,000 bytes of
serialized JSON (`work_display_too_large`, 413), and anything but a JSON object is refused
as invalid input. It belongs to the submission like every other member: the same `eventId`
with another `display` is refused with `work_event_id_reused`. The HTTP work-event route
does not take it.

`setDefaultSettings(selection)` stores native settings (for example `model` and `effort`) that
Router sends with every turn of the agent, including turns started by channel messages;
`defaultSettings()` reads them and an empty selection removes them. A work event's own
`settings` win key by key, and compaction takes none. Router does not decide which values are
valid: Host checks each one against the allowed list in the runtime owner's configuration when
the turn starts, and `inspect()` returns that description without a native handshake. A value
Host refuses fails that turn with `setting_not_allowed:<key>`; Router does not retry it with
different settings.

`HostAdmission` is trusted embedding metadata, never a model-visible authorization token.
The product's Host decorator consumes and strips it; the default `HttpAgentHost` also
strips it before the Host HTTP request. Owner channel admission is issued for a
verified owner private chat, and for the owner's turn in a hub room, whose members are
only the owner and the owner's own agents. Other group chats, peer messages and forged context
IDs do not receive it. Each group keeps its own session; it never joins the private main session.
The product must enforce expiry, operation grants and call budgets at tool execution.

The owner HTTP API offers bounded `/communication/sessions` management and
`/communication/work-events` submission/observation. HTTP callers cannot supply an
admission; Router constructs a user-origin admission from their authenticated identity.
Internal schedule/delegation admission is available only to trusted embedding code.

## Execution and delivery

The Host worker retains each claim while releasing its foreground slot with the existing
defer mechanism. Different contexts run concurrently; a single context remains serialized.
Every run and long-running tool has an independent observer, so waiting does not block the
dispatch loop. Native run IDs and original claim IDs remain stable after a Router restart.
An uncertain submission is only reconciled by its original request key; it is never blindly
executed again.

The default budget is four regular runs plus a fixed reserve of four dependency runs, for
a hard ceiling of eight live Host runs. A product tool calling `wait` supplies its actual
`waitingRunId`, `waitingReference`, and `waitingCallId` from the trusted execution context;
these are never model arguments. Each valid waiting parent permits one extra dispatch,
only for an explicitly awaited task, within that fixed ceiling. The parent remains live
at Host. A contextual wait without a cursor waits for the next saved change; terminal or
unknown results return immediately. Waiting on the same busy context or requesting more capacity at the hard ceiling
returns an explicit error instead of silently waiting for work that cannot start. After a
wait returns or times out, already-started children keep running; new regular work waits
until capacity is free. At the worker boundary, `maxConcurrentRuns` and
`maxDependencyRuns` configure these two budgets (the latter defaults to the former).
This bounds dependency nesting; it does not promise unlimited parallel child sessions.
Unknown submissions also retain their capacity reservation because the native run may
exist. They are never silently removed or resubmitted; reconciliation or explicit owner
closure is required to release that reservation.

An internally delivered turn can continue an existing owner session while retaining its
native tool catalog. It does not inherit a channel reply route. Channel tools are denied
for that turn unless it has an admitted channel message. Products similarly retain stable
business tool definitions while authorizing each call from the current run's admission.

Internal work does not send a chat message unless it was submitted with `reply` (below).
After inspecting a result, the product may call `validateTarget` and
`deliver({eventId,targetSessionId,text})`. Only a known owner private conversation is
accepted. The stable delivery intent and the delivery are committed together.
`lookupDelivery` reports the actual receipt: `queued` is not delivery, and an uncertain
result is not automatically resent as a new message.

## The owner conversation

Every owner channel of an agent shares one session, the owner conversation. The functions in
this section let a product work in it without a message from the owner. They are for trusted
embedding code and have no HTTP route.

### Opening it

```ts
const { sessionId } = sessions.openOwnerConversation();
```

The call returns the owner conversation's session id and makes it usable as a `submit`
target even when the owner has never written. It creates what the owner's first message
would have created: the ledger session (the agent's writable chat in the web API) and the
binding to the Host session, with the definition an owner turn gives it. A later owner
message continues the same session and the same native thread. An existing binding is left
as it is. `submit` with this session id does the same on its own.

### Turns that answer the owner

```ts
const event = await sessions.submit({
  eventId: "message-17", sessionId, input: "The report is ready.",
  admission: { kind: "delegation", owner, agentId, reference: "message-17", toolGrants: {} },
  sender: { kind: "agent", id: "agent-b", name: "Agent B" },
  reply: {},
});
```

With `reply`, the turn answers the owner the way a turn started by a channel message does:
its answer, its notices and the cards of its questions and approvals are recorded once on the
transcript and sent along an owner route through the delivery queue, with the same retry
rules. The owner answers a card on the web or in that conversation. The route is chosen when
the turn is submitted:

| `reply.connectionId` | Route |
| --- | --- |
| omitted | the owner's newest conversation whose connection is still registered; the transcript when there is none |
| `"web"` | the transcript only |
| a notify connection | the transcript, and a push to that connection whatever its policy says |
| another connection | the owner's newest conversation on it; without one, the transcript only, reported as `suppressed` / `no_conversation_on_connection` |

A connection that is not registered is refused with `delivery_connection_not_found`. On an
external connection the answer is sent as a reply to the owner's newest message there. An
answer that reaches the owner only through the transcript is pushed by notify connections
under the same policy as an owner's web turn.

`get`, `lookup` and `wait` return the receipt as `reply: { connectionId, state, externalId,
error }`. `state` is `pending` until the answer is recorded, then `web`, `suppressed` or the
state of the send (`queued`, `submitting`, `accepted`, `failed`, `uncertain`). A connection
that was removed while the turn ran gives `failed` / `connection_removed`; the answer is
still on the transcript.

`reply` is accepted only for the owner conversation (`reply_requires_owner_conversation`) and
not for compaction (`compaction_reply_unsupported`). The turn queues behind a running turn of
the conversation like every other turn. It does not get the channel tool: that needs a
received message.

### Approvals and questions of a work turn

An approval or question that a work turn's run asks is a card in the turn's session, like one a
channel turn asks, with the same answer path and the same closing: `expired` when the Host timed
the call out, `canceled` when the run ended first. With `reply` the question is also sent along
the route. Without `reply` there is only the card: no channel message and no push. The owner
answers it through the web chat API (`POST /web/chats/:chatId/cards/:cardId/answer`, for the
owner conversation `dm:<agentId>`) or through the run API; an approval takes a choice, never text.
A card in a work session of its own (`obs:<agentId>:<sessionId>`) is listed there and answered
through the run API, because observed chats are read-only.

While such cards wait, `get`, `lookup`, `wait` and `GET .../work-events/:eventId` return them:

```ts
pendingCards?: Array<{
  cardId: string; chatId: string;            // the web chat that shows the card
  kind: "approval" | "question" | "sensitive" | "connector_approval";
  text: string; choices: Array<{ choiceId: string; label: string }>;
  deadlineAt: string | null;
  origin?: { kind: "delegation" | "schedule"; reference: string; sender?: { kind: "agent"; id: string; name: string } };
}>
```

The field is absent when nothing waits. `wait` returns as soon as it changes. Router tells no other
conversation: a product that wants the party who sent the work to know relays it itself.

`origin` is on the card (`CardView.origin`) and in `pendingCards` when the owner did not start
the turn: the admission `kind` and `reference` and the `sender` of the submission. The card's
text then begins with a line that says so, naming the sender when the submission has one, on
every surface. Pass `sender` with delegated work so the owner sees whose message asks.

`extension.communication.input(turnId)` returns the route of such a turn as an input with
`routed` set, and `isOwnerInput` is true for it because the route is the owner's. It is not
a message the owner wrote: use the turn's admission to tell whose work it is. When the
outcome of such a turn is unknown, the route gets the notice, and the retry card stays on
the transcript; it closes the turn and does not run the work again.

### Owner requests

```ts
const request = sessions.request({
  eventId: "approval-9", kind: "approval", title: "Agent B asks for approval",
  text: "Send the report to the customer?",
  choices: [{ id: "allow", label: "Allow once" }, { id: "deny", label: "Deny", style: "danger" }],
  expiresAt: "2026-01-01T12:00:00.000Z",
});
```

A request is a card with one to six choices in the owner conversation that belongs to no
run. Use it for a decision the product needs from the owner about something that happens
elsewhere. It is an ordinary ledger card with `source: "product"`: the web API returns it as
a `card` event and answers it through the card answer route, and an external conversation
gets it as a message with buttons, or with numbered choices where the channel has no
buttons. `connectionId` follows the table above. `kind: "approval"` takes exactly two
choices, the first approving and the second rejecting, and closes the card as `approved` or
`rejected`; the default `question` closes it as `answered`. An `approval` request is decided
only by its button or through the card answer route with `choiceId`: a typed label or number
never answers it, and a channel without buttons gets the text with a line that says to decide
it in the web console.

- The same `eventId` returns the same request; other content under it is refused with
  `owner_request_event_id_reused`. An `expiresAt` that has passed is refused with
  `owner_request_expired`.
- `display` is an optional JSON object the product defines for the card, with the limit of
  `submit`'s `display` (`owner_request_display_too_large`, 413). The web API returns it as
  `card.display`. Router does not interpret it, and an external conversation gets the title,
  the text and the choices only. Another `display` under the same `eventId` is other content.
- `lookupRequest(eventId)` returns `{ status, choice?, answeredBy?, surface?, settledAt?,
  delivery }`. `status` is `pending`, `answered` (with the chosen `id`), `expired` or
  `withdrawn`. A request past its deadline never reads as pending.
- The first answer wins on every surface. Only the owner can answer. In a channel the owner
  presses a button or, for a `question` request, replies with the label of a choice, and a reply that quotes the card's
  message always means that card. A number is accepted only where the card was sent as a
  numbered list, and without a quote only while the request is the only card waiting. When
  a label could mean several cards, Router asks which one. A stop or steer command is never
  taken for an answer. Router confirms an answer with the chosen label. A label the owner
  types as an ordinary message while a request waits is an answer, so choose labels that are
  not everyday replies.
- `withdrawRequest(eventId)` closes an unanswered request as `canceled`. Expiry closes it as
  `expired`. In both cases an external conversation that received the card gets one line
  saying so, and a later answer is refused there with the same line.
- A request ends as `expired` when the owner clears the conversation.

### Settlements

```ts
const { data, cursor } = sessions.settlements({ after: savedCursor, limit: 100 });
```

`settlements` lists what ended since a cursor, in the order it ended: work events whose turn
reached a terminal state (`completed`, `failed`, `cancelled`, `rejected`) and owner requests
that were answered, expired or withdrawn. Each entry is `{ seq, settledAt, kind: "work",
event }` or `{ seq, settledAt, kind: "request", request }` with the same result `get` and
`lookupRequest` return. The record is written in the transaction that ends the turn or
closes the card, and `seq` only grows, so a reader that stores `cursor` sees every ending
once, also after a restart of either side. A turn whose outcome is unknown is listed when it
is reconciled or closed. A turn that answers the owner is listed when its task ends; its
`reply` receipt may still be `pending` at that moment. The list starts with this release:
events that ended earlier are read by their id.

`skills`, `configureSkill`, `memoryStatus`, `readMemory`, and `memoryMode` use explicit
native methods. Skill discovery always supplies the selected runtime's trusted working
directory from Host inspection as `cwds`; callers cannot choose another workspace. Skill
configuration accepts only paths returned by that native skill catalog. Memory thread operations resolve the Router/Host binding before supplying
the native ID. Native experimental/disabled methods return their actual failure rather
than fabricated success. These controls are not a filesystem or cross-owner memory
isolation mechanism; that boundary belongs to the configured Host environment.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

Install separate Router and Host tarballs into an empty consumer directory, then run:

```sh
node scripts/verify-native-sessions.mjs /absolute/path/to/consumer
```

That check imports only public installed package exports and exercises Router → Host HTTP
→ a native app-server protocol subprocess. Four parent runs fill the regular budget. Each
tool forks its active native session before the unfinished turn, then actually waits while
Router starts and observes the children using the bounded reserve; their results unblock
the parents. It then restarts Router, continues the same native parent
thread and pages native history. The child's original tool-output source is retained.
A second agent on a runtime that takes text only then receives the same kind of delegated
input as the same object in text, and its ending appears in the settlement feed.
This is deterministic
protocol evidence, not live-model, live-account or cloud-environment acceptance.
