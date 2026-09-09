import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReviewAwareEditToMarkdown,
  buildReviewAwareThreadUpdates,
  createLineInsertionEditPlan,
  createLineRangeDeletePlan,
  createLineRangeEditPlan,
  createOffsetEditPlan,
  lineNumberAtOffset
} from '../src/reviewAwareEdits';
import type { ReviewThread } from '../src/types';

const now = '2026-05-22T10:00:00.000Z';

describe('review-aware edits', () => {
  function repeatedAnchorUpdate(before: string, replacement: string, reviewThread: ReviewThread) {
    const plan = createLineRangeEditPlan(before, {
      lineStart: 1,
      lineEnd: before.split('\n').length,
      replacement,
      actor: 'user',
      intent: 'manual_block_edit'
    });
    return buildReviewAwareThreadUpdates(before, [reviewThread], plan, now)[0].update.anchor;
  }

  it('keeps a repeated phrase on its original line after a block edit', () => {
    const reviewThread = thread('rv_second', { anchorText: 'Pending', lineStart: 2 });
    reviewThread.anchor.occurrence = 1;
    const anchor = repeatedAnchorUpdate('First Pending task.\nSecond Pending task.',
      'First Pending task.\nSecond Pending task updated.', reviewThread);
    assert.equal(anchor?.lineStart, 2);
    assert.equal(anchor?.occurrence, 1);
    assert.equal(anchor?.confidence, 'exact');
    assert.equal(anchor?.contextBefore, 'First Pending task. Second');
  });

  it('preserves the selected occurrence when duplicates share one line', () => {
    const reviewThread = thread('rv_second', { anchorText: 'Pending', lineStart: 1 });
    reviewThread.anchor.occurrence = 1;
    const anchor = repeatedAnchorUpdate('First Pending and second Pending.',
      'First Pending and second Pending updated.', reviewThread);
    assert.equal(anchor?.occurrence, 1);
    assert.equal(anchor?.contextBefore, 'First Pending and second');
    assert.equal(anchor?.confidence, 'exact');
  });

  it('edits the second repeated phrase without borrowing the first surviving text', () => {
    const reviewThread = thread('rv_second', { anchorText: 'Pending', lineStart: 1 });
    reviewThread.anchor.occurrence = 1;
    const anchor = repeatedAnchorUpdate('First Pending and second Pending.',
      'First Pending and second Done.', reviewThread);
    assert.equal(anchor?.text, 'Done');
    assert.equal(anchor?.occurrence, 0);
    assert.equal(anchor?.confidence, 'exact');
  });

  it('tracks surviving duplicate phrases across a distinct earlier deletion', () => {
    const reviewThread = thread('rv_second', { anchorText: 'Pending', lineStart: 2 });
    reviewThread.anchor.occurrence = 1;
    const anchor = repeatedAnchorUpdate('First Pending task.\nSecond Pending task.',
      'Second Pending task.', reviewThread);
    assert.equal(anchor?.lineStart, 1);
    assert.equal(anchor?.occurrence, 0);
    assert.equal(anchor?.confidence, 'exact');
  });

  it('updates occurrence after a new matching phrase is inserted earlier', () => {
    const reviewThread = thread('rv_second', { anchorText: 'Pending', lineStart: 2 });
    reviewThread.anchor.occurrence = 1;
    const anchor = repeatedAnchorUpdate('First Pending task.\nSecond Pending task.',
      'New Pending task.\nFirst Pending task.\nSecond Pending task.', reviewThread);
    assert.equal(anchor?.lineStart, 3);
    assert.equal(anchor?.occurrence, 2);
    assert.equal(anchor?.confidence, 'exact');
  });

  it('leaves indistinguishable adjacent-duplicate deletion missing', () => {
    const reviewThread = thread('rv_second', { anchorText: 'Pending', lineStart: 2 });
    reviewThread.anchor.occurrence = 1;
    const anchor = repeatedAnchorUpdate('Pending\nPending', 'Pending', reviewThread);
    assert.equal(anchor?.confidence, 'missing');
  });

  it('uses corroborating context when a same-line occurrence was not recorded', () => {
    const reviewThread = thread('rv_second', { anchorText: 'Pending', lineStart: 1 });
    reviewThread.anchor.contextBefore = 'First Pending and second';
    reviewThread.anchor.contextAfter = '.';
    const anchor = repeatedAnchorUpdate('First Pending and second Pending.',
      'First Pending and second Pending updated.', reviewThread);
    assert.equal(anchor?.occurrence, 1);
    assert.equal(anchor?.confidence, 'exact');
  });

  it('prefers matching source context when an earlier duplicate made the occurrence stale', () => {
    const reviewThread = thread('rv_second', { anchorText: 'Pending', lineStart: 1 });
    reviewThread.anchor.occurrence = 0;
    reviewThread.anchor.contextBefore = 'and second';
    reviewThread.anchor.contextAfter = '.';
    const anchor = repeatedAnchorUpdate('First Pending and second Pending.',
      'First Pending and second Pending updated.', reviewThread);
    assert.equal(anchor?.occurrence, 1);
    assert.equal(anchor?.confidence, 'exact');
  });

  it('leaves repeated source text missing when neither occurrence nor context identifies it', () => {
    const reviewThread = thread('rv_unknown', { anchorText: 'Pending', lineStart: 1 });
    const anchor = repeatedAnchorUpdate('First Pending and second Pending.',
      'First Pending and second Pending updated.', reviewThread);
    assert.equal(anchor?.confidence, 'missing');
  });

  it('keeps unrelated same-line comments unchanged when applying a narrow suggestion', () => {
    const markdown = 'Old wording. Preserve rollback steps.';
    const plan = createOffsetEditPlan(markdown, {
      start: 0, end: 3, replacement: 'New', actor: 'user', intent: 'apply_suggestion',
      targetThreadId: 'rv_target', closeTargetAs: 'accepted'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_target', { anchorText: 'Old', lineStart: 1 }),
      thread('rv_other', { anchorText: 'rollback steps', lineStart: 1 })
    ], plan, now);
    assert.deepEqual(updates.map(update => update.threadId), ['rv_target']);
  });

  it('creates a line range edit plan and replaces only the selected lines', () => {
    const markdown = ['Intro', 'Old paragraph', 'Outro'].join('\n');
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 2,
      replacement: 'New paragraph',
      actor: 'user',
      intent: 'manual_block_edit'
    });

    assert.equal(plan.start, 6);
    assert.equal(plan.end, 19);
    assert.equal(applyReviewAwareEditToMarkdown(markdown, plan), 'Intro\nNew paragraph\nOutro');
  });

  it('refreshes overlapping thread anchors and records edit outcomes', () => {
    const markdown = ['Intro context', 'Old paragraph', 'Outro context'].join('\n');
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 2,
      replacement: 'New paragraph',
      actor: 'user',
      intent: 'manual_block_edit'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_changed', {
        anchorText: 'Old paragraph',
        lineStart: 2
      }),
      thread('rv_unrelated', {
        anchorText: 'Outro context',
        lineStart: 3
      })
    ], plan, now);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].threadId, 'rv_changed');
    assert.equal(updates[0].update.anchor?.text, 'New paragraph');
    assert.equal(updates[0].update.anchor?.lineStart, 2);
    assert.equal(updates[0].update.anchor?.lineEnd, 2);
    assert.equal(updates[0].update.anchor?.confidence, 'exact');
    assert.equal(updates[0].update.anchor?.contextBefore, 'Intro context');
    assert.equal(updates[0].update.anchor?.contextAfter, 'Outro context');
    assert.match(updates[0].update.thread?.[0].text ?? '', /edited the reviewed text/);
  });

  it('keeps partial comment anchors narrow when an edited block still contains them', () => {
    const markdown = [
      'Intro context',
      'The owner must document rollback steps.',
      'Outro context'
    ].join('\n');
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 2,
      replacement: 'The owner must document rollback steps before launch.',
      actor: 'user',
      intent: 'manual_block_edit'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_partial', {
        anchorText: 'rollback steps',
        lineStart: 2
      })
    ], plan, now);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.anchor?.text, 'rollback steps');
    assert.equal(updates[0].update.anchor?.confidence, 'exact');
    assert.notEqual(
      updates[0].update.anchor?.text,
      'The owner must document rollback steps before launch.'
    );
  });

  it('updates a partial comment anchor to the edited word in the same context slot', () => {
    const markdown = [
      'Intro context',
      'The owner must document rollback steps.',
      'Outro context'
    ].join('\n');
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 2,
      replacement: 'The owner must document fallback steps.',
      actor: 'user',
      intent: 'manual_block_edit'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_partial', {
        anchorText: 'rollback',
        lineStart: 2
      })
    ], plan, now);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.anchor?.text, 'fallback');
    assert.equal(updates[0].update.anchor?.confidence, 'exact');
    assert.equal(updates[0].update.anchor?.lineStart, 2);
    assert.equal(updates[0].update.anchor?.lineEnd, 2);
    assert.notEqual(updates[0].update.anchor?.text, 'The owner must document fallback steps.');
  });

  it('updates a multi-word partial anchor to the edited phrase in the same context slot', () => {
    const markdown = [
      'Intro context',
      'The owner must document rollback steps.',
      'Outro context'
    ].join('\n');
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 2,
      replacement: 'The owner must document fallback steps.',
      actor: 'user',
      intent: 'manual_block_edit'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_partial', {
        anchorText: 'rollback steps',
        lineStart: 2
      })
    ], plan, now);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.anchor?.text, 'fallback steps');
    assert.equal(updates[0].update.anchor?.confidence, 'exact');
    assert.notEqual(updates[0].update.anchor?.text, 'The owner must document fallback steps.');
  });

  it('marks partial comment anchors missing when a rewrite has no reliable local slot', () => {
    const markdown = [
      'Intro context',
      'The owner must document rollback steps.',
      'Outro context'
    ].join('\n');
    const plan = createLineRangeEditPlan(markdown, {
      lineStart: 2,
      lineEnd: 2,
      replacement: 'A completely different release safety plan is required.',
      actor: 'user',
      intent: 'manual_block_edit'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_partial', {
        anchorText: 'rollback steps',
        lineStart: 2
      })
    ], plan, now);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.anchor?.text, 'rollback steps');
    assert.equal(updates[0].update.anchor?.confidence, 'missing');
  });

  it('marks the target suggested edit accepted while preserving its outcome reply', () => {
    const markdown = 'Old sentence';
    const plan = createOffsetEditPlan(markdown, {
      start: 0,
      end: markdown.length,
      replacement: 'New sentence',
      actor: 'user',
      intent: 'apply_suggestion',
      targetThreadId: 'rv_patch',
      closeTargetAs: 'accepted'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_patch', {
        anchorText: 'Old sentence',
        lineStart: 1
      })
    ], plan, now);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.status, 'accepted');
    assert.equal(updates[0].update.closedBy, 'user');
    assert.equal(updates[0].update.closedAt, now);
    assert.equal(updates[0].update.anchor?.text, 'New sentence');
    assert.match(updates[0].update.thread?.[0].text ?? '', /applied the suggested edit/);
  });

  it('keeps deleted overlapping feedback visible as a missing anchor instead of dropping it', () => {
    const markdown = ['Intro', 'Delete me', 'Outro'].join('\n');
    const plan = createLineRangeDeletePlan(markdown, {
      lineStart: 2,
      lineEnd: 2,
      actor: 'assistant',
      intent: 'delete_block'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_delete', {
        anchorText: 'Delete me',
        lineStart: 2
      })
    ], plan, now);

    assert.equal(updates[0].update.anchor?.text, 'Delete me');
    assert.equal(updates[0].update.anchor?.confidence, 'missing');
    assert.equal(updates[0].update.anchor?.contextBefore, undefined);
    assert.equal(updates[0].update.anchor?.contextAfter, undefined);
    assert.equal(updates[0].update.thread?.[0].role, 'assistant');
    assert.match(updates[0].update.thread?.[0].text ?? '', /deleted the reviewed block/);
  });

  it('deletes a middle line range without leaving a blank line', () => {
    const markdown = ['Intro', 'Delete me', 'Outro'].join('\n');
    const plan = createLineRangeDeletePlan(markdown, {
      lineStart: 2,
      lineEnd: 2,
      actor: 'user',
      intent: 'delete_block'
    });

    assert.equal(applyReviewAwareEditToMarkdown(markdown, plan), 'Intro\nOutro');
  });

  it('deletes the final line range without leaving a trailing newline', () => {
    const markdown = ['Intro', 'Delete me'].join('\n');
    const plan = createLineRangeDeletePlan(markdown, {
      lineStart: 2,
      lineEnd: 2,
      actor: 'user',
      intent: 'delete_block'
    });

    assert.equal(applyReviewAwareEditToMarkdown(markdown, plan), 'Intro');
  });

  it('deletes the first line range without leaving a leading newline', () => {
    const markdown = ['Delete me', 'Outro'].join('\r\n');
    const plan = createLineRangeDeletePlan(markdown, {
      lineStart: 1,
      lineEnd: 1,
      actor: 'user',
      intent: 'delete_block'
    });

    assert.equal(applyReviewAwareEditToMarkdown(markdown, plan), 'Outro');
  });

  it('inserts a Markdown block without marking existing threads affected', () => {
    const markdown = ['Intro', 'Outro'].join('\n');
    const plan = createLineInsertionEditPlan(markdown, {
      afterLine: 1,
      replacement: 'New paragraph',
      actor: 'user',
      intent: 'insert_block'
    });
    const updates = buildReviewAwareThreadUpdates(markdown, [
      thread('rv_outro', {
        anchorText: 'Outro',
        lineStart: 2
      })
    ], plan, now);

    assert.equal(applyReviewAwareEditToMarkdown(markdown, plan), 'Intro\n\nNew paragraph\n\nOutro');
    assert.equal(plan.lineStart, 3);
    assert.equal(plan.lineEnd, 3);
    assert.equal(plan.affectsExistingThreads, false);
    assert.equal(updates.length, 0);
  });

  it('inserts a multiline Markdown block and reports its inserted line range', () => {
    const markdown = ['Intro', 'Outro'].join('\n');
    const plan = createLineInsertionEditPlan(markdown, {
      afterLine: 1,
      replacement: 'First inserted\nSecond inserted',
      actor: 'user',
      intent: 'insert_block'
    });

    assert.equal(
      applyReviewAwareEditToMarkdown(markdown, plan),
      ['Intro', '', 'First inserted', 'Second inserted', '', 'Outro'].join('\n')
    );
    assert.equal(plan.lineStart, 3);
    assert.equal(plan.lineEnd, 4);
  });

  it('inserts a Markdown block at the end and into an empty document', () => {
    const endPlan = createLineInsertionEditPlan('Intro', {
      afterLine: 1,
      replacement: 'New ending',
      actor: 'user',
      intent: 'insert_block'
    });
    const emptyPlan = createLineInsertionEditPlan('', {
      afterLine: 1,
      replacement: 'First block',
      actor: 'user',
      intent: 'insert_block'
    });

    assert.equal(applyReviewAwareEditToMarkdown('Intro', endPlan), 'Intro\n\nNew ending');
    assert.equal(endPlan.lineStart, 3);
    assert.equal(endPlan.lineEnd, 3);
    assert.equal(applyReviewAwareEditToMarkdown('', emptyPlan), 'First block');
    assert.equal(emptyPlan.lineStart, 1);
    assert.equal(emptyPlan.lineEnd, 1);
  });

  it('reports one-based line numbers for LF and CRLF text', () => {
    assert.equal(lineNumberAtOffset('a\nb\nc', 3), 2);
    assert.equal(lineNumberAtOffset('a\r\nb\r\nc', 4), 2);
  });
});

function thread(
  id: string,
  input: {
    anchorText: string;
    lineStart: number;
  }
): ReviewThread {
  return {
    id,
    documentUri: 'file:///workspace/spec.md',
    anchor: {
      text: input.anchorText,
      lineStart: input.lineStart,
      lineEnd: input.lineStart,
      confidence: 'exact'
    },
    type: 'note',
    source: 'human',
    status: 'open',
    severity: 'medium',
    comment: 'Review this.',
    thread: [],
    createdAt: now,
    updatedAt: now
  };
}
