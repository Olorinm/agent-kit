import { useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ChevronRight, Wrench } from "lucide-react";
import { ChatButton } from "./provider.js";

/** Tool labels and semantics belong to the caller; this owns the shared layout. */
export function ActivityRow(props: {
  title: ReactNode;
  status?: string;
  icon?: ReactNode;
  className?: string;
  titleTooltip?: string;
  detail?: { label: ReactNode; title?: string };
  fullDetail?: string;
  header?: ReactNode;
  children?: ReactNode;
  error?: string;
  errorTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={clsx(
        "thread-activity-row",
        `status-${props.status ?? "completed"}`,
        props.className,
      )}
    >
      <span className="thread-activity-row-icon" aria-hidden="true">
        {props.icon ?? <Wrench size={14} />}
      </span>
      <div className="thread-activity-row-body">
        {props.header ?? (
          <>
            {props.fullDetail ? (
              <button
                type="button"
                className="thread-activity-row-toggle"
                aria-expanded={open}
                title={props.titleTooltip}
                onClick={() => setOpen(!open)}
              >
                <span className="thread-activity-row-title-line">
                  <span className="thread-activity-row-title">
                    {props.title}
                  </span>
                  <ChevronRight
                    className="thread-activity-row-detail-chevron"
                    size={13}
                    strokeWidth={2.1}
                    aria-hidden="true"
                  />
                </span>
                {props.detail?.label ? (
                  <span className="thread-activity-row-detail">
                    {props.detail.label}
                  </span>
                ) : null}
              </button>
            ) : (
              <>
                <div
                  className="thread-activity-row-title"
                  title={props.titleTooltip}
                >
                  {props.title}
                </div>
                {props.detail ? (
                  <div
                    className="thread-activity-row-detail"
                    title={props.detail.title}
                  >
                    {props.detail.label}
                  </div>
                ) : null}
              </>
            )}
            {props.fullDetail && open ? (
              <pre className="thread-activity-row-full-detail">
                {props.fullDetail}
              </pre>
            ) : null}
          </>
        )}
        {props.children}
        {props.error ? (
          <div
            className="thread-activity-row-error"
            role="alert"
            title={props.errorTitle}
          >
            {props.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
export interface InteractionChoice {
  id: string;
  label: string;
  description?: string;
  primary?: boolean;
  disabled?: boolean;
}
/** Uses exact caller-provided choice IDs, including native persistence scopes. */
export function InteractionActions({
  choices,
  onChoose,
  disabled = false,
}: {
  choices: InteractionChoice[];
  onChoose(id: string): void | Promise<unknown>;
  disabled?: boolean;
}) {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState("");
  const choose = (id: string) => {
    if (
      lock.current ||
      disabled ||
      resolved ||
      !choices.some((c) => c.id === id && !c.disabled)
    )
      return;
    lock.current = true;
    setPending(true);
    setError("");
    Promise.resolve()
      .then(() => onChoose(id))
      .then(
        () => setResolved(true),
        (reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      )
      .finally(() => {
        lock.current = false;
        setPending(false);
      });
  };
  return (
    <>
      <div
        className="thread-approval-actions compact"
        aria-busy={pending || undefined}
      >
        {choices.map((choice) => (
          <ChatButton
            key={choice.id}
            variant={choice.primary ? "primary" : "ghost"}
            disabled={disabled || pending || resolved || choice.disabled}
            title={choice.description}
            onClick={() => choose(choice.id)}
          >
            {choice.label}
          </ChatButton>
        ))}
      </div>
      {error ? (
        <div
          className="thread-activity-row-error thread-approval-error"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </>
  );
}
export function EditDiff({
  lines,
  label = "Changes",
}: {
  lines: Array<{ kind: "add" | "del" | "meta" | "context"; text: string }>;
  label?: string;
}) {
  return (
    <pre className="thread-activity-edit-diff" aria-label={label}>
      {lines.map((line, index) => (
        <code
          key={index}
          className={`thread-activity-edit-diff-line is-${line.kind}`}
        >
          <span className="thread-activity-edit-diff-sign" aria-hidden="true">
            {line.kind === "add"
              ? "+"
              : line.kind === "del"
                ? "-"
                : line.kind === "meta"
                  ? ""
                  : " "}
          </span>
          <span className="thread-activity-edit-diff-text">{line.text}</span>
        </code>
      ))}
    </pre>
  );
}
