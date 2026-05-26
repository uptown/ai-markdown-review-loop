import { normalizeAnchorText } from './anchorText';
import type { ReviewThread } from './types';

export type ReviewHistoryAnchorState = 'linked' | 'outdated';

export function getReviewHistoryAnchorStates(
  markdown: string,
  threads: ReviewThread[]
): Record<string, ReviewHistoryAnchorState> {
  const states: Record<string, ReviewHistoryAnchorState> = {};

  for (const thread of threads) {
    states[thread.id] = hasLinkedHistoryAnchor(markdown, thread)
      ? 'linked'
      : 'outdated';
  }

  return states;
}

export function hasLinkedHistoryAnchor(markdown: string, thread: ReviewThread): boolean {
  const anchorText = normalizeAnchorText(thread.anchor.text);

  if (!anchorText) {
    return false;
  }

  const lines = markdown.split(/\r?\n/);
  const candidates = lines
    .map((line, index) => ({
      lineNumber: index + 1,
      text: normalizeAnchorText(line)
    }))
    .filter(candidate => candidate.text.includes(anchorText));

  if (candidates.length === 0) {
    return false;
  }

  const preferredLine = thread.anchor.lastLocatedLine ?? thread.anchor.lineStart;

  if (preferredLine !== undefined && candidates.some(candidate => candidate.lineNumber === preferredLine)) {
    return true;
  }

  const occurrence = normalizeOccurrence(thread.anchor.occurrence);
  const occurrenceCandidate = occurrence !== undefined
    ? candidates[occurrence]
    : undefined;

  if (candidates.length === 1 && occurrence === undefined) {
    return true;
  }

  const contextBefore = normalizeAnchorText(thread.anchor.contextBefore || '');
  const contextAfter = normalizeAnchorText(thread.anchor.contextAfter || '');

  if (!contextBefore && !contextAfter) {
    return false;
  }

  const contextCandidates = occurrenceCandidate
    ? [occurrenceCandidate]
    : candidates;

  return contextCandidates.some(candidate => {
    const before = normalizeAnchorText(lines.slice(Math.max(0, candidate.lineNumber - 3), candidate.lineNumber - 1).join('\n'));
    const after = normalizeAnchorText(lines.slice(candidate.lineNumber, Math.min(lines.length, candidate.lineNumber + 2)).join('\n'));
    return (!contextBefore || before.includes(contextBefore))
      && (!contextAfter || after.includes(contextAfter));
  });
}

export function createRestoredReviewThread(
  thread: ReviewThread,
  now: string
): ReviewThread {
  return {
    ...thread,
    status: 'open',
    closedBy: undefined,
    closedAt: undefined,
    updatedAt: now,
    thread: [
      ...thread.thread,
      {
        role: 'user',
        text: 'Review outcome: restored this closed thread to open feedback.',
        createdAt: now
      }
    ]
  };
}

function normalizeOccurrence(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}
