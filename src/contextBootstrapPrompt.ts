import { AGENT_CONTEXT_BRIEF_TEMPLATE } from './agentReviewPolicy';

export interface ContextBootstrapPromptInput {
  availableSources: readonly string[];
  currentDocumentPath?: string;
  recommendedBriefPath?: string;
}

export function createContextBootstrapPrompt(input: ContextBootstrapPromptInput): string {
  const recommendedBriefPath = input.recommendedBriefPath ?? 'docs/AI-CONTEXT-BRIEF.md';
  const orderedSources = dedupeStrings([
    ...input.availableSources,
    input.currentDocumentPath ?? ''
  ].filter(Boolean));
  const sourceList = orderedSources.length > 0
    ? orderedSources.map((source, index) => `${index + 1}. \`${source}\``).join('\n')
    : '1. the current Markdown document under review';
  const detectedSources = orderedSources.length > 0
    ? orderedSources.map(source => `- \`${source}\``).join('\n')
    : '- No repo context files were detected. Expect the AI to ask for the missing basics before it reviews or edits.';
  const reviewTarget = input.currentDocumentPath
    ? `Current review target: \`${input.currentDocumentPath}\``
    : 'Current review target: the Markdown document you plan to review next';

  return [
    '# AI Markdown Review Loop Bootstrap Prompt',
    '',
    'Use this prompt with any AI agent before it reviews or edits Markdown in a repository that uses AI Markdown Review Loop. The goal is to give the agent enough context to use the review loop, preserve existing comments, and avoid destructive Markdown rewrites.',
    '',
    '## Detected Sources',
    '',
    detectedSources,
    '',
    reviewTarget,
    '',
    '## Prompt To Paste',
    '',
    '```md',
    'You are an AI agent working in a repository that uses AI Markdown Review Loop for Markdown review.',
    '',
    'Bootstrap context first, then continue with the requested review or edit task in the same conversation unless you need missing information from the human.',
    '',
    'Read these files first, in order, if they exist:',
    sourceList,
    '',
    reviewTarget,
    '',
    'Context discovery:',
    '1. Extract what is already knowable about:',
    '   - Product goal',
    '   - Intended audience',
    '   - Hard constraints',
    '   - Non-goals',
    '   - Canonical source docs',
    '   - Current open decisions',
    '   - Review focus for this pass',
    '2. If a required slot is unclear and it changes the review or edit outcome, ask me at most 3 specific questions. Ask only about missing information.',
    `3. If \`${recommendedBriefPath}\` exists, treat it as durable context. If it is missing or stale, offer a compact draft or refresh using this format:`,
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
    '- Treat the Markdown file and `.ai-markdown-review/` sidecar JSON as one review state.',
    '- Open thread text lives in `.ai-markdown-review/documents/*.json`; closed history may live in `.ai-markdown-review/resolved/*.json`.',
    '- Inline `ai-review-anchors` and `ai-review-log` comments are metadata pointers, not prose. Preserve them during normal edits unless the human explicitly asks to clean stale review metadata.',
    '- Prefer localized Markdown edits over whole-document rewrites so comments can stay attached to the smallest stable span.',
    '- When editing reviewed text, preserve thread ids, replies, status history, sidecar links, anchor context, and nearby text whenever possible.',
    '- If an edit moves, partially changes, or invalidates a commented span, report the affected `rv_*` ids with the outcome instead of silently deleting comments.',
    '- Do not mark threads `accepted`, `resolved`, or `rejected` unless the human explicitly asks for that review decision.',
    '',
    'After bootstrap:',
    '- Continue with the requested review, reply, or Markdown edit.',
    '- In your final response, list any `rv_*` threads you touched and whether each was preserved, replied to, edited near, moved, stale, blocked, or needs a human decision.',
    '```',
    '',
    '## Expected Agent Behavior',
    '',
    'The AI should not stop at creating a brief. It should use the bootstrapped context to operate through the review loop and keep review metadata intact while it reviews or edits Markdown.'
  ].join('\n');
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
