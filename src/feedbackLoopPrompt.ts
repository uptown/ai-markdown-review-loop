import type * as Vscode from 'vscode';

export interface FeedbackLoopPromptInput {
  currentDocumentPath?: string;
  focusThreadId?: string;
}

export async function openFeedbackLoopPrompt(
  documentUri?: Vscode.Uri,
  focusThreadId?: string
): Promise<Vscode.TextDocument | undefined> {
  const vscode = await import('vscode');
  const workspaceFolder = resolveWorkspaceFolder(vscode, documentUri);

  if (!workspaceFolder) {
    return undefined;
  }

  const currentDocumentPath = documentUri
    ? vscode.workspace.asRelativePath(documentUri, false)
    : undefined;
  const prompt = createFeedbackLoopPrompt({ currentDocumentPath, focusThreadId });
  const { openReadOnlyMarkdownPrompt } = await import('./promptDocuments');
  return openReadOnlyMarkdownPrompt('AI Feedback Loop Prompt', prompt);
}

export function createFeedbackLoopPrompt(input: FeedbackLoopPromptInput): string {
  const targetInstruction = input.currentDocumentPath
    ? `Current Markdown target: \`${input.currentDocumentPath}\`. If I name a different target later, use the newer target.`
    : 'Ask me which Markdown file is the current review target if it is not already clear from the conversation.';
  const threadInstruction = input.focusThreadId
    ? [
      '',
      `Current review thread focus: \`${input.focusThreadId}\`. Continue this exact thread first. Do not open a duplicate for the same issue; reply, revise the suggested patch, apply an explicit safe patch, or report why this thread needs a human decision.`
    ]
    : [];

  return [
    '# AI Markdown Review Loop Feedback Loop Prompt',
    '',
    'You are continuing an AI-assisted Markdown review loop. Use this prompt after initial context bootstrap, when the document already has review threads, replies, suggested edits, or human decisions.',
    '',
    targetInstruction,
    ...threadInstruction,
    '',
    'Loop objective:',
    '1. Inspect the current Markdown target and its colocated hidden `.<filename>.ai-review.json` sidecar when available.',
    '2. Recover the current review session brief from the latest human request and thread replies: review goal, focus areas, non-goals, constraints, preferred comment style, and done condition.',
    '3. Treat Review Threads as conversation state, not as disposable comments.',
    '4. Continue existing `rv_*` threads with replies when the same issue is still being discussed.',
    '5. Make localized Markdown edits only through review-aware edit paths when plugin tools are available.',
    '6. Preserve thread ids, replies, sidecar links, anchor context, status history, and decision history.',
    '',
    'Action semantics:',
    '- `Apply Patch and Close` means the human wants the proposed Markdown change applied. Apply the patch through the review-aware edit path, refresh affected anchors, record an edit outcome reply, and close the target thread as `accepted` only after the edit succeeds.',
    '- If the human says "accept this suggestion" and the thread has a safe suggested patch, treat that as an apply request. If there is no safe patch target, ask before closing anything.',
    '- `Agree` means the human agrees with the feedback. Add or draft a reply; do not mutate the document or close the thread unless the human also asks to apply a patch or resolve the issue.',
    '- `Disagree` means the human is challenging the feedback. Add or draft a reply with the reason, then continue the same thread unless the issue has split into a separate concern.',
    '- `Revise` means the human wants a sharper comment or patch. Reply with a narrower diagnosis, a revised suggested patch, or a specific clarifying question.',
    '- `Resolve` means the issue is handled, no longer applies, or the human explicitly wants to close the thread. Do not use resolve as a substitute for applying an edit.',
    '- `Close as Declined` means the human judged the feedback wrong or intentionally not applicable. Preserve the decision as `rejected`; do not reopen the same concern unless new evidence appears.',
    '- If you revise a suggested patch in a reply, use a `Suggested patch revision:` label followed by a fenced `diff` block so the human and extension can distinguish discussion from a concrete replacement candidate.',
    '- If the human changes the review goal, priority, or comment style, apply that as session context before adding more comments.',
    '',
    'Type-specific behavior:',
    '- `suggestion` or `fix` with a `suggestedPatch`: prefer showing the exact patch impact. Apply it only on an explicit apply/accept-change request.',
    '- `risk`: explain the downstream failure mode, then propose the smallest safe document change or ask for missing constraints.',
    '- `question`: answer from available context or ask the human for the missing decision. Keep the thread open until the decision is captured.',
    '- Mermaid, table, or source-scoped suggestions: reply with the exact source patch and wait for explicit apply/edit intent before changing Markdown.',
    '- `note`: keep it lightweight. Reply only when it affects future AI handoff or document maintenance.',
    '',
    'When editing Markdown:',
    '- Prefer the smallest stable span that satisfies the thread.',
    '- If an anchor moved, partially changed, or became stale, report the affected `rv_*` id and whether it was preserved, re-anchored, left open, or needs a human decision.',
    '- If a suggested patch is missing, duplicated ambiguously, or attached to a low-confidence anchor, do not guess. Reply with the blocker and ask for a human decision.',
    '',
    'Final response requirements:',
    '- Restate the review session brief if it changed during this turn.',
    '- List each touched `rv_*` thread.',
    '- For each one, report one outcome: replied - waiting for human decision, applied patch, edited nearby, preserved, stale, blocked, resolved by human request, or needs human decision.',
    '- Do not claim the loop is complete until every open feedback item involved in this turn has an explicit outcome.'
  ].join('\n');
}

function resolveWorkspaceFolder(
  vscode: typeof import('vscode'),
  documentUri?: Vscode.Uri
): Vscode.WorkspaceFolder | undefined {
  if (documentUri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);

    if (workspaceFolder) {
      return workspaceFolder;
    }
  }

  const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
  return activeDocumentUri ? vscode.workspace.getWorkspaceFolder(activeDocumentUri) : undefined;
}
