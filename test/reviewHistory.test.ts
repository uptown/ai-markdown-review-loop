import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRestoredReviewThread,
  getReviewHistoryAnchorLocations,
  getReviewHistoryAnchorStates
} from '../src/reviewHistory';
import type { ReviewThread } from '../src/types';

const now = '2026-05-22T15:00:00.000Z';

describe('review history', () => {
  it('keeps a multiline completed edit linked across LF and CRLF source', () => {
    for (const eol of ['\n', '\r\n']) {
      const states = getReviewHistoryAnchorStates(`First revised sentence.${eol}Second revised sentence.`, [
        thread('rv_multiline', 'First revised sentence. Second revised sentence.', { lineStart: 1, lineEnd: 2 })
      ]);
      assert.equal(states.rv_multiline, 'linked');
    }
  });

  it('does not relink an explicitly missing history anchor onto an identical surviving snippet', () => {
    assert.equal(getReviewHistoryAnchorStates('First\nSecond', [
      thread('rv_deleted', 'First Second', { confidence: 'missing', lineStart: 1, lineEnd: 2 })
    ]).rv_deleted, 'outdated');
  });

  it('uses offset context to locate a moved multiline history anchor', () => {
    assert.equal(getReviewHistoryAnchorStates('New intro\nBefore\nFirst\nSecond\nAfter', [
      thread('rv_moved', 'First Second', {
        lineStart: 2, lineEnd: 3, occurrence: 0, contextBefore: 'Before', contextAfter: 'After'
      })
    ]).rv_moved, 'linked');
    const location = getReviewHistoryAnchorLocations('New intro\nBefore\nFirst\nSecond\nAfter', [
      thread('rv_moved', 'First Second', {
        lineStart: 2, lineEnd: 3, occurrence: 0, contextBefore: 'Before', contextAfter: 'After'
      })
    ]).rv_moved;
    assert.deepEqual(location, { start: 17, length: 12, lineStart: 3, lineEnd: 4 });
  });

  it('keeps an uncorroborated removed multiline occurrence outdated', () => {
    assert.equal(getReviewHistoryAnchorStates('Intro\nFirst\nSecond', [
      thread('rv_removed', 'First Second', { lineStart: 1, lineEnd: 2, occurrence: 0 })
    ]).rv_removed, 'outdated');
  });

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
