# Changelog

## Unreleased

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
- Shows suggested replacement patches with an `Apply Suggested Patch` action that updates Markdown only when the target is reliable.
- Hides `Apply Suggested Patch` when the original patch target no longer matches the current Markdown and shows a stale-patch explanation instead.
- Refreshes the review preview when an AI agent or external editor updates the Markdown review sidecar, so revised suggested patches appear without reopening the preview.
- Routes `Apply Suggested Patch` through a review-aware edit service that refreshes sidecar anchors/context and records edit outcome replies.
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
