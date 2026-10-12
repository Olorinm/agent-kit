import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Download, Maximize2, PackagePlus } from "lucide-react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChatLabels } from "./provider.js";
export interface ChatImagePayload {
  src: string;
  alt: string;
}
export type ChatMarkdownRenderOptions = {
  onPreviewImage?(image: ChatImagePayload): void;
  onSaveImageArtifact?(image: ChatImagePayload): void;
  renderLink?(label: string, href: string): ReactNode;
  resolveImageUrl?(src: string): string | undefined;
  onDownloadImage?(image: ChatImagePayload, fileName: string): Promise<void>;
  downloadErrorMessage?(error: unknown): string;
};

const ChatMarkdownRenderOptionsContext =
  createContext<ChatMarkdownRenderOptions | null>(null);
const CHAT_MARKDOWN_COMPONENTS: Components = {
  pre: MarkdownPre,
  code: MarkdownCode,
  p: MarkdownParagraph,
  a: MarkdownAnchor,
  img: MarkdownImage,
  table: MarkdownTable,
};

export function ChatMarkdown(
  props: { markdown: string } & ChatMarkdownRenderOptions,
) {
  const { markdown, ...options } = props;
  return (
    <ChatMarkdownRenderOptionsContext.Provider value={options}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={CHAT_MARKDOWN_COMPONENTS}
        skipHtml
        urlTransform={(url, key) =>
          key === "src" && safeImageUrl(url) ? url : defaultUrlTransform(url)
        }
      >
        {markdown}
      </ReactMarkdown>
    </ChatMarkdownRenderOptionsContext.Provider>
  );
}

function useChatMarkdownRenderOptions(): ChatMarkdownRenderOptions {
  const options = useContext(ChatMarkdownRenderOptionsContext);
  if (!options) {
    throw new Error(
      "Markdown components must render inside ChatMarkdownRenderer",
    );
  }
  return options;
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const options = useChatMarkdownRenderOptions();
  return <ChatImageNode src={src} alt={alt} options={options} />;
}

type CodeProps = {
  className?: string;
  children?: ReactNode;
};

