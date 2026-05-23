# Review Loop Simulation

Generated from `runReviewLoopSimulations()` in `src/reviewLoopSimulation.ts`.

The simulation models two working personas:

- an AI reviewer that opens focused review threads, proposes patches, replies, exports handoff context, and tries to preserve review metadata;
- a human author/reviewer that disagrees, replies, edits Markdown, applies patches, and resolves only when a decision is genuinely handled.

## Summary

- Scenarios run: 7
- Turns simulated: 23
- Feedback items: 16

## Severity Summary

- High: 5
- Medium: 8
- Low: 3

## Repeated Themes

- Patch application clarity: 4
- Anchor preservation visibility: 3
- AI handoff continuity: 2
- Closure ownership: 2
- Reply quality: 2
- Context capture: 1
- Outcome clarity: 1
- Prompt clarity: 1

## Scenario Feedback

### First AI review pass with missing acceptance criteria

Starting situation: A Markdown workflow doc has goals but no testable acceptance criteria.

Turns:

1. AI reviewer bootstraps by reading the target document and nearby shared docs.
2. AI reviewer opens `rv_acceptance` as a question anchored to the vague goal.
3. Human author replies that acceptance should focus on preserving review metadata during edits.
4. AI reviewer replies with a narrower acceptance criterion candidate.

Feedback:

- Medium, context capture: the bootstrap prompt is concise, but it should tell AI agents when a missing answer should become a review thread rather than a direct chat question.
- Low, outcome clarity: the final response outcome vocabulary is useful, but users may not know whether `needs human decision` means the thread stays open.

### Human disagrees with an AI suggested patch

Starting situation: AI suggests removing a section that the human knows is contractually required.

Turns:

1. AI reviewer opens `rv_remove_section` with a suggested replacement patch.
2. Human author uses the Disagree shortcut and explains the contractual constraint.
3. AI reviewer acknowledges the missed constraint and revises the recommendation in the same thread.

Feedback:

- High, closure ownership: discussion-first shortcuts prevent accidental closure, but rejected history still exists while active UI no longer exposes Reject. Keep rejected history for compatibility, and document disagreement as a reply-first flow.
- High, AI handoff continuity: after saving a reply, the UI should offer a focused Continue with AI handoff for that thread and verify that the prompt/export includes the reply plus the `rv_*` id.
- Medium, AI handoff continuity: there is no structured place for an AI agent to return a revised patch candidate inside the existing thread.

### Human says "accept this suggestion" on an AI patch

Starting situation: A thread has a suggested patch, and the human uses natural language instead of the exact UI label.

Turns:

1. AI reviewer opens `rv_accept_language` with a localized suggested patch.
2. Human author replies, "accept this suggestion".
3. Extension applies the patch only when target text is unambiguous; otherwise it leaves the thread open and asks.

Feedback:

- High, patch application clarity: humans naturally say "accept" when they mean "apply the proposed change", while stored `accepted` status still means closed after a successful patch. Prompt and UI copy should stay biased toward `Apply Patch`.
- Medium, patch application clarity: `Apply Suggested Patch` is accurate but verbose, and it hides that the thread closes afterward. Consider copy like `Apply Patch and Close` with a compact diff preview.

### Human explicitly applies a reliable suggested patch

Starting situation: AI suggests replacing one unambiguous sentence with a testable requirement.

Turns:

1. AI reviewer opens `rv_retry_policy` with a replace patch.
2. Human author clicks Apply Suggested Patch.
3. Extension refreshes anchors, records an edit outcome reply, and closes the thread as accepted.
4. AI reviewer exports `rv_retry_policy` as `applied patch` in the final outcome list.

Feedback:

- High, patch application clarity: a real user still needs to see why a patch is considered safe before applying. Add a compact diff/target preview before Apply Suggested Patch for medium-risk docs.
- Medium, patch application clarity: visible closed-history copy should say `Patch applied` when accepted came from Apply Suggested Patch.

### Human manually edits text that has an open comment

Starting situation: A comment is anchored to one word inside a paragraph, and the human edits that word manually.

Turns:

1. Human author changes the commented word in the rendered block editor.
2. Extension adds an edit outcome reply to `rv_wording`.
3. AI reviewer continues from the edited wording instead of re-reviewing the old text.

Feedback:

- Medium, anchor preservation visibility: ordinary source edits still rely on later re-anchor confidence. Add scenario coverage that exports approximate or missing anchors after ordinary source edits.
- Medium, anchor preservation visibility: users need immediate confirmation that a comment was kept, moved, or became stale after an edit.
- Low, anchor preservation visibility: automatic edit outcome replies need tests so internal pipeline wording does not regress.

### Human leaves a vague reply during an AI handoff

Starting situation: A thread has a reasonable AI question, but the human replies with "ok" before export.

Turns:

1. AI reviewer opens `rv_owner` asking who owns the follow-up decision.
2. Human author replies only "ok".
3. AI reviewer cannot infer a decision and reports `rv_owner` as `needs human decision`.

Feedback:

- Medium, reply quality: vague replies can still weaken agent handoff. Add lightweight reply-quality warnings for very short replies before export.
- Medium, reply quality: disable submit or warn when a shortcut reply still ends with unfinished prompt text such as "because".

### AI tries to close a thread after answering itself

Starting situation: AI answers its own question from docs and wants to mark the thread resolved.

Turns:

1. AI reviewer opens `rv_scope_question` asking whether a workflow is in scope.
2. AI reviewer finds context later and proposes an answer in the same thread.
3. Human author confirms the answer is captured and resolves the thread.

Feedback:

- High, closure ownership: closure APIs should stay human-gated or require explicit user intent tokens for accepted/resolved/rejected transitions.
- Low, prompt clarity: keep bootstrap short and move detailed lifecycle rules to the feedback-loop prompt and docs.

## Product Implications

- The most urgent UX gap is not more thread statuses; it is making patch application obvious, previewable, and tied to an actual Markdown change.
- Human replies are part of the loop, so a reply should naturally lead to a focused AI handoff path when the user wants the agent to continue.
- Anchor preservation should be visible after edits. Users should see whether a thread was kept, moved, approximated, or made stale.
- AI agents should be allowed to reply and propose, but final closure should remain human-owned unless explicit user intent is present.
