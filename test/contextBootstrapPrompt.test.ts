import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createContextBootstrapPrompt } from '../src/contextBootstrapPrompt';

describe('createContextBootstrapPrompt', () => {
  it('builds a concise generic agent prompt that preserves review state during reviews and edits', () => {
    const prompt = createContextBootstrapPrompt();

    assert.match(prompt, /# AI Markdown Review Loop Agent Prompt/);
    assert.match(prompt, /review or edit Markdown/i);
    assert.match(prompt, /Use the Markdown target named by the human or current conversation/);
    assert.match(prompt, /Discover only the repo context needed/);
    assert.match(prompt, /skip context discovery when the human already gave enough direction/);
    assert.match(prompt, /review session brief/);
    assert.match(prompt, /review goal, focus areas, non-goals, constraints/);
    assert.match(prompt, /ask at most 3 specific questions/i);
    assert.match(prompt, /create or reply to a focused `question` thread/);
    assert.match(prompt, /Treat review threads as conversation state/);
    assert.match(prompt, /session context for the next pass/);
    assert.match(prompt, /switch to the AI Feedback Loop Prompt/);
    assert.match(prompt, /Apply a suggested Markdown change only when the human explicitly asks/i);
    assert.match(prompt, /hidden `\.<filename>\.ai-review\.json` sidecars/);
    assert.match(prompt, /inline `ai-review-\*` metadata comments/);
    assert.match(prompt, /List every touched `rv_\*` id/);
    assert.doesNotMatch(prompt, /Detected Sources/);
    assert.doesNotMatch(prompt, /Prompt To Paste/);
    assert.doesNotMatch(prompt, /Initial Markdown target/);
    assert.doesNotMatch(prompt, /Current Markdown target/);
    assert.doesNotMatch(prompt, /docs\/specs\/checkout.md/);
    assert.doesNotMatch(prompt, /Skip files that do not exist/);
    assert.doesNotMatch(prompt, /README.md/);
    assert.doesNotMatch(prompt, /docs\/AI-CONTEXT-BRIEF.md/);
    assert.doesNotMatch(prompt, /docs\/AI-REVIEW-POLICY.md/);
    assert.doesNotMatch(prompt, /docs\/AI-COLLABORATION-LOOP.md/);
    assert.doesNotMatch(prompt, /docs\/agent-review-thread.schema.json/);
    assert.doesNotMatch(prompt, /docs\/PRD.md/);
    assert.doesNotMatch(prompt, /\.agent\/PROJECT_STATE.md/);
    assert.doesNotMatch(prompt, /openThreads/);
    assert.doesNotMatch(prompt, /closedThreads/);
    assert.doesNotMatch(prompt, /Legacy `\.ai-markdown-review/);
    assert.doesNotMatch(prompt, /# AI Context Brief/);
    assert.doesNotMatch(prompt, /```md/);
  });

  it('does not turn context discovery into a detected-source checklist', () => {
    const prompt = createContextBootstrapPrompt();

    assert.match(prompt, /ask which Markdown file to review or edit/);
    assert.doesNotMatch(prompt, /Read these repo context sources first/);
    assert.doesNotMatch(prompt, /especially `README.md`/);
    assert.doesNotMatch(prompt, /1\. `README.md`/);
    assert.doesNotMatch(prompt, /1\. `docs\/AI-CONTEXT-BRIEF.md`/);
    assert.doesNotMatch(prompt, /AI-CONTEXT-BRIEF/);
    assert.doesNotMatch(prompt, /AI-REVIEW-POLICY/);
    assert.doesNotMatch(prompt, /AI-COLLABORATION-LOOP/);
    assert.doesNotMatch(prompt, /docs\/PRD.md/);
    assert.doesNotMatch(prompt, /\.agent\/PROJECT_STATE.md/);
  });
});
