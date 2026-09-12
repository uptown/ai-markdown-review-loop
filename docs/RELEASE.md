# Release checklist

Use this checklist for the JSON-only review flow.

## Before publishing

- Confirm the version, changelog, README, UI labels, policy, and schema all
  describe comment → JSON → agent edit → review.
- Keep `.agent/`, `.ai-markdown-review/`, colocated review JSON files, and local
  context documents out of Git and the VSIX.
- Use the Node version in `.nvmrc`. Run `npm run assets:check`; regenerate
  artwork only when its source changes, then inspect the icon, hero, and
  walkthrough. Artwork is illustrative, not live agent evidence.
- Preserve local Git hooks and respect their allowed commit hours.

## Automated gates

```bash
npm run release:check
npm run test:host -- --output .agent/host-evidence.json
git diff --check
```

The release check typechecks host and browser code, runs regression tests,
audits dependencies, verifies deterministic assets and notices, packages the
VSIX, and checks its contents. The separate host runner installs that package
in an isolated VS Code profile and exercises actual preview interactions,
source edits, JSON deletion, recovery and restart. Record the exact package
version, SHA-256, host version and platform. Follow
[the validation guide](./VALIDATION.md) for minimum/current host coverage.

## Manual smoke

1. Open a Markdown preview and save comments on normal text and rich blocks.
2. Confirm a colocated v3 JSON appears with guidance and current user comments.
   Copy Review JSON adds portable workspace-relative context to the clipboard.
3. Give an external agent the JSON and current Markdown. It reviews every
   current comment, leaves already satisfied requests unchanged, saves its
   Markdown edits, then deletes the JSON. No result note is required.
4. Review the updated Markdown and confirm current comments remain editable.
   Toggle the comments sidebar, then save or edit a comment, or use Copy Review
   JSON, and confirm the next round's sidecar is recreated.
5. Check malformed JSON, ambiguous anchors, failed saves, rename migration,
   keyboard navigation, and draft recovery.

The host runner simulates agent file edits; it does not run a model. Automated
keyboard checks do not establish human screen-reader usability. Record actual
host results separately from unperformed model, human and platform checks.

## Publication evidence

Finalize the release date in the changelog and rebuild the package. Commit
without bypassing hooks, push through the repository's branch/PR workflow, and
wait for build and installed-host CI on the exact commit to be released. Tag
that commit, create the GitHub release, and upload the matching VSIX to the
Visual Studio Marketplace. Record the commit, tag, CI result and artifact hash.

Verify the GitHub asset digest and the public Marketplace version independently.
An accepted upload or a publisher page showing Verifying is not proof that the
new version is publicly available. Preserve existing releases if publication
fails, and report the pending stage without exposing authentication material.
