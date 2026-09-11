# AI Markdown Review Loop

Turn comments on a Markdown document into a small JSON task file for an
external AI coding agent. The extension stays local: it does not call a model
provider and it does not host an agent conversation.

![Comment, export JSON, and review the revised Markdown](./media/marketplace-hero.png)

## Workflow

1. Open a Markdown file and choose **AI Markdown Review: Open Review Beside**.
2. Select rendered text and save a comment describing the change.
3. The extension writes `.<filename>.ai-review.json` beside the Markdown file.
4. Use **AI Markdown Review: Copy Review JSON** when the agent needs pasted
   JSON. A file based agent can read the sidecar directly.
5. The agent reads the guidance, edits the Markdown, records `done` or
   `blocked` for each item, then deletes the JSON when the round is complete.
6. Return to the preview and inspect the revised Markdown. Add another comment
   for the next round.

The preview watches the sidecar. When the external agent removes it, the last
valid task snapshot remains visible so the result can be reviewed. The next
saved comment recreates the JSON file.

## Review JSON

The sidecar is intentionally short and contains no Markdown copy or chat
transcript:

```text
docs/spec.md
docs/.spec.md.ai-review.json
```

Each item has a stable `rv_*` ID, a revision, a quoted target with line hints,
the comment, and a status. The agent may write a one-line `result` and matching
`resultFor` revision.

```json
{
  "schemaVersion": 3,
  "document": "spec.md",
  "guidance": "Resolve the Markdown relative to this JSON. Handle pending items, verify quote and context, edit the document first, then set done or blocked with one short result. Preserve IDs and revisions. Delete this JSON after recording outcomes.",
  "items": [
    {
      "id": "rv_123",
      "rev": 1,
      "target": { "line": 12, "quote": "The retry policy is documented here." },
      "comment": "Add the failure reason and the user retry steps.",
      "status": "pending"
    }
  ]
}
```

`done` means the agent reported that revision as handled. Always inspect the
actual Markdown. Use `blocked` when the target is missing or ambiguous. Editing
a comment or reattaching its target creates a new revision and clears the old
result.

## Commands and shortcuts

- **AI Markdown Review: Open Review Beside** — source and preview side by side.
- **AI Markdown Review: Open Review Preview** — rendered review only.
- **AI Markdown Review: Copy Review JSON** — copy the current sidecar without
  pausing review writes.
- `Cmd+Alt+Shift+R` on macOS / `Ctrl+Alt+Shift+R` elsewhere — open beside.
- `Cmd+Alt+R` on macOS / `Ctrl+Alt+R` elsewhere — open preview.

There are no in-extension replies, chat prompts, patch approval buttons, agent
handoff locks, history menus, or backup restore actions.

## Privacy and support

Review JSON stays in the workspace and recovery snapshots stay in local VS Code
storage. The extension sends no document text to a provider. Review comments
and results can contain sensitive project context; check both files before
sharing or committing them.

MIT licensed. See [third-party notices](./THIRD_PARTY_NOTICES.md) and
[support](./SUPPORT.md).

[Report an issue](https://github.com/uptown/ai-markdown-review-loop/issues).
