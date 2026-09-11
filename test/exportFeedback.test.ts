import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFeedbackExport } from '../src/exportFeedback';
import { REVIEW_TASK_GUIDANCE, type ReviewTaskSidecar } from '../src/reviewTaskProtocol';

function review(): ReviewTaskSidecar {
  return {
    schemaVersion: 3,
    document: 'spec.md',
    guidance: REVIEW_TASK_GUIDANCE,
    items: [
      {
        id: 'rv_retry', rev: 2,
        target: { quote: 'Retry requests.', line: 3, occurrence: 1, contextBefore: 'Network', state: 'ambiguous' },
        comment: 'Define the retry limit.', status: 'pending',
        result: 'Previously added a retry limit.', resultFor: 1
      },
      {
        id: 'rv_owner', rev: 1, target: { quote: 'An owner approves the launch.' },
        comment: 'Name the approving owner.', status: 'blocked',
        result: 'Which team owns approval?', resultFor: 1
      },
      {
        id: 'rv_error', rev: 1, target: { quote: 'Notify the user.' },
        comment: 'Describe the failure message.', status: 'done',
        result: 'Added the failure reason and retry action.', resultFor: 1
      }
    ]
  };
}

describe('v3 task JSON export', () => {
  it('round-trips targets, revision-bound results and all active statuses without a transcript', () => {
    const input = review();
    const snapshot = structuredClone(input);
    const output = renderFeedbackExport(input);
    assert.deepEqual(JSON.parse(output), snapshot);
    assert.deepEqual(input, snapshot);
    assert.equal(output.endsWith('\n'), true);
    assert.ok(output.length < 2500, 'A three-item export should remain a compact task file.');
    assert.doesNotMatch(output, /file:\/\/|openThreads|closedThreads|sidecarReply|propose_edit_plan|generatedAt/);
  });

  it('rejects invalid input instead of silently stripping richer or conflicting records', () => {
    const duplicate = review();
    duplicate.items.push(structuredClone(duplicate.items[0]));
    assert.throws(() => renderFeedbackExport(duplicate), /Duplicate/);
    const extra = { ...review(), openThreads: [] };
    assert.throws(() => renderFeedbackExport(extra), /unsupported field/);
    const incomplete = review();
    delete incomplete.items[1].resultFor;
    assert.throws(() => renderFeedbackExport(incomplete), /result and resultFor together/);
  });
});
