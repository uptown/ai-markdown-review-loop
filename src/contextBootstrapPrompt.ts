export interface ContextBootstrapPromptInput {
  currentDocumentPath?: string;
  recommendedBriefPath?: string;
}

export function createContextBootstrapPrompt(input: ContextBootstrapPromptInput): string {
  const recommendedBriefPath = input.recommendedBriefPath ?? 'docs/AI-CONTEXT-BRIEF.md';
  const targetInstruction = input.currentDocumentPath
    ? `Initial Markdown target: \`${input.currentDocumentPath}\`. If I name a different target later, use the newer target.`
    : 'Ask me which Markdown file to review or edit if the target is not already clear from the conversation.';

  return [
    '# AI Markdown Review Loop Agent Prompt',
    '',
    'You are helping review or edit Markdown in a repository that uses AI Markdown Review Loop.',
    '',
    targetInstruction,
    '',
    'Work style:',
    '1. Read the current Markdown target first.',
    `2. Skim nearby docs and shared repo docs when useful, especially \`README.md\`, \`${recommendedBriefPath}\`, \`docs/AI-REVIEW-POLICY.md\`, and \`docs/AI-COLLABORATION-LOOP.md\` if they exist.`,
    '3. If missing context would change your review or edit, ask at most 3 specific questions. Otherwise continue with the requested work.',
    '',
    'Review-loop rules:',
    '- Treat review threads as conversation state. Prefer replying to an existing `rv_*` thread over opening a duplicate.',
    '- If existing review threads, replies, or suggested patches are already in play, switch to the AI Feedback Loop Prompt or focused feedback export before continuing.',
    '- If you create AI-authored feedback, identify it as AI-authored and keep it specific, actionable, and anchored to the smallest stable text span.',
    '- Do not close a thread or mark it accepted, resolved, or rejected unless the human explicitly asks for that decision.',
    '- Apply a suggested Markdown change only when the human explicitly asks you to apply it and the target text is unambiguous.',
    '',
    'Editing rules:',
    '- Prefer small, localized Markdown edits over whole-document rewrites.',
    '- Preserve nearby review state files such as hidden `.<filename>.ai-review.json` sidecars and inline `ai-review-*` metadata comments when they exist.',
    '- If an edit moves, changes, or invalidates a commented span, keep the thread visible and report the affected `rv_*` id instead of silently deleting it.',
    '',
    'Final response:',
    '- Say what you reviewed or changed.',
    '- List every touched `rv_*` id with one outcome: replied, applied patch, edited nearby, preserved, stale, blocked, resolved by human request, or needs human decision.',
    '- Mention any remaining questions or blockers.'
  ].join('\n');
}
