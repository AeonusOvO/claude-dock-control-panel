# Security policy

## Supported versions

Security fixes are made on the current stable line and the main branch. After 4.1.0 is formally
released, 4.1.x is the supported binary line. Older installers and source snapshots receive fixes
only when the maintainer explicitly says so in a security advisory.

## Private reporting

Do not open a public issue with an exploit, private data, credentials or an unpatched vulnerability.
Use the repository's **Security → Report a vulnerability** form. It creates a private GitHub security
advisory visible to the maintainer.

If GitHub private reporting is unavailable, contact the maintainer AeonusOvO by telephone or SMS at
13585928550 and ask for a private reporting channel. Do not send secrets, proof-of-concept payloads or
personal data in the first SMS.

Please include the affected version and operating system, impact, reproduction conditions, whether
the issue is already public, and a safe way to contact you. You should receive an acknowledgement
within seven calendar days. Fix and disclosure timing depends on severity and coordination needs.

## Scope

ClaudeDock does not modify Codex, Claude Code or system-level API routing. Reports about the app's
privilege boundary, updater, release signatures, local credential handling, renderer isolation,
command execution or dependency chain are in scope. Service-provider account disputes and
vulnerabilities in an unmodified third-party CLI should be sent to that upstream vendor.

Never include real AI tokens, SSH keys, certificate keys or user files in a report. Test only systems
and accounts you are authorized to use.
