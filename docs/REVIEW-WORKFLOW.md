# Review workflow

The supported loop is **comment → JSON → external agent edit → Markdown
review**.

## Save a request

Select rendered text and save one clear change request. The extension writes a
single hidden `.<filename>.ai-review.json` next to the Markdown file. It keeps
stable IDs, revisions, quoted targets, line hints, and a short agent guidance
string. Later comments can be added while the JSON exists.

## Give the request to an agent

Use **AI Markdown Review: Copy Review JSON** when pasted content is needed. A
file-capable agent can open the sidecar directly. The extension does not create
a second prompt, lock the editor, or coordinate an agent conversation.

The agent must read the current Markdown, verify each quote and context, edit
the source first, then set `done` or `blocked` with a one-line `result` and the
handled `resultFor` revision. It should preserve other items and delete the JSON
after recording outcomes.

## Review the result

The sidecar watcher refreshes the preview after external changes. If the agent
deletes the JSON, the extension shows the last valid snapshot and a notice that
the round is ready for review. Inspect the Markdown itself; `done` is only an
agent report. Add a new comment to start another round and recreate the JSON.

Missing or ambiguous anchors remain visible as blocked work. Reattach is an
explicit location change that preserves the request ID and increments its
revision.

## Safety boundaries

The extension writes only local workspace files and local recovery snapshots.
It does not send Markdown to a provider. Do not let the extension and an
external agent write the same JSON simultaneously; normal atomic writes protect
against partial files but cannot coordinate arbitrary writers.
