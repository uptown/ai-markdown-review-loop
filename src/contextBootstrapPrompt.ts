import { AGENT_CONTEXT_BRIEF_TEMPLATE } from './agentReviewPolicy';

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
    '# AI Markdown Review Loop Bootstrap Prompt',
    '',
    'You are an AI agent working in a repository that uses AI Markdown Review Loop for Markdown review.',
    '',
    'Use this message as your bootstrap instructions before you review or edit Markdown. Continue with the requested review, reply, or edit task in the same conversation after bootstrapping unless required information is missing.',
    '',
    targetInstruction,
    '',
    'Context discovery:',
    '1. Start with the current Markdown target and nearby docs that explain the same feature, workflow, or product area.',
    `2. Read shared repo context that is available to an AI agent, especially \`README.md\`, \`${recommendedBriefPath}\`, \`docs/AI-REVIEW-POLICY.md\`, \`docs/AI-COLLABORATION-LOOP.md\`, and \`docs/agent-review-thread.schema.json\` when they are relevant.`,
    '3. Extract what is already knowable about:',
    '   - Product goal',
    '   - Intended audience',
    '   - Hard constraints',
    '   - Non-goals',
    '   - Canonical source docs',
    '   - Current open decisions',
    '   - Review focus for this pass',
    '4. If the available context leaves a decision unclear and that decision changes the review or edit outcome, ask me at most 3 specific questions. Ask only about missing information.',
    `5. Treat \`${recommendedBriefPath}\` as an optional durable context brief when it is available. If durable context would help future review passes, offer a compact draft or refresh using this format:`,
    '',
    AGENT_CONTEXT_BRIEF_TEMPLATE.trimEnd(),
    '',
    'AI Markdown Review Loop usage:',
    '- If the extension/plugin tools are available, use them as the review surface: open the review preview, inspect Review Threads, add replies instead of overwriting discussion, and export feedback for agent handoff when needed.',
    '- If direct plugin tools are not available, follow the repo contracts in `docs/AI-REVIEW-POLICY.md`, `docs/AI-COLLABORATION-LOOP.md`, and `docs/agent-review-thread.schema.json`.',
    '- Use `source: "ai"` for AI-authored review threads. Do not impersonate human comments.',
    '- Prefer replies on existing `rv_*` threads when continuing discussion, disagreeing, or asking for clarification.',
    '',
    'Review metadata and edit safety:',
    '- Treat the Markdown file and its colocated hidden `.<filename>.ai-review.json` sidecar as one review state.',
    '- Open thread text lives in `openThreads`; accepted, resolved, and rejected history lives in `closedThreads` in the same sidecar.',
    '- Legacy `.ai-markdown-review/documents/*.json` and `.ai-markdown-review/resolved/*.json` sidecars may still exist in older repos. Preserve them unless the extension migrates them.',
    '- Inline `ai-review-anchors` and `ai-review-log` comments are metadata pointers, not prose. Preserve them during normal edits unless the human explicitly asks to clean stale review metadata.',
    '- Prefer localized Markdown edits over whole-document rewrites so comments can stay attached to the smallest stable span.',
    '- When editing reviewed text, preserve thread ids, replies, status history, sidecar links, anchor context, and nearby text whenever possible.',
    '- If an edit moves, partially changes, or invalidates a commented span, report the affected `rv_*` ids with the outcome instead of silently deleting comments.',
    '- Do not mark threads `accepted`, `resolved`, or `rejected` unless the human explicitly asks for that review decision.',
    '',
    'After bootstrap:',
    '- Continue with the requested review, reply, or Markdown edit.',
    '- In your final response, list any `rv_*` threads you touched and whether each was preserved, replied to, edited near, moved, stale, blocked, or needs a human decision.',
    '',
    'Do not stop after creating or refreshing context. The goal is to use this context to operate through the review loop while keeping review metadata intact.'
  ].join('\n');
}
