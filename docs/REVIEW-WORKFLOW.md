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
the source first, and optionally record a one-line result with its revision. It
must preserve every user comment and target; it must not add replies, close, or
archive comments. Delete the JSON after recording the outcome.

## Review the result

The sidecar watcher refreshes the preview after external changes. If the agent
deletes the JSON, the extension shows the last valid snapshot and a notice that
the round is ready for review. Inspect the Markdown itself; an agent result is
only a report. Add a new comment to start another round and recreate the JSON.

Missing or ambiguous targets are reported in the agent result instead of being
silently moved. The user edits or deletes the comment and creates the next JSON
round.

## Safety boundaries

The extension writes only local workspace files and local recovery snapshots.
It does not send Markdown to a provider. Do not let the extension and an
external agent write the same JSON simultaneously; normal atomic writes protect
against partial files but cannot coordinate arbitrary writers.
