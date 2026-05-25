import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewAnchorIdentityKey } from '../src/reviewAnchorIdentity';
import type { ReviewThread } from '../src/types';

describe('review anchor identity', () => {
  it('distinguishes repeated text on different source lines', () => {
    assert.notEqual(
      createReviewAnchorIdentityKey(thread({ lineStart: 1, lineEnd: 1 })),
      createReviewAnchorIdentityKey(thread({ lineStart: 8, lineEnd: 8 }))
    );
  });

  it('distinguishes repeated text on the same line by occurrence', () => {
    assert.notEqual(
      createReviewAnchorIdentityKey(thread({ lineStart: 1, lineEnd: 1, occurrence: 0 })),
      createReviewAnchorIdentityKey(thread({ lineStart: 1, lineEnd: 1, occurrence: 1 }))
    );
  });

  it('keeps comments on the same repeated span groupable when location hints match', () => {
    assert.equal(
      createReviewAnchorIdentityKey(thread({ lineStart: 3, lineEnd: 3, occurrence: 2 })),
      createReviewAnchorIdentityKey(thread({ lineStart: 3, lineEnd: 3, occurrence: 2 }))
    );
  });

  it('distinguishes repeated text by surrounding context when line hints are missing', () => {
    assert.notEqual(
      createReviewAnchorIdentityKey(thread({
        lineStart: undefined,
        lineEnd: undefined,
        occurrence: undefined,
        contextBefore: 'First paragraph before repeated word',
        contextAfter: 'First paragraph after repeated word'
      })),
      createReviewAnchorIdentityKey(thread({
        lineStart: undefined,
        lineEnd: undefined,
        occurrence: undefined,
        contextBefore: 'Second paragraph before repeated word',
        contextAfter: 'Second paragraph after repeated word'
      }))
    );
  });
});

function thread(anchorOverrides: Partial<ReviewThread['anchor']>): ReviewThread {
  return {
    id: 'rv_same_word',
    documentUri: 'file:///doc.md',
    anchor: {
      text: 'repeated',
      ...anchorOverrides
    },
    type: 'note',
    source: 'human',
    status: 'open',
    severity: 'medium',
    comment: 'Comment',
    thread: [],
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z'
  };
}
