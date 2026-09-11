# Comment → Agent Edit → Review

This is the current v3 workflow. The user reviews a document; an external coding
agent handles the requested changes in that document. The extension collects
requests and displays outcomes without running a model.

## A Review Round

1. Open the review preview and save comments on specific content.
2. Choose **AI에 전달**. The extension saves a request checkpoint, pauses its
   writes, and copies a short request pointing to the colocated JSON.
3. Paste that request into an agent with workspace file access.
4. The agent reads current Markdown, edits it, then records a short done or
   blocked result for each handled item and stops writing.
5. Choose **수정본 검수**. Inspect the revised source and results. Reopen an
   unsatisfactory item, clarify blocked work, or save new comments.
6. Send the next round. Previously completed items move to local history before
   being removed from active JSON; unfinished requests remain.

**Done** means the agent reports completion of a particular request revision.
The user still evaluates the actual change. There is no separate patch approval
or reply transcript to maintain in the extension.

## Blocked Work

A result such as “Which team owns the retry policy?” gives a concrete next step.
You may answer the agent in its existing conversation and let it finish the same
revision, or return to review mode and edit the request. Editing the request
creates a new revision. If an agent later returns a result for an older revision,
it is shown as stale until the current revision is handled. Do not ask both the extension and agent to write simultaneously.

## Scenarios To Verify

These are acceptance scenarios, not claims of a completed live-agent test:

- **Normal round:** save two comments, hand off, edit both source targets, record
  two done results, return to review, and inspect both changes.
- **Partial result:** complete one request and block another. The blocked reason
  stays visible and the unfinished request carries into the next round.
- **Restart:** interrupt an agent after its Markdown edit; on restart it reads
  current content before recording an outcome or making another edit.
- **Ambiguous location:** duplicate or delete a selected phrase. The agent
  blocks instead of guessing; the user can confirm a new target with Reattach.
- **Stale result:** revise a request while keeping its old result. That result
  cannot mark the new revision done.
- **Interrupted handoff:** reload the window during handoff and confirm that
  extension writes remain paused. Return only after the agent stops writing.
- **File discrepancy:** remove an item or change its request without revising it.
  Return-to-review must show the discrepancy and retain recoverable state.
- **Next round:** verify local history is saved before completed items disappear
  from active JSON, then reopen one historical item.

Run these with the actual Extension Host and a file-capable agent as well as
focused automated tests. A DOM simulation cannot establish real external-agent
or filesystem coordination behavior.
