# Changelog

## 0.3.1 - 2026-09-12

- Removes `pending`, `done`, and `blocked` from new JSON task files; the agent
  can leave only an optional revision-bound result note.
- Keeps older v3 status fields readable for one-way migration and omits them on
  the next write.
- Removes the retired `reattach` wording from the agent contract and published
  workflow examples.

## 0.3.0 - 2026-09-12

- Removes the reattach workflow, closed-comment history panel, and in-preview
  status/location labels from the shipped review surface.
- Keeps every v3 comment in one current list; agent results stay attached to the
  user comment until the user edits or deletes it.
- Adds a collapsible comments sidebar and removes the unused prompt document
  provider.
- Updates the JSON guidance, schema docs, README, and regression coverage for
  the user-managed comment cycle.

## 0.2.0 - 2026-09-11

- Removes the Send to Agent / Review Changes handoff state, write pause, and
  recovery menu from the public command and preview surfaces.
- Keeps one compact Copy Review JSON action for agents that need pasted input;
  comments continue to write the colocated v3 task file automatically.
- Treats external deletion of the JSON as a completed agent round while keeping
  the last valid snapshot visible for Markdown review and the next comment.
- Updates the guidance, schema, README, workflow docs, and regression tests for
  the JSON-only loop.

## 0.1.1 - 2026-09-11

- Keeps the public README, workflow documentation, and user-facing labels and
  messages in English while retaining the same v3 task-file behavior.
- Removes a tracked local review sidecar so workspace-specific review history and
  absolute paths are not part of the repository or release package.

## 0.1.0 - 2026-09-11

- Simplifies the workflow to comments → Send to Agent → Review Changes. Removes in-extension conversation replies, AI patch approval, local checks, and multiple prompt commands.
- Stores new requests in compact v3 JSON with portable document names, target context, agent guidance, stable IDs, revisions, and pending/done/blocked results. A done result reports AI handling, not user approval.
- Pauses extension writes during handoff and retains drafts across reloads. Validates returned requests before resuming, detects missing or damaged JSON, and offers explicit recovery.
- Preserves earlier reviews with raw local backups, converts open discussions verbatim on handoff, and archives completed requests before the next round. Archived requests can be reopened.
- Retains rendered Markdown, image/code/table/Mermaid comments, precise navigation, manual editing, and side-by-side review. Passive preview no longer rewrites anchor metadata; Undo cannot cross external-edit boundaries.
- Updates the workflow documentation, protocol schema, Marketplace artwork, and regression coverage.

## 0.0.21 - 2026-09-09

- Keeps unsaved comment, reply, block, table, and Mermaid drafts through preview refreshes; waits for save confirmation, supports failed-save retries, and recovers stale drafts through explicit copy/discard.
- Adds manual `Reattach` for existing review threads while preserving discussion history, and prevents a relocated thread from applying a patch at an unrelated target.
- Fixes navigation through overlapping comments, adds keyboard-accessible source jumps and review position, and distinguishes first-use and completed-feedback empty states.
- Recognizes multiline closed-history anchors and navigates to their verified current source ranges.
- Clarifies `Run Local Checks`, recognizes Korean acceptance headings, excludes code examples, and avoids repeating unchanged local findings already closed by the reviewer.
- Resolves prompt commands from the active review preview and offers retry against the same document after command failures.
- Preserves later comments, replies, and human decisions through review-aware Undo and Redo, and serializes review writes to prevent lost updates.
- Rejects stale preview edits and conflicting sidecar writes without overwriting newer work; preserves document line endings during edit and rollback.
- Keeps review files when a Markdown rename changes only filename casing.
- Preserves original image Markdown and inline-code whitespace during rich editing, and keeps nested quote/list content inside its source-owning editor.
- Tracks table row/column identity and repeated text anchors through edits, and fixes highlighted selections inside indented code fences.

## 0.0.20 - 2026-05-28

- Makes ordinary fenced code blocks reviewable by preserving source line ranges in the rendered preview.
- Allows selected code block text, including multiline selections, to receive comment popovers, highlights, badges, and thread navigation.

## 0.0.19 - 2026-05-27