function MarkdownCode({ className, children }: CodeProps) {
  const text = String(children ?? "");
  // react-markdown v10:fenced code 走 <pre><code class="language-xxx">。
  // 块级外壳由 pre override 负责,code 自身只返回合法 <code>。
  const isFenced =
    Boolean(className?.startsWith("language-")) || text.includes("\n");
  if (isFenced) {
    return <code className={className}>{text.replace(/\n$/, "")}</code>;
  }
  // inline code 永远是纯 <code>,不资源化(Phase 1 决策)。
  return <code className="thread-md-inline-code">{children}</code>;
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const codeChild = Children.toArray(children).find((child) =>
    isValidElement<{ className?: string }>(child),
  );
  const className = isValidElement<{ className?: string }>(codeChild)
    ? codeChild.props.className || ""
    : "";
  const lang = className.replace(/^language-/, "").trim();
  return (
    <div className="thread-code-block">
      {lang ? <div className="thread-code-lang">{lang}</div> : null}
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownParagraph({ children }: { children?: ReactNode }) {
  const nodes = Children.toArray(children);
  if (!nodes.some(isChatImageElement)) {
    return <p className="thread-md-p">{children}</p>;
  }

  const blocks: ReactNode[] = [];
  let inlineNodes: ReactNode[] = [];
  const flushInline = () => {
    if (!inlineNodes.some(isMeaningfulInlineNode)) {
      inlineNodes = [];
      return;
    }
    blocks.push(
      <p className="thread-md-p" key={`p-${blocks.length}`}>
        {inlineNodes}
      </p>,
    );
    inlineNodes = [];
  };

  nodes.forEach((node) => {
    if (isChatImageElement(node)) {
      flushInline();
      blocks.push(node);
      return;
    }
    inlineNodes.push(node);
  });
  flushInline();

  return <>{blocks}</>;
}

function MarkdownAnchor({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const options = useChatMarkdownRenderOptions();
  const label = nodeToText(children);
  const target = String(href || "");
  if (options.renderLink) return options.renderLink(label, target);
  return /^(https?:|mailto:|#)/i.test(target) ? (
    <a
      className="thread-md-link"
      href={target}
      target={target.startsWith("#") ? undefined : "_blank"}
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="thread-md-table-wrap">
      <table className="thread-md-table">{children}</table>
    </div>
  );
}

// ===== image:复用 Phase 1 的 figure/预览/下载/存成果 交互 =====

function ChatImageNode(props: {
  src?: string;
  alt?: string;
  options: ChatMarkdownRenderOptions;
}) {
  const safeSrc = props.options.resolveImageUrl
    ? props.options.resolveImageUrl(String(props.src || ""))
    : safeImageUrl(String(props.src || ""));
  if (!safeSrc) {
    return null;
  }
  const image: ChatImagePayload = {
    src: safeSrc,
    alt: String(props.alt || ""),
  };
  return (
    <ChatRenderedImage
      image={image}
      onPreview={props.options.onPreviewImage}
      onSaveArtifact={props.options.onSaveImageArtifact}
      onDownload={props.options.onDownloadImage}
      downloadErrorMessage={props.options.downloadErrorMessage}
    />
  );
}

function isChatImageElement(node: ReactNode): boolean {
  return isValidElement(node) && node.type === MarkdownImage;
}

function isMeaningfulInlineNode(node: ReactNode): boolean {
  if (typeof node === "string") return node.trim().length > 0;
  return node != null && node !== false;
}

function ChatRenderedImage(props: {
  image: ChatImagePayload;
  onPreview?(image: ChatImagePayload): void;
  onSaveArtifact?(image: ChatImagePayload): void;
  onDownload?(image: ChatImagePayload, fileName: string): Promise<void>;
  downloadErrorMessage?(error: unknown): string;
}) {
  const { t } = useChatLabels();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const fileName = fileNameFromImageSrc(props.image.src);
  const openPreview = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    props.onPreview?.(props.image);
  };
  const download = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDownloading(true);
    setDownloadError("");
    void Promise.resolve()
      .then(() => props.onDownload?.(props.image, fileName))
      .catch((error) =>
        setDownloadError(
          props.downloadErrorMessage?.(error) ??
            (error instanceof Error ? error.message : String(error)),
        ),
      )
      .finally(() => setDownloading(false));
  };
  return (
    <figure className="thread-image-figure">
      <div className="thread-image-frame">
        <button
          type="button"
          className="thread-image-preview-button"
          onClick={openPreview}
          aria-label={t("chat.previewImageAria", {
            name: props.image.alt || fileName,
          })}
        >
          <img
            className="thread-rendered-image"
            src={props.image.src}
            alt={props.image.alt}
          />
        </button>
        <span className="thread-image-action-buttons">
          <button
            type="button"
            className="thread-image-action"
            onClick={openPreview}
            aria-label={t("chat.previewAria", {
              name: props.image.alt || fileName,
            })}
            title={t("thread.resourcePreview")}
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            className="thread-image-action"
            onClick={download}
            disabled={downloading || !props.onDownload}
            aria-label={t("chat.downloadAria", {
              name: props.image.alt || fileName,
            })}
            title={t("filePreview.download")}
          >
            <Download size={13} />
          </button>
          {props.onSaveArtifact ? (
            <button
              type="button"
              className="thread-image-action"
              onClick={() => props.onSaveArtifact?.(props.image)}
              aria-label={t("chat.saveToArtifactsAria", {
                name: props.image.alt || fileName,
              })}
              title={t("chat.saveToArtifacts")}
            >
              <PackagePlus size={13} />
            </button>
          ) : null}
        </span>
      </div>
      <figcaption className="thread-image-caption">
        {props.image.alt || fileName}
      </figcaption>
      {downloadError ? (
        <span className="thread-image-download-error" role="alert">
          {downloadError}
        </span>
      ) : null}
    </figure>
  );
}

function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return nodeToText(node.props.children);
  return "";
}

function fileNameFromImageSrc(src: string): string {
  try {
    const url = new URL(src, "http://localhost");
    const name = url.pathname.split("/").filter(Boolean).at(-1);
    return name || "image";
  } catch {
    return "image";
  }
}

export function safeImageUrl(src: string): string | undefined {
  return /^(https?:\/\/|blob:|data:image\/(?:png|jpeg|gif|webp|avif);base64,)/i.test(
    src,
  )
    ? src
    : undefined;
}
