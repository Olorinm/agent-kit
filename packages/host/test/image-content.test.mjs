import assert from "node:assert/strict";
import test from "node:test";
import { productToolBridge } from "../dist/product-tool-bridge.js";

test("MCP product tools preserve image bytes and reject malformed inline image results", async () => {
  const context = {
    sessionId: "s",
    runId: "r",
    threadId: "t",
    turnId: "turn",
    signal: new AbortController().signal,
  };
  const events = [];
  const bridge = productToolBridge(
    [
      {
        name: "image",
        description: "Return an image",
        inputSchema: {},
        execute: async (url) => ({
          success: true,
          contentItems: [{ type: "inputImage", imageUrl: url }],
        }),
      },
    ],
    context,
    { push: (event) => events.push(event) },
  );
  const result = await bridge.call(
    "image",
    "data:image/png;base64,AAH/",
    "valid",
  );
  assert.deepEqual(result.content, [
    { type: "image", mimeType: "image/png", data: "AAH/" },
  ]);
  for (const [index, url] of [
    "data:image/png;base64,not-valid!",
    "data:image/png;base64,A===",
    "data:text/html;base64,AA==",
    "data:image/png;base64,",
  ].entries()) {
    const rejected = await bridge.call("image", url, "invalid-" + index);
    assert.equal(rejected.isError, true);
    assert.equal(rejected.content[0].text, "invalid_inline_image");
    assert.equal(events.at(-1).type, "tool.finished");
    assert.equal(events.at(-1).result.success, false);
  }
  const linked = await bridge.call(
    "image",
    "https://example.invalid/image.png",
    "link",
  );
  assert.deepEqual(linked.content, [
    {
      type: "resource_link",
      uri: "https://example.invalid/image.png",
      name: "image",
    },
  ]);
});
