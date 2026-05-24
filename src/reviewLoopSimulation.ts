import type { ReviewThread } from './types';

export type SimulationSeverity = 'low' | 'medium' | 'high';
export type SimulationActor = 'ai_reviewer' | 'human_author' | 'extension';
export type SimulationAction =
  | 'bootstrap'
  | 'open_thread'
  | 'reply'
  | 'apply_patch'
  | 'manual_edit'
  | 'revise_patch'
  | 'resolve'
  | 'watch_sidecar'
  | 'export';

export interface SimulationTurn {
  actor: SimulationActor;
  action: SimulationAction;
  threadId?: string;
  summary: string;
  expectedOutcome: string;
}

export interface SimulationFeedback {
  severity: SimulationSeverity;
  theme: string;
  finding: string;
  recommendation: string;
}

export interface SimulationReviewThread extends ReviewThread {
  expectedOutcome: string;
}

export interface SimulationScenario {
  id: string;
  title: string;
  startingSituation: string;
  fixtureFocus: string;
  turns: SimulationTurn[];
  reviewThreads: SimulationReviewThread[];
  feedback: SimulationFeedback[];
}

export interface SimulationSummary {
  fixturePath: string;
  scenarios: SimulationScenario[];
  totalTurns: number;
  reviewThreadCount: number;
  replyCount: number;
  feedback: SimulationFeedback[];
  feedbackBySeverity: Record<SimulationSeverity, number>;
  repeatedThemes: Array<{ theme: string; count: number }>;
}

const richFixturePath = 'test/fixtures/rich-review-loop-sample.md';
const fixtureDocumentUri = `file:///workspace/${richFixturePath}`;
const baseTime = Date.parse('2026-05-24T00:00:00.000Z');

export function runReviewLoopSimulations(): SimulationSummary {
  const scenarios = createReviewLoopScenarios();
  const feedback = scenarios.flatMap(scenario => scenario.feedback);
  const reviewThreads = scenarios.flatMap(scenario => scenario.reviewThreads);

  return {
    fixturePath: richFixturePath,
    scenarios,
    totalTurns: scenarios.reduce((sum, scenario) => sum + scenario.turns.length, 0),
    reviewThreadCount: reviewThreads.length,
    replyCount: reviewThreads.reduce((sum, thread) => sum + thread.thread.length, 0),
    feedback,
    feedbackBySeverity: countFeedbackBySeverity(feedback),
    repeatedThemes: countRepeatedThemes(feedback)
  };
}

export function renderReviewLoopSimulationReport(summary: SimulationSummary): string {
  return [
    '# Review Loop Simulation Report',
    '',
    `Fixture: ${summary.fixturePath}`,
    `Scenarios run: ${summary.scenarios.length}`,
    `Turns simulated: ${summary.totalTurns}`,
    `Review threads simulated: ${summary.reviewThreadCount}`,
    `Thread replies simulated: ${summary.replyCount}`,
    `Feedback items: ${summary.feedback.length}`,
    '',
    '## Severity Summary',
    '',
    `- High: ${summary.feedbackBySeverity.high}`,
    `- Medium: ${summary.feedbackBySeverity.medium}`,
    `- Low: ${summary.feedbackBySeverity.low}`,
    '',
    '## Repeated Themes',
    '',
    ...summary.repeatedThemes.map(item => `- ${item.theme}: ${item.count}`),
    '',
    '## Scenario Feedback',
    '',
    ...summary.scenarios.flatMap(renderScenario)
  ].join('\n');
}

