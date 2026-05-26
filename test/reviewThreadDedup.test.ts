import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicateReviewThread } from '../src/reviewThreadDedup';
import type { ReviewThread } from '../src/types';

const now = '2026-05-26T00:00:00.000Z';

describe('review thread dedupe', () => {
  it('keeps same-line repeated-span comments distinct when occurrence differs', () => {
    assert.equal(
      isDuplicateReviewThread(
        thread('rv_first', { lineStart: 7, occurrence: 0 }),
        thread('rv_second', { lineStart: 7, occurrence: 1 })
      ),
      false
    );
  });

  it('dedupes imported open threads only when comment and anchor identity match', () => {
    assert.equal(
      isDuplicateReviewThread(
        thread('rv_existing', { lineStart: 7, occurrence: 0 }),
        thread('rv_incoming', { lineStart: 7, occurrence: 0 })
      ),
      true
    );
  });
});

function thread(
  id: string,
  anchor: Pick<ReviewThread['anchor'], 'lineStart' | 'occurrence'>
): ReviewThread {
  return {
    id,
    documentUri: 'file:///workspace/spec.md',
    anchor: {
      text: 'duplicate',
      lineStart: anchor.lineStart,
      lineEnd: anchor.lineStart,
      occurrence: anchor.occurrence,
      confidence: 'exact'
    },
    type: 'note',
    source: 'ai',
    status: 'open',
    severity: 'medium',
    comment: 'Clarify this repeated value.',
    thread: [],
    createdAt: now,
    updatedAt: now
  };
}
