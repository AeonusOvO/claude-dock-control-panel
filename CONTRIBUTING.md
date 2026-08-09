# Contributing to ClaudeDock

Thank you for helping improve ClaudeDock. The project is an Apache-2.0 Windows desktop application
and accepts focused bug fixes, tests, documentation and features that preserve its product boundary.

## Before opening a pull request

1. Discuss large behavioral or architectural changes in an issue first.
2. Create a short-lived branch from the current main branch.
3. Keep one topic per branch and avoid generated output, credentials, local databases and installer
   files.
4. Update tests and the relevant root documentation when behavior, design or architecture changes.
5. Run npm ci, npm test and npm run dist on Windows.
6. Describe the purpose, important changes, verification results, risks and remaining questions in
   the pull request.

The maintainer assigns the release version. Do not add private keys, tokens, certificate passwords,
real AI credentials or personal test data. Use example.com hosts and clearly synthetic placeholders
in tests.

All contributions are made under Apache License 2.0. By submitting a contribution, you confirm that
you have the right to provide it under that license and that third-party material is identified with
its applicable license.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not a public issue.
