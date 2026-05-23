export type SimulationSeverity = 'low' | 'medium' | 'high';
export type SimulationActor = 'ai_reviewer' | 'human_author' | 'extension';
export type SimulationAction =
  | 'bootstrap'
  | 'open_thread'
  | 'reply'
  | 'apply_patch'
  | 'manual_edit'
  | 'resolve'
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

export interface SimulationScenario {
  id: string;
  title: string;
  startingSituation: string;
  turns: SimulationTurn[];
  feedback: SimulationFeedback[];
}

export interface SimulationSummary {
  scenarios: SimulationScenario[];
  totalTurns: number;
  feedback: SimulationFeedback[];
  feedbackBySeverity: Record<SimulationSeverity, number>;
  repeatedThemes: Array<{ theme: string; count: number }>;
}

export function runReviewLoopSimulations(): SimulationSummary {
  const scenarios = createReviewLoopScenarios();
  const feedback = scenarios.flatMap(scenario => scenario.feedback);

  return {
    scenarios,
    totalTurns: scenarios.reduce((sum, scenario) => sum + scenario.turns.length, 0),
    feedback,
    feedbackBySeverity: countFeedbackBySeverity(feedback),
    repeatedThemes: countRepeatedThemes(feedback)
  };
}

export function renderReviewLoopSimulationReport(summary: SimulationSummary): string {
  return [
    '# Review Loop Simulation Report',
    '',
    `Scenarios run: ${summary.scenarios.length}`,
    `Turns simulated: ${summary.totalTurns}`,
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
      startingSituation: 'A Markdown workflow doc has goals but no testable acceptance criteria.',
      turns: [
        turn('ai_reviewer', 'bootstrap', 'Reads the target document and nearby shared docs before commenting.', 'AI asks only for missing acceptance context that changes review quality.'),
        turn('ai_reviewer', 'open_thread', 'Opens rv_acceptance as a question anchored to the vague goal.', 'Thread stays specific and actionable instead of becoming broad style feedback.', 'rv_acceptance'),
        turn('human_author', 'reply', 'Answers that acceptance should focus on preserving review metadata during edits.', 'Human context remains inside the same thread.', 'rv_acceptance'),
        turn('ai_reviewer', 'reply', 'Replies with a narrower acceptance criterion candidate.', 'AI continues the thread rather than opening a duplicate.', 'rv_acceptance')
      ],
      feedback: [
        feedback('medium', 'Context capture', 'The bootstrap prompt is now concise, but it does not tell the AI when a missing answer should become a thread versus a direct question.', 'Add guidance that blocking document questions should become `question` threads when the user is reviewing inside the extension.'),
        feedback('low', 'Outcome clarity', 'The final response outcome vocabulary is useful, but users may not know whether `needs human decision` means the thread stays open.', 'Surface the same outcome vocabulary in export docs and tooltips.')
      ]
    },
    {
      id: 'sim_human_disagrees_with_patch',
      title: 'Human disagrees with an AI suggested patch',
      startingSituation: 'AI suggests removing a section that the human knows is contractually required.',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_remove_section with a suggested replacement patch.', 'Thread has one issue and one patch.', 'rv_remove_section'),
        turn('human_author', 'reply', 'Uses Disagree shortcut and explains the contractual constraint.', 'Thread remains open; no source mutation happens.', 'rv_remove_section'),
        turn('ai_reviewer', 'reply', 'Acknowledges the missed constraint and revises the recommendation to clarify the section instead.', 'AI follows the same thread and does not silently close it.', 'rv_remove_section')
      ],
      feedback: [
        feedback('high', 'Closure ownership', 'Discussion-first shortcuts prevent accidental closure, but closed history still supports rejected status while the active UI no longer exposes Reject.', 'Keep rejected history for compatibility, but document that active disagreement is a reply-first flow and add a future explicit close-as-declined affordance only if users ask for it.'),
        feedback('high', 'AI handoff continuity', 'Disagree and Revise shortcuts create the right thread state, but they do not naturally hand the updated thread back to an AI agent.', 'After saving a reply, offer a focused Continue with AI handoff for that thread and test that the prompt/export includes the reply plus the `rv_*` id.'),
        feedback('medium', 'AI handoff continuity', 'The product has a Revise Patch shortcut, but there is no structured place for the AI to return a replacement patch candidate inside the existing thread.', 'Add a schema or UI convention for revised suggested patches in replies.')
      ]
    },
    {
      id: 'sim_accept_this_suggestion_language',
      title: 'Human says "accept this suggestion" on an AI patch',
      startingSituation: 'A thread has a suggested patch, and the human uses natural language instead of the exact UI label.',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_accept_language with a localized suggested patch.', 'The AI provides a concrete replacement and keeps the thread open.', 'rv_accept_language'),
        turn('human_author', 'reply', 'Says "accept this suggestion".', 'The loop treats this as an apply request only if the patch target is safe.', 'rv_accept_language'),
        turn('extension', 'apply_patch', 'Applies the patch only when target text is unambiguous; otherwise it leaves the thread open and asks.', 'Natural language accept does not become a silent close-only action.', 'rv_accept_language')
      ],
      feedback: [
        feedback('high', 'Patch application clarity', 'Humans naturally say "accept" when they mean "apply the proposed change", while the stored accepted status still means closed after a successful patch.', 'Keep prompt and UI copy biased toward `Apply Patch`; add tests where "accept this suggestion" applies a safe patch or asks when unsafe.'),
        feedback('medium', 'Patch application clarity', '`Apply Suggested Patch` is accurate but verbose, and it hides that the thread closes afterward.', 'Consider button copy like `Apply Patch and Close` with a compact diff preview.')
      ]
    },
    {
      id: 'sim_apply_suggested_patch',
      title: 'Human explicitly applies a reliable suggested patch',
      startingSituation: 'AI suggests replacing one unambiguous sentence with a testable requirement.',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_retry_policy with a replace patch.', 'Patch is localized and has one exact target.', 'rv_retry_policy'),
        turn('human_author', 'apply_patch', 'Clicks Apply Suggested Patch.', 'Markdown changes only after explicit apply action.', 'rv_retry_policy'),
        turn('extension', 'apply_patch', 'Refreshes anchors, records an edit outcome reply, and closes the thread as accepted.', 'Accepted means the patch actually landed, not just that feedback was liked.', 'rv_retry_policy'),
        turn('ai_reviewer', 'export', 'Reports rv_retry_policy as applied patch in the final outcome list.', 'Agent handoff has a clear audit trail.', 'rv_retry_policy')
      ],
      feedback: [
        feedback('high', 'Patch application clarity', 'The simulation succeeds only when the patch target is unambiguous. A real user still needs to see why a patch is considered safe before applying.', 'Add a compact diff/target preview before Apply Suggested Patch for medium-risk docs.'),
        feedback('medium', 'Patch application clarity', '`accepted` is still overloaded in persisted history even though the UI moved away from Accept as a generic close action.', 'Rename visible history copy to `Patch applied` when accepted came from Apply Suggested Patch.')
      ]
    },
    {
      id: 'sim_manual_edit_near_comment',
      title: 'Human manually edits text that has an open comment',
      startingSituation: 'A comment is anchored to one word inside a paragraph, and the human edits that word manually.',
      turns: [
        turn('human_author', 'manual_edit', 'Changes the commented word in the rendered block editor.', 'Review-aware edit keeps the thread narrow and updates the anchor text.', 'rv_wording'),
        turn('extension', 'reply', 'Adds an edit outcome reply to rv_wording.', 'Thread history explains why the anchor moved.', 'rv_wording'),
        turn('ai_reviewer', 'reply', 'Continues from the edited wording instead of re-reviewing the old text.', 'AI preserves discussion continuity.', 'rv_wording')
      ],
      feedback: [
        feedback('medium', 'Anchor preservation visibility', 'The review-aware path behaves well, but ordinary source edits still rely on later re-anchor confidence.', 'Add scenario coverage that exports approximate or missing anchors after ordinary source edits.'),
        feedback('medium', 'Anchor preservation visibility', 'Core anchor preservation is improving, but users need immediate confirmation that a comment was kept, moved, or became stale after an edit.', 'Show a per-thread outcome badge such as Kept, Moved, Needs re-anchor, or Closed as Accepted after review-aware edits.'),
        feedback('low', 'Anchor preservation visibility', 'Automatic edit outcome replies need to stay human-readable or they will pollute the conversation.', 'Keep tests around edit outcome text so internal pipeline wording does not regress.')
      ]
    },
    {
      id: 'sim_vague_human_reply',
      title: 'Human leaves a vague reply during an AI handoff',
      startingSituation: 'A thread has a reasonable AI question, but the human replies with "ok" before export.',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Asks rv_owner who owns the follow-up decision.', 'Thread is actionable before the reply.', 'rv_owner'),
        turn('human_author', 'reply', 'Replies only "ok".', 'Reply is preserved but does not help the agent.', 'rv_owner'),
        turn('ai_reviewer', 'export', 'Cannot infer a decision and reports rv_owner as needs human decision.', 'The loop avoids pretending the issue is resolved.', 'rv_owner')
      ],
      feedback: [
        feedback('medium', 'Reply quality', 'Comment quality warnings exist for comments, but vague replies can still poison agent handoff.', 'Add lightweight reply-quality warnings for very short replies before export.'),
        feedback('medium', 'Reply quality', 'The user may expect Agree/Answer shortcuts to submit a complete reply, but some templates intentionally need user completion.', 'Disable submit or show a warning when a shortcut reply still ends with an unfinished prompt such as "because".')
      ]
    },
    {
      id: 'sim_agent_overreaches_closure',
      title: 'AI tries to close a thread after answering itself',
      startingSituation: 'AI answers its own question from docs and wants to mark the thread resolved.',
      turns: [
        turn('ai_reviewer', 'open_thread', 'Opens rv_scope_question asking whether a workflow is in scope.', 'The question is valid because scope is ambiguous.', 'rv_scope_question'),
        turn('ai_reviewer', 'reply', 'Finds context later and proposes an answer in the same thread.', 'AI can help reduce ambiguity without closing.', 'rv_scope_question'),
        turn('human_author', 'resolve', 'Human confirms the answer is now captured and resolves the thread.', 'Final closure remains human-owned.', 'rv_scope_question')
      ],
      feedback: [
        feedback('high', 'Closure ownership', 'The prompts correctly warn the AI not to close threads, but a future integrated AI reviewer could still mutate sidecars directly if APIs are too permissive.', 'Keep closure APIs human-gated or require explicit user intent tokens for accepted/resolved/rejected transitions.'),
        feedback('low', 'Prompt clarity', 'The concise prompt is easier to follow than the previous implementation-heavy bootstrap.', 'Keep bootstrap short and move detailed lifecycle rules to the feedback-loop prompt and docs.')
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
    '',
    'Turns:',
    ...scenario.turns.map((turnItem, index) => {
      const thread = turnItem.threadId ? ` (${turnItem.threadId})` : '';
      return `${index + 1}. ${turnItem.actor} ${turnItem.action}${thread}: ${turnItem.summary} Expected: ${turnItem.expectedOutcome}`;
    }),
    '',
    'Feedback:',
    ...scenario.feedback.map(item => `- ${item.severity.toUpperCase()} ${item.theme}: ${item.finding} Recommendation: ${item.recommendation}`),
    ''
  ];
}
