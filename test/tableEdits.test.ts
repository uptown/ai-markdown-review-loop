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

  it('keeps a table cell comment attached to the edited cell value', () => {
    const markdown = [
      'Before',
      '| Feature | Status |',
      '| --- | --- |',
      '| Tables | Gap |',
      '| Mermaid | Open |',
      'After'
    ].join('\n');
    const replacement = createMarkdownTableReplacement({
      headers: ['Feature', 'Status'],
      alignments: ['none', 'none'],
      rows: [
        ['Tables', 'Fixed'],
        ['Mermaid', 'Open']
      ]
    });
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 5,
      replacement,
      actor: 'user',
      intent: 'manual_table_edit'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_table_cell', 'Gap', 4)
    ], plan, now);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.anchor?.text, 'Fixed');
    assert.equal(updates[0].update.anchor?.lineStart, 4);
    assert.equal(updates[0].update.anchor?.lineEnd, 4);
    assert.equal(updates[0].update.anchor?.confidence, 'exact');
  });

  it('uses the original table line to disambiguate repeated cell comments', () => {
    const markdown = [
      'Before',
      '| Feature | Status |',
      '| --- | --- |',
      '| Tables | Pending |',
      '| Mermaid | Pending |',
      'After'
    ].join('\n');
    const replacement = createMarkdownTableReplacement({
      headers: ['Feature', 'Status'],
      alignments: ['none', 'none'],
      rows: [
        ['Tables', 'Fixed'],
        ['Mermaid', 'Open']
      ]
    });
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 5,
      replacement,
      actor: 'user',
      intent: 'manual_table_edit'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_second_row', 'Pending', 5)
    ], plan, now);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.anchor?.text, 'Open');
    assert.equal(updates[0].update.anchor?.lineStart, 5);
    assert.equal(updates[0].update.anchor?.lineEnd, 5);
    assert.equal(updates[0].update.anchor?.confidence, 'exact');
  });

  it('keeps a partial cell comment on its original row when another row is an exact match', () => {
    const markdown = [
      'Before',
      '| Feature | Status |',
      '| --- | --- |',
      '| Tables | Pending review |',
      '| Mermaid | Pending |',
      'After'
    ].join('\n');
    const replacement = createMarkdownTableReplacement({
      headers: ['Feature', 'Status'],
      alignments: ['none', 'none'],
      rows: [
        ['Tables', 'Fixed review'],
        ['Mermaid', 'Open']
      ]
    });
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 5,
      replacement,
      actor: 'user',
      intent: 'manual_table_edit'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_partial_cell', 'Pending', 4)
    ], plan, now);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.anchor?.text, 'Fixed');
    assert.equal(updates[0].update.anchor?.lineStart, 4);
    assert.equal(updates[0].update.anchor?.lineEnd, 4);
    assert.equal(updates[0].update.anchor?.confidence, 'exact');
  });
});

function thread(id: string, anchorText: string, lineStart = 2, lineEnd = 4): ReviewThread {
  return {
    id,
    documentUri: 'file:///workspace/spec.md',
    anchor: {
      text: anchorText,
      lineStart,
      lineEnd,
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
