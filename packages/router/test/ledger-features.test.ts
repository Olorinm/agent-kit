import { describe, expect, it } from "vitest";
import { loadServiceConfig } from "../src/service/config.js";

/** The web API, cards, control, groups, identities and attachments are part of Router; nothing switches them. */
describe("retired ledger switches", () => {
  it("ignores AGENT_LEDGER_* in the environment of an existing deployment", () => {
    const env = { MATRIX_SERVER_NAME: "example.test", AGENT_SERVICE_URL: "https://example.test/x" };
    const retired = { AGENT_LEDGER_READ: "0", AGENT_LEDGER_SEND: "1", AGENT_LEDGER_CARDS: "1", AGENT_LEDGER_CONTROL: "1", AGENT_LEDGER_GROUPS: "1",
      AGENT_LEDGER_ATTACHMENTS: "1", AGENT_LEDGER_IDENTITY: "1" };
    expect(loadServiceConfig({ ...env, ...retired })).toEqual(loadServiceConfig(env));
  });
});