function createReviewLoopScenarios(): SimulationScenario[] {
  return [
    {
      id: 'sim_bootstrap_missing_context',
      title: 'First AI review pass with missing acceptance criteria',
      startingSituation: 'The rich fixture has a goal section, but an acceptance criterion can still be too broad to test.',
      fixtureFocus: '`## Acceptance Criteria` item 1',
      turns: [
        turn('ai_reviewer', 'bootstrap', 'Reads the target fixture and shared review-loop docs before commenting.', 'AI asks only for missing context that changes review quality.'),
        turn('ai_reviewer', 'open_thread', 'Opens rv_acceptance as a question anchored to the broad acceptance criterion.', 'Thread stays specific and actionable instead of becoming broad style feedback.', 'rv_acceptance'),
        turn('human_author', 'reply', 'Answers that acceptance should focus on preserving review metadata during edits.', 'Human context remains inside the same thread.', 'rv_acceptance'),
        turn('ai_reviewer', 'reply', 'Replies with a narrower acceptance criterion candidate.', 'AI continues the thread rather than opening a duplicate.', 'rv_acceptance')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_acceptance',
          type: 'question',
          severity: 'medium',
          anchorText: 'comments stay attached during normal edits',
          lineStart: 9,
          lineEnd: 9,
          comment: 'This acceptance criterion says comments stay attached, but it does not define the edit cases that must pass. Should this cover rendered block edits, ordinary source edits, or both?',
          replies: [
            reply('user', 'Cover rendered block edits first, and report ordinary source edits as approximate unless the extension can recover them with high confidence.', 1),
            reply('assistant', 'Then the criterion should say: rendered block edits must keep affected comments attached to the smallest stable span, while ordinary source edits must keep approximate comments visible instead of dropping them.', 2)
          ],
          expectedOutcome: 'Open question becomes a precise acceptance criterion without duplicating threads.'
        })
      ],
      feedback: [
        feedback('medium', 'Context capture', 'The bootstrap prompt now tells the AI to turn blocking document questions into focused `question` threads when review tools are available.', 'Keep this distinction covered so agents do not stop in chat for questions that belong in the review loop.'),
        feedback('low', 'Outcome clarity', 'Export now spells out that `needs human decision` leaves the thread open instead of letting an agent infer closure.', 'Keep outcome vocabulary synchronized between export, feedback-loop prompt, and docs.')
      ]
    },
    {
      id: 'sim_human_disagrees_with_patch',
      title: 'Human disagrees with an AI suggested patch',
      startingSituation: 'AI suggests removing launch policy text that the human knows is required.',
      fixtureFocus: '`The repeated phrase appears twice` policy section',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_remove_section with a suggested replacement patch.', 'Thread has one issue and one patch.', 'rv_remove_section'),
        turn('human_author', 'reply', 'Uses Disagree and explains the contractual constraint.', 'Thread remains open; no source mutation happens.', 'rv_remove_section'),
        turn('ai_reviewer', 'reply', 'Acknowledges the missed constraint and revises the recommendation to clarify the section instead.', 'AI follows the same thread and does not silently close it.', 'rv_remove_section')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_remove_section',
          type: 'suggestion',
          severity: 'high',
          anchorText: 'the policy owner must approve the launch',
          lineStart: 26,
          lineEnd: 26,
          occurrence: 2,
          comment: 'This repeated policy sentence looks redundant. Consider removing the duplicate to reduce noise.',
          suggestedPatch: patch(
            'The repeated phrase appears again: the policy owner must approve the launch.',
            'The policy owner approval requirement appears once and applies to the full launch checklist.'
          ),
          replies: [
            reply('user', 'I disagree because the duplicate is intentional test data for repeated-anchor matching.', 3),
            reply('assistant', 'Good catch. I should revise this as a test-data note instead of suggesting deletion: label the repeated phrase as deliberate in the fixture.', 4)
          ],
          expectedOutcome: 'Disagreement stays in the same thread and asks the AI to revise rather than close.'
        })
      ],
      feedback: [
        feedback('high', 'Closure ownership', 'Discussion-first shortcuts prevent accidental closure, and Close as Declined now gives humans an explicit way to close feedback that is wrong without calling it resolved.', 'Keep declined closure visually distinct from discussion-only Disagree replies so humans can either continue debate or preserve a final rejected decision.'),
        feedback('high', 'AI handoff continuity', 'Disagree and Revise shortcuts create the right thread state, but they do not naturally hand the updated thread back to an AI agent.', 'After saving a reply, offer a focused Continue with AI handoff for that thread and test that the prompt/export includes the reply plus the `rv_*` id.'),
        feedback('medium', 'AI handoff continuity', 'The feedback-loop prompt now gives revised patch replies a lightweight `Suggested patch revision:` plus fenced diff convention.', 'Keep revised patch candidates readable without treating every reply as an immediately applyable edit.')
      ]
    },
    {
      id: 'sim_accept_this_suggestion_language',
      title: 'Human says "accept this suggestion" on an AI patch',
      startingSituation: 'A thread has a safe suggested patch, and the human uses natural language instead of the exact button label.',
      fixtureFocus: '`when the target is safe` product narrative sentence',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_accept_language with a localized suggested patch.', 'The AI provides a concrete replacement and keeps the thread open.', 'rv_accept_language'),
        turn('human_author', 'reply', 'Says "accept this suggestion".', 'The loop treats this as an apply request only if the patch target is safe.', 'rv_accept_language'),
        turn('extension', 'apply_patch', 'Applies the patch only when target text is unambiguous; otherwise it leaves the thread open and asks.', 'Natural language accept does not become a silent close-only action.', 'rv_accept_language')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_accept_language',
          type: 'suggestion',
          severity: 'medium',
          anchorText: 'only if the suggested patch still has one reliable target',
          lineStart: 22,
          lineEnd: 22,
          comment: 'This sentence is good, but "reliable target" should say "one exact Markdown target" to match the apply semantics.',
          suggestedPatch: patch(
            'only if the suggested patch still has one reliable target',
            'only if the suggested patch still has one exact Markdown target'
          ),
          replies: [
            reply('user', 'accept this suggestion', 5),
            reply('user', 'Review update: applied the suggested edit and kept this thread attached.', 6)
          ],
          status: 'accepted',
          closedBy: 'user',
          closedAt: iso(6),
          expectedOutcome: 'Accepted status means the patch landed, not that the user merely liked the idea.'
        })
      ],
      feedback: [
        feedback('high', 'Patch application clarity', 'Humans naturally say "accept" when they mean "apply the proposed change", while the stored accepted status still means closed after a successful patch.', 'Keep prompt, UI copy, and scenario coverage biased toward `Apply Patch and Close` so "accept this suggestion" is never a close-only decision.'),
        feedback('medium', 'Patch application clarity', '`Apply Patch and Close` makes the source edit plus closure behavior visible, but the copy must stay paired with a target-safety explanation.', 'Keep the ready/stale status text visible beside the patch preview.')
      ]
    },
    {
      id: 'sim_apply_suggested_patch',
      title: 'Human explicitly applies a reliable suggested patch',
      startingSituation: 'AI suggests replacing one unambiguous sentence with a testable requirement.',
      fixtureFocus: '`Success means comments stay attached...` paragraph',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_retry_policy with a replace patch.', 'Patch is localized and has one exact target.', 'rv_retry_policy'),
        turn('human_author', 'apply_patch', 'Clicks Apply Patch and Close.', 'Markdown changes only after explicit apply action.', 'rv_retry_policy'),
        turn('extension', 'apply_patch', 'Refreshes anchors, records an edit outcome reply, and closes the thread as accepted.', 'Accepted means the patch actually landed, not just that feedback was liked.', 'rv_retry_policy'),
        turn('ai_reviewer', 'export', 'Reports rv_retry_policy as applied patch in the final outcome list.', 'Agent handoff has a clear audit trail.', 'rv_retry_policy')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_retry_policy',
          type: 'fix',
          severity: 'medium',
          anchorText: 'suggested patches apply only when the target is safe',
          lineStart: 9,
          lineEnd: 9,
          comment: 'This should name the safety condition so authors know why some patches cannot be applied.',
          suggestedPatch: patch(
            'suggested patches apply only when the target is safe',
            'suggested patches apply only when the original text has one exact current Markdown match'
          ),
          replies: [
            reply('user', 'Review update: applied the suggested edit and kept this thread attached.', 7),
            reply('assistant', 'Final outcome: rv_retry_policy applied patch; no further human decision needed.', 8)
          ],
          status: 'accepted',
          closedBy: 'user',
          closedAt: iso(7),
          expectedOutcome: 'Patch application produces an audit trail and closed history.'
        })
      ],
      feedback: [
        feedback('high', 'Patch application clarity', 'The simulation succeeds only when the patch target is unambiguous, and the preview now needs to keep showing why the target is safe before applying.', 'Keep the ready message explicit: one exact Markdown target, anchors refresh, and thread closes as Patch Applied.'),
        feedback('medium', 'Patch application clarity', '`accepted` remains a persisted status, but visible history copy now needs to stay human-readable as `Patch applied`.', 'Keep visible history copy as `Patch applied` when accepted came from Apply Patch and Close.')
      ]
    },
    {
      id: 'sim_manual_edit_near_comment',
      title: 'Human manually edits text that has an open comment',
      startingSituation: 'A comment is anchored to one phrase inside a paragraph, and the human edits that phrase manually.',
      fixtureFocus: '`rollback owner` acceptance criterion',
      turns: [
        turn('human_author', 'manual_edit', 'Changes the commented phrase in the rendered block editor.', 'Review-aware edit keeps the thread narrow and updates the anchor text.', 'rv_wording'),
        turn('extension', 'reply', 'Adds an edit outcome reply to rv_wording.', 'Thread history explains why the anchor moved.', 'rv_wording'),
        turn('ai_reviewer', 'reply', 'Continues from the edited wording instead of re-reviewing the old text.', 'AI preserves discussion continuity.', 'rv_wording')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_wording',
          type: 'question',
          severity: 'medium',
          anchorText: 'rollback owner',
          lineStart: 13,
          lineEnd: 13,
          comment: 'Who owns rollback? The fixture names the phrase but not the responsible team or decision date.',
          replies: [
            reply('user', 'I changed the phrase to "release rollback owner" in the rendered block editor.', 9),
            reply('user', 'Review update: edited the reviewed text and kept this comment attached.', 10),
            reply('assistant', 'Continuing from the updated wording: the remaining question is whether Release or Platform owns the rollback decision.', 11)
          ],
          expectedOutcome: 'Manual edit keeps the comment attached to the smallest changed phrase.'
        })
      ],
      feedback: [
        feedback('medium', 'Anchor preservation visibility', 'The review-aware path behaves well, and ordinary source edits are covered separately as approximate-but-visible rather than dropped.', 'Keep rendered-edit and source-edit scenarios distinct so exact and approximate anchors do not blur together.'),
        feedback('medium', 'Anchor preservation visibility', 'Outcome chips now give immediate confirmation that a comment was kept, moved, made stale, or closed by a patch.', 'Keep per-thread badges such as Kept, Moved, Needs re-anchor, or Patch Applied visible after review-aware edits.'),
        feedback('low', 'Anchor preservation visibility', 'Automatic edit outcome replies need to stay human-readable or they will pollute the conversation.', 'Keep tests around edit outcome text so internal pipeline wording does not regress.')
      ]
    },
    {
      id: 'sim_ordinary_source_edit_approximate',
      title: 'Human source-edits text with an open comment',
      startingSituation: 'A comment is anchored to prose, and the human edits the Markdown source directly instead of using a review-aware rendered editor.',
      fixtureFocus: '`anchor visibility` long wrapping paragraph',
      turns: [
        turn('human_author', 'manual_edit', 'Edits the source paragraph around anchor visibility.', 'The extension cannot claim an exact review-aware edit outcome.', 'rv_source_anchor'),
        turn('extension', 'export', 'Keeps rv_source_anchor visible with approximate confidence in the next export.', 'The thread is not silently dropped after source edits.', 'rv_source_anchor'),
        turn('ai_reviewer', 'reply', 'Reports that rv_source_anchor needs a human decision before closure.', 'Approximate comments remain actionable instead of being auto-resolved.', 'rv_source_anchor')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_source_anchor',
          type: 'question',
          severity: 'medium',
          anchorText: 'anchor visibility',
          lineStart: 110,
          lineEnd: 110,
          confidence: 'approximate',
          comment: 'This phrase should still show its review thread even after a direct source edit changes nearby wording.',
          replies: [
            reply('user', 'I edited this paragraph in Markdown source, not through the rendered editor.', 12),
            reply('assistant', 'rv_source_anchor is still visible with approximate confidence; final outcome should be needs human decision until the anchor is confirmed.', 13)
          ],
          expectedOutcome: 'Ordinary source edits keep approximate feedback visible and exported for human confirmation.'
        })
      ],
      feedback: [
        feedback('medium', 'Anchor preservation visibility', 'Ordinary source edits now have simulation coverage that keeps approximate anchors exported rather than dropped.', 'Keep approximate or missing anchors in agent handoff until a human resolves, re-anchors, or cleans them.')
      ]
    },
    {
      id: 'sim_vague_human_reply',
      title: 'Human leaves a vague reply during an AI handoff',
      startingSituation: 'A thread has a reasonable AI question, but the human replies with "ok" before export.',
      fixtureFocus: '`Owner` column in Review Matrix',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Asks rv_owner who owns the follow-up decision.', 'Thread is actionable before the reply.', 'rv_owner'),
        turn('human_author', 'reply', 'Replies only "ok".', 'Reply is preserved but does not help the agent.', 'rv_owner'),
        turn('ai_reviewer', 'export', 'Cannot infer a decision and reports rv_owner as needs human decision.', 'The loop avoids pretending the issue is resolved.', 'rv_owner')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_owner',
          type: 'question',
          severity: 'medium',
          anchorText: 'Owner',
          lineStart: 30,
          lineEnd: 30,
          comment: 'Several rows name Extension or Product, but the rollback row still needs one owner who can make the launch decision.',
          replies: [
            reply('user', 'ok', 12),
            reply('assistant', 'I cannot infer the owner from "ok"; final outcome should be needs human decision.', 13)
          ],
          expectedOutcome: 'Vague reply stays visible and blocks false completion.'
        })
      ],
      feedback: [
        feedback('medium', 'Reply quality', 'Comment and reply quality warnings reduce vague handoff, but export should still surface existing weak replies so agents do not infer decisions from "ok".', 'Keep lightweight reply-quality warnings for very short replies before export and in thread history.'),
        feedback('medium', 'Reply quality', 'The user may expect Agree/Answer shortcuts to submit a complete reply, but live warnings now catch unfinished templates such as text ending with "because".', 'Keep shortcut draft warnings visible before handoff and after saved replies.')
      ]
    },
    {
      id: 'sim_agent_overreaches_closure',
      title: 'AI tries to close a thread after answering itself',
      startingSituation: 'AI answers its own question from docs and wants to mark the thread resolved.',
      fixtureFocus: '`Threads-first export guides agents` row',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_scope_question asking whether a workflow is in scope.', 'The question is valid because scope is ambiguous.', 'rv_scope_question'),
        turn('ai_reviewer', 'reply', 'Finds context later and proposes an answer in the same thread.', 'AI can help reduce ambiguity without closing.', 'rv_scope_question'),
        turn('human_author', 'resolve', 'Human confirms the answer is now captured and resolves the thread.', 'Final closure remains human-owned.', 'rv_scope_question')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_scope_question',
          type: 'question',
          severity: 'low',
          anchorText: 'Threads-first export guides agents',
          lineStart: 36,
          lineEnd: 36,
          comment: 'Is export ordering part of this fixture or just background context?',
          replies: [
            reply('assistant', 'I found README guidance that exports should put open threads first, so this row is in scope.', 14),
            reply('user', 'Resolved by human request: keep it as a fixture expectation.', 15)
          ],
          status: 'resolved',
          closedBy: 'user',
          closedAt: iso(15),
          expectedOutcome: 'AI can answer, but human owns final closure.'
        })
      ],
      feedback: [
        feedback('high', 'Closure ownership', 'The prompts correctly warn the AI not to close threads, but a future integrated AI reviewer could still mutate sidecars directly if APIs are too permissive.', 'Keep closure APIs human-gated or require explicit user intent tokens for accepted/resolved/rejected transitions.'),
        feedback('low', 'Prompt clarity', 'The concise prompt is easier to follow than the previous implementation-heavy bootstrap.', 'Keep bootstrap short and move detailed lifecycle rules to the feedback-loop prompt and docs.')
      ]
    },
    {
      id: 'sim_revised_patch_sidecar_refresh',
      title: 'AI revises a stale suggested patch and preview updates automatically',
      startingSituation: 'Human edited the target sentence before clicking Apply Patch and Close, so the first patch is stale.',
      fixtureFocus: '`stale suggested patch` acceptance criterion',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_stale_patch with a suggested patch against the old sentence.', 'Preview shows the suggested edit but blocks unsafe apply if the original text no longer matches.', 'rv_stale_patch'),
        turn('human_author', 'reply', 'Says the sentence was already edited and asks the AI to revise the patch.', 'Thread remains open and captures why apply is blocked.', 'rv_stale_patch'),
        turn('ai_reviewer', 'revise_patch', 'Writes a revised suggestedPatch to the sidecar using the current Markdown text.', 'Preview watcher rerenders without manual refresh.', 'rv_stale_patch'),
        turn('extension', 'watch_sidecar', 'Detects the sidecar change and recomputes suggested patch applicability.', 'Apply button appears only after the revised patch has one exact target.', 'rv_stale_patch')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_stale_patch',
          type: 'suggestion',
          severity: 'high',
          anchorText: 'An AI suggested patch that no longer matches the source is shown as stale',
          lineStart: 14,
          lineEnd: 14,
          comment: 'This criterion should also say that a revised sidecar patch appears without reopening the preview.',
          suggestedPatch: patch(
            'An AI suggested patch that no longer matches the source is shown as stale rather than as an applyable green button.',
            'An AI suggested patch that no longer matches the source is shown as stale, and a revised sidecar patch updates the preview without manual refresh.'
          ),
          replies: [
            reply('user', 'I already changed the sentence; please revise against the current text instead of asking me to refresh.', 16),
            reply('assistant', 'Revised patch written against the current sentence: include automatic sidecar refresh in the criterion.', 17),
            reply('user', 'Review update: sidecar watcher rerendered the overlay and recomputed the patch state.', 18)
          ],
          expectedOutcome: 'AI-revised patch becomes visible without closing and reopening the preview.'
        })
      ],
      feedback: [
        feedback('high', 'Live sidecar refresh', 'AI agents can update the sidecar while the preview is open, so stale patch state must not require a manual preview refresh.', 'Keep file watching on colocated and legacy sidecars and preserve overlay focus when rerendering revised patch data.'),
        feedback('medium', 'Patch application clarity', 'The same thread can move from stale patch to revised patch, so the UI needs to keep explaining why the button appears or disappears.', 'Keep the current patch applicability reason beside the suggested edit.')
      ]
    },
    {
      id: 'sim_table_cell_conversation',
      title: 'AI and human discuss a table-cell comment through a grid edit',
      startingSituation: 'AI comments on one table cell, the human edits that cell in the grid, and the AI continues from the updated cell.',
      fixtureFocus: '`Rollback` row in Review Matrix',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_table_owner on the Rollback owner cell.', 'Thread anchors to the table cell rather than the full table.', 'rv_table_owner'),
        turn('human_author', 'manual_edit', 'Uses the table editor to change Owner from Release to Release Lead.', 'Review-aware table edit keeps the cell comment attached.', 'rv_table_owner'),
        turn('extension', 'reply', 'Adds a table edit outcome reply.', 'Thread history explains that the anchor was preserved through a grid edit.', 'rv_table_owner'),
        turn('ai_reviewer', 'reply', 'Continues by asking whether Release Lead is a team or a named accountable person.', 'AI continues the same thread after the table edit.', 'rv_table_owner')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_table_owner',
          type: 'question',
          severity: 'medium',
          anchorText: 'Release',
          lineStart: 32,
          lineEnd: 32,
          comment: 'This owner cell is too broad. Is Release a team label, or should the table name the accountable person?',
          replies: [
            reply('user', 'I changed the cell to Release Lead in the table grid editor.', 19),
            reply('user', 'Review update: edited the table and kept this comment attached.', 20),
            reply('assistant', 'The cell is clearer, but the next review question is whether Release Lead is a role or a named owner.', 21)
          ],
          expectedOutcome: 'Table edit preserves cell identity and keeps discussion continuity.'
        })
      ],
      feedback: [
        feedback('medium', 'Anchor preservation visibility', 'Outcome chips help after review-aware edits, but table comments still need especially clear kept/moved language because users distrust table anchor stability after grid edits.', 'Keep cell-level outcome badges and table-specific edit outcome replies after table edits.'),
        feedback('medium', 'Table editing confidence', 'The fixture and table scenario cover repeated owner values in adjacent rows so row/column identity remains testable.', 'Keep row/column identity in tests whenever table cells contain repeated owner names.')
      ]
    },
    {
      id: 'sim_mermaid_source_review',
      title: 'AI and human revise a Mermaid diagram comment',
      startingSituation: 'AI comments on a Mermaid edge label, the human asks for a clearer patch, and the AI revises the diagram source recommendation.',
      fixtureFocus: '`flowchart TD` Mermaid diagram',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_mermaid_branch on the Mermaid decision branch.', 'Thread attaches to the fenced Mermaid source.', 'rv_mermaid_branch'),
        turn('human_author', 'reply', 'Uses Revise Patch because the first wording is too vague.', 'Thread stays open and asks for a more concrete source edit.', 'rv_mermaid_branch'),
        turn('ai_reviewer', 'revise_patch', 'Replies with a revised Mermaid source patch.', 'AI does not mutate source until the human explicitly applies it.', 'rv_mermaid_branch'),
        turn('extension', 'manual_edit', 'Human edits Mermaid source through the diagram editor.', 'Only the fenced Mermaid block changes and following Markdown remains intact.', 'rv_mermaid_branch')
      ],
      reviewThreads: [
        reviewThread({
          id: 'rv_mermaid_branch',
          type: 'suggestion',
          severity: 'medium',
          anchorText: 'Human -->|Apply Patch| Patch[Review-aware edit]',
          lineStart: 52,
          lineEnd: 52,
          comment: 'The Apply Patch branch does not show that the sidecar and Markdown update together.',
          suggestedPatch: patch(
            'Human -->|Apply Patch| Patch[Review-aware edit]',
            'Human -->|Apply Patch| Patch[Review-aware Markdown and sidecar edit]'
          ),
          replies: [
            reply('user', 'Please revise this patch so it names sidecar sync explicitly.', 22),
            reply('assistant', 'Revised patch: change the Mermaid node label to "Review-aware Markdown and sidecar edit".', 23),
            reply('user', 'Review update: edited the Mermaid source and kept this comment attached.', 24)
          ],
          expectedOutcome: 'Mermaid comment stays source-scoped and does not delete following Markdown.'
        })
      ],
      feedback: [
        feedback('medium', 'Diagram editing confidence', 'Mermaid edits are now in the review-aware path, but users need assurance that source edits do not affect following Markdown.', 'Keep scenario tests that assert only the fenced Mermaid block changes.'),
        feedback('low', 'Prompt clarity', 'AI agents now get a clear distinction between proposing a Mermaid, table, or source-scoped patch and applying it.', 'Keep source-scoped patch proposals as replies until the human explicitly asks to edit/apply.')
      ]
    }
  ];
}

