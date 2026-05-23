import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createContextBootstrapPrompt } from '../src/contextBootstrapPrompt';

describe('createContextBootstrapPrompt', () => {
  it('builds a generic agent bootstrap prompt that preserves review metadata during reviews and edits', () => {
    const prompt = createContextBootstrapPrompt({
      availableSources: ['docs/PRD.md', 'README.md'],
      currentDocumentPath: 'docs/specs/checkout.md',
      recommendedBriefPath: 'docs/AI-CONTEXT-BRIEF.md'
    });

    assert.match(prompt, /# AI Markdown Review Loop Bootstrap Prompt/);
    assert.match(prompt, /Use this message as your bootstrap instructions/);
    assert.match(prompt, /Continue with the requested review, reply, or edit task/i);
    assert.match(prompt, /1\. `docs\/PRD.md`/);
    assert.match(prompt, /2\. `README.md`/);
    assert.match(prompt, /3\. `docs\/specs\/checkout.md`/);
    assert.match(prompt, /initial Markdown review target is `docs\/specs\/checkout.md`/);
    assert.match(prompt, /ask me at most 3 specific questions/i);
    assert.match(prompt, /If `docs\/AI-CONTEXT-BRIEF.md` exists, treat it as durable context/i);
    assert.match(prompt, /# AI Context Brief/);
    assert.match(prompt, /use them as the review surface/i);
    assert.match(prompt, /\.ai-markdown-review\/documents\/\*\.json/);
    assert.match(prompt, /Inline `ai-review-anchors` and `ai-review-log` comments are metadata pointers/);
    assert.match(prompt, /Do not mark threads `accepted`, `resolved`, or `rejected`/);
    assert.match(prompt, /list any `rv_\*` threads you touched/);
    assert.doesNotMatch(prompt, /Detected Sources/);
    assert.doesNotMatch(prompt, /Prompt To Paste/);
    assert.doesNotMatch(prompt, /```md/);
  });
});
