# Changelog

Notable changes to Agent Environment, newest first. Each version has a GitHub Release with the same
notes and the package archive. When releasing, add the new section here in the version-bump commit;
the Release notes are copied from it.

## [0.2.0-alpha.3] - 2026-10-21

- Adapter for Cloudflare environments.
- Limited outbound network access.
- Managed configuration for credentials.
- Separate encrypted recovery backups.

## [0.2.0-alpha.2] - 2026-10-14

- OMA workspace interfaces and adapters, so Mau's shared workspaces keep their files when an
  environment is replaced and can be shared between Agents with the same owner.
- Volcengine TOS mounts. A mount is checked against Kubernetes authorization, and by reading an
  object back, before the private Host starts up.
- Exports `./workspace` and `./oma`. Account ownership stays in Mau. Bundles the server TOS client,
  with corrected pagination.

## [0.2.0-alpha.1] - 2026-10-14

- Reuses OMA's sandbox implementation, contracts and patched E2B runtime. The Alibaba and
  Volcengine adapters build on the shared client.
- Removed the reverse bridge and the duplicate command implementation.
- Distributed through this private repository only. The upstream redistribution terms are
  unresolved, so there is no public npm release.

PR: #4
