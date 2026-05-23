import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createContextBootstrapPrompt } from '../src/contextBootstrapPrompt';

describe('createContextBootstrapPrompt', () => {
  it('builds a generic agent bootstrap prompt that preserves review metadata during reviews and edits', () => {
    const prompt = createContextBootstrapPrompt({
      currentDocumentPath: 'docs/specs/checkout.md',
      recommendedBriefPath: 'docs/AI-CONTEXT-BRIEF.md'
    });

    assert.match(prompt, /# AI Markdown Review Loop Bootstrap Prompt/);
    assert.match(prompt, /Use this message as your bootstrap instructions/);
    assert.match(prompt, /Continue with the requested review, reply, or edit task/i);
    assert.match(prompt, /Initial Markdown target: `docs\/specs\/checkout.md`/);
    assert.match(prompt, /Start with the current Markdown target/);
    assert.match(prompt, /README.md/);
    assert.match(prompt, /docs\/AI-REVIEW-POLICY.md/);
    assert.match(prompt, /docs\/AI-COLLABORATION-LOOP.md/);
    assert.match(prompt, /ask me at most 3 specific questions/i);
    assert.match(prompt, /Treat `docs\/AI-CONTEXT-BRIEF.md` as an optional durable context brief/i);
    assert.match(prompt, /# AI Context Brief/);
    assert.match(prompt, /use them as the review surface/i);
    assert.match(prompt, /colocated hidden `\.<filename>\.ai-review\.json` sidecar/);
    assert.match(prompt, /Legacy `\.ai-markdown-review\/documents\/\*\.json`/);
    assert.match(prompt, /Inline `ai-review-anchors` and `ai-review-log` comments are metadata pointers/);
    assert.match(prompt, /Do not mark threads `accepted`, `resolved`, or `rejected`/);
    assert.match(prompt, /list any `rv_\*` threads you touched/);
    assert.doesNotMatch(prompt, /Detected Sources/);
    assert.doesNotMatch(prompt, /Prompt To Paste/);
    assert.doesNotMatch(prompt, /Skip files that do not exist/);
    assert.doesNotMatch(prompt, /docs\/PRD.md/);
    assert.doesNotMatch(prompt, /\.agent\/PROJECT_STATE.md/);
    assert.doesNotMatch(prompt, /```md/);
  });

  it('does not turn context discovery into a detected-source checklist', () => {
    const prompt = createContextBootstrapPrompt({
      recommendedBriefPath: 'docs/AI-CONTEXT-BRIEF.md'
    });

    assert.match(prompt, /Ask me which Markdown file to review or edit/);
    assert.doesNotMatch(prompt, /Read these repo context sources first/);
    assert.doesNotMatch(prompt, /1\. `README.md`/);
    assert.doesNotMatch(prompt, /1\. `docs\/AI-CONTEXT-BRIEF.md`/);
    assert.doesNotMatch(prompt, /docs\/PRD.md/);
    assert.doesNotMatch(prompt, /\.agent\/PROJECT_STATE.md/);
  });
});
