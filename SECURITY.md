# Security policy

This policy covers every package in this repository: Host, Router, Connectors and Environment. Only the current
release is maintained. Production stability and an independent security audit are not claimed.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub security advisories](https://github.com/Olorinm/agent-kit/security/advisories/new). Do not open a public issue
for a vulnerability.

Name the package and version or commit, and describe the impact and a reproduction with synthetic data. Do not include
real credentials, tokens, prompts, conversation or task content, database dumps, hostnames or other deployment
identifiers, in a report or in a public issue.

## Security boundaries

### Router

- Owner requests are authenticated by the edge identity: Router verifies the signed Cloudflare Access JWT and maps it
  to a configured owner. Requests that change state with an edge login must come from an allowed browser origin. An
  embedding product can supply its own bearer-token authenticator.
- An owner can reach only that owner's agents. Each agent has its own store, work queue and connection directory.
- Channel credentials are stored as private files (mode 0600) in the state directory and are not returned by the API.
  Owner HTTP requests cannot supply Host endpoints or credential file paths.
- The API is rate limited before authentication. Forwarded headers are trusted only from proxies the operator
  configures.

See [Accounts and agents](packages/router/docs/guides/managed-agents.md).

### Host

- The HTTP service listens on `127.0.0.1` by default and requires a bearer token on every operation.
- The token identifies one trusted owner with access to every configured profile, session and task. This is not
  multi-tenant authorization: products with different trust boundaries need separate instances and state directories.
- HTTP callers select a configured runtime; they cannot supply executables, environment variables, provider
  credentials or workspace roots.

See [HTTP service](packages/host/docs/http-service.md).

### Connectors

- Connector credentials are held by the connector service and do not enter the agent's environment.
- Each call carries a Router-signed caller token for one agent, one owner and a list of connections. A connection is
  usable only by its owner.
- Write operations wait for the owner's approval unless the owner's policy allows them.

See the [security model](packages/connectors/docs/security-model.md).

### Environment

- Provider credentials are kept in private key files referenced by the configuration, not in metadata or references.

See the [Environment README](packages/environment/README.md).

## Operators

Keep state directories, credential and token files, model login state and TLS material out of Git, and back up each
package's state consistently.
