import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRestoredReviewThread,
  getReviewHistoryAnchorStates
} from '../src/reviewHistory';
import type { ReviewThread } from '../src/types';

const now = '2026-05-22T15:00:00.000Z';

describe('review history', () => {
  it('marks closed history anchors linked only when the anchor text still exists', () => {
    const states = getReviewHistoryAnchorStates(
      ['Current text', 'Still here'].join('\n'),
      [
        thread('rv_linked', 'Still here'),
        thread('rv_outdated', 'Removed text')
      ]
    );

    assert.deepEqual(states, {
      rv_linked: 'linked',
      rv_outdated: 'outdated'
    });
  });

  it('restores closed threads to open feedback with an audit reply', () => {
    const restored = createRestoredReviewThread(thread('rv_done', 'Decision'), now);

    assert.equal(restored.status, 'open');
    assert.equal(restored.closedBy, undefined);
    assert.equal(restored.closedAt, undefined);
    assert.equal(restored.updatedAt, now);
    assert.equal(restored.thread.length, 2);
    assert.equal(restored.thread[1].role, 'user');
    assert.match(restored.thread[1].text, /restored this closed thread/);
  });

  it('marks repeated history anchors outdated when no line, occurrence, or context disambiguates them', () => {
    const states = getReviewHistoryAnchorStates(
      [
        'Alpha repeated phrase',
        'Spacer',
        'Omega repeated phrase'
      ].join('\n'),
      [
        thread('rv_ambiguous', 'repeated phrase', {
          lineStart: undefined,
          lineEnd: undefined,
          occurrence: undefined,
          contextBefore: undefined,
          contextAfter: undefined
        })
      ]
    );

    assert.deepEqual(states, {
      rv_ambiguous: 'outdated'
    });
  });

  it('keeps repeated history anchors linked when the stored line still matches', () => {
    const states = getReviewHistoryAnchorStates(
      [
        'Alpha repeated phrase',
        'Spacer',
        'Omega repeated phrase'
      ].join('\n'),
      [
        thread('rv_linked_line', 'repeated phrase', {
          lineStart: 3,
          lineEnd: 3
        })
      ]
    );

    assert.deepEqual(states, {
      rv_linked_line: 'linked'
    });
  });

  it('does not relink a closed first occurrence after only a later duplicate survives', () => {
    const states = getReviewHistoryAnchorStates(
      [
        'Spacer',
        'Omega repeated phrase'
      ].join('\n'),
      [
        thread('rv_deleted_first_occurrence', 'repeated phrase', {
          lineStart: 1,
          lineEnd: 1,
          occurrence: 0,
          contextBefore: undefined,
          contextAfter: undefined
        })
      ]
    );

    assert.deepEqual(states, {
      rv_deleted_first_occurrence: 'outdated'
    });
  });
});

function thread(
  id: string,
  anchorText: string,
  anchorOverrides: Partial<ReviewThread['anchor']> = {}
): ReviewThread {
  return {
    id,
    documentUri: 'file:///workspace/spec.md',
    anchor: {
      text: anchorText,
      lineStart: 1,
      lineEnd: 1,
      confidence: 'exact',
      ...anchorOverrides
    },
    type: 'note',
    source: 'human',
    status: 'resolved',
    closedBy: 'user',
    closedAt: '2026-05-22T14:00:00.000Z',
    severity: 'medium',
    comment: 'Review this.',
    thread: [
      {
        role: 'user',
        text: 'Prior decision.',
        createdAt: '2026-05-22T14:00:00.000Z'
      }
    ],
    createdAt: '2026-05-22T13:00:00.000Z',
    updatedAt: '2026-05-22T14:00:00.000Z'
  };
}
