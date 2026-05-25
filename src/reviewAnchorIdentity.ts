import { normalizeAnchorText } from './anchorText';
import type { ReviewThread } from './types';

export function createReviewAnchorIdentityKey(thread: ReviewThread): string {
  const anchor = thread.anchor;
  const lineStart = normalizeNumber(anchor.lastLocatedLine ?? anchor.lineStart);
  const lineEnd = normalizeNumber(anchor.lineEnd ?? lineStart);
  const occurrence = normalizeNumber(anchor.occurrence);

  return JSON.stringify({
    text: normalizeAnchorText(anchor.text || ''),
    lineStart,
    lineEnd,
    occurrence,
    before: tailSnippet(anchor.contextBefore),
    after: headSnippet(anchor.contextAfter)
  });
}

function normalizeNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

function tailSnippet(value: string | undefined): string | undefined {
  const normalized = normalizeAnchorText(value || '');
  return normalized ? normalized.slice(-80) : undefined;
}

function headSnippet(value: string | undefined): string | undefined {
  const normalized = normalizeAnchorText(value || '');
  return normalized ? normalized.slice(0, 80) : undefined;
}
