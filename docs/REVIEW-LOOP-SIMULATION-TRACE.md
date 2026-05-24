# Review Loop Simulation Trace

This trace records the dogfood session behind `runReviewLoopSimulations()`. It is
intentionally written like a real review loop: AI leaves comments, the human
author replies or edits, then AI continues from the same thread.

Machine-readable record:
`test/fixtures/review-loop-session-record.json`

Dogfood Markdown target:
`test/fixtures/rich-review-loop-sample.md`

## Review Session Brief

- Human goal: use realistic AI reviewer and human author feedback loops to
  improve AI Markdown Review Loop until no actionable product feedback remains.
- Review focus: real thread continuity, session-level user instructions, patch
  apply semantics, anchor preservation after edits, and agent handoff quality.
- Comment style: concrete review threads with a question, suggested patch, or
  explicit blocker.
- Done condition: every collected improvement is implemented or converted into
  regression guidance; `remainingFeedback` is empty.

## Round 1: AI First Pass Leaves Review Comments

Human prompt:

> Review the rich Markdown fixture like a real AI reviewer. Leave comments that
> a human author can answer.

AI comments:

- `rv_session_intent`: the fixture proves thread export, but not how the
  human's current review goal changes the AI pass.
- `rv_acceptance`: the acceptance criterion says comments stay attached, but
  does not define rendered edits versus source edits.
- `rv_retry_policy`: patch safety needs to say why some patches cannot be
  applied.
- `rv_owner`: the rollback row still needs one launch owner.

Human replies:

- `rv_session_intent`: "The reviewer needs my current review goal too. This pass
  is product/agent handoff, not grammar."
- `rv_acceptance`: "Cover rendered block edits first, and report ordinary source
  edits as approximate unless confidence is high."
- `rv_retry_policy`: "Apply the patch only if the target is exact; otherwise
  explain why it is blocked."
- `rv_owner`: "ok"

AI follow-up:

- `rv_session_intent`: AI treats the reply as a session-level review
  instruction.
- `rv_acceptance`: AI narrows the acceptance criterion.
- `rv_owner`: AI refuses to infer a decision from "ok" and keeps the thread open.

Improvements applied:

- Add review-session-brief guidance to prompts and export.
- Keep vague human replies visible as handoff warnings.

## Round 2: Human Challenges AI Feedback

Human prompt:

> Continue the same threads. Do not open duplicates if my reply changes the
> interpretation.

AI comments:

- `rv_remove_section`: AI suggests deleting a repeated policy sentence.
- `rv_stale_patch`: AI proposes a patch against text that may already be stale.
- `rv_mermaid_branch`: AI comments that a Mermaid branch hides sidecar sync.

Human replies:

- `rv_remove_section`: "I disagree because the duplicate sentence is intentional
  test data for repeated-anchor matching."
- `rv_stale_patch`: "I already edited that sentence. Revise the patch against
  the current source instead of telling me to refresh."
- `rv_mermaid_branch`: "Please revise this patch so it names sidecar sync
  explicitly."

AI follow-up:

- `rv_remove_section`: AI retracts deletion and reframes the concern as test
  data labeling.
- `rv_stale_patch`: AI replies with `Suggested patch revision:` and a fenced
  `diff` block.
- `rv_mermaid_branch`: AI replies with a Mermaid source diff and waits for human
  apply/edit intent.

Improvements applied:

- Keep revised patch candidates as replies with a `Suggested patch revision:`
  label and fenced `diff`.
- Keep `Apply Patch and Close` gated on exact current Markdown targets.

## Round 3: Human Edits Markdown

Human prompt:

> Now simulate real author edits: one rendered edit, one source edit, one table
> edit, and one Mermaid edit.

Human edits and replies:

- `rv_wording`: human changes `rollback owner` to `release rollback owner` in
  the rendered block editor.
- `rv_source_anchor`: human edits the paragraph in Markdown source, outside the
  review-aware editor.
- `rv_table_owner`: human changes a table cell to `Release Lead`.

AI follow-up:

- `rv_wording`: AI continues from the updated wording instead of re-reviewing
  old text.
- `rv_source_anchor`: AI reports approximate confidence and asks for human
  decision before closure.
- `rv_table_owner`: AI continues the same table-cell thread and asks whether
  `Release Lead` is a role or named owner.

Improvements applied:

- Record approximate source-edit anchors as visible handoff state.
- Keep cell-level and Mermaid edit scenarios in regression coverage.

## Round 4: Final Feedback Closure

Human prompt:

> Collect feedback from these simulated users and keep improving until there are
> no actionable improvement items left.

Human replies:

- `rv_retry_policy`: "Apply Patch and Close is clear enough if the UI also says
  why the patch is safe."
- `rv_scope_question`: "Resolved by human request: keep threads-first export as
  a fixture expectation."

AI follow-up:

- `rv_retry_policy`: AI reports the patch-applied outcome and no further human
  decision needed.
- `rv_scope_question`: AI acknowledges human-owned closure and does not close
  additional threads.

Improvements applied:

- Keep this trace as a durable product dogfood record.
- Treat remaining recommendations as regression guardrails only.

## Final State

- Open threads stay open when they still need human decision or anchor
  confirmation.
- Closed threads record human-owned accepted/resolved decisions.
- `remainingFeedback` is empty in the machine-readable record.
