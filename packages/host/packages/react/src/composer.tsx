import { useRef, type ComponentProps, type ReactNode, type Ref } from "react";
import { ArrowUp, Square } from "lucide-react";
import clsx from "clsx";
import { useChatLabels } from "./provider.js";

export interface ChatComposerProps {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  onStop?(): void;
  running?: boolean;
  disabled?: boolean;
  canSend?: boolean;
  placeholder?: string;
  /** Product menus, attachments and queued instructions remain caller-owned. */
  before?: ReactNode;
  attachments?: ReactNode;
  inputPrefix?: ReactNode;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  resizeHandle?: ReactNode;
  unavailableReason?: string;
  sendIcon?: ReactNode;
  textareaRef?: Ref<HTMLTextAreaElement>;
  boxProps?: ComponentProps<"div"> & { "data-skill"?: string };
  inputLineProps?: ComponentProps<"div"> & { "data-skill"?: string };
  footerProps?: ComponentProps<"div">;
  textareaProps?: Omit<
    ComponentProps<"textarea">,
    "value" | "onChange" | "ref"
  >;
  classNames?: Partial<
    Record<
      | "region"
      | "box"
      | "inputLine"
      | "input"
      | "footer"
      | "footerLeft"
      | "footerRight"
      | "action"
      | "unavailable",
      string
    >
  >;
}

/** The shared composer layout, with product controls supplied through slots. */
export function ChatComposer(props: ChatComposerProps) {
  const { t } = useChatLabels();
  const composing = useRef(false);
  const c = props.classNames ?? {};
  const actionDisabled = props.running
    ? !props.onStop
    : props.disabled ||
      (props.canSend ?? Boolean(props.value.trim())) === false;
  const act = () => {
    if (!actionDisabled) (props.running ? props.onStop : props.onSend)?.();
  };
  const input = props.textareaProps;
  return (
    <section
      className={c.region ?? "agent-composer-region"}
      aria-label={props.placeholder ?? t("composer.placeholder")}
    >
      {props.before}
      <div
        {...props.boxProps}
        className={clsx(c.box ?? "agent-composer", props.boxProps?.className)}
        data-sending={props.running ? "true" : "false"}
      >
        {props.resizeHandle}
        {props.attachments}
        <div
          {...props.inputLineProps}
          className={c.inputLine ?? "agent-composer-input-line"}
        >
          {props.inputPrefix}
          <textarea
            rows={3}
            spellCheck={false}
            {...input}
            ref={props.textareaRef}
            className={clsx(
              c.input ?? "agent-composer-input",
              input?.className,
            )}
            value={props.value}
            placeholder={props.placeholder ?? t("composer.placeholder")}
            aria-label={
              input?.["aria-label"] ??
              props.placeholder ??
              t("composer.placeholder")
            }
            disabled={props.disabled}
            onChange={(event) => props.onChange(event.target.value)}
            onCompositionStart={(event) => {
              composing.current = true;
              input?.onCompositionStart?.(event);
            }}
            onCompositionEnd={(event) => {
              composing.current = false;
              input?.onCompositionEnd?.(event);
            }}
            onKeyDown={(event) => {
              if (input?.onKeyDown) {
                input.onKeyDown(event);
                return;
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !composing.current &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                // Enter never stops an active turn; the explicit stop control does.
                if (!props.running) act();
              }
            }}
          />
        </div>
        {props.unavailableReason ? (
          <div
            className={c.unavailable ?? "agent-composer-unavailable"}
            role="status"
          >
            {props.unavailableReason}
          </div>
        ) : null}
        <div
          {...props.footerProps}
          className={clsx(
            c.footer ?? "agent-composer-footer",
            props.footerProps?.className,
          )}
        >
          <div className={c.footerLeft ?? "agent-composer-footer-left"}>
            {props.footerLeft}
          </div>
          <div className={c.footerRight ?? "agent-composer-footer-right"}>
            {props.footerRight}
            <button
              className={c.action ?? "agent-composer-send"}
              type="button"
              disabled={actionDisabled}
              onClick={act}
              aria-label={
                props.running ? t("composer.stop") : t("composer.send")
              }
              title={
                props.running
                  ? t("composer.stop")
                  : props.unavailableReason || t("composer.send")
              }
            >
              {props.running ? (
                <Square size={13} fill="currentColor" strokeWidth={0} />
              ) : (
                (props.sendIcon ?? <ArrowUp size={18} />)
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
