import { test } from "node:test";
import assert from "node:assert/strict";
import { signAccess, verifyAccess, createSpec, equalSecret } from "../src/security.mjs";
const id = "e85982d9-ea40-4be4-9646-02c07b7109d2";
test("application capability is bound to sandbox, port, expiry and signing key", async () => {
  const now = Date.now(), token = await signAccess("private-test-key", id, 37420, now + 300000);
  assert.equal(await verifyAccess("private-test-key", token, id, 37420, now), true);
  assert.equal(await verifyAccess("private-test-key", token, id, 37421, now), false);
  assert.equal(await verifyAccess("other-key", token, id, 37420, now), false);
  assert.equal(await verifyAccess("private-test-key", token, "a85982d9-ea40-4be4-9646-02c07b7109d2", 37420, now), false);
  assert.equal(await verifyAccess("private-test-key", token, id, 37420, now + 300001), false);
  assert.equal(await verifyAccess("", token, id, 37420, now), false);
  assert.equal(await verifyAccess("private-test-key", token + "x", id, 37420, now), false);
});
test("missing credentials and malformed resource choices fail closed", async () => {
  assert.equal(await equalSecret("", ""), false);
  assert.equal(await equalSecret("a", "a"), true);
  assert.throws(() => createSpec({ template: "arbitrary-image" }));
  assert.throws(() => createSpec({ template: "node24", timeoutSeconds: 0 }));
  assert.throws(() => createSpec({ template: "node24", timeoutSeconds: 90000 }));
  assert.throws(() => createSpec({ template: "node24", env: { KEY: 123 } }));
  assert.equal(createSpec({ template: "node24" }).onTimeout, "pause");
});
