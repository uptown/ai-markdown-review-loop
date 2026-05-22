import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMermaidFenceReplacement } from '../src/mermaidEdits';
import {
  applyReviewAwareEditToMarkdown,
  buildReviewAwareThreadUpdates,
  createLineRangeEditPlan
} from '../src/reviewAwareEdits';
import type { ReviewThread } from '../src/types';

const now = '2026-05-23T00:30:00.000Z';

describe('Mermaid edits', () => {
  it('normalizes edited Mermaid source into a fenced Mermaid block', () => {
    assert.equal(
      createMermaidFenceReplacement('flowchart TD\r\n  A --> B\n'),
      ['```mermaid', 'flowchart TD', '  A --> B', '```'].join('\n')
    );
  });

  it('unwraps a pasted Mermaid fence before rebuilding the fenced block', () => {
    assert.equal(
      createMermaidFenceReplacement('```mermaid\nflowchart LR\n  A --> B\n```'),
      ['```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n')
    );
  });

  it('replaces only the Mermaid fenced block and keeps following Markdown', () => {
    const markdown = [
      'Before',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      'After'
    ].join('\n');
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 5,
      replacement: createMermaidFenceReplacement('flowchart LR\n  A --> B'),
      actor: 'user',
      intent: 'manual_mermaid_edit'
    });

    assert.equal(
      applyReviewAwareEditToMarkdown(markdown, plan),
      [
        'Before',
        '```mermaid',
        'flowchart LR',
        '  A --> B',
        '```',
        'After'
      ].join('\n')
    );
  });

  it('records Mermaid-specific edit outcomes for overlapping comments', () => {
    const markdown = [
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```'
    ].join('\n');
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 1,
      lineEnd: 4,
      replacement: createMermaidFenceReplacement('flowchart TD\n  A --> C'),
      actor: 'user',
      intent: 'manual_mermaid_edit'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_mermaid', 'flowchart TD\n  A --> B')
    ], plan, now);

    assert.equal(updates.length, 1);
    assert.match(updates[0].update.thread?.[0].text ?? '', /edited the Mermaid source/);
  });
});

function thread(id: string, anchorText: string): ReviewThread {
  return {
    id,
    documentUri: 'file:///workspace/spec.md',
    anchor: {
      text: anchorText,
      lineStart: 1,
      lineEnd: 4,
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
