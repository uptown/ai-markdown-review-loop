import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getReplyShortcutDescriptors } from '../src/replyShortcuts';
import type { ReviewThread } from '../src/types';

describe('reply shortcuts', () => {
  it('hides AI-response shortcuts on human-only threads', () => {
    assert.deepEqual(
      getReplyShortcutDescriptors(thread({ source: 'human', type: 'suggestion' })),
      []
    );
  });

  it('shows discussion shortcuts for AI-authored suggestions', () => {
    assert.deepEqual(
      labels(getReplyShortcutDescriptors(thread({ source: 'ai', type: 'suggestion' }))),
      ['Agree', 'Revise', 'Disagree']
    );
  });

  it('shows patch-specific revision copy for AI patches', () => {
    assert.deepEqual(
      labels(getReplyShortcutDescriptors(thread({
        source: 'ai',
        type: 'suggestion',
        suggestedPatch: { mode: 'replace', original: 'old', replacement: 'new' }
      }))),
      ['Agree', 'Revise Patch', 'Disagree']
    );
  });

  it('shows response shortcuts after an assistant joins a human-created thread', () => {
    assert.deepEqual(
      labels(getReplyShortcutDescriptors(thread({
        source: 'human',
        type: 'question',
        thread: [{ role: 'assistant', text: 'Can you clarify the target reader?', createdAt: now }]
      }))),
      ['Answer', 'Clarify', 'Not Applicable']
    );
  });

  it('keeps automated local review feedback actionable', () => {
    assert.deepEqual(
      labels(getReplyShortcutDescriptors(thread({ source: 'local', type: 'risk' }))),
      ['Acknowledge', 'Mitigate', 'Challenge']
    );
  });
});

const now = '2026-05-25T00:00:00.000Z';

function labels(shortcuts: ReturnType<typeof getReplyShortcutDescriptors>): string[] {
  return shortcuts.map(shortcut => shortcut.label);
}

function thread(overrides: Partial<ReviewThread>): ReviewThread {
  return {
    id: 'rv_shortcut',
    documentUri: 'file:///doc.md',
    anchor: { text: 'target' },
    type: 'note',
    source: 'human',
    status: 'open',
    severity: 'medium',
    comment: 'comment',
    thread: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}
