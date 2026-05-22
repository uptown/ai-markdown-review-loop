import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectMarkdownTables,
  createMarkdownTableReplacement
} from '../src/tableEdits';
import {
  applyReviewAwareEditToMarkdown,
  buildReviewAwareThreadUpdates,
  createLineRangeEditPlan
} from '../src/reviewAwareEdits';
import type { ReviewThread } from '../src/types';

const now = '2026-05-23T01:00:00.000Z';

describe('Markdown table edits', () => {
  it('collects source-mapped Markdown tables with alignment metadata', () => {
    const markdown = [
      '# Spec',
      '',
      '| Field | Owner | Status |',
      '| :--- | :---: | ---: |',
      '| Scope | AI | Open |',
      '| Risk | User | Closed |',
      '',
      'After'
    ].join('\n');

    assert.deepEqual(collectMarkdownTables(markdown), [{
      lineStart: 3,
      lineEnd: 6,
      headers: ['Field', 'Owner', 'Status'],
      alignments: ['left', 'center', 'right'],
      rows: [
        ['Scope', 'AI', 'Open'],
        ['Risk', 'User', 'Closed']
      ]
    }]);
  });

  it('serializes edited table data back to padded Markdown pipe table syntax', () => {
    assert.equal(
      createMarkdownTableReplacement({
        headers: ['Feature', 'Notes'],
        alignments: ['left', 'none'],
        rows: [
          ['Tables', 'Cells with | pipes'],
          ['Mermaid', 'Editable']
        ]
      }),
      [
        '| Feature | Notes               |',
        '| :---    | ---                 |',
        '| Tables  | Cells with \\| pipes |',
        '| Mermaid | Editable            |'
      ].join('\n')
    );
  });

  it('routes table replacements through review-aware line edits', () => {
    const markdown = [
      'Before',
      '| Feature | Status |',
      '| --- | --- |',
      '| Tables | Gap |',
      'After'
    ].join('\n');
    const replacement = createMarkdownTableReplacement({
      headers: ['Feature', 'Status'],
      alignments: ['none', 'none'],
      rows: [['Tables', 'Editable']]
    });
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 4,
      replacement,
      actor: 'user',
      intent: 'manual_table_edit'
    });
    const nextMarkdown = applyReviewAwareEditToMarkdown(markdown, plan);
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_table', 'Tables | Gap')
    ], plan, now);

    assert.match(nextMarkdown, /Editable/);
    assert.equal(nextMarkdown.split('\n').at(-1), 'After');
    assert.equal(updates.length, 1);
    assert.match(updates[0].update.thread?.[0].text ?? '', /edited the table/);
  });
});

function thread(id: string, anchorText: string): ReviewThread {
  return {
    id,
    documentUri: 'file:///workspace/spec.md',
    anchor: {
      text: anchorText,
      lineStart: 2,
      lineEnd: 4,
      confidence: 'exact'
    },
    type: 'note',
    source: 'human',
    status: 'open',
    severity: 'medium',
    comment: 'Review this table.',
    thread: [],
    createdAt: now,
    updatedAt: now
  };
}
