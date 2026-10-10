# Security policy

## Trust model

Testy builds and runs code from your workspace. To find affected tests it evaluates MSBuild projects, builds them, instruments the resulting assemblies, and runs your test projects with `dotnet`. Any build script, analyzer, source generator, test, or MSBuild import in the workspace therefore executes on your machine, with your permissions.

For that reason Testy only activates in trusted workspaces. Do not trust a workspace you would not build and run yourself. Issues that only demonstrate that a malicious workspace can run code when it is trusted and built are expected behavior, not vulnerabilities.

Vulnerabilities we do want to hear about include, for example, code execution or file writes outside the workspace and Testy's own cache from an untrusted workspace, path or command-line injection in the helper processes, and tampering with the extension's cache or packaged helpers.

## Supported versions

Security fixes are made in the latest released version.

## Verifying a release

The VSIX attached to each GitHub release has a build provenance attestation: `gh attestation verify testy.vsix --repo reginaldFerland/testy`. The release also carries an SPDX SBOM of the locked dependencies and the production source maps.

## Reporting a vulnerability

Please do not open a public issue. Report privately through [GitHub security advisories](https://github.com/reginaldFerland/testy/security/advisories/new) ("Report a vulnerability" on the repository's Security tab). Include the Testy and VS Code versions, your OS, and steps to reproduce.

You can expect an acknowledgement within a few days. We will coordinate a fix and disclosure with you and credit you in the release notes if you wish.
