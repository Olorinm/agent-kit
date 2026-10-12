import {
  createContext,
  useContext,
  type ButtonHTMLAttributes,
  type ComponentType,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { defaultLabels, type ChatLabelKey } from "./labels.js";
export type ChatTranslate = (
  key: ChatLabelKey,
  values?: Record<string, string | number>,
) => string;
export interface ChatButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
}
const defaultTranslate: ChatTranslate = (key, values) =>
  defaultLabels[key].replace(/\{([^}]+)\}/g, (token, name: string) =>
    String(values?.[name] ?? token),
  );
const Context = createContext<{
  t: ChatTranslate;
  Button: ComponentType<ChatButtonProps>;
}>({ t: defaultTranslate, Button: DefaultButton });
function DefaultButton({
  variant = "ghost",
  className,
  ...props
}: ChatButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={clsx(
        variant === "primary" ? "primary-button" : "ghost-button",
        className,
      )}
    />
  );
}
/** No store, network access or product provider is required. */
export function ChatProvider({
  children,
  translate,
  Button,
}: {
  children: ReactNode;
  translate?: ChatTranslate;
  Button?: ComponentType<ChatButtonProps>;
}) {
  const parent = useContext(Context);
  return (
    <Context.Provider
      value={{ t: translate ?? parent.t, Button: Button ?? parent.Button }}
    >
      {children}
    </Context.Provider>
  );
}
export function useChatLabels() {
  return { t: useContext(Context).t };
}
export function ChatButton(props: ChatButtonProps) {
  const { Button } = useContext(Context);
  return <Button {...props} />;
}
