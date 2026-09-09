import { normalizeAnchorText } from './anchorText';
import { findSourceAnchorMatches, type SourceAnchorMatch } from './anchorSourceMatches';
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
  return Boolean(findLinkedHistoryAnchor(markdown, thread));
}

export function getReviewHistoryAnchorLocations(markdown: string, threads: ReviewThread[]): Record<string, SourceAnchorMatch> {
  const locations: Record<string, SourceAnchorMatch> = {};
  for (const thread of threads) {
    const match = findLinkedHistoryAnchor(markdown, thread);
    if (match) locations[thread.id] = match;
  }
  return locations;
}

function findLinkedHistoryAnchor(markdown: string, thread: ReviewThread): SourceAnchorMatch | undefined {
  const anchorText = normalizeAnchorText(thread.anchor.text);

  if (!anchorText || thread.anchor.confidence === 'missing') {
    return undefined;
  }

  const candidates = findSourceAnchorMatches(markdown, anchorText);

  if (candidates.length === 0) {
    return undefined;
  }

  const preferredLine = thread.anchor.lastLocatedLine ?? thread.anchor.lineStart;

  const matchingLine = candidates.find(candidate => candidate.lineStart === preferredLine);
  if (preferredLine !== undefined && matchingLine) {
    return matchingLine;
  }

  const occurrence = normalizeOccurrence(thread.anchor.occurrence);
  const occurrenceCandidate = occurrence !== undefined
    ? candidates[occurrence]
    : undefined;

  if (candidates.length === 1 && occurrence === undefined) {
    return candidates[0];
  }

  const contextBefore = normalizeAnchorText(thread.anchor.contextBefore || '');
  const contextAfter = normalizeAnchorText(thread.anchor.contextAfter || '');

  if (!contextBefore && !contextAfter) {
    return undefined;
  }

  const contextCandidates = occurrenceCandidate
    ? [occurrenceCandidate]
    : candidates;

  return contextCandidates.find(candidate => {
    const before = normalizeAnchorText(markdown.slice(0, candidate.start));
    const after = normalizeAnchorText(markdown.slice(candidate.start + candidate.length));
    return (!contextBefore || before.endsWith(contextBefore))
      && (!contextAfter || after.startsWith(contextAfter));
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