function turn(
  actor: SimulationActor,
  action: SimulationAction,
  summary: string,
  expectedOutcome: string,
  threadId?: string
): SimulationTurn {
  return { actor, action, summary, expectedOutcome, threadId };
}

function feedback(
  severity: SimulationSeverity,
  theme: string,
  finding: string,
  recommendation: string
): SimulationFeedback {
  return { severity, theme, finding, recommendation };
}

function reviewThread(input: {
  id: string;
  type: ReviewThread['type'];
  severity: ReviewThread['severity'];
  anchorText: string;
  lineStart: number;
  lineEnd: number;
  confidence?: ReviewThread['anchor']['confidence'];
  occurrence?: number;
  comment: string;
  replies: ReviewThread['thread'];
  expectedOutcome: string;
  suggestedPatch?: ReviewThread['suggestedPatch'];
  status?: ReviewThread['status'];
  closedBy?: ReviewThread['closedBy'];
  closedAt?: string;
}): SimulationReviewThread {
  const updatedAt = input.replies.at(-1)?.createdAt ?? iso(0);

  return {
    id: input.id,
    documentUri: fixtureDocumentUri,
    anchor: {
      text: input.anchorText,
      confidence: input.confidence ?? 'exact',
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      occurrence: input.occurrence
    },
    type: input.type,
    source: 'ai',
    status: input.status ?? 'open',
    closedBy: input.closedBy,
    closedAt: input.closedAt,
    severity: input.severity,
    comment: input.comment,
    suggestedPatch: input.suggestedPatch,
    thread: input.replies,
    createdAt: iso(0),
    updatedAt,
    expectedOutcome: input.expectedOutcome
  };
}

