import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ActivityRow, InteractionActions } from "./activity.js";
import { QuestionForm, type QuestionAnswers } from "./question-form.js";
import { Disclosure } from "./disclosure.js";
import { ChatProvider, useChatLabels } from "./provider.js";

const defaultInteractionLabels = {
  expired: "Request is no longer active",
  details: "Request details",
  schema: "Requested schema",
  native: "Native request",
  json: "JSON response",
  unsupportedUrl: "Unsupported URL scheme",
  completed: "I have completed this step",
  submit: "Submit response",
  decline: "Decline",
  cancel: "Cancel request",
  objectRequired: "Form response must be a JSON object",
};

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json | undefined };
/** Structural subset of Agent Host's Interaction; no runtime or Node dependency. */
export interface HostInteraction {
  kind: "approval" | "questions" | "form" | "url" | "native";
  title: string;
  choices?: Array<{
    id: string;
    label: string;
    scope?: string;
    allows?: boolean;
  }>;
  questions?: Array<{
    id: string;
    title: string;
    options?: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    secret?: boolean;
  }>;
  permissions?: unknown;
  schema?: unknown;
  url?: string;
  native: unknown;
}
export type HostInteractionAnswer =
  | { choice: string }
  | { answers: QuestionAnswers }
  | { action: "accept"; content?: { [key: string]: Json | undefined } }
  | { action: "decline" | "cancel" }
  | { native: Json };
export interface HostInteractionProps {
  /** Stable native/remote call identity; changing it resets all local form state. */
  requestId: string;
  request: HostInteraction;
  disabled?: boolean;
  labels?: Partial<typeof defaultInteractionLabels>;
  onReply(answer: HostInteractionAnswer): void | Promise<unknown>;
  renderNative?(props: Omit<HostInteractionProps, "renderNative">): ReactNode;
}
export function AgentInteraction(props: HostInteractionProps) {
  return <InteractionContent key={props.requestId} {...props} />;
}
function InteractionContent(props: HostInteractionProps) {
  const request = props.request;
  const labels = { ...defaultInteractionLabels, ...props.labels };
  const { t } = useChatLabels();
  if (request.kind === "questions")
    return (
      <ChatProvider
        translate={(key, values) =>
          key === "activity.cancelRun"
            ? labels.cancel
            : key === "activity.skip" || key === "activity.cancelAll"
              ? labels.decline
              : t(key, values)
        }
      >
        <QuestionForm
          title={request.title}
          allowSkip={false}
          disabledReason={props.disabled ? labels.expired : undefined}
          questions={(request.questions ?? []).map((q) => ({
            ...q,
            multiSelect: q.multiple,
            options: (q.options ?? []).map((option) => ({
              ...option,
              value: option.label,
            })),
          }))}
          onAnswer={(answers) => props.onReply({ answers })}
          onDecline={() => props.onReply({ action: "decline" })}
          onCancel={() => props.onReply({ action: "cancel" })}
        />
      </ChatProvider>
    );
  if (request.kind === "approval")
    return (
      <ActivityRow title={request.title} status="approval">
        <Disclosure summary={labels.details}>
          <pre>
            {JSON.stringify(request.permissions ?? request.native, null, 2)}
          </pre>
        </Disclosure>
        <InteractionActions
          disabled={props.disabled}
          choices={(request.choices ?? []).map((choice) => ({
            id: choice.id,
            label: choice.label,
            description: choice.scope,
            primary: choice.allows && choice.scope === "once",
          }))}
          onChoose={(choice) => props.onReply({ choice })}
        />
      </ActivityRow>
    );
  return props.renderNative ? (
    props.renderNative(props)
  ) : (
    <NativeInteraction {...props} />
  );
}
/** Explicit JSON fallback retains forms and unknown native replies without inventing fields. */
function NativeInteraction({
  request,
  onReply,
  disabled,
  labels: overrides,
}: HostInteractionProps) {
  const labels = { ...defaultInteractionLabels, ...overrides };
  const [text, setText] = useState("{}");
  const safeUrl =
    request.url && /^https?:\/\//i.test(request.url) ? request.url : undefined;
  return (
    <ActivityRow title={request.title} status="approval">
      <Disclosure
        summary={request.kind === "form" ? labels.schema : labels.native}
      >
        <pre>{JSON.stringify(request.schema ?? request.native, null, 2)}</pre>
      </Disclosure>
      {request.kind === "url" ? (
        safeUrl ? (
          <a href={safeUrl} target="_blank" rel="noreferrer noopener">
            {safeUrl}
          </a>
        ) : (
          <p role="alert">{labels.unsupportedUrl}</p>
        )
      ) : (
        <label>
          {labels.json}
          <textarea
            className="thread-approval-input"
            aria-label={labels.json}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={disabled}
          />
        </label>
      )}
      <InteractionActions
        disabled={disabled}
        choices={[
          {
            id: "accept",
            label: request.kind === "url" ? labels.completed : labels.submit,
            disabled: request.kind === "url" && !safeUrl,
          },
          { id: "decline", label: labels.decline },
          { id: "cancel", label: labels.cancel },
        ]}
        onChoose={(action) => {
          if (action === "decline" || action === "cancel")
            return onReply({ action });
          if (request.kind === "url") return onReply({ action: "accept" });
          const parsed: Json = JSON.parse(text);
          if (request.kind === "native") return onReply({ native: parsed });
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error(labels.objectRequired);
          return onReply({ action: "accept", content: parsed });
        }}
      />
    </ActivityRow>
  );
}

