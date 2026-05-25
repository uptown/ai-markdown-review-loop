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
    assert.match(prompt, /Recover the current review session brief/);
    assert.match(prompt, /review goal, focus areas, non-goals, constraints/);
    assert.match(prompt, /Review Threads as conversation state/);
    assert.match(prompt, /Do not validate, strip, or rewrite existing sidecar `openThreads` or `closedThreads`/);
    assert.match(prompt, /schema is only for proposed new AI-authored open feedback/);
    assert.match(prompt, /extension-owned persistence/);
    assert.match(prompt, /preserve full sidecar thread objects and all anchor fields/);
    assert.match(prompt, /`hash`, `confidence`, `lastLocatedLine`, `lastLocatedAt`, `contextBefore`, and `contextAfter`/);
    assert.match(prompt, /Apply Patch and Close.*proposed Markdown change applied/);
    assert.match(prompt, /accept this suggestion/);
    assert.match(prompt, /close the target thread as `accepted` only after the edit succeeds/);
    assert.match(prompt, /`Agree` means the human agrees with the feedback/);
    assert.match(prompt, /do not mutate the document or close the thread/);
    assert.match(prompt, /`Resolve` means the issue is handled/);
    assert.match(prompt, /`Close as Declined` means the human judged the feedback wrong/);
    assert.match(prompt, /Suggested patch revision:/);
    assert.match(prompt, /fenced `diff` block/);
    assert.match(prompt, /human changes the review goal, priority, or comment style/);
    assert.match(prompt, /`suggestion` or `fix` with a `suggestedPatch`/);
    assert.match(prompt, /Mermaid, table, or source-scoped suggestions/);
    assert.match(prompt, /List each touched `rv_\*` thread/);
    assert.match(prompt, /Restate the review session brief if it changed/);
    assert.match(prompt, /replied - waiting for human decision/);
    assert.doesNotMatch(prompt, /docs\/PRD.md/);
    assert.doesNotMatch(prompt, /\.agent\/PROJECT_STATE.md/);
  });

  it('can target one existing review thread for continuation', () => {
    const prompt = createFeedbackLoopPrompt({
      currentDocumentPath: 'docs/specs/checkout.md',
      focusThreadId: 'rv_focus_123'
    });

    assert.match(prompt, /Current review thread focus: `rv_focus_123`/);
    assert.match(prompt, /Continue this exact thread first/);
    assert.match(prompt, /Do not open a duplicate for the same issue/);
  });
});
