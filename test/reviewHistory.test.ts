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
    assert.equal(restored.updatedAt, now);
    assert.equal(restored.thread.length, 2);
    assert.equal(restored.thread[1].role, 'user');
    assert.match(restored.thread[1].text, /restored this closed thread/);
  });
});

function thread(id: string, anchorText: string): ReviewThread {
  return {
    id,
    documentUri: 'file:///workspace/spec.md',
    anchor: {
      text: anchorText,
      lineStart: 1,
      lineEnd: 1,
      confidence: 'exact'
    },
    type: 'note',
    source: 'human',
    status: 'resolved',
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
