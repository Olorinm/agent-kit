import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatComposer,
  ChatMarkdown,
  ChatMessage,
  Disclosure,
  ImagePreview,
  ResourceCard,
  InteractionActions,
  type ChatImagePayload,
} from "@olorinm/agent-ui";
import {
  AgentInteraction,
  useAgentInteractions,
} from "@olorinm/agent-ui/agent-host";
import "@olorinm/agent-ui/styles.css";
const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
function Fixture() {
  const [value, setValue] = useState(""),
    [sent, setSent] = useState<string[]>([]);
  const [running, setRunning] = useState(false),
    [reply, setReply] = useState("");
  const [preview, setPreview] = useState<ChatImagePayload | null>(null),
    [resource, setResource] = useState("");
  const [mode, setMode] = useState("approval"),
    [identity, setIdentity] = useState(1);
  const [attempts, setAttempts] = useState(0),
    [theme, setTheme] = useState("light");
  const { pending, onInteraction } = useAgentInteractions();
  const controller = useRef<AbortController | null>(null);
  const request =
    mode === "questions"
      ? {
          kind: "questions" as const,
          title: "Questions",
          native: {},
          questions: [
            {
              id: "paths",
              title: "Choose paths",
              multiple: true,
              options: [{ label: "one,two" }, { label: "three" }],
            },
            { id: "secret", title: "Secret", secret: true },
          ],
        }
      : mode === "form"
        ? {
            kind: "form" as const,
            title: "Details",
            schema: { type: "object" },
            native: { method: "elicitation/create" },
          }
        : mode === "native"
          ? {
              kind: "native" as const,
              title: "Native",
              native: { method: "unusual" },
            }
          : {
              kind: "approval" as const,
              title: "Allow operation?",
              native: { method: "requestPermission" },
              choices: [
                {
                  id: "native-once",
                  label: "Allow once",
                  scope: "once",
                  allows: true,
                },
                {
                  id: "native-always",
                  label: "Always allow",
                  scope: "always",
                  allows: true,
                },
                { id: "native-deny", label: "Deny", allows: false },
              ],
            };
  return (
    <div
      className="agent-chat"
      data-theme={theme}
      style={{ padding: 24, minHeight: "100vh" }}
    >
      <h1>Shared chat components</h1>
      <ChatMessage role="assistant">
        <div className="thread-text-block">
          <ChatMarkdown
            markdown={
              "**Ready**\n\n| Name | State |\n| --- | --- |\n| Agent | Ready |\n\n```js\nconst ok = true;\n```\n\n[**Docs**](https://example.com)\n\n![Sample](" +
              pixel +
              ")\n\n[unsafe](javascript:alert(1))\n<script>window.bad=true</script>"
            }
            onPreviewImage={setPreview}
          />
        </div>
      </ChatMessage>
      <Disclosure summary="Process">
        <button onClick={() => setReply("process-clicked")}>
          Hidden action
        </button>
      </Disclosure>
      <ResourceCard
        resource={{ title: "result.txt", path: "result.txt" }}
        onOpen={setResource}
        renderMenu={({ open, close }) => (
          <div role="menu">
            <button role="menuitem" onClick={() => open("download")}>
              Download resource
            </button>
            <button onClick={close}>Close menu</button>
          </div>
        )}
      >
        <span>result.txt</span>
      </ResourceCard>
      <output aria-label="Resource action">{resource}</output>
      <nav>
        {["approval", "questions", "form", "native"].map((item) => (
          <button
            key={item}
            onClick={() => {
              setMode(item);
              setIdentity(identity + 1);
              setReply("");
            }}
          >
            {item}
          </button>
        ))}
      </nav>
      <AgentInteraction
        requestId={String(identity)}
        request={request}
        onReply={(answer) => setReply(JSON.stringify(answer))}
      />
      <output aria-label="Reply">{reply}</output>
      <InteractionActions
        choices={[{ id: "retry", label: "Retry action" }]}
        onChoose={async () => {
          setAttempts((n) => n + 1);
          if (!attempts) throw new Error("Transient failure");
        }}
      />
      <output aria-label="Attempts">{attempts}</output>
      <button
        onClick={() => {
          controller.current = new AbortController();
          void onInteraction(
            {
              kind: "approval",
              title: "Live request",
              native: {},
              choices: [{ id: "live", label: "Live approve" }],
            },
            { signal: controller.current.signal },
          ).then(
            (answer) => setReply(JSON.stringify(answer)),
            () => setReply("aborted"),
          );
        }}
      >
        Start interaction
      </button>
      <button onClick={() => controller.current?.abort()}>
        Abort interaction
      </button>
      {pending.map((item) => (
        <AgentInteraction
          key={item.id}
          requestId={item.id}
          request={item.request}
          onReply={item.reply}
        />
      ))}
      <ChatComposer
        value={value}
        onChange={setValue}
        running={running}
        onSend={() => {
          setSent((items) => [...items, value]);
          setValue("");
          setRunning(true);
        }}
        onStop={() => setRunning(false)}
      />
      <output aria-label="Sent">{JSON.stringify(sent)}</output>
      <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
        Theme
      </button>
      {preview ? (
        <ImagePreview image={preview} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
