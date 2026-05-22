# Review Workflow

This extension is built around repeated document-review loops between human authors, human reviewers, and AI agents. A review thread is a durable discussion item attached to Markdown content. Editing the document and deciding the thread status are separate actions.

## User Stories

- As an author, I want to drag-select rendered Markdown and leave feedback so the comment stays attached to the document content.
- As a reviewer, I want human and AI comments to be visually distinct so I can judge the source of each concern.
- As an author, I want to reply before closing a thread so objections, clarification, and decisions are preserved for later AI handoff.
- As an author, I want `Accept`, `Resolve`, and `Reject` to mean different things so I can close feedback without implying the document was automatically edited.
- As an AI-agent user, I want open feedback exported with thread IDs, source labels, discussion history, anchor confidence, and suggested patches so an agent can work from the review queue.
- As a collaborator, I want comments to remain visible after nearby edits so feedback does not silently disappear when wording changes.
- As an author, I want rendered-block edits and suggested patch application to use the same review-aware pipeline so sidecar anchors, context, and edit outcomes stay current.
- As an author, I want to edit Mermaid diagram source from the rendered preview so diagram fixes stay in the same review loop as prose edits.
- As a reviewer, I want accepted, resolved, and rejected threads to remain visible as history so I can audit decisions and restore one when discussion needs to continue.

## Action Vocabulary

- `Reply`: add context, clarification, or objection without changing status.
- `Apply edit`: change the Markdown manually or through an agent patch. This does not close a thread by itself.
- `Apply Edit`: extension action for a suggested replacement patch. It mutates the Markdown and closes the thread as `accepted` only when the original text has one reliable target.
- `Edit block`: constrained rendered-preview Markdown editing for a source-mapped block. It mutates Markdown and refreshes overlapping thread anchors without deciding review status.
- `Edit Mermaid`: source editor for a Mermaid fenced code block. It replaces only that fenced block and refreshes overlapping thread anchors without deciding review status.
- `Rewrite block`: manual rewrite path that uses the same review-aware edit pipeline reserved for future AI rewrite integration.
- `Accept`: agree with the feedback or recommendation and close the thread as an accepted decision.
- `Resolve`: close because the underlying issue has been handled, superseded, or no longer applies.
- `Reject`: close because the recommendation is intentionally declined.
- `Restore`: reopen a closed thread, move it back to active feedback, and attach it to the current document again.
- `Re-anchor`: attach a drifted comment to a new document location.
- `Clean stale anchors`: remove broken metadata only; this is not a review decision.
- `Export for Agent`: package open threads for AI work without mutating review state.

## Scenarios

### Draft, Review, Handoff

1. An author writes a Markdown PRD.
2. The extension seeds obvious local review items.
3. The author replies to one thread with extra context, rejects another recommendation, accepts one direction, and keeps a risky item open.
4. The agent export includes only open feedback plus discussion history and editing guidelines.

### AI Suggestion, Manual Fix

1. AI feedback says an acceptance criterion is not testable.
2. The author edits the Markdown manually instead of applying the exact suggested patch.
3. The anchor is recovered near the changed paragraph.
4. The author marks the thread `Resolve` because the issue was fixed, not `Accept` because an AI patch was applied.

### AI Suggestion, Patch Accepted

1. AI feedback includes a suggested replacement patch.
2. The author opens the thread and reviews the diff.
3. The extension checks that the original text still exists at a reliable anchor.
4. The author clicks `Apply Edit`.
5. The extension replaces the Markdown text, refreshes affected sidecar anchors and context snippets, records edit outcome replies, removes the open target anchor, archives the target thread as `accepted`, and leaves an audit log pointer.
6. If the text is missing, duplicated ambiguously, or attached to a low-confidence anchor, the thread remains open for reply, re-anchor, or manual editing.

### Rendered Block Edit

1. A paragraph has one or more open comments attached.
2. The author opens the block editor from the rendered preview.
3. The extension replaces only the source-mapped Markdown lines for that block.
4. Overlapping open threads receive refreshed anchor text, line hints, hash, context snippets, and an edit outcome reply.
5. Ordinary source edits outside this pipeline still use debounced re-anchor fallback and only persist high-confidence locations.

### Mermaid Source Edit

1. A Mermaid diagram has source feedback or needs a quick syntax/content correction.
2. The author clicks `Edit` on the diagram card.
3. The extension opens a source editor for the Mermaid fenced block.
4. Saving replaces only that fenced block, keeps following Markdown intact, and refreshes overlapping review anchors.
5. The preview re-renders the diagram and shows Mermaid render errors inline if the new source is invalid.

### Objection Before Decision

1. AI recommends removing a section.
2. The author replies that the section is contractual context and should remain.
3. The thread stays open while the discussion continues.
4. The final user decision is `Reject`, preserving that the recommendation was deliberately declined.

### Restore a Closed Decision

1. A user accepts, resolves, or rejects a thread.
2. The thread moves into closed history with its final decision and discussion.
3. If the original anchor text still exists, the history card is `Linked`; if the text disappeared, it is `Outdated`.
4. The user clicks `Restore` when the decision needs more discussion.
5. The extension moves the thread back to open feedback, removes the old closed audit pointer, writes a fresh open anchor index, and focuses the restored thread.

### Comment Survives Iterative Editing

1. A user comments on a paragraph asking who owns rollback.
2. An AI agent rewrites the surrounding section.
3. Exact text no longer exists, but context snippets and line hints locate the closest surviving block.
4. The UI shows the anchor confidence so the user can re-anchor, resolve, or keep discussing.

## Agent Behavior

Agents should treat review sidecar data and inline review metadata as part of the document state. They should preserve review anchors and logs, prefer localized edits, keep nearby context stable where possible, and report every handled `rv_*` ID with an outcome. Agents should not close threads as `accepted`, `resolved`, or `rejected` unless the user explicitly asks them to make that review decision.

When an AI rewrite provider is added, it should emit a review-aware edit plan instead of rewriting Markdown directly. The plan should identify the selected range, actor, intent, target thread when applicable, and whether a user explicitly requested a status decision.
