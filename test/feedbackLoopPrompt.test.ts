import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedbackLoopPrompt } from '../src/feedbackLoopPrompt';

describe('createFeedbackLoopPrompt', () => {
  it('builds a feedback-loop prompt with patch, reply, and resolve semantics', () => {
    const prompt = createFeedbackLoopPrompt({
      currentDocumentPath: 'docs/specs/checkout.md'
    });

    assert.match(prompt, /# AI Markdown Review Loop Feedback Loop Prompt/);
    assert.match(prompt, /Current Markdown target: `docs\/specs\/checkout.md`/);
    assert.match(prompt, /Review Threads as conversation state/);
    assert.match(prompt, /Apply Suggested Patch.*proposed Markdown change applied/);
    assert.match(prompt, /close the target thread as `accepted` only after the edit succeeds/);
    assert.match(prompt, /`Agree` means the human agrees with the feedback/);
    assert.match(prompt, /do not mutate the document or close the thread/);
    assert.match(prompt, /`Resolve` means the issue is handled/);
    assert.match(prompt, /`suggestion` or `fix` with a `suggestedPatch`/);
    assert.match(prompt, /List each touched `rv_\*` thread/);
    assert.doesNotMatch(prompt, /docs\/PRD.md/);
    assert.doesNotMatch(prompt, /\.agent\/PROJECT_STATE.md/);
  });
});
