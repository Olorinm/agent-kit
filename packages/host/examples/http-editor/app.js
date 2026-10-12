import { AgentHostClient } from "/client.js";
const el = (id) => document.getElementById(id);
const client = await new AgentHostClient({
  baseUrl: `${location.origin}/host`,
  headers: { "x-editor-client": "1" },
}).connect();
const product = async (path, value) => {
  const response = await fetch(`/product/${path}`, {
    headers: { "x-editor-client": "1", "content-type": "application/json" },
    ...(value ? { method: "POST", body: JSON.stringify(value) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
};
let project = await product("document"),
  task,
  observer,
  observing;
el("document").textContent = project.text;
const profiles = await client.runtimes();
for (const profile of profiles) {
  const option = document.createElement("option");
  option.value = profile.id;
  option.textContent = `${profile.id}${profile.available ? "" : "（未就绪）"}`;
  option.disabled = !profile.available;
  el("runtime").append(option);
}
let prompts = Promise.resolve();
function confirm(title, text, signal, question = false) {
  const operation = prompts.then(
    () =>
      new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const dialog = el("confirmation");
        el("confirmation-title").textContent = title;
        el("confirmation-text").textContent = text;
        el("confirmation-input").hidden = !question;
        el("confirmation-input").value = "";
        const done = (value, error) => {
          dialog.close();
          signal.removeEventListener("abort", stop);
          el("approve").onclick = el("reject").onclick = dialog.oncancel = null;
          if (error) reject(error);
          else resolve(value);
        };
        const stop = () => done(false, signal.reason);
        signal.addEventListener("abort", stop, { once: true });
        el("approve").onclick = () =>
          done(question ? el("confirmation-input").value : true);
        el("reject").onclick = () => done(false);
        dialog.oncancel = (event) => {
          event.preventDefault();
          done(false);
        };
        dialog.showModal();
      }),
  );
  prompts = operation.catch(() => {});
  return operation;
}
const tools = [
  {
    name: "edit_document",
    description: "Replace the document after the user approves in the product.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (
        !input ||
        typeof input.text !== "string" ||
        input.text.length > 100_000
      )
        throw new Error("Invalid document text");
      if (!(await confirm("确认替换文档？", input.text, context.signal)))
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "The user rejected this edit. Keep the original document.",
            },
          ],
        };
      context.signal.throwIfAborted();
      const result = await product("apply", {
        runId: context.runId,
        callId: context.callId,
        text: input.text,
      });
      project = await product("document");
      el("document").textContent = project.text;
      return result;
    },
  },
];
async function onInteraction(request, { signal }) {
  if (request.kind === "approval") {
    const choices = request.choices ?? [];
    const selection = await confirm(
      request.title,
      [
        request.permissions ? JSON.stringify(request.permissions, null, 2) : "",
        ...choices.map(
          (c, i) => `${i + 1}. ${c.label}${c.scope ? ` (${c.scope})` : ""}`,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
      signal,
      true,
    );
    const choice = choices[Number(selection) - 1];
    return choice ? { choice: choice.id } : { action: "cancel" };
  }
  if (request.kind === "questions") {
    const answers = {};
    for (const question of request.questions ?? []) {
      if (question.secret) return { action: "cancel" };
      const answer = await confirm(
        question.title,
        (question.options ?? [])
          .map((o) => `${o.label}: ${o.description ?? ""}`)
          .join("\n") + (question.multiple ? "\n多个答案用逗号分隔" : ""),
        signal,
        true,
      );
      if (answer === false) return { action: "cancel" };
      answers[question.id] = question.multiple
        ? answer.split(",").map((v) => v.trim())
        : answer;
    }
    return { answers };
  }
  if (request.kind === "form") {
    const answer = await confirm(
      request.title,
      `请按以下字段填写 JSON：\n${JSON.stringify(request.schema, null, 2)}`,
      signal,
      true,
    );
    return answer === false
      ? { action: "cancel" }
      : { action: "accept", content: JSON.parse(answer) };
  }
  if (request.kind === "url") {
    const answer = await confirm(
      request.title,
      `请在浏览器打开以下地址，完成后确认：\n${request.url}`,
      signal,
    );
    return { action: answer ? "accept" : "cancel" };
  }
  const answer = await confirm(
    "原生交互",
    `此内核请求需要原生 JSON 回复。取消会拒绝请求。\n${JSON.stringify(request.native, null, 2)}`,
    signal,
    true,
  );
  return answer === false
    ? { action: "cancel" }
    : { native: JSON.parse(answer) };
}
async function stopObserving() {
  observer?.abort();
  await observing;
  observer = undefined;
}
function observe() {
  if (!task) return;
  observer = new AbortController();
  el("observe").textContent = "暂停查看";
  const current = observer;
  observing = task
    .wait({
      signal: current.signal,
      onInteraction,
      onHistoryGap: () => {
        el("status").textContent = "较早的进度已省略，完成后仍可查看完整结果。";
      },
      onEvent: ({ event }) => {
        if (event.type === "assistant.delta")
          el("answer").textContent += event.text;
      },
    })
    .then((result) => {
      el("answer").textContent =
        result.answer || result.outcome?.error || "任务已结束";
      el("status").textContent = {
        completed: "已完成",
        cancelled: "已取消",
        failed: "任务失败",
      }[result.status];
    })
    .catch((error) => {
      if (!current.signal.aborted) el("status").textContent = error.message;
    })
    .finally(() => {
      if (observer === current) observer = undefined;
      el("observe").textContent = "重新连接";
    });
}
el("send").onclick = async () => {
  try {
    await stopObserving();
    project = await product("document");
    task = await client
      .session({
        sessionId: project.sessionId,
        runtimeId: el("runtime").value,
        tools,
        instructions:
          "Help edit this product's document. Always use edit_document to make changes. The product owns approval and persistence. Never modify project.json through shell or native file tools. Respect rejected edits.",
      })
      .run(el("input").value, { document: project.text });
    el("answer").textContent = "";
    el("input").value = "";
    el("runtime").disabled = true;
    el("status").textContent = "助手正在处理…";
    observe();
  } catch (error) {
    el("status").textContent = error.message;
  }
};
el("observe").onclick = async () => {
  if (observer) {
    await stopObserving();
    el("status").textContent = "已暂停查看，后台任务仍在运行。";
  } else observe();
};
el("cancel").onclick = async () => {
  try {
    await task?.cancel();
  } catch (error) {
    el("status").textContent = error.message;
  }
};
const existing = (await client.runs(project.sessionId))[0];
if (existing) {
  el("runtime").value = existing.runtimeId;
  el("runtime").disabled = true;
  task = client.task(existing.id, tools);
  if (existing.status === "running") {
    el("answer").textContent = "";
    el("status").textContent = "已接回后台任务";
    observe();
  } else {
    el("answer").textContent =
      existing.answer || existing.outcome?.error || "任务已结束";
    el("status").textContent = "已恢复文档和上次结果";
  }
} else el("status").textContent = "已连接，可以开始编辑。";
