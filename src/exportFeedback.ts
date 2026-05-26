import {
  AGENT_COMMENTING_GUIDELINES,
  AGENT_COLLABORATION_LOOP_GUIDELINES,
  AGENT_CONTEXT_BOOTSTRAP_GUIDELINES,
  AGENT_EDITING_GUIDELINES,
  AGENT_THREAD_CREATION_CONTRACT
} from './agentReviewPolicy';
import type { ReviewDocument } from './types';

const minActionableCommentLength = 8;

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
    `## Open Review Threads`,
    ``,
    `Handle these threads first. Use the policy sections below as guardrails, not as work to do before reading the queue.`,
    ``
  );

  for (const thread of openThreads) {
    const handoffWarning = getCommentHandoffWarning(thread.comment);

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
      `- Handoff quality: ${handoffWarning ? 'needs_detail' : 'ready'}`,
      ...(handoffWarning ? [`- Quality warning: ${handoffWarning}`] : []),
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

  lines.push(
    `## Review Session Context`,
    ``,
    `Treat the latest human replies and request text as the active review session brief. Capture review goal, focus areas, non-goals, constraints, preferred comment style, and done condition before adding or revising comments. If the human changes review priority mid-thread, apply that new session context to the next pass rather than repeating generic review rules.`,
    ``,
    `## Acceptance Gate`,
    ``,
    `Do not mark the task complete until every open feedback item has an explicit outcome in your response. Do not close review threads unless the user explicitly asks you to mark them accepted, resolved, or rejected.`,
    ``,
    `For any Markdown edit that handles or affects an \`rv_*\` thread, the done state is two-part: the Markdown changed and the colocated sidecar thread history was updated with an assistant reply explaining the outcome. If you cannot update sidecar history safely, report the thread as blocked instead of claiming the loop is complete.`,
    ``,
    `Outcome vocabulary: replied keeps the thread open with new context; applied patch means Markdown changed and sidecar history records the edit outcome, and the thread may close as accepted only after the edit succeeds; preserved means the thread stayed attached after nearby edits; stale or blocked means the thread stays open; needs human decision means stop before deciding and leave the thread open for the human.`
  );

  return lines.join('\n');
}

export function getCommentHandoffWarning(comment: string): string | undefined {
  const normalized = comment.trim().replace(/\s+/g, ' ');

  if (normalized.length === 0) {
    return 'Comment is empty, so an AI agent has no actionable instruction.';
  }

  if (normalized.length < minActionableCommentLength) {
    return 'Comment is too short for reliable AI handoff; add the expected action or reason.';
  }

  if (!/[\p{L}\p{N}]/u.test(normalized)) {
    return 'Comment has no readable words or numbers; add a concrete action or question.';
  }

  return undefined;
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
