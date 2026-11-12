# Contributing

Agent Kit welcomes focused bug reports, documentation improvements, tests and implementation changes to any of its
packages: [Host](packages/host), [Router](packages/router), [Connectors](packages/connectors) and
[Environment](packages/environment).

## Before opening an issue

- Search existing issues and each package's documentation and architecture decisions.
- Name the package and its version or commit.
- Include a minimal reproduction with synthetic data. Remove credentials, real conversation or task content, private
  hostnames, IP addresses and deployment data.
- For security problems, follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## Development setup

All packages require Node.js 24 or later. There is no root workspace: install, test and build inside a package
directory.

```sh
cd packages/<name>
npm ci
npm test
```

Each package has its own CI workflow, `.github/workflows/ci-<package>.yml`, which runs when that package changes. It
is the reference for the commands that must pass; some packages run more than `npm test` (for example
`npm run typecheck` and `npm run build` in Router, or `npm run test:package` in Host and Environment). Run the same
commands locally before opening a pull request.

Tests use synthetic identities and reserved domains such as `example.test`. Do not add tests that need real accounts
or credentials.

## Change process

1. Open an issue before a large feature or a change to a public API, HTTP route, configuration format or stored data.
2. Keep a change inside one package where possible. A change that crosses packages states which versions work together.
3. Add or update an architecture decision record in the package for a durable architectural choice.
4. Update the package's README and guides when behavior, configuration or commands change.
5. Add an entry under `## [Unreleased]` in the root [`CHANGELOG.md`](CHANGELOG.md), prefixed with the package name,
   when package contents or behavior change.
6. Keep commits focused and explain security consequences.

## Pull requests

Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md): the problem, the approach, user impact,
security and privacy impact, and how the change was verified. Confirm that:

- the commands in each changed package's CI workflow pass locally;
- documentation and the root `CHANGELOG.md` are updated;
- no secrets, real deployment identifiers or generated state are added.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
