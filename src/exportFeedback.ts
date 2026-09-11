import { parseReviewTaskSidecar, type ReviewTaskSidecar } from './reviewTaskProtocol';

/** The same v3 task JSON used on disk, without a second prompt or transcript. */
export function renderFeedbackExport(review: ReviewTaskSidecar): string {
  return JSON.stringify(parseReviewTaskSidecar(review), null, 2) + '\n';
}
