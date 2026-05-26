import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectMermaidSourceBlocks,
  matchMermaidReviewThreadsToBlocks
} from '../src/mermaidAnchors';
import type { ReviewThread } from '../src/types';

const now = '2026-05-26T00:00:00.000Z';

describe('Mermaid review anchors', () => {
  it('does not attach a shared Mermaid snippet to another figure without line overlap', () => {
    const blocks = [
      {
        source: 'flowchart TD\n  A --> B\n  B --> C',
        lineStart: 1,
        lineEnd: 4
      },
      {
        source: 'flowchart TD\n  A --> B\n  B --> D',
        lineStart: 6,
        lineEnd: 9
      }
    ];
    const matches = matchMermaidReviewThreadsToBlocks(blocks, [
      thread('rv_first_diagram', 'A --> B', { lineStart: 2, lineEnd: 2 })
    ]);

    assert.deepEqual(matches, [
      [{ threadId: 'rv_first_diagram', state: 'approximate' }],
      []
    ]);
  });

  it('marks only a full-fence Mermaid source match as exact', () => {
    const source = 'flowchart TD\n  A --> B';
    const matches = matchMermaidReviewThreadsToBlocks([
      { source, lineStart: 1, lineEnd: 3 }
    ], [
      thread('rv_full_diagram', source, { lineStart: 1, lineEnd: 3 })
    ]);

    assert.deepEqual(matches, [
      [{ threadId: 'rv_full_diagram', state: 'exact' }]
    ]);
  });

  it('collects fenced Mermaid source blocks with source line ranges', () => {
    const blocks = collectMermaidSourceBlocks([
      '# Spec',
      '',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '',
      'After'
    ].join('\n'));

    assert.deepEqual(blocks, [{
      source: 'flowchart TD\n  A --> B',
      lineStart: 3,
      lineEnd: 6
    }]);
  });
});

function thread(
  id: string,
  anchorText: string,
  anchor: Pick<ReviewThread['anchor'], 'lineStart' | 'lineEnd'>
): ReviewThread {
  return {
    id,
    documentUri: 'file:///workspace/spec.md',
    anchor: {
      text: anchorText,
      lineStart: anchor.lineStart,
      lineEnd: anchor.lineEnd,
      confidence: 'exact'
    },
    type: 'note',
    source: 'human',
    status: 'open',
    severity: 'medium',
    comment: 'Review this diagram.',
    thread: [],
    createdAt: now,
    updatedAt: now
  };
}
