# Development and host validation

Use the Node version in `.nvmrc`, then `npm ci`.

- `npm run check`: host/browser typechecking and regression tests.
- `npm run compile`: host/browser bundles, stylesheet and inventoried Mermaid runtime.
- `npm run watch`: the same build configuration in watch mode.
- `npm run assets:check`: deterministic, read-only marketing asset verification.
- `npm run notices:check`: resolved and bundled dependency notice coverage.
- `npm run package` and `npm run package:hygiene`: build and inspect the VSIX.
- `npm run test:host`: install that VSIX into a fresh temporary profile and run
  actual webview interactions, filesystem edits, recovery and process restart.

The host runner downloads VS Code from Microsoft's update endpoint. Use
`CODE_VERSION=1.85.0` for the minimum host or `--vscode /path/to/executable`
for an existing binary. `--vsix` selects an exact artifact and `--output` selects
the evidence JSON. Linux requires a display; CI uses `xvfb-run -a`.
Profiles and fixture documents are isolated under the system temporary directory.
The driver has no production test hook and never uses real user sidecars.

Host evidence records VS Code, platform, candidate hash and each scenario.
An external file process simulates the agent; it does not run a model.
Automated keyboard/focus checks do not establish human screen-reader usability.

## Compatibility contract

| Environment | Product behavior | Verification requirement |
|---|---|---|
| Local saved Markdown in Desktop | Supported | Minimum/current host, packaged runtime |
| macOS / Windows / Linux | Desktop target matrix | CI host jobs; record actual run results |
| Restricted Mode | Preview only | No comment/source/copy/recovery writes |
| Virtual workspace / unsaved URI | Unsupported | Clear refusal without mutation |
| Remote SSH / WSL / containers / browser VS Code | Not advertised as validated | Separate host evidence before claiming support |
| Read-only files | Readable preview; writes may fail | Preserve drafts and actionable errors |
| Multi-root, Unicode, spaces, CRLF | Portable context and local paths | Deterministic fixtures plus host coverage |

Configured CI jobs are not evidence of completed remote runs. Local audit and
implementation evidence stays under ignored `.agent/reviews/`. Keep generated
fixtures, private sidecars, runtime caches and reports outside the VSIX.

The former dialogue/history simulation documents are historical design records;
they are not current acceptance gates. Current user decisions and the current
[agent contract](./AI-REVIEW-POLICY.md) supersede those records.

Official references: [VS Code testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
and [CLI isolation/install flags](https://code.visualstudio.com/docs/configure/command-line).
