# Agent Host

Read `README.md`, `docs/scope.md` and `docs/kernel-support.md` before changing public boundaries.

- This package (`packages/host` in agent-kit) is a product-independent native Agent integration layer. Preserve source attribution and license notices when reusing code.
- Keep consumer-specific business objects out of public contracts and runtime dependencies.
- Preserve native model loops, tools, sessions and permission semantics. Do not rebuild those behaviors in the Host.
- Reuse existing adapters and tests where appropriate. Review referenced unmerged work before depending on it; do not silently treat it as merged.
- Declare capabilities only with an implementation path and a test. Keep protocol/mock tests distinct from model-backed native runs.
- Test distributable archives from an independent consumer, not only repository-relative imports.
- Separate integration regressions from upstream upgrade regressions in commits and validation.
- Do not commit credentials, private conversations, machine-local state or raw diagnostic recordings.
- For documentation-only changes, check local links and `git diff --check`.

Runtime changes: run `npm test` and `npm run test:package` from `packages/host`. `AGENT_HOST_NATIVE_PROBE=1 npm run test:package` additionally uses a real Codex login and is opt-in.

CI (`.github/workflows/ci-host.yml`) runs both commands on Linux and Windows.
