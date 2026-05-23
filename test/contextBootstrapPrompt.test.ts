import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createContextBootstrapPrompt } from '../src/contextBootstrapPrompt';

describe('createContextBootstrapPrompt', () => {
  it('builds a concise generic agent prompt that preserves review state during reviews and edits', () => {
    const prompt = createContextBootstrapPrompt({
      currentDocumentPath: 'docs/specs/checkout.md',
      recommendedBriefPath: 'docs/AI-CONTEXT-BRIEF.md'
    });

    assert.match(prompt, /# AI Markdown Review Loop Agent Prompt/);
    assert.match(prompt, /review or edit Markdown/i);
    assert.match(prompt, /Initial Markdown target: `docs\/specs\/checkout.md`/);
    assert.match(prompt, /Read the current Markdown target first/);
    assert.match(prompt, /README.md/);
    assert.match(prompt, /docs\/AI-REVIEW-POLICY.md/);
    assert.match(prompt, /docs\/AI-COLLABORATION-LOOP.md/);
    assert.match(prompt, /ask at most 3 specific questions/i);
    assert.match(prompt, /Treat review threads as conversation state/);
    assert.match(prompt, /switch to the AI Feedback Loop Prompt/);
    assert.match(prompt, /Apply a suggested Markdown change only when the human explicitly asks/i);
    assert.match(prompt, /hidden `\.<filename>\.ai-review\.json` sidecars/);
    assert.match(prompt, /inline `ai-review-\*` metadata comments/);
    assert.match(prompt, /List every touched `rv_\*` id/);
    assert.doesNotMatch(prompt, /Detected Sources/);
    assert.doesNotMatch(prompt, /Prompt To Paste/);
    assert.doesNotMatch(prompt, /Skip files that do not exist/);
    assert.doesNotMatch(prompt, /docs\/PRD.md/);
    assert.doesNotMatch(prompt, /\.agent\/PROJECT_STATE.md/);
    assert.doesNotMatch(prompt, /openThreads/);
    assert.doesNotMatch(prompt, /closedThreads/);
    assert.doesNotMatch(prompt, /Legacy `\.ai-markdown-review/);
    assert.doesNotMatch(prompt, /# AI Context Brief/);
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
