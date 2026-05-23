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
    : '- No repo context files were detected. Expect the AI to ask for the missing basics before it drafts the brief.';
  const reviewTarget = input.currentDocumentPath
    ? `Current review target: \`${input.currentDocumentPath}\``
    : 'Current review target: the Markdown document you plan to review next';

  return [
    '# AI Context Bootstrap Prompt',
    '',
    'Use this once per repo before the first AI review pass. The goal is to let the AI read what already exists, ask only for missing context, and draft a durable brief.',
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
    'We are bootstrapping AI review context for a repository that uses AI Markdown Review Loop.',
    '',
    'Do not start the actual review yet.',
    '',
    'Read these files first, in order, if they exist:',
    sourceList,
    '',
    reviewTarget,
    '',
    'Your job:',
    '1. Extract whatever is already knowable about:',
    '   - Product goal',
    '   - Intended audience',
    '   - Hard constraints',
    '   - Non-goals',
    '   - Canonical source docs',
    '   - Current open decisions',
    '   - Review focus for this pass',
    '2. If any required slot is still unclear, ask me at most 3 specific questions. Ask only about missing information.',
    `3. After I answer, draft or refresh \`${recommendedBriefPath}\` using exactly this format:`,
    '',
    AGENT_CONTEXT_BRIEF_TEMPLATE.trimEnd(),
    '',
    '4. Keep the brief short, concrete, and repo-specific. Do not rewrite the entire PRD.',
    '5. Stop after drafting the brief. Do not start the substantive review until the brief is saved or confirmed.',
    '```',
    '',
    '## After The AI Responds',
    '',
    `1. Save the finalized brief to \`${recommendedBriefPath}\`.`,
    '2. Then run the first AI review pass with that brief available to read first.'
  ].join('\n');
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
