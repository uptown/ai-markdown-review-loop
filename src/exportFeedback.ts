import {
  AGENT_COMMENTING_GUIDELINES,
  AGENT_COLLABORATION_LOOP_GUIDELINES,
  AGENT_CONTEXT_BOOTSTRAP_GUIDELINES,
  AGENT_EDITING_GUIDELINES,
  AGENT_THREAD_CREATION_CONTRACT
} from './agentReviewPolicy';
import type { ReviewDocument } from './types';

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

  lines.push(
    `## Agent Editing Guidelines`,
    ``,
    ...AGENT_EDITING_GUIDELINES.map(line => `- ${line}`),
    ``,
    `## Agent Commenting Guidelines`,
    ``,
    ...AGENT_COMMENTING_GUIDELINES.map(line => `- ${line}`),
    ``,
    `## Agent Thread Creation Contract`,
    ``,
    ...AGENT_THREAD_CREATION_CONTRACT.map(line => `- ${line}`),
    ``,
    `## Human-AI Feedback Loop`,
    ``,
    ...AGENT_COLLABORATION_LOOP_GUIDELINES.map(line => `- ${line}`),
    ``,
    `## Initial Context Bootstrap`,
    ``,
    ...AGENT_CONTEXT_BOOTSTRAP_GUIDELINES.map(line => `- ${line}`),
    ``,
    `Use the linked policy files as canonical source material instead of copying full templates or examples into this export.`,
    ``
  );

  for (const thread of openThreads) {
    lines.push(
      `## ${thread.id}`,
      ``,
      `- Type: ${thread.type}`,
      `- Source: ${thread.source}`,
      `- Severity: ${thread.severity}`,
      `- Anchor confidence: ${thread.anchor.confidence ?? 'unknown'}`,
      `- Anchor: ${quoteInline(thread.anchor.text)}`,
      `- Location: ${thread.anchor.lineStart ? `line ${thread.anchor.lineStart}` : 'unknown'}`,
      `- Requested action: edit_or_reply`,
      `- Allowed to close: no, unless the user explicitly asks you to close this thread`,
      ``,
      `Feedback:`,
      ``,
      thread.comment,
      ``
    );

    if (thread.thread.length > 0) {
      lines.push(
        `Discussion:`,
        ``
      );

      for (const reply of thread.thread) {
        lines.push(
          `- ${reply.role} (${reply.createdAt}):`,
          indentBlock(reply.text),
          ``
        );
      }
    }

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
    `Do not mark the task complete until every open feedback item has an explicit outcome in your response. Do not close review threads unless the user explicitly asks you to mark them accepted, resolved, or rejected.`
  );

  return lines.join('\n');
}

function quoteInline(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function indentBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map(line => `  ${line}`)
    .join('\n');
}
