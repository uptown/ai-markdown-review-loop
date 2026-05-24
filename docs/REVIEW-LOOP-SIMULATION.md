# Review Loop Simulation

Generated from `runReviewLoopSimulations()` in `src/reviewLoopSimulation.ts`.

The simulation models two working personas:

- an AI reviewer that opens focused review threads, proposes patches, replies, exports handoff context, and tries to preserve review metadata;
- a human author/reviewer that disagrees, replies, edits Markdown, applies patches, and resolves only when a decision is genuinely handled.

The current dogfood target is `test/fixtures/rich-review-loop-sample.md`, a dense Markdown fixture with tables, ordered lists, task lists, Mermaid diagrams, code fences, repeated phrases, and long wrapping prose.

The actual session record is stored in `test/fixtures/review-loop-session-record.json`, and the human-readable transcript is in `docs/REVIEW-LOOP-SIMULATION-TRACE.md`. Those files capture AI comments, human replies, AI follow-ups, sidecar snapshots, applied improvements, and the final empty `remainingFeedback` list.

## Summary

- Scenarios run: 11
- Session record: `test/fixtures/review-loop-session-record.json`
- Trace: `docs/REVIEW-LOOP-SIMULATION-TRACE.md`
- Turns simulated: 38
- Review threads simulated: 11
- Thread replies simulated: 26
- Feedback items: 23

## Severity Summary

- High: 6
- Medium: 13
- Low: 4

## Repeated Themes

- Anchor preservation visibility: 5
- Patch application clarity: 5
- AI handoff continuity: 2
- Closure ownership: 2
- Prompt clarity: 2
- Reply quality: 2
- Context capture: 1
- Diagram editing confidence: 1
- Live sidecar refresh: 1
- Outcome clarity: 1
- Table editing confidence: 1

## Scenario Feedback

### First AI review pass with missing acceptance criteria

Starting situation: The rich fixture has a goal section, but an acceptance criterion can still be too broad to test.
Fixture focus: `## Acceptance Criteria` item 1

Turns:

1. AI reviewer bootstraps by reading the target fixture and shared review-loop docs before commenting.
2. AI reviewer opens `rv_acceptance` as a question anchored to the broad acceptance criterion.
3. Human author answers that acceptance should focus on preserving review metadata during edits.
4. AI reviewer replies with a narrower acceptance criterion candidate.

Thread transcript:

- `rv_acceptance` question, medium, open: This acceptance criterion says comments stay attached, but it does not define the edit cases that must pass. Should this cover rendered block edits, ordinary source edits, or both?
- User: Cover rendered block edits first, and report ordinary source edits as approximate unless the extension can recover them with high confidence.
- Assistant: Then the criterion should say: rendered block edits must keep affected comments attached to the smallest stable span, while ordinary source edits must keep approximate comments visible instead of dropping them.
- Outcome: Open question becomes a precise acceptance criterion without duplicating threads.

Feedback:

- Medium, context capture: the bootstrap prompt now tells the AI to turn blocking document questions into focused `question` threads when review tools are available.
- Low, outcome clarity: export now spells out that `needs human decision` leaves the thread open instead of letting an agent infer closure.

### Human disagrees with an AI suggested patch

Starting situation: AI suggests removing launch policy text that the human knows is required.
Fixture focus: `The repeated phrase appears twice` policy section

Turns:

1. AI reviewer opens `rv_remove_section` with a suggested replacement patch.
2. Human author uses Disagree and explains the contractual constraint.
3. AI reviewer acknowledges the missed constraint and revises the recommendation to clarify the section instead.

Thread transcript:

- `rv_remove_section` suggestion, high, open: This repeated policy sentence looks redundant. Consider removing the duplicate to reduce noise.
- Suggested patch: replace the second repeated launch-approval sentence with a single generalized approval requirement.
- User: I disagree because the duplicate is intentional test data for repeated-anchor matching.
- Assistant: Good catch. I should revise this as a test-data note instead of suggesting deletion: label the repeated phrase as deliberate in the fixture.
- Outcome: Disagreement stays in the same thread and asks the AI to revise rather than close.