function reply(
  role: ReviewThread['thread'][number]['role'],
  text: string,
  minuteOffset: number
): ReviewThread['thread'][number] {
  return {
    role,
    text,
    createdAt: iso(minuteOffset)
  };
}

function patch(original: string, replacement: string): NonNullable<ReviewThread['suggestedPatch']> {
  return {
    mode: 'replace',
    original,
    replacement
  };
}

function iso(minuteOffset: number): string {
  return new Date(baseTime + minuteOffset * 60_000).toISOString();
}

function countFeedbackBySeverity(feedbackItems: readonly SimulationFeedback[]): Record<SimulationSeverity, number> {
  return {
    high: feedbackItems.filter(item => item.severity === 'high').length,
    medium: feedbackItems.filter(item => item.severity === 'medium').length,
    low: feedbackItems.filter(item => item.severity === 'low').length
  };
}

function countRepeatedThemes(feedbackItems: readonly SimulationFeedback[]): Array<{ theme: string; count: number }> {
  const counts = new Map<string, number>();

  for (const item of feedbackItems) {
    counts.set(item.theme, (counts.get(item.theme) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([theme, count]) => ({ theme, count }))
    .sort((left, right) => right.count - left.count || left.theme.localeCompare(right.theme));
}

function renderScenario(scenario: SimulationScenario): string[] {
  return [
    `### ${scenario.title}`,
    '',
    `Starting situation: ${scenario.startingSituation}`,
    `Fixture focus: ${scenario.fixtureFocus}`,
    '',
    'Turns:',
    ...scenario.turns.map((turnItem, index) => {
      const thread = turnItem.threadId ? ` (${turnItem.threadId})` : '';
      return `${index + 1}. ${turnItem.actor} ${turnItem.action}${thread}: ${turnItem.summary} Expected: ${turnItem.expectedOutcome}`;
    }),
    '',
    'Thread transcript:',
    ...scenario.reviewThreads.flatMap(renderThreadTranscript),
    '',
    'Feedback:',
    ...scenario.feedback.map(item => `- ${item.severity.toUpperCase()} ${item.theme}: ${item.finding} Recommendation: ${item.recommendation}`),
    ''
  ];
}

function renderThreadTranscript(thread: SimulationReviewThread): string[] {
  const patchLines = thread.suggestedPatch
    ? [
      `  Suggested patch:`,
      `  - ${thread.suggestedPatch.original}`,
      `  + ${thread.suggestedPatch.replacement}`
    ]
    : [];

  return [
    `- ${thread.id} [${thread.type}/${thread.severity}/${thread.status}] on "${thread.anchor.text}": ${thread.comment}`,
    ...patchLines,
    ...thread.thread.map(replyItem => `  - ${replyItem.role}: ${replyItem.text}`),
    `  Outcome: ${thread.expectedOutcome}`
  ];
}
