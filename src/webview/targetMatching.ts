import type { ReviewAnchor } from '../types';

export interface TargetCandidate<T> {
  value: T;
  line?: number;
  occurrence: number;
  before: string;
  after: string;
}

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Choose only quoted candidates with corroborated identity. Lines never create a match. */
export function chooseTargetCandidate<T>(anchor: ReviewAnchor, candidates: TargetCandidate<T>[]): T | undefined {
  if (anchor.confidence === 'missing' || anchor.confidence === 'ambiguous' || !candidates.length) return undefined;
  const before = normalized(anchor.contextBefore || '').slice(-60);
  const after = normalized(anchor.contextAfter || '').slice(0, 60);
  const corroborated = candidates.filter(candidate =>
    (!before || normalized(candidate.before).endsWith(before))
      && (!after || normalized(candidate.after).startsWith(after)));
  if (before || after) {
    if (corroborated.length === 1) return corroborated[0].value;
    // A surviving copy elsewhere must not inherit the deleted original's comment.
    if (!corroborated.length) return undefined;
  }
  const remaining = before || after ? corroborated : candidates;
  if (remaining.length === 1 && (anchor.occurrence || 0) === 0) return remaining[0].value;
  const atOriginalPosition = remaining.filter(candidate =>
    candidate.line === anchor.lineStart && candidate.occurrence === (anchor.occurrence || 0));
  return atOriginalPosition.length === 1 ? atOriginalPosition[0].value : undefined;
}
