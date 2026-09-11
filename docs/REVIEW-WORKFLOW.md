# Review Workflow And Recovery

The active workflow is **comment → short JSON handoff → external agent edits
Markdown and records done/blocked → review the revised document**.

## Requests And Results

A saved comment has a stable ID, revision, and target. The current task JSON
is the canonical request file. Changing the comment or reattaching its target
creates a newer revision. An externally returned result for an older revision
is shown as stale and cannot complete the current revision.

Use Pending to identify work remaining, Blocked to find questions or incomplete
work, and Done to inspect the changes an agent says it finished. Reopen work
that needs another pass. The [agent contract](./AI-REVIEW-POLICY.md) defines the
file format and outcomes.

## Handoff Boundary

AI에 전달 saves current state and pauses extension writes. 내용 복사 uses
the same boundary. 리뷰 파일 확인 is read-only inspection; it does not start
a handoff or pause review mode. Wait for the agent to stop before
수정본 검수 or 인계 취소 / 리뷰 계속; both validate the current review file before
resuming extension writes. Cancel does not roll back the agent's source edits.

A direct file-path handoff is possible, but does not create this pause or a
checkpoint. Keep one writer at a time, including across VS Code windows. The
extension cannot lock an arbitrary external editor.

During handoff, reading and local drafts remain available. A draft is not a
saved request and is not sent to the agent. Saved requests are paused, including
comment edits, reattachment, review-aware source changes, and undo effects.

## Recovering A Review

- If the JSON is temporarily incomplete during an external write, keep the last
  usable view and retry after the agent finishes.
- If JSON remains invalid, a request vanished, or an ID/revision/target changed
  unexpectedly, inspect the discrepancy and checkpoint before resuming. A
  deleted v3 file must not silently resurrect an older review.
- If a source target is missing, use Reattach in review mode and explicitly
  confirm the new selection. Cancel leaves the old target intact.
- If a save fails, keep the draft and retry. If source changed, copy the draft
  and inspect the current target before applying it.
- If completed work needs another pass, inspect local history and reopen it.
  Archive persistence must succeed before items leave the active JSON.

Checkpoints and local archives aid recovery; they are not a second active
request file or a substitute for workspace backups.

## Converting Older Reviews

Before the first v3 handoff, back up and convert a v2 sidecar. Existing open
requests retain their IDs and locations. Old replies and suggested-patch context are included as labeled text in the
converted request so requirements are preserved. This does not apply a patch
or mark a request done. Keep the original backup for inspection.

Old accepted, resolved, and rejected threads are legacy history, not proof that
an agent handled a v3 request. They are not automatically requeued. If an older
extension is needed, preserve both the original backup and any new v3 work
before restoring old data. Never overwrite newer requests during downgrade.

The historical simulation documents describe the old discussion workflow. They
are retained as legacy regression context, not as instructions for a v3 agent
or evidence that the new workflow passed a live-agent test.
