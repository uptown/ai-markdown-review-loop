# Release checklist

Use this checklist for the JSON-only review flow.

## Before publishing

- Confirm the version, changelog, README, UI labels, policy, and schema all
  describe comment → JSON → agent edit → review.
- Keep `.agent/`, `.ai-markdown-review/`, colocated review JSON files, and local
  context documents out of Git and the VSIX.
- Run `npm run assets:marketplace` and inspect the generated icon, hero, and
  walkthrough artwork. Artwork is illustrative, not live agent evidence.

## Automated gates

```bash
npm run release:check
git diff --check
```

The release check typechecks, runs unit tests, verifies notices, packages the
VSIX, and checks its contents. Record the exact package version and SHA-256.

## Manual smoke

1. Open a Markdown preview and save comments on normal text and rich blocks.
2. Confirm a colocated v3 JSON appears and contains only short guidance plus
   request items.
3. Copy the JSON, edit the Markdown as an external agent, record a result, and
   delete the JSON.
4. Confirm the preview shows the last valid snapshot and removal notice, then
   save a new comment and confirm the sidecar is recreated.
5. Check malformed JSON, ambiguous anchors, failed saves, rename migration,
   keyboard navigation, and draft recovery.

Automated DOM and storage tests do not prove a real external-agent run. Record
unperformed host, device, and public-distribution checks as untested.

## Publication evidence

Tag and push the exact release commit, wait for CI on that commit, create the
GitHub release, and upload the matching VSIX to the Visual Studio Marketplace.
Verify the public Marketplace version and artifact SHA independently.
