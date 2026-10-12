import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentHostClient } from "@olorinm/agent-host/client";
import {
  ChatComposer,
  ChatMarkdown,
  ChatMessage,
  ChatTranscript,
  Disclosure,
  ActivityRow,
  ImagePreview,
  ResourceCard,
} from "@olorinm/agent-ui";
import {
  AgentInteraction,
  useAgentInteractions,
  createRunView,
  appendRunEvent,
} from "@olorinm/agent-ui/agent-host";
import "@olorinm/agent-ui/styles.css";
import "./editor.css";

async function product(path, value) {
  const response = await fetch("/product/" + path, {
    headers: { "x-editor-client": "1", "content-type": "application/json" },
    ...(value ? { method: "POST", body: JSON.stringify(value) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function Editor({ client, profiles, initialProject }) {
  const [project, setProject] = useState(initialProject);
  const [runtime, setRuntime] = useState(
    profiles.find((p) => p.available)?.id ?? "",
  );
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState([]);
  const [view, setView] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [preview, setPreview] = useState(null);
  const [theme, setTheme] = useState("light");
  const [historyGap, setHistoryGap] = useState(false);
  const task = useRef(null),
    observer = useRef(null),
    sending = useRef(false);
  const { pending, onInteraction } = useAgentInteractions();
  useEffect(() => () => observer.current?.abort(), []);
  const profile = profiles.find((item) => item.id === runtime);
  const tools = [
    {
      name: "edit_document",
      description:
        "Replace the document after the user approves in the product.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(input, context) {
        if (typeof input?.text !== "string")
          throw new Error("Invalid document text");
        const answer = await onInteraction(
          {
            kind: "approval",
            title: "Replace this document?",
            choices: [
              { id: "apply", label: "Apply edit", scope: "once", allows: true },
              { id: "reject", label: "Keep original", allows: false },
            ],
            native: { method: "edit_document", params: input },
          },
          context,
        );
        if (answer.choice !== "apply")
          return {
            success: false,
            contentItems: [
              { type: "inputText", text: "User declined this edit." },
            ],
          };
        context.signal.throwIfAborted();
        const result = await product("apply", {
          runId: context.runId,
          callId: context.callId,
          text: input.text,
        });
        setProject(await product("document"));
        return result;
      },
    },
  ];
  const send = async () => {
    if (sending.current || (!prompt.trim() && !attachments.length)) return;
    sending.current = true;
    setRunning(true);
    setError("");
    setHistoryGap(false);
    const text = prompt,
      files = attachments;
    const userId = crypto.randomUUID();
    try {
      const next = await client
        .session({
          sessionId: project.sessionId,
          runtimeId: runtime,
          tools,
          instructions:
            "Help edit this document. Always use edit_document to change it. The product owns approval and persistence. Never write project.json through shell or native tools. Respect rejected edits.",
        })
        .run(
          text,
          { document: project.text },
          files.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
        );
      task.current = next;
      setMessages((items) => [
        ...items,
        { id: userId, role: "user", text, files },
      ]);
      setPrompt("");
      setAttachments([]);
      setView(createRunView(next.runId));
      const controller = new AbortController();
      observer.current = controller;
      const result = await next.wait({
        signal: controller.signal,
        onInteraction,
        onHistoryGap: () => setHistoryGap(true),
        onEvent: (item) =>
          setView((current) =>
            appendRunEvent(current ?? createRunView(item.event.runId), item),
          ),
      });
      setMessages((items) => [
        ...items,
        {
          id: next.runId,
          role: "assistant",
          text: result.answer,
          status: result.status,
        },
      ]);
      setView(null);
      if (result.outcome?.error) setError(result.outcome.error);
    } catch (reason) {
      setError(reason.message);
    } finally {
      sending.current = false;
      setRunning(false);
      task.current = null;
      observer.current = null;
    }
  };
  const chooseFiles = async (event) => {
    const selected = [...event.target.files];
    event.target.value = "";
    try {
      if (
        selected.reduce((total, file) => total + file.size, 0) +
          attachments.reduce(
            (total, file) => total + file.data.length * 0.75,
            0,
          ) >
        500_000
      )
        throw new Error(
          "This example allows up to 500 KB of attachments per turn.",
        );
      const prepared = await Promise.all(
        selected.map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return {
            id: crypto.randomUUID(),
            name: file.name,
            mediaType: file.type || "application/octet-stream",
            data: btoa(binary),
          };
        }),
      );
      setAttachments((current) => [...current, ...prepared]);
    } catch (reason) {
      setError(reason.message);
    }
  };
  const renderFiles = (files, removable = false) =>
    files?.map((file) => (
      <div className="editor-attachment" key={file.id}>
        <ResourceCard
          resource={{ title: file.name, kind: "attachment" }}
          onOpen={() =>
            file.mediaType.startsWith("image/")
              ? setPreview({
                  src: "data:" + file.mediaType + ";base64," + file.data,
                  alt: file.name,
                })
              : undefined
          }
        >
          <span>{file.name}</span>
        </ResourceCard>
        {removable ? (
          <button
            aria-label={"Remove " + file.name}
            onClick={() =>
              setAttachments((current) =>
                current.filter((item) => item.id !== file.id),
              )
            }
          >
            Remove
          </button>
        ) : null}
      </div>
    ));
  return (
    <main className="agent-chat editor" data-theme={theme}>
      <header className="editor-header">
        <div>
          <h1>Document editor</h1>
          <p>One product, your choice of agent.</p>
        </div>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch theme
        </button>
      </header>
      <div className="editor-columns">
        <aside>
          <h2>Your document</h2>
          <pre data-testid="document">{project.text}</pre>
        </aside>
        <section aria-label="Conversation">
          <ChatTranscript
            messages={messages}
            getKey={(message) => message.id}
            renderMessage={(message) => (
              <ChatMessage role={message.role} status={message.status}>
                {message.role === "user" ? (
                  <div className="thread-user-bubble">{message.text}</div>
                ) : (
                  <div className="thread-text-block">
                    <ChatMarkdown
                      markdown={message.text}
                      onPreviewImage={setPreview}
                    />
                  </div>
                )}
                {renderFiles(message.files)}
              </ChatMessage>
            )}
          />
          {view ? (
            <ChatMessage role="assistant" status="Working">
              <Disclosure summary={"Agent activity · " + view.events.length}>
                {view.reasoning ? <p>{view.reasoning}</p> : null}
                {view.events
                  .filter(
                    (event) =>
                      event.type === "tool.started" ||
                      event.type === "native.tool",
                  )
                  .map((event, index) => (
                    <ActivityRow
                      key={index}
                      title={event.tool ?? event.type}
                      fullDetail={JSON.stringify(event, null, 2)}
                    />
                  ))}
              </Disclosure>
              <div className="thread-text-block">
                <ChatMarkdown
                  markdown={view.text}
                  onPreviewImage={setPreview}
                />
              </div>
            </ChatMessage>
          ) : null}
          {pending.map((item) => (
            <AgentInteraction
              key={item.id}
              requestId={item.id}
              request={item.request}
              onReply={item.reply}
            />
          ))}
          {historyGap ? (
            <p role="status">
              Earlier progress is unavailable. The final answer will still be
              shown.
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <ChatComposer
            value={prompt}
            onChange={setPrompt}
            onSend={() => void send()}
            running={running}
            disabled={!profile?.available}
            canSend={Boolean(prompt.trim() || attachments.length)}
            onStop={() => {
              void task.current
                ?.cancel()
                .catch((reason) => setError(reason.message));
            }}
            attachments={
              <div className="editor-attachments">
                {renderFiles(attachments, true)}
              </div>
            }
            footerLeft={
              <>
                <label>
                  Agent{" "}
                  <select
                    aria-label="Agent"
                    disabled={running || messages.length > 0}
                    value={runtime}
                    onChange={(event) => setRuntime(event.target.value)}
                  >
                    {profiles.map((item) => (
                      <option
                        key={item.id}
                        value={item.id}
                        disabled={!item.available}
                      >
                        {item.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Attach{" "}
                  <input
                    aria-label="Attach files"
                    type="file"
                    multiple
                    disabled={!profile?.inputs?.attachments || running}
                    onChange={chooseFiles}
                  />
                </label>
              </>
            }
          />
        </section>
      </div>
      {preview ? (
        <ImagePreview image={preview} onClose={() => setPreview(null)} />
      ) : null}
    </main>
  );
}
const root = createRoot(document.getElementById("root"));
try {
  const client = await new AgentHostClient({
    baseUrl: location.origin + "/host",
    headers: { "x-editor-client": "1" },
  }).connect();
  const [profiles, initialProject] = await Promise.all([
    client.runtimes(),
    product("document"),
  ]);
  root.render(
    <Editor
      client={client}
      profiles={profiles}
      initialProject={initialProject}
    />,
  );
} catch (error) {
  root.render(<p role="alert">{error.message}</p>);
}
