# Release Checklist

Use this checklist for the v3 task-file workflow introduced in version 0.1.
Record the exact source revision and distinguish automated checks, actual
Extension Host tests, external-agent runs, and public publication evidence.

## Preconditions

- Review the final diff and confirm version, changelog, README, UI labels, schema,
  and Marketplace artwork describe the same current workflow.
- Use the Node version in `.nvmrc` (Node 20). Install existing dependencies with
  `npm ci`; asset generation also needs ImageMagick and FFmpeg.
- Keep `.agent/`, `.ai-markdown-review/`, all local `*.ai-review.json` files,
  `docs/PRD.md`, and context briefs out of Git and the VSIX.
- Confirm the `uptown` publisher and the authorized publication channel without
  printing authentication material.

## Version And Assets

1. Update package version and lockfile together. Move user-facing changelog
   entries into the dated release section.
2. Back up current media before regeneration: `npm run assets:marketplace`.
3. Inspect the icon, hero, all walkthrough frames, GIF, and MP4. Artwork is an
   illustrated workflow, so do not call it a live screenshot or agent test.
4. Ensure the old reply, AI attribution, local-check, and patch-approval flows
   are absent from current product copy and artwork.

Required public assets are `media/marketplace-icon.png`,
`media/marketplace-hero.png`, `media/review-loop-demo.gif`, and
`media/review-loop-demo.mp4`. They are generated from repository-owned SVG code.

## Automated Gates

```bash
npm run release:check
git diff --check
```

The release script regenerates media, typechecks, runs tests, checks third-party
notices, packages the VSIX, and checks its contents. Review the test names as well
as the totals: retained legacy fixtures do not prove the v3 round trip.

Confirm the packaged version and required files, then record the VSIX size and
SHA-256. No local plans, sidecars, source/test trees, dependencies, credentials,
or source maps should ship. Do not upload an older ignored VSIX by mistake.

## Actual Extension Host And Agent Smoke

Install the generated artifact in a test environment, for example:

```bash
code --install-extension ai-markdown-review-loop-<version>.vsix --force
```

1. Open a Markdown file beside its preview and add comments on text, a table,
   image, code, and Mermaid content. Navigate and reattach a missing target.
2. AI에 전달; verify saved v3 JSON, a short copied request, write pause, and
   local draft preservation. Reload VS Code and confirm the pause survives.
3. Use a file-capable external agent to edit Markdown, mark one item done, and
   block another. Confirm it stops writing before 수정본 검수 resumes review.
4. Inspect the revised source, clarify or reopen work, and send a second round.
   Confirm completed work remains in local history and unfinished work remains
   in active JSON. Reopen an archived request.
5. Exercise failed saves/clipboard writes, interrupted JSON writes, deleted or
   malformed review files, stale result revisions, missing/changed IDs, dirty
   source and JSON editors, and an interrupted preparing state.
6. Check v2 conversion backup, legacy-history inspection, source rename/move,
   undo around the handoff boundary, keyboard navigation, and draft recovery.
7. Exercise a direct-path handoff separately and document its lack of extension
   pause/checkpoint protection. Never claim multiple-writer safety from this test.

Use [the workflow scenarios](./AI-COLLABORATION-LOOP.md) for expected outcomes.
Passing pure tests or a mocked DOM does not replace these host/agent checks.
If a check was not run, record it as untested rather than counting it as passed.

## Publication Evidence

Commit/tag/push and publication are separate authorized actions. Run CI on the
exact release commit. Keep its tag, CI result, artifact digest, and GitHub release
aligned before publishing the VSIX through the authorized channel.

Verify the public Marketplace listing independently. An upload acknowledgement,
CLI timeout, or management-page “Verifying” state does not establish public
availability. Report GitHub publication and Marketplace visibility separately.
