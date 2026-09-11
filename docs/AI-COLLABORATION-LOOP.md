# Comment → JSON → Agent Edit → Review

This extension is a local review surface. It collects comments and writes one
small JSON task file; the external coding agent owns the Markdown edit.

## One review round

1. Open the preview and select the text that needs a change.
2. Save a clear comment. The sidecar `.<filename>.ai-review.json` is created or
   updated beside the Markdown file.
3. Use **Copy Review JSON** only when the agent needs pasted content. Agents
   with workspace access can read the sidecar directly.
4. The agent reads the guidance, reviews every current comment against the
   latest Markdown, edits the source, and records a one-line result.
5. The agent stops writing and deletes the JSON file.
6. The preview keeps the last valid task snapshot and shows a removal notice.
   Inspect the revised Markdown, then add a new comment for another round.

There is no in-extension conversation, reply transcript, patch approval, or
write pause. The user and agent should still avoid editing the same files at
the same time.

## Expected outcomes

- **Normal:** every comment has a matching Markdown change and a short result.
- **Partial:** the result explains what could not be completed. The user can
  edit or delete the comment before the next round.
- **Stale target:** the agent reports the ambiguity instead of guessing.
- **Interrupted run:** the agent reads the current Markdown and JSON before
  continuing. A missing JSON leaves the last valid result visible; saving a
  new comment creates a fresh sidecar.

## File contract

The JSON contains only `schemaVersion`, the Markdown basename, one guidance
string, and the current user comments. Each item preserves its `rv_*` ID,
`rev`, target quote and line hints, comment, and optional agent result metadata.
The agent must preserve comment fields and never add replies, history records,
or replacement targets. The extension rejects malformed or stale revisions and
never treats an agent result as proof that the source is correct.