Feedback:

- High, closure ownership: discussion-first shortcuts prevent accidental closure, and Close as Declined gives humans an explicit way to close feedback that is wrong without calling it resolved.
- High, AI handoff continuity: after saving a reply, the UI should offer a focused Continue with AI handoff for that thread and verify that the prompt/export includes the reply plus the `rv_*` id.
- Medium, AI handoff continuity: the feedback-loop prompt now gives revised patch replies a lightweight `Suggested patch revision:` plus fenced diff convention.

### Human says "accept this suggestion" on an AI patch

Starting situation: A thread has a safe suggested patch, and the human uses natural language instead of the exact button label.
Fixture focus: `when the target is safe` product narrative sentence

Turns:

1. AI reviewer opens `rv_accept_language` with a localized suggested patch.
2. Human author replies, "accept this suggestion".
3. Extension applies the patch only when target text is unambiguous; otherwise it leaves the thread open and asks.

Thread transcript:

- `rv_accept_language` suggestion, medium, accepted: This sentence is good, but "reliable target" should say "one exact Markdown target" to match the apply semantics.
- Suggested patch: replace "one reliable target" with "one exact Markdown target".
- User: accept this suggestion
- User: Review update: applied the suggested edit and kept this thread attached.
- Outcome: Accepted status means the patch landed, not that the user merely liked the idea.

Feedback:

- High, patch application clarity: humans naturally say "accept" when they mean "apply the proposed change", while the stored accepted status still means closed after a successful patch.
- Medium, patch application clarity: `Apply Patch and Close` makes the source edit plus closure behavior visible, but the copy must stay paired with a target-safety explanation.

### Human explicitly applies a reliable suggested patch

Starting situation: AI suggests replacing one unambiguous sentence with a testable requirement.
Fixture focus: `Success means comments stay attached...` paragraph

Turns:

1. AI reviewer opens `rv_retry_policy` with a replace patch.
2. Human author clicks Apply Patch and Close.
3. Extension refreshes anchors, records an edit outcome reply, and closes the thread as accepted.
4. AI reviewer reports `rv_retry_policy` as applied patch in the final outcome list.

Thread transcript:

- `rv_retry_policy` fix, medium, accepted: This should name the safety condition so authors know why some patches cannot be applied.
- Suggested patch: replace "suggested patches apply only when the target is safe" with "suggested patches apply only when the original text has one exact current Markdown match".
- User: Review update: applied the suggested edit and kept this thread attached.
- Assistant: Final outcome: `rv_retry_policy` applied patch; no further human decision needed.
- Outcome: Patch application produces an audit trail and closed history.

Feedback:

- High, patch application clarity: the preview now needs to keep showing why the target is safe before applying.
- Medium, patch application clarity: visible closed-history copy should stay human-readable as `Patch applied` when accepted came from Apply Patch and Close.

### Human manually edits text that has an open comment

Starting situation: A comment is anchored to one phrase inside a paragraph, and the human edits that phrase manually.
Fixture focus: `rollback owner` acceptance criterion

Turns:

1. Human author changes the commented phrase in the rendered block editor.
2. Extension adds an edit outcome reply to `rv_wording`.
3. AI reviewer continues from the edited wording instead of re-reviewing the old text.

Thread transcript:

- `rv_wording` question, medium, open: Who owns rollback? The fixture names the phrase but not the responsible team or decision date.
- User: I changed the phrase to "release rollback owner" in the rendered block editor.
- User: Review update: edited the reviewed text and kept this comment attached.
- Assistant: Continuing from the updated wording: the remaining question is whether Release or Platform owns the rollback decision.
- Outcome: Manual edit keeps the comment attached to the smallest changed phrase.

Feedback:

- Medium, anchor preservation visibility: the review-aware path behaves well, and ordinary source edits are covered separately as approximate-but-visible rather than dropped.
- Medium, anchor preservation visibility: outcome chips now give immediate confirmation that a comment was kept, moved, made stale, or closed by a patch.
- Low, anchor preservation visibility: automatic edit outcome replies need tests so internal pipeline wording does not regress.

### Human source-edits text with an open comment

Starting situation: A comment is anchored to prose, and the human edits the Markdown source directly instead of using a review-aware rendered editor.
Fixture focus: `anchor visibility` long wrapping paragraph

Turns:

1. Human author edits the source paragraph around anchor visibility.
2. Extension keeps `rv_source_anchor` visible with approximate confidence in the next export.
3. AI reviewer reports that `rv_source_anchor` needs a human decision before closure.

Thread transcript:

- `rv_source_anchor` question, medium, open: This phrase should still show its review thread even after a direct source edit changes nearby wording.
- User: I edited this paragraph in Markdown source, not through the rendered editor.
- Assistant: `rv_source_anchor` is still visible with approximate confidence; final outcome should be needs human decision until the anchor is confirmed.
- Outcome: Ordinary source edits keep approximate feedback visible and exported for human confirmation.

Feedback:

- Medium, anchor preservation visibility: ordinary source edits now have simulation coverage that keeps approximate anchors exported rather than dropped.

### Human leaves a vague reply during an AI handoff

Starting situation: A thread has a reasonable AI question, but the human replies with "ok" before export.
Fixture focus: `Owner` column in Review Matrix

Turns:

1. AI reviewer opens `rv_owner` asking who owns the follow-up decision.
2. Human author replies only "ok".
3. AI reviewer cannot infer a decision and reports `rv_owner` as `needs human decision`.

Thread transcript:

- `rv_owner` question, medium, open: Several rows name Extension or Product, but the rollback row still needs one owner who can make the launch decision.
- User: ok
- Assistant: I cannot infer the owner from "ok"; final outcome should be needs human decision.
- Outcome: Vague reply stays visible and blocks false completion.

Feedback:

- Medium, reply quality: comment and reply quality warnings reduce vague handoff, but export should still surface existing weak replies so agents do not infer decisions from "ok".
- Medium, reply quality: live warnings now catch unfinished shortcut templates such as text ending with "because".

### AI tries to close a thread after answering itself

Starting situation: AI answers its own question from docs and wants to mark the thread resolved.
Fixture focus: `Threads-first export guides agents` row

Turns:

1. AI reviewer opens `rv_scope_question` asking whether a workflow is in scope.
2. AI reviewer finds context later and proposes an answer in the same thread.
3. Human author confirms the answer is captured and resolves the thread.

Thread transcript:

- `rv_scope_question` question, low, resolved: Is export ordering part of this fixture or just background context?
- Assistant: I found README guidance that exports should put open threads first, so this row is in scope.
- User: Resolved by human request: keep it as a fixture expectation.
- Outcome: AI can answer, but human owns final closure.

Feedback:

- High, closure ownership: closure APIs should stay human-gated or require explicit user intent tokens for accepted/resolved/rejected transitions.
- Low, prompt clarity: keep bootstrap short and move detailed lifecycle rules to the feedback-loop prompt and docs.

### AI revises a stale suggested patch and preview updates automatically

Starting situation: Human edited the target sentence before clicking Apply Patch and Close, so the first patch is stale.
Fixture focus: `stale suggested patch` acceptance criterion

Turns:

1. AI reviewer opens `rv_stale_patch` with a suggested patch against the old sentence.
2. Human author says the sentence was already edited and asks the AI to revise the patch.
3. AI reviewer writes a revised `suggestedPatch` to the sidecar using the current Markdown text.
4. Extension detects the sidecar change and recomputes suggested patch applicability.

Thread transcript:

