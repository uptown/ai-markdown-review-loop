# License Policy

AI Markdown Review Loop is distributed under the MIT License. The repository
license is the root `LICENSE` file, and `package.json` must declare
`"license": "MIT"` for Marketplace and npm tooling consistency.

## Repository License

Unless a file states otherwise, original source code, documentation, scripts,
icons created for this project, and extension packaging metadata are licensed
under MIT.

The MIT license grants broad use, modification, distribution, sublicensing, and
commercial use rights, subject to preserving the copyright and permission
notice.

## Third-Party Dependencies

Runtime and bundled dependencies keep their own licenses. Before each
Marketplace release, review production dependencies and any copied runtime
assets, especially files placed under `out/vendor/`.

The release package currently bundles extension host code and copies the Mermaid
runtime into `out/vendor/mermaid.min.js`. Keep `THIRD_PARTY_NOTICES.md` updated
with package name, version, license, source URL, and any required notice text.

Development-only dependencies do not need prominent Marketplace README
treatment, but their licenses must remain acceptable for repository development
and build tooling.

## Marketplace Expectations

- Keep the root `LICENSE` file in the VSIX package.
- Keep `package.json` license metadata set to `MIT`.
- Do not imply that third-party dependencies are relicensed by this project.
- Include or link third-party notices when bundled third-party runtime files are shipped.
- If future AI providers are added, document provider terms and whether document content may leave the user machine.

## Contributor Policy

Contributions are accepted under the same MIT license as the project. By opening
a pull request or submitting a patch, contributors confirm they have the right
to contribute the material and agree that it may be distributed under MIT.

No separate CLA is required unless the maintainer later adds one explicitly.
Contributors must not submit copied code, proprietary snippets, leaked material,
or assets whose license is incompatible with MIT distribution.

## AI-Assisted Contributions

AI-assisted contributions are allowed when reviewed by a human contributor. The
person submitting the change is responsible for verifying correctness, license
compatibility, and provenance.

Do not paste large blocks of code from proprietary products, closed-source
extensions, books, paid examples, or unclear online sources. AI-generated code,
comments, docs, prompts, and test data submitted to this repository are treated
as contributor-submitted material licensed under MIT.

If a contribution intentionally adapts a public source, cite that source in the
pull request and preserve any required attribution or notice.

## Avoid

- Dependencies or assets with unclear, custom, non-commercial, source-available, GPL, AGPL, or strong copyleft obligations unless explicitly approved.
- Removing license headers, upstream notices, package metadata, or generated notice files.
- Bundling new webview runtimes, model SDKs, fonts, icons, sample documents, or AI-generated datasets without checking redistribution rights.
- Claiming that Marketplace installation, VSIX packaging, or MIT licensing grants rights to third-party trademarks, VS Code branding, Marketplace branding, or external AI provider services.
