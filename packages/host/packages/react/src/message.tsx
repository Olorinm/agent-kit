import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { Bot, UserRound, X } from "lucide-react";
import clsx from "clsx";
import { useChatLabels } from "./provider.js";
import type { ChatImagePayload } from "./markdown.js";
export interface ChatMessageProps {
  role: string;
  title?: ReactNode;
  avatar?: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}
export function ChatMessage(props: ChatMessageProps) {
  return (
    <article
      className={clsx("thread-message", `role-${props.role}`, props.className)}
      data-role={props.role}
    >
      <header className="thread-message-header">
        <div
          className={clsx("thread-message-avatar", `role-${props.role}`)}
          aria-hidden="true"
        >
          {props.avatar ??
            (props.role === "user" ? (
              <UserRound size={16} />
            ) : (
              <Bot size={16} />
            ))}
        </div>
        <div className="thread-message-meta">
          <div className="thread-message-role-row">
            <span className="thread-message-role">
              {props.title ?? props.role}
            </span>
            {props.status}
          </div>
          <div className="thread-message-subtitle">{props.subtitle}</div>
        </div>
        {props.actions}
      </header>
      <div className="thread-message-content">{props.children}</div>
    </article>
  );
}
export function ChatTranscript<T>({
  messages,
  getKey,
  renderMessage,
  empty,
  className,
}: {
  messages: readonly T[];
  getKey(message: T): string;
  renderMessage(message: T, index: number): ReactNode;
  empty?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("thread-stack", className)}>
      {messages.length
        ? messages.map((message, index) => (
            <Fragment key={getKey(message)}>
              {renderMessage(message, index)}
            </Fragment>
          ))
        : empty}
    </div>
  );
}
export function ImagePreview({
  image,
  onClose,
}: {
  image: ChatImagePayload;
  onClose(): void;
}) {
  const { t } = useChatLabels();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <div
      className="thread-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={image.alt || t("chat.imagePreview")}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        if (event.key === "Tab") {
          event.preventDefault();
          closeRef.current?.focus();
        }
      }}
    >
      <div
        className="thread-image-lightbox-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="thread-image-lightbox-header">
          <div>{image.alt || t("chat.imagePreview")}</div>
          <button
            ref={closeRef}
            type="button"
            className="thread-image-icon-button"
            onClick={onClose}
            aria-label={t("chat.closePreview")}
          >
            <X size={16} />
          </button>
        </div>
        <img src={image.src} alt={image.alt || t("chat.imagePreview")} />
      </div>
    </div>
  );
}
