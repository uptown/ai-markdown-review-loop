import { normalizeAnchorText } from './anchorText';
import type { ReviewThread } from './types';

export type ReviewHistoryAnchorState = 'linked' | 'outdated';

export function getReviewHistoryAnchorStates(
  markdown: string,
  threads: ReviewThread[]
): Record<string, ReviewHistoryAnchorState> {
  const normalizedMarkdown = normalizeAnchorText(markdown);
  const states: Record<string, ReviewHistoryAnchorState> = {};

  for (const thread of threads) {
    const anchorText = normalizeAnchorText(thread.anchor.text);
    states[thread.id] = anchorText && normalizedMarkdown.includes(anchorText)
      ? 'linked'
      : 'outdated';
  }

  return states;
}

export function createRestoredReviewThread(
  thread: ReviewThread,
  now: string
): ReviewThread {
  return {
    ...thread,
    status: 'open',
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
