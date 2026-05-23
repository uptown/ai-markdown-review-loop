import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_COLLABORATION_LOOP_DOC_PATH,
  AGENT_CONTEXT_BOOTSTRAP_DOC_PATH,
  AGENT_COMMENTING_GUIDELINES,
  AGENT_EDITING_GUIDELINES,
  AGENT_REVIEW_POLICY_DOC_PATH,
  AGENT_REVIEW_THREAD_SCHEMA_PATH,
  AGENT_THREAD_CREATION_CONTRACT
} from '../src/agentReviewPolicy';

describe('agent review policy', () => {
  it('keeps non-empty editing, commenting, and creation guidance', () => {
    assert.ok(AGENT_EDITING_GUIDELINES.length >= 5);
    assert.ok(AGENT_COMMENTING_GUIDELINES.length >= 5);
    assert.ok(AGENT_THREAD_CREATION_CONTRACT.length >= 4);
  });

  it('ships a thread creation schema aligned with the review policy', () => {
    const schemaPath = path.resolve(process.cwd(), AGENT_REVIEW_THREAD_SCHEMA_PATH);
    const policyPath = path.resolve(process.cwd(), AGENT_REVIEW_POLICY_DOC_PATH);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const policy = readFileSync(policyPath, 'utf8');

    assert.deepEqual(
      schema.required,
      ['source', 'status', 'anchor', 'type', 'severity', 'comment']
    );
    assert.ok(schema.properties?.anchor);
    assert.ok(schema.properties?.suggestedPatch);
    assert.match(policy, /Schema: \[`docs\/agent-review-thread.schema.json`\]/);
  });

  it('ships collaboration-loop and context-bootstrap docs for first-pass grounding', () => {
    const collaborationPath = path.resolve(process.cwd(), AGENT_COLLABORATION_LOOP_DOC_PATH);
    const bootstrapPath = path.resolve(process.cwd(), AGENT_CONTEXT_BOOTSTRAP_DOC_PATH);
    const collaboration = readFileSync(collaborationPath, 'utf8');
    const bootstrap = readFileSync(bootstrapPath, 'utf8');

    assert.match(collaboration, /## Recommended Loop/);
    assert.match(collaboration, /## When AI Should Reply Instead Of Opening A New Thread/);
    assert.match(bootstrap, /Prompt First, Brief Optional/);
    assert.match(bootstrap, /Open Bootstrap Prompt/);
    assert.match(bootstrap, /docs\/AI-CONTEXT-BRIEF.md/);
    assert.match(bootstrap, /\.ai-markdown-review\/` sidecars/);
  });
});
