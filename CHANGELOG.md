# Changelog

Notable changes to Agent Kit, newest first. All packages share one version. Pushing a `v<version>`
tag publishes a GitHub Release whose notes are this file's section for that version, so add the
section in the version-bump commit before tagging. Changes up to the versions listed under
0.8.0-alpha.1 are in each package's own `CHANGELOG.md`.

## [Unreleased]

- **Router:** removed the one-time migration tools that moved a deployment from Matrix to the
  owner ledger (`ledger:backfill`, `ledger:promote-media`, `matrix:export`, `matrix:forget`) and
  the `GET /web/debug/ledger` diffing endpoint. Deleting an agent whose Matrix account is dormant
  no longer records it in `matrix_orphans`.
- **Host:** removed the package exports `./environment/windows-discovery`,
  `./environment/windows-query`, `./transport`, `./acp/mcp-server`, `./native-session-lock` and
  `./openclaw/plugin`; the modules remain internal and the OpenClaw plugin is still loaded from
  `plugins/openclaw`. Removed the manual probe scripts, the `probe:codex` script and the
  `AGENT_HOST_NATIVE_COVERAGE` option of `test:package`. Removed the dated upgrade, evidence,
  audit and evaluation documents and `examples/cloud` from the package. The two editor examples
  depend on the package directory that contains them instead of a fixed archive version. The
  service store no longer reads run records written before event kinds were tracked.
- **Connectors:** the package root no longer exports `GENERIC_CATALOG`, `defaultSetting`,
  `PolicyOperationView`, `LIMITS`, `TOKEN_TYPES`, `TokenError`, `operationDigest` and
  `CloudflareBrowserRun`. Removed the `Dockerfile` and the `test:cloudflare` script; run
  `npm test` in `cloudflare/` instead.
- **Environment:** requires Node.js 24 or later. Removed `scripts/probe.mjs` and the `probe`
  script. The Cloudflare start script example installs Codex 0.166.0.
- **CI:** Host is tested on Linux and Windows, Connectors and Environment on Linux, all with
  Node.js 24.22.2.

## [0.8.0-alpha.1] - 2026-11-12

First release from this repository. Host, Router, Connectors and Environment now share one
version and one release; they continue from Host 0.1.0-alpha.14, Router 0.7.0-alpha.14,
Connectors 0.1.0-alpha.11 and Environment 0.2.0-alpha.3.

- **Release:** one tag `v<version>` publishes every package, the Router CLI archives and a single
  `SHA256SUMS` covering all of them. `scripts/set-version.mjs` sets the version everywhere.
- **Environment:** Cloudflare is the only provider; the provider interface is unchanged and
  further providers are added through the factory table in `src/config.ts`. Removed the Alibaba
  and Volcengine providers, the E2B driver, the OSS and TOS workspace stores, and the `./sandbox`,
  `./contracts`, `./sdk`, `./oma` and `./workspace` exports. The package has no runtime
  dependencies and is distributed as a regular `.tgz` archive.
- **Host:** removed the React editor example and the UI package test; dropped the unused
  `@earendil-works/pi-agent-core` dependency. No runtime change.
- **Router:** the CLI reads its version from `package.json`. `scripts/install.sh` installs
  releases from this repository.
- **Connectors:** no functional change.
