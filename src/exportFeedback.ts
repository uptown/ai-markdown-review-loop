import { ReviewDocument } from './types';

export function renderFeedbackExport(reviewDocument: ReviewDocument): string {
  const openThreads = reviewDocument.threads.filter(thread => thread.status === 'open');

  const lines = [
    `# Agent Feedback`,
    ``,
    `Document: ${reviewDocument.documentUri}`,
    `Open feedback: ${openThreads.length}`,
    `Generated: ${new Date().toISOString()}`,
    ``
  ];

  if (openThreads.length === 0) {
    lines.push(`No open feedback.`);
    return lines.join('\n');
  }

  for (const thread of openThreads) {
    lines.push(
      `## ${thread.id}`,
      ``,
      `- Type: ${thread.type}`,
      `- Source: ${thread.source}`,
      `- Severity: ${thread.severity}`,
      `- Anchor: ${quoteInline(thread.anchor.text)}`,
      `- Location: ${thread.anchor.lineStart ? `line ${thread.anchor.lineStart}` : 'unknown'}`,
      ``,
      `Feedback:`,
      ``,
      thread.comment,
      ``
    );

    if (thread.suggestedPatch) {
      lines.push(
        `Suggested patch:`,
        ``,
        '```diff',
        `- ${thread.suggestedPatch.original}`,
        `+ ${thread.suggestedPatch.replacement}`,
        '```',
        ``
      );
    }
  }

  lines.push(
    `## Acceptance Gate`,
    ``,
    `Do not mark the task complete until every open feedback item is resolved, accepted, or explicitly rejected by the user.`
  );

  return lines.join('\n');
}

function quoteInline(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
