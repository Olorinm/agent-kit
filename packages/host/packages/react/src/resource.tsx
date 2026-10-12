import { useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
export interface ResourceDescriptor {
  title: string;
  kind?: string;
  origin?: string;
  path?: string;
  line?: number;
}
export interface ResourceMenuContext {
  position: { x: number; y: number };
  close(): void;
  open(action?: string): void;
}
/** Resource identity and actions are provided by the product; no filesystem or API access. */
export function ResourceCard({
  resource,
  children,
  onOpen,
  renderMenu,
  moreLabel = "More",
}: {
  resource: ResourceDescriptor;
  children: ReactNode;
  onOpen?(action: string): void;
  renderMenu?(context: ResourceMenuContext): ReactNode;
  moreLabel?: string;
}) {
  const trigger = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const close = () => {
    setPosition(null);
    trigger.current?.focus({ preventScroll: true });
  };
  const open = (action = "preview") => {
    close();
    onOpen?.(action);
  };
  const openMenu = (event: React.MouseEvent) => {
    if (!renderMenu) return;
    event.preventDefault();
    event.stopPropagation();
    setPosition({ x: event.clientX, y: event.clientY });
  };
  return (
    <>
      <article
        ref={trigger}
        className="thread-artifact-card thread-resource-card"
        role="button"
        tabIndex={0}
        data-resource-reference="true"
        data-resource-origin={resource.origin}
        data-resource-kind={resource.kind}
        data-resource-path={resource.path}
        data-resource-title={resource.title}
        data-resource-line={resource.line ? String(resource.line) : undefined}
        onClick={() => open()}
        onDoubleClick={() => open("open")}
        onContextMenu={openMenu}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            open();
          }
        }}
      >
        {children}
        {renderMenu ? (
          <span className="thread-resource-card-actions">
            <button
              type="button"
              className="thread-resource-card-action"
              title={moreLabel}
              aria-label={moreLabel}
              onClick={openMenu}
            >
              <MoreHorizontal size={14} />
            </button>
          </span>
        ) : null}
      </article>
      {position && renderMenu ? renderMenu({ position, close, open }) : null}
    </>
  );
}