export interface HostEvent {
  type: string;
  runId: string;
  text?: string;
}
export interface RunView<E extends HostEvent = HostEvent> {
  runId: string;
  sequence: number;
  text: string;
  reasoning: string;
  events: E[];
}
export function createRunView<E extends HostEvent = HostEvent>(
  runId: string,
): RunView<E> {
  return { runId, sequence: 0, text: "", reasoning: "", events: [] };
}
/** Ordered service-event projection. Native events remain available to product renderers. */
export function appendRunEvent<E extends HostEvent>(
  state: RunView<E>,
  item: { sequence: number; event: E },
): RunView<E> {
  if (item.event.runId !== state.runId) throw new Error("run_event_mismatch");
  if (item.sequence <= state.sequence) return state;
  return {
    ...state,
    sequence: item.sequence,
    events: [...state.events, item.event],
    text:
      item.event.type === "assistant.delta"
        ? state.text + (item.event.text ?? "")
        : state.text,
    reasoning:
      item.event.type === "reasoning.delta"
        ? state.reasoning + (item.event.text ?? "")
        : state.reasoning,
  };
}

export interface PendingInteraction {
  id: string;
  request: HostInteraction;
  reply(answer: HostInteractionAnswer): void;
}
/** Connect directly to Agent Host's onInteraction callback, in either hosting mode. */
export function useAgentInteractions() {
  const prefix = useId();
  const counter = useRef(0);
  const [pending, setPending] = useState<PendingInteraction[]>([]);
  const active = useRef(new Map<string, () => void>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    // React Strict Mode may replay setup after cleanup without discarding state.
    setPending((items) => items.filter((item) => active.current.has(item.id)));
    return () => {
      mounted.current = false;
      for (const abort of active.current.values()) abort();
    };
  }, []);
  const onInteraction = useCallback(
    (
      request: HostInteraction,
      { signal }: { signal: AbortSignal },
    ): Promise<HostInteractionAnswer> => {
      if (!mounted.current || signal.aborted)
        return Promise.reject(
          signal.reason ?? new DOMException("Interaction closed", "AbortError"),
        );
      return new Promise((resolve, reject) => {
        const id = `${prefix}-${++counter.current}`;
        const finish = (answer?: HostInteractionAnswer) => {
          if (!active.current.delete(id)) return;
          signal.removeEventListener("abort", abort);
          if (mounted.current)
            setPending((current) => current.filter((item) => item.id !== id));
          if (answer) resolve(answer);
          else
            reject(
              signal.reason ??
                new DOMException("Interaction closed", "AbortError"),
            );
        };
        const abort = () => finish();
        active.current.set(id, abort);
        signal.addEventListener("abort", abort, { once: true });
        setPending((current) => [...current, { id, request, reply: finish }]);
      });
    },
    [prefix],
  );
  return { pending, onInteraction };
}
