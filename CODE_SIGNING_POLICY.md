# ClaudeDock code-signing policy

ClaudeDock publishes Windows installers only from the public
[AeonusOvO/claude-dock-control-panel](https://github.com/AeonusOvO/claude-dock-control-panel)
repository. The source and release materials use the Apache License 2.0.

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

## Roles

- **Author and maintainer:** AeonusOvO reviews source changes, dependencies, release notes and
  security impact.
- **Release reviewer:** AeonusOvO confirms that the tagged commit is the current main branch, all
  required CI checks passed, the version is correct, and the release contains no unrelated files.
- **Signing approver:** the SignPath project role assigned after Foundation approval manually
  approves each stable signing request. Automated approval is prohibited.
- **Build identity:** GitHub-hosted Windows runners build tagged public source with the committed
  package-lock.json. No developer workstation binary may be substituted.

The single-maintainer role overlap is public and intentional. GitHub multi-factor authentication is
required for the maintainer account. A future maintainer must be named here before receiving signing
or release permissions.

## Stable release requirements

1. The tag must equal v plus the package version, point at the current main branch, and use an exact
   stable SemVer.
2. CI installs dependencies with npm ci, runs the complete verification suite, and builds the
   Windows artifacts once.
3. The application executable, generated NSIS uninstaller and NSIS installer must all have a valid
   Authenticode chain, the approved publisher subject, and a trusted timestamp.
4. CI rejects NotSigned, UnknownError, an unexpected publisher, a missing timestamp, or an invalid
   Windows chain. A silent install/uninstall smoke test verifies the installed copies too.
5. Only the final signed installer bytes may be hashed into latest.yml, the blockmap and the Ed25519
   release manifest.
6. The exact same installer, blockmap, metadata, manifest and detached manifest signature are
   uploaded to GitHub Releases and the HTTPS mirror. Any size, SHA-512 or signature mismatch aborts
   publication.
7. Every stable signing request requires manual approval after the source commit, CI run and release
   notes have been reviewed.

## Artifact restrictions

Signed files must identify the product as ClaudeDock, use the package version, and originate from the
tagged workflow. The signing policy must reject arbitrary file names, unrelated executables,
unverified origins and versions that do not match the request parameter. Signing credentials,
certificate passwords, API tokens and manifest private keys are stored only as protected CI secrets
or in the signing service; they are never committed or embedded in the application.

ClaudeDock currently uses NSIS, whose installer contains a generated uninstaller. The selected
signing integration must support electron-builder's sequential signing calls so that the application,
embedded uninstaller and outer installer are all signed. Signing only the outer installer is not
acceptable.

## Incident response

Compromise or suspected misuse of a signing credential stops releases immediately. The maintainer
will disable the affected CI credential, notify the signing provider, revoke the certificate when
appropriate, rotate the release-manifest key in a reviewed client release, and publish an incident
notice through the repository's security process.

Privacy handling for signing and releases follows [docs/PRIVACY.md](docs/PRIVACY.md). Security
reports follow [SECURITY.md](SECURITY.md).

## Current approval status

The repository is prepared for SignPath Foundation review, but a stable binary must not be described
as trusted-signed until Foundation approval and the full NSIS signing path above have both been
verified by Get-AuthenticodeSignature on Windows.
