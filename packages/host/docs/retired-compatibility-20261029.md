# Retired compatibility paths

Follow-up to [harness refresh #29](https://github.com/Olorinm/agent-host/issues/29).

The product owner explicitly retired unused compatibility paths on 2026-10-29:

- Pi 0.85 JSONL adapter, public subpath and pinned native dependencies.
- OpenCode 1 HTTP history, deletion and compaction bridge. OpenCode now requires version 2 or later and uses native ACP operations.
- Hermes model-bound fingerprint migration. Unrecognized bindings fail without rewriting native sessions.

Current Pi 1.2, OpenCode 2 and both Hermes transports remain supported. Builds clear generated output before compiling so removed adapters cannot remain in distributable archives.

Validation: `npm test` and `npm run test:package`. These are deterministic protocol and independent archive tests; they do not establish real model/provider acceptance.
