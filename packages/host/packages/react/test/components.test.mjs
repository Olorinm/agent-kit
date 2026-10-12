import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "../dist/index.js";
import {
  AgentInteraction,
  createRunView,
  appendRunEvent,
} from "../dist/agent-host.js";

test("standalone Markdown renders tables and code without product services", () => {
  const html = renderToStaticMarkup(
    h(ChatMarkdown, {
      markdown: "| File | Value |\n| --- | --- |\n| `file.ts` | **ready** |",
    }),
  );
  assert.match(html, /<table/);
  assert.match(html, /<code[^>]*>file.ts<\/code>/);
  assert.match(html, /<strong>ready<\/strong>/);
  assert.doesNotMatch(html, /data-resource-reference/);
});

test("native approval options and scopes remain exact, including an empty allowed set", () => {
  const render = (choices) =>
    renderToStaticMarkup(
      h(AgentInteraction, {
        requestId: "call-1",
        request: {
          kind: "approval",
          title: "Allow?",
          native: {},
          choices,
        },
        onReply() {},
      }),
    );
  assert.match(
    render([{ id: "native-session", label: "Session", scope: "session" }]),
    /Session/,
  );
  assert.doesNotMatch(render([]), /Allow once|Always allow|Confirm/);
});
test("native questions cannot skip required IDs; secret fields are password inputs", () => {
  const html = renderToStaticMarkup(
    h(AgentInteraction, {
      requestId: "call-2",
      request: {
        kind: "questions",
        title: "Questions",
        native: {},
        questions: [
          { id: "secret", title: "Secret", secret: true },
          { id: "next", title: "Next" },
        ],
      },
      onReply() {},
    }),
  );
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, />Skip</);
  assert.match(html, /Cancel request/);
});
test("events retain native objects, ignore replayed sequences and reject cross-run mixing", () => {
  const native = {
    type: "native.notification",
    runId: "run-a",
    notification: { method: "custom", params: { extra: true } },
  };
  let state = appendRunEvent(createRunView("run-a"), {
    sequence: 1,
    event: native,
  });
  assert.equal(state.events[0], native);
  state = appendRunEvent(state, {
    sequence: 2,
    event: { type: "assistant.delta", runId: "run-a", text: "Hello" },
  });
  assert.equal(appendRunEvent(state, { sequence: 2, event: native }), state);
  assert.equal(state.text, "Hello");
  assert.throws(
    () =>
      appendRunEvent(state, {
        sequence: 3,
        event: { type: "turn.started", runId: "run-b" },
      }),
    /mismatch/,
  );
});
test("Markdown preserves rich link labels and data images but not script links or HTML", () => {
  const html = renderToStaticMarkup(
    h(ChatMarkdown, {
      markdown:
        "[**Docs**](https://example.com)\n\n![pixel](data:image/png;base64,aGVsbG8=)\n\n[unsafe](javascript:alert(1))\n<script>alert(1)</script>",
    }),
  );
  assert.match(html, /<strong>Docs<\/strong><\/a>/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /href="javascript:|<script>/);
});
