import assert from "node:assert/strict";
import test from "node:test";
import { projectProgress } from "../dist/progress.js";

const updates = [
  {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "child reasoning" },
  },
  {
    sessionUpdate: "usage_update",
    used: 15,
    size: 100,
    inputTokens: 12,
    outputTokens: 3,
    cost: { amount: 0.5, currency: "USD" },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "child:call-1",
    title: "Research: read",
    status: "in_progress",
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "child:call-1",
    status: "completed",
  },
];

for (const update of updates)
  test(`legacy child ${update.sessionUpdate} retains attribution without root progress`, () => {
    const childUpdate = {
      ...update,
      _meta: {
        "opencode/child-session": {
          id: "child",
          parentID: "root",
          depth: 1,
          title: "Research",
        },
      },
    };
    const event = {
      type: "native.notification",
      runId: "run",
      threadId: "root",
      turnId: "turn",
      notification: {
        method: "session/update",
        params: { sessionId: "root", update: childUpdate },
      },
    };
    const result = projectProgress(event);
    assert.deepEqual(result, [event]);
    assert.equal(result[0], event);

    const rootEvent = {
      ...event,
      notification: {
        ...event.notification,
        params: { sessionId: "root", update },
      },
    };
    assert.equal(projectProgress(rootEvent).length, 2);
  });

test("negotiated child-update extension remains a raw attributed native event", () => {
  const event = {
    type: "native.notification",
    runId: "run",
    threadId: "root",
    turnId: "turn",
    notification: {
      method: "opencode/session/child_update",
      params: {
        rootSessionId: "root",
        childSessionId: "child",
        parentSessionId: "root",
        depth: 1,
        type: "update",
        update: updates[0],
      },
    },
  };
  assert.deepEqual(projectProgress(event), [event]);
});