- Frames the Review Threads side panel as a sticky floating review frame when space allows.
- Prevents rendered-block edit controls from appearing on read-only AI prompt documents and floating over the feedback-loop prompt header.
- Adds table-level and table-cell comment buttons so rendered Markdown tables can receive review feedback without manual source selection.
- Renames the `Recovered` anchor state label to `Found nearby` in the UI and docs while keeping the underlying compatibility value unchanged.
- Adds a closed-loop AI action packet contract and template to feedback-loop prompts, agent exports, and policy docs so AI turns can plan, reply, record outcomes, or request closure explicitly.

## 0.0.18 - 2026-05-26

- Removes the premature rendered-block `Rewrite` button until a real AI rewrite or suggested-patch workflow exists.
- Keeps rendered-block editing focused on explicit `Edit`, `Add Below`, and `Delete` actions.

## 0.0.17 - 2026-05-26

- Clarifies rendered-block actions by labeling insertion as `Add Below` and distinguishing manual edits from whole-block rewrites in tooltips.
- Inserts new rendered-preview Markdown blocks as separated blocks below the selected source line instead of merging them into adjacent paragraphs.
- Lets the block editor switch to Raw after rich formatting changes by converting the current rich editor contents back to Markdown first.
- Makes inline `Code` formatting visibly wrap text in `<code>` styling and preserve toolbar selections during formatting.

## 0.0.16 - 2026-05-26

- Prevents closed-history anchors from reporting `Linked` solely because a later duplicate occurrence survived after the original was removed.
- Keeps imported same-line review comments distinct when their anchor occurrence or surrounding identity differs.
- Stops Mermaid diagram comments from decorating every figure that shares a common snippet; full-fence matches stay exact, while source-line-scoped snippet matches are approximate.

## 0.0.15 - 2026-05-26

- Strengthens AI feedback-loop prompts and exports so direct AI-applied Markdown edits must also append sidecar thread history before the loop is considered complete.

## 0.0.14 - 2026-05-26

- Prevents comments on deleted Markdown blocks from being automatically re-anchored to neighboring sections.
- Clears misleading surrounding context from delete-block missing anchors so `Needs re-anchor` remains explicit until the user decides what to do.

## 0.0.13 - 2026-05-26

- Adds rendered-preview block insertion below a source-mapped block through the review-aware edit path.
- Adds raw Markdown mode to the rendered block editor so list markers and other source syntax can be edited directly.
- Adds rendered-block deletion with affected comment anchors preserved as missing instead of silently dropped.
- Highlights the currently selected draft comment range while the selected-text composer is open.
- Improves multiline list selection source-line capture so comments attach to the selected list rows instead of a nearby header.
- Clarifies AI prompts and policy docs so agents do not confuse the new-thread proposal schema with the full sidecar `openThreads`/`closedThreads` persistence format.

## 0.0.12 - 2026-05-26

- Hides YAML front matter from the rendered review preview while preserving source line mapping for anchors and edits.
- Hides AI-response reply shortcuts on human-only review threads until AI or automated review has joined the discussion.
- Improves repeated-text anchor placement so comments prefer the original line, occurrence, and surrounding context instead of jumping to another matching word.
- Prevents review threads on the same repeated text from being grouped together unless their anchor identity matches.

## 0.0.11 - 2026-05-25

- Makes colocated `.<filename>.ai-review.json` sidecars the source of truth for new comments, replies, decisions, restores, and local review feedback without inserting inline Markdown metadata.
- Changes legacy `ai-review-*` source comments into optional cleanup hints instead of export blockers.
- Updates AI prompt and review policy guidance so agents preserve sidecars and avoid creating new inline review metadata.

## 0.0.10 - 2026-05-25

- Renders local Markdown images in the review preview through VS Code-safe webview URIs.
- Adds image-level `Feedback` actions, badges, overlays, replies, and agent-export matching for image review threads.
- Blocks remote `http` and `https` image loading by default and shows a reviewable placeholder/link instead.
- Updates release guidance so every versioned change gets a release-manager metadata pass.

## 0.0.9 - 2026-05-25

