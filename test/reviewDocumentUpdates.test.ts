import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyReviewThreadUpdatesToDocuments } from '../src/reviewDocumentUpdates';
import type { ReviewDocument, ReviewThread } from '../src/types';

const now = '2026-05-23T00:00:00.000Z';

describe('review document updates', () => {
  it('moves closed thread updates to resolved review data for undoable review transactions', () => {
    const reviewDocument = documentWithThreads([
      thread('rv_patch', 'open'),
      thread('rv_keep', 'open')
    ]);
    const resolvedReviewDocument = documentWithThreads([
      thread('rv_old', 'resolved')
    ]);
    const result = applyReviewThreadUpdatesToDocuments(
      reviewDocument,
      resolvedReviewDocument,
      [{
        threadId: 'rv_patch',
        update: {
          status: 'accepted',
          anchor: {
            text: 'new text',
            lineStart: 1,
            lineEnd: 1,
            confidence: 'exact'
          },
          thread: [
            {
              role: 'user',
              text: 'Review update: applied the suggested edit and kept this thread attached.',
              createdAt: now
            }
          ]
        }
      }],
      now
    );

    assert.deepEqual(result.reviewDocument.threads.map(item => item.id), ['rv_keep']);
    assert.deepEqual(result.resolvedReviewDocument.threads.map(item => item.id), ['rv_old', 'rv_patch']);
    assert.deepEqual(result.closedThreads, [{ threadId: 'rv_patch', status: 'accepted' }]);
    assert.equal(result.resolvedReviewDocument.threads[1].anchor.text, 'new text');
    assert.equal(result.resolvedReviewDocument.threads[1].updatedAt, now);
  });

  it('keeps open thread updates in active review data', () => {
    const result = applyReviewThreadUpdatesToDocuments(
      documentWithThreads([thread('rv_keep', 'open')]),
      documentWithThreads([]),
      [{
        threadId: 'rv_keep',
        update: {
          anchor: {
            text: 'updated text',
            lineStart: 2,
            lineEnd: 2,
            confidence: 'exact'
          }
        }
      }],
      now
    );

    assert.equal(result.reviewDocument.threads.length, 1);
    assert.equal(result.reviewDocument.threads[0].anchor.text, 'updated text');
    assert.equal(result.resolvedReviewDocument.threads.length, 0);
    assert.deepEqual(result.closedThreads, []);
  });
});

function documentWithThreads(threads: ReviewThread[]): ReviewDocument {
  return {
    documentUri: 'file:///workspace/spec.md',
    threads,
    updatedAt: '2026-05-22T00:00:00.000Z'
  };
}

function thread(id: string, status: ReviewThread['status']): ReviewThread {
  return {
    id,
    documentUri: 'file:///workspace/spec.md',
    anchor: {
      text: id,
      lineStart: 1,
      lineEnd: 1,
      confidence: 'exact'
    },
    type: 'note',
    source: 'human',
    status,
    severity: 'medium',
    comment: id,
    thread: [],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z'
  };
}
