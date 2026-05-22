# Changelog

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

- Adds top-of-file CodeLens shortcuts for Markdown files.
- Broadens Markdown menu visibility using file extension and language context.

## 0.0.2

- Opens the inline comment composer immediately after a rendered Markdown text selection.
- Excludes local review sidecar data from packaged VSIX output.

## 0.0.1

- Initial MVP scaffold for Markdown review preview, Mermaid rendering, local feedback storage, review export, and local heuristic review.
- Added Markdown editor title/context shortcuts and drag-selection inline comment composer.
