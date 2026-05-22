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
    `- Treat the Markdown document and its review sidecar as one review state.`,
    `- Work on open review threads only unless the user explicitly asks you to inspect closed history.`,
    `- Preserve the document-level \`ai-review-anchors\` marker unless the user explicitly asks to clean stale anchors.`,
    `- Preserve \`ai-review-log\` audit comments and sidecar files during normal document editing.`,
    `- Prefer localized edits over whole-document rewrites so anchors can keep tracking nearby content.`,
    `- When editing text with open feedback, keep enough nearby context stable for anchor recovery.`,
    `- Do not silently delete or rewrite open review comments. If a comment no longer matches after your edit, call that out and leave it open for re-anchor.`,
    `- Use replies to discuss, clarify, or challenge feedback. If you disagree, propose a reply or objection instead of ignoring the thread.`,
    `- Do not mark a thread \`accepted\`, \`resolved\`, or \`rejected\` on behalf of the user unless they explicitly ask you to close it.`,
    `- Report every handled \`rv_*\` ID in your response with an outcome: applied, partially applied, replied, needs user decision, or blocked.`,
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
