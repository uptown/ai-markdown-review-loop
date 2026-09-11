# Comment → JSON → Agent Edit → Review

This extension is a local review surface. It collects comments and writes one
small JSON task file; the external coding agent owns the Markdown edit.

## One review round

1. Open the preview and select the text that needs a change.
2. Save a clear comment. The sidecar `.<filename>.ai-review.json` is created or
   updated beside the Markdown file.
3. Use **Copy Review JSON** only when the agent needs pasted content. Agents
   with workspace access can read the sidecar directly.
4. The agent reads the guidance, verifies each target, edits the Markdown, and
   records `done` or `blocked` plus a one-line result for each handled revision.
5. The agent stops writing and deletes the JSON file.
6. The preview keeps the last valid task snapshot and shows a removal notice.
   Inspect the revised Markdown, then add a new comment for another round.

There is no in-extension conversation, reply transcript, patch approval, or
write pause. The user and agent should still avoid editing the same files at
the same time.

## Expected outcomes

- **Normal:** every comment has a matching Markdown change and a `done` result.
- **Partial:** completed items are `done`; uncertain or incomplete items are
  `blocked` with a reason. The user can add a clearer comment next round.
- **Stale target:** the agent leaves the item `blocked` instead of guessing.
- **Interrupted run:** the agent reads the current Markdown and JSON before
  continuing. A missing JSON can be restored from the extension's local
  snapshot view; saving a new comment creates a fresh sidecar.

## File contract

The JSON contains only `schemaVersion`, the Markdown basename, one guidance
string, and `items`. Each item preserves its `rv_*` ID, `rev`, target quote and
line hints, comment, status, and optional `result`/`resultFor`. The extension
rejects malformed or stale revisions and never treats a `done` report as proof
that the source is correct.
