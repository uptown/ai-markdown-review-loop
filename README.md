# AI Markdown Review Loop

AI Markdown Review Loop is a VS Code extension for reviewing Markdown documents with inline feedback, AI-ready review threads, and agent handoff exports.

The first MVP focuses on a local workflow:

- Open a rendered Markdown review preview.
- Render Mermaid diagrams from fenced `mermaid` code blocks.
- Open the review preview from a Markdown editor title shortcut.
- Use top-of-file CodeLens shortcuts: `Open AI Review`, `Review Document`, and `Export Feedback`.
- Drag-select rendered text and attach feedback from an inline comment popover.
- Attach feedback directly to a Mermaid diagram source block.
- Store review threads in a workspace-local sidecar file.
- Export unresolved feedback as Markdown for an AI coding agent.
- Run a local heuristic document review to seed obvious feedback items.

## Development

```bash
nvm use
npm install
npm run compile
```

To run inside VS Code:

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Open a `.md` file.
4. Click the review shortcut in the Markdown editor title, or run `AI Markdown Review: Open Review Preview`.

Installed usage:

1. Open a Markdown file.
2. Click `Open AI Review` above the first line, click the editor title shortcut, right-click the editor and choose `AI Markdown Review: Open Review Preview`, or press `Cmd+Alt+R`.
3. Drag-select rendered text in the review preview.
4. Click the floating `Comment` button and save feedback inline.

## Commands

- `AI Markdown Review: Open Review Preview`
- `AI Markdown Review: Review Document`
- `AI Markdown Review: Export Feedback for Agent`

## Shortcuts

- Editor title shortcut on Markdown files: open review preview.
- Top-of-file CodeLens shortcuts on Markdown files: open review, review document, export feedback.
- Editor context menu on Markdown files: open review preview or export feedback.
- Keyboard shortcut: `Cmd+Alt+R` on macOS, `Ctrl+Alt+R` elsewhere.

## Mermaid

Mermaid diagrams render directly inside the review preview:

````md
```mermaid
flowchart TD
  A[Draft PRD] --> B[AI review]
  B --> C{User decision}
  C -->|Accept| D[Patch document]
  C -->|Reject| E[Close thread]
  C -->|Reply| B
```
````

Each diagram card includes:

- `Feedback` to attach review feedback to the diagram source.
- `Copy` to copy the Mermaid source.
- A collapsible `Source` view.
- Inline render errors with the original diagram source.

## Storage

MVP review data is stored under:

```text
.ai-markdown-review/
  documents/
    <document-hash>.json
```

## Packaging

```bash
npm run package
```

Publishing requires a Visual Studio Marketplace publisher and a `vsce` login:

```bash
npx vsce login <publisher-id>
npx vsce publish
```

GitHub publishing will use:

```bash
gh repo create uptown/ai-markdown-review-loop --public --source=. --remote=origin --push
```
