# Changelog

## Unreleased

- Warns when Markdown inline review anchors refer to sidecar comment JSON that is missing or incomplete.
- Adds reply threads under review comments and includes discussion history in agent exports.
- Compacts multiple inline review anchors at the same insertion point into one grouped marker.
- Removes the text-only Review Document action from the editor title toolbar and keeps it in context menus/Command Palette.
- Removes resolved or rejected review threads from inline Markdown anchor metadata.
- Moves closed review threads to `.ai-markdown-review/resolved/` and appends a compact end-of-file audit log.
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
- Adds Accept actions to close agreed review feedback separately from resolve/reject.
- Shows suggested replacement patches with an Apply Edit action that updates Markdown only when the target is reliable.
- Routes Apply Edit through a review-aware edit service that refreshes sidecar anchors/context and records edit outcome replies.
- Adds a constrained rendered-block Markdown editor and rewrite path that use the same review-aware edit pipeline.
- Uses Turndown for block-editor HTML-to-Markdown conversion instead of a hand-rolled serializer.
- Submits comment and reply textareas with Enter while keeping Shift+Enter for multi-line text.
- Keeps the active comment overlay or review thread focused after saving a reply.
- Shows accepted, resolved, and rejected review history with linked/outdated anchor state and a Restore action.
- Dismisses an empty selected-text comment composer on outside click or Escape while preserving typed drafts.
- Hides compact `ai-review-log` audit comments from the rendered Markdown review preview.
- Fixes rendered-block edits so excluded following blocks are not accidentally deleted and partial comment anchors do not expand to the whole edited block.
- Adds Node unit and scenario tests for suggested patch selection, review-aware edits, inline anchor metadata, review lifecycle flow, and agent feedback export guardrails.
- Extends license policy guidance to cover test tooling and future dependencies.
- Adds agent editing guidelines and workflow documentation for iterative human/AI review handoff.

## 0.0.8

- Removes the top preview Add Feedback button and Markdown source shortcut provider.
- Adds a read-only comment overlay from highlighted regions and badges, including Resolve and Reject actions.

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