- Adds Marketplace-ready package metadata, icon, gallery banner, README visuals, and support links.
- Adds generated Marketplace hero, animated GIF demo, MP4 demo, and reproducible asset generation script.
- Adds release hygiene scripts for third-party notice coverage and VSIX package contents.
- Warns when Markdown inline review anchors refer to sidecar comment JSON that is missing or incomplete.
- Adds reply threads under review comments and includes discussion history in agent exports.
- Compacts multiple inline review anchors at the same insertion point into one grouped marker.
- Removes the text-only Review Document action from the editor title toolbar and keeps it in context menus/Command Palette.
- Removes resolved or rejected review threads from inline Markdown anchor metadata.
- Moves closed review threads into closed history and appends a compact end-of-file audit log.
- Adds a one-click cleanup action for stale inline anchors when their sidecar data is missing.
- Trims inline anchor metadata to the minimum open-thread pointer shape and cleans closed stale anchors.
- Keeps comments visible after the commented text changes by falling back to stored line hints.
- Rewrites Markdown review anchors as one document-level `ai-review-anchors` index per document and uses sidecar line hints for changed text.
- Stores sidecar context snippets around new comments, uses them to relocate comments after text edits, and refreshes line hints from the preview.
- Differentiates user and AI review comments with source labels, badge colors, and highlight colors.
- Shows anchor confidence states for review threads, including recovered, approximate, and needs re-anchor when edited text can no longer be located.
- Shows reply authors with the same `You` and `AI` labels used by top-level review comments.
- Debounces review anchor maintenance and only auto-saves high-confidence anchor relocations to the sidecar.
- Labels review metadata chips as type, severity, and status instead of showing bare values.
- Replaces open-thread Accept/Reject close buttons with type-aware reply shortcuts, leaving Resolve as the explicit handled-issue closure.
- Shows suggested replacement patches with an `Apply Patch and Close` action that updates Markdown only when the target is reliable.
- Hides `Apply Patch and Close` when the original patch target no longer matches the current Markdown and shows a stale-patch explanation instead.
- Refreshes the review preview when an AI agent or external editor updates the Markdown review sidecar, so revised suggested patches appear without reopening the preview.
- Routes `Apply Patch and Close` through a review-aware edit service that refreshes sidecar anchors/context and records edit outcome replies.
- Adds a constrained rendered-block Markdown editor and rewrite path that use the same review-aware edit pipeline.
- Uses Turndown for block-editor HTML-to-Markdown conversion instead of a hand-rolled serializer.
- Hardens rendered-block HTML-to-Markdown conversion for empty inline tags, task lists, fenced code languages, pasted tables, and malformed emphasis.
- Preserves ordered list numbering when editing one rendered list item through the block editor.
- Makes rendered list-item edits source-aware so the editor preserves the original Markdown list marker without wrapping the edit in a fake ordered-list parent.
- Adds Mermaid source editing from rendered diagram cards through the review-aware edit pipeline.
- Adds a rendered Markdown table grid editor with row, column, and alignment controls through the review-aware edit pipeline.
- Keeps table-cell comment anchors attached to edited cells, including repeated text in different rows.
- Adds repo-owned AI review policy, collaboration-loop docs, context bootstrap commands, and guarded rename migration for review sidecars.
- Simplifies the preview AI context entry point to one bootstrap prompt action and makes that prompt a generic agent contract for review-loop usage and comment-preserving Markdown edits.
- Adds an AI feedback loop prompt for continuing active review threads, drafting replies, and applying explicit suggested patches through the review-aware edit path.
- Opens generated prompt and feedback-export documents as read-only virtual Markdown so VS Code does not wait to back up unsaved prompt editors during reload.
- Clarifies feedback-loop prompt behavior for "accept this suggestion" so safe suggested patches are treated as apply requests instead of close-only decisions.
- Adds a deterministic AI reviewer and human author simulation harness plus a review-loop feedback report.
- Adds a rich Markdown review-loop fixture and expands AI/human simulation coverage with realistic comment transcripts, replies, stale-patch revision, table-cell, and Mermaid scenarios.
- Adds recovery-first stale sidecar actions to open the expected sidecar or find legacy review sidecars before cleaning stale anchors.
- Adds `Close as Declined`, thread-focused `Continue with AI`, reply handoff warnings, and post-edit outcome chips for active review threads.
- Shows safe-patch applicability text before `Apply Patch and Close` so users can see why the action will update Markdown and close the thread.
- Adds previous/next review comment navigation through compact arrow buttons and Left/Right Arrow keys outside text entry.
- Adds feedback-loop prompt guidance for revised patch replies and clarifies that `needs human decision` leaves the thread open.
- Adds a durable AI/human review-loop session record and trace that capture AI comments, human replies, AI follow-ups, sidecar snapshots, closed improvements, and empty remaining feedback.
- Treats the latest human request and thread replies as a review session brief in bootstrap prompts, feedback-loop prompts, and agent exports.
- Keeps the bootstrap prompt OS-like and generic by removing generated target text from the prompt body.
- Removes the repo-specific context-source checklist from the bootstrap prompt so it stays generic and copy-pasteable.
- Submits comment and reply textareas with Enter while keeping Shift+Enter for multi-line text.
- Keeps the active comment overlay or review thread focused after saving a reply.
- Shows accepted, resolved, and rejected review history with linked/outdated anchor state and a Restore action.
- Colors closed history by accepted, resolved, or rejected decision and records who closed newly decided threads.
- Stores new review state beside each Markdown file in one hidden `.<filename>.ai-review.json` sidecar while still reading legacy `.ai-markdown-review/` sidecars for migration.
- Dismisses an empty selected-text comment composer on outside click or Escape while preserving typed drafts.
- Hides compact `ai-review-log` audit comments from the rendered Markdown review preview.
- Fixes rendered-block edits so excluded following blocks are not accidentally deleted and partial comment anchors do not expand to the whole edited block.
- Updates partial comment anchors to the edited word or phrase when a reviewed text fragment changes in place.
- Humanizes automatic review update replies and hides older internal edit-pipeline wording in the preview.
- Keeps review sidecar updates in sync with Ctrl+Z/Ctrl+Shift+Z for review-aware edits and review marker changes.
- Moves agent exports to a threads-first layout and flags review comments that are too vague for reliable AI handoff.
- Cleans the Mermaid smoke-test sample so source view does not start with stale review metadata.
- Adds Node unit and scenario tests for suggested patch selection, review-aware edits, inline anchor metadata, review lifecycle flow, and agent feedback export guardrails.
- Adds regression coverage for simulated review-loop scenarios, including patch application clarity, anchor preservation visibility, AI handoff continuity, and human-gated closure.
- Extends license policy guidance to cover test tooling and future dependencies.
- Adds agent editing guidelines and workflow documentation for iterative human/AI review handoff.

