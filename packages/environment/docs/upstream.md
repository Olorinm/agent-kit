# OMA source and updates

Agent Environment now uses the sandbox implementation from
[OMA e046951](https://github.com/BroZhong/open-managed-agents/tree/e04695152219a91c2ecdff41955dfc3fab73b438).
`upstream.json` records original paths and hashes. `src/sandbox` retains all nine
original sandbox files; `test/sandbox` retains the six original suites and their
119 tests. Small infrastructure-free contracts are extracted alongside
them, so neither Mau nor this package depends on OMA's database implementation.

`patches/oma-extraction.patch` records all changes to extracted files:

- Redirect package imports to the extracted contracts and relocate test imports.
- Add an explicit timeout policy and reconnect timeout; OMA defaults stay 24-hour
  running lifetime, auto-pause, 24-hour retention and 150-second readiness budgets.
- Let the provider adapter inspect/detach the existing connection cache. It uses
  the original factory hooks for cloud transport differences.
- Bound command output to 8 MiB and cancellation observation to 10 seconds;
  retain OMA's original byte decoding, cancellation and uncertain-exit handling.
- Reject invalid argv/environment keys before shell interpolation, and recognize
  missing files by typed errors/ENOENT so DNS and gateway failures stay uncertain.
- Export existing mount/filesystem helpers for consumers that previously imported
  OMA's private source paths. `/oma` is an optional structural adapter for
  consumers supplying an EnvironmentProvider; the primary provider runtime
  continues to use OMA's extracted implementation directly.

The E2B 2.24.0 patch is copied verbatim. Build applies it to an isolated SDK copy
and bundles that runtime into the archive, including its MIT license. Installation
with `--ignore-scripts` therefore preserves the patch. `/sdk` is also the source
of error classes for injected transports, avoiding mismatched class identities.

Provider code contains endpoint validation, discovery, application ingress and
Volcengine's typed missing response, explicit timeout refresh and sync-before-pause.
The provider's SDK directory listing retains newline-safe names and bounded
traversal; OMA's ToolExecutor retains its original recursive find and native
filesystem behavior. Product lifecycle policy stays with each product:
OMA uses DefaultSandboxManager and durable Turn activities; Mau coordinates
persistent Host processes and its own allocation journal.

To update OMA, check out the desired upstream revision, update the manifest hashes,
copy the mapped source files, and reapply the extraction patch. Resolve patch
conflicts explicitly, regenerate the patch, then run:

```sh
npm ci --ignore-scripts
npm run check:upstream -- /path/to/pinned-oma
npm test
npm run test:package
```

Also install the resulting archive in OMA and Mau. Run OMA's session-router,
workspace/lifecycle and native tool tests, followed by Mau's typecheck, tests and
four-package integration. Source comparison and fixture tests do not establish
live cloud acceptance.

The pinned OMA revision has no license declaration. This derived version is
private/UNLICENSED and has not been publicly released. Source attribution does
not grant redistribution rights; confirm those before a public archive or npm
release. The previous public 0.1 archive is the earlier implementation.