- `rv_stale_patch` suggestion, high, open: This criterion should also say that a revised sidecar patch appears without reopening the preview.
- Suggested patch: update the stale-patch criterion to require automatic sidecar refresh.
- User: I already changed the sentence; please revise against the current text instead of asking me to refresh.
- Assistant: Revised patch written against the current sentence: include automatic sidecar refresh in the criterion.
- User: Review update: sidecar watcher rerendered the overlay and recomputed the patch state.
- Outcome: AI-revised patch becomes visible without closing and reopening the preview.

Feedback:

- High, live sidecar refresh: AI agents can update the sidecar while the preview is open, so stale patch state must not require a manual preview refresh.
- Medium, patch application clarity: the same thread can move from stale patch to revised patch, so the UI needs to keep explaining why the button appears or disappears.

### AI and human discuss a table-cell comment through a grid edit

Starting situation: AI comments on one table cell, the human edits that cell in the grid, and the AI continues from the updated cell.
Fixture focus: `Rollback` row in Review Matrix

Turns:

1. AI reviewer opens `rv_table_owner` on the Rollback owner cell.
2. Human author uses the table editor to change Owner from Release to Release Lead.
3. Extension adds a table edit outcome reply.
4. AI reviewer continues by asking whether Release Lead is a team or a named accountable person.

Thread transcript:

- `rv_table_owner` question, medium, open: This owner cell is too broad. Is Release a team label, or should the table name the accountable person?
- User: I changed the cell to Release Lead in the table grid editor.
- User: Review update: edited the table and kept this comment attached.
- Assistant: The cell is clearer, but the next review question is whether Release Lead is a role or a named owner.
- Outcome: Table edit preserves cell identity and keeps discussion continuity.

Feedback:

- Medium, anchor preservation visibility: outcome chips help after review-aware edits, but table comments still need especially clear kept/moved language because users distrust table anchor stability after grid edits.
- Medium, table editing confidence: the fixture and table scenario cover repeated owner values in adjacent rows so row/column identity remains testable.

### AI and human revise a Mermaid diagram comment

Starting situation: AI comments on a Mermaid edge label, the human asks for a clearer patch, and the AI revises the diagram source recommendation.
Fixture focus: `flowchart TD` Mermaid diagram

Turns:

1. AI reviewer opens `rv_mermaid_branch` on the Mermaid decision branch.
2. Human author uses Revise Patch because the first wording is too vague.
3. AI reviewer replies with a revised Mermaid source patch.
4. Extension edits Mermaid source through the diagram editor.

Thread transcript:

- `rv_mermaid_branch` suggestion, medium, open: The Apply Patch branch does not show that the sidecar and Markdown update together.
- Suggested patch: replace `Patch[Review-aware edit]` with `Patch[Review-aware Markdown and sidecar edit]`.
- User: Please revise this patch so it names sidecar sync explicitly.
- Assistant: Revised patch: change the Mermaid node label to "Review-aware Markdown and sidecar edit".
- User: Review update: edited the Mermaid source and kept this comment attached.
- Outcome: Mermaid comment stays source-scoped and does not delete following Markdown.

Feedback:

- Medium, diagram editing confidence: Mermaid edits need assurance that source edits do not affect following Markdown.
- Low, prompt clarity: AI agents now get a clear distinction between proposing a Mermaid, table, or source-scoped patch and applying it.

## Product Implications

- The patch-application clarity gap is now treated as a regression target: users should always see whether they are agreeing, applying a source change, or closing a thread before the action is enabled.
- Replies are not side chatter; they are the feedback loop. A reply can now lead to focused AI continuation when the human wants another pass.
- Anchor preservation needs visible outcomes after edits. Users should see whether a thread was kept, moved, approximated, stale, declined, or closed by a patch.
- Table and Mermaid editing now deserve first-class scenario coverage because they are the fastest way to prove source-aware editing is not just paragraph editing with prettier chrome.
- AI agents should be allowed to reply and propose, but final closure should remain human-owned unless explicit user intent is present.