## 0.0.8

- Removes the top preview Add Feedback button and Markdown source shortcut provider.
- Adds a read-only comment overlay from highlighted regions and badges, including Resolve actions and discussion shortcuts.

## 0.0.7

- Makes Review Threads cards jump back to their highlighted content in the rendered preview.
- Keeps `.agent/` local-only through `.gitignore`.
- Adds MIT license policy and third-party notices.

## 0.0.6

- Adds a split-review toolbar command that opens Markdown source and review preview side by side.
- Adds compact `ai-review-anchor` metadata comments to Markdown files when feedback is created.
- Hides review anchor metadata from the custom rendered preview.

## 0.0.5

- Shows visible review highlights and comment badges in the rendered Markdown preview.
- Marks Mermaid diagram cards that have attached review feedback.
- Replaces the toolbar shortcut asset with a clearer comment-review icon.

## 0.0.4

- Adds a custom editor title toolbar icon for opening AI Review.
- Keeps the toolbar shortcut visible even when VS Code does not expose Markdown resource context.

## 0.0.3

- Adds Markdown editor shortcuts.
- Broadens Markdown menu visibility using file extension and language context.

## 0.0.2

- Opens the inline comment composer immediately after a rendered Markdown text selection.
- Excludes local review sidecar data from packaged VSIX output.

## 0.0.1

- Initial MVP scaffold for Markdown review preview, Mermaid rendering, local feedback storage, review export, and local heuristic review.
- Added Markdown editor title/context shortcuts and drag-selection inline comment composer.
