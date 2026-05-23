import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createContextBootstrapPrompt } from '../src/contextBootstrapPrompt';

describe('createContextBootstrapPrompt', () => {
  it('builds a repo-aware bootstrap prompt that drafts the durable brief before review', () => {
    const prompt = createContextBootstrapPrompt({
      availableSources: ['docs/PRD.md', 'README.md'],
      currentDocumentPath: 'docs/specs/checkout.md',
      recommendedBriefPath: 'docs/AI-CONTEXT-BRIEF.md'
    });

    assert.match(prompt, /# AI Context Bootstrap Prompt/);
    assert.match(prompt, /Do not start the actual review yet\./);
    assert.match(prompt, /1\. `docs\/PRD.md`/);
    assert.match(prompt, /2\. `README.md`/);
    assert.match(prompt, /3\. `docs\/specs\/checkout.md`/);
    assert.match(prompt, /ask me at most 3 specific questions/i);
    assert.match(prompt, /draft or refresh `docs\/AI-CONTEXT-BRIEF.md`/i);
    assert.match(prompt, /# AI Context Brief/);
    assert.match(prompt, /Then run the first AI review pass with that brief available to read first\./);
  });
});
