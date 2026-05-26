import { createReviewAnchorIdentityKey } from './reviewAnchorIdentity';
import type { ReviewThread } from './types';

export function isDuplicateReviewThread(
  existing: ReviewThread,
  incoming: ReviewThread
): boolean {
  return existing.status === 'open'
    && existing.comment === incoming.comment
    && createReviewAnchorIdentityKey(existing) === createReviewAnchorIdentityKey(incoming);
}
