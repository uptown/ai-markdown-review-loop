# Repository working rules

- The current product contract is [docs/AI-REVIEW-POLICY.md](docs/AI-REVIEW-POLICY.md): users own comments; an external agent edits Markdown and deletes the JSON; users review the source and manage the next pass. Keep all product and documentation copy in English.
- Historical `.agent` notes and dialogue/history simulation documents describe retired designs. They must not restore chat, status transitions, handoff locks, history/reopen or reattach controls. Preserve legacy read migration and user data.
- Inspect Git status first and preserve unrelated changes and review sidecars. `.agent/`, local review JSON and generated evidence remain outside Git and the VSIX. Do not edit global memory as part of repository fixes.
- Keep host code, typed browser code, messages and CSS separate. Build/watch share `scripts/build.mjs`; do not emit standalone TypeScript runtime modules into `out/`.
- Reproduce stateful failures and add corrected regression assertions. Follow [docs/VALIDATION.md](docs/VALIDATION.md), including installed-VSIX host evidence. Tests, real-host runs, CI and public release visibility are separate claims.
- Patch dependencies in the actual shipped bundle. Verify its manifest, licenses, deterministic assets and package hygiene. Do not publish or bypass local Git hooks implicitly.
