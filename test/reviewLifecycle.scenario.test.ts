import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFeedbackExport } from '../src/exportFeedback';
import { REVIEW_TASK_GUIDANCE } from '../src/reviewTaskProtocol';
import {
  applyReviewAwareEditToMarkdown,
  buildReviewAwareThreadUpdates,
  createOffsetEditPlan
} from '../src/reviewAwareEdits';
import { selectSuggestedPatchReplacement } from '../src/suggestedPatches';
import type { ReviewThread } from '../src/types';

describe('legacy source-edit regression and v3 handoff', () => {
  it('applies a reliable suggested edit without adding inline review metadata', () => {
    const markdown = [
      'Requirement old',
      '',
      'Follow up text'
    ].join('\n');

    const patchThread = thread('rv_patch', {
      anchorText: 'Requirement old',
      lineStart: 1,
      comment: 'Make the requirement testable.',
      suggestedPatch: {
        mode: 'replace',
        original: 'Requirement old',
        replacement: 'Requirement new'
      }
    });
    const followupThread = thread('rv_followup', {
      anchorText: 'Follow up text',
      lineStart: 3,
      comment: 'Clarify the follow-up action.'
    });

    const patchSelection = selectSuggestedPatchReplacement(
      markdown,
      patchThread.suggestedPatch,
      patchThread.anchor
    );
    assert.equal(patchSelection.result, 'applied');
    const editPlan = patchSelection.result === 'applied'
      ? createOffsetEditPlan(markdown, {
        start: patchSelection.start,
        end: patchSelection.end,
        replacement: patchSelection.replacement,
        actor: 'user',
        intent: 'apply_suggestion',
        targetThreadId: patchThread.id,
        closeTargetAs: 'accepted'
      })
      : undefined;

    assert.ok(editPlan);
    const nextMarkdown = applyReviewAwareEditToMarkdown(markdown, editPlan);
    const threadUpdates = buildReviewAwareThreadUpdates(
      markdown,
      [patchThread, followupThread],
      editPlan,
      '2026-05-22T00:10:00.000Z'
    );

    assert.match(nextMarkdown, /^Requirement new/);
    assert.doesNotMatch(nextMarkdown, /ai-review-/);
    assert.equal(threadUpdates.length, 1);
    assert.equal(threadUpdates[0].threadId, 'rv_patch');
    assert.equal(threadUpdates[0].update.status, 'accepted');
    assert.equal(threadUpdates[0].update.closedBy, 'user');
    assert.equal(threadUpdates[0].update.anchor?.text, 'Requirement new');
    assert.match(threadUpdates[0].update.thread?.[0].text ?? '', /applied the suggested edit/);

    const exportText = renderFeedbackExport({
      schemaVersion: 3,
      document: 'spec.md',
      guidance: REVIEW_TASK_GUIDANCE,
      items: [{
        id: followupThread.id, rev: 1,
        target: { quote: followupThread.anchor.text, line: followupThread.anchor.lineStart },
        comment: followupThread.comment, status: 'pending'
      }]
    });

    const handoff = JSON.parse(exportText);
    assert.equal(handoff.schemaVersion, 3);
    assert.equal(handoff.items.length, 1);
    assert.equal(handoff.items[0].id, 'rv_followup');
    assert.equal(handoff.items[0].status, 'pending');
    assert.doesNotMatch(exportText, /rv_patch/);
    assert.doesNotMatch(exportText, /rv_stale/);
  });
});

function thread(
  id: string,
  input: {
    anchorText: string;
    lineStart: number;
    comment: string;
    suggestedPatch?: ReviewThread['suggestedPatch'];
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
    type: input.suggestedPatch ? 'suggestion' : 'note',
    source: input.suggestedPatch ? 'ai' : 'human',
    status: 'open',
    severity: 'medium',
    comment: input.comment,
    suggestedPatch: input.suggestedPatch,
    thread: [],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z'
  };
}
