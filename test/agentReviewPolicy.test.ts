import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_ACTION_PACKET_CONTRACT,
  AGENT_ACTION_PACKET_TEMPLATE,
  AGENT_COLLABORATION_LOOP_DOC_PATH,
  AGENT_CONTEXT_BOOTSTRAP_DOC_PATH,
  AGENT_CONTEXT_BOOTSTRAP_GUIDELINES,
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
    assert.ok(AGENT_ACTION_PACKET_CONTRACT.length >= 5);
    assert.match(AGENT_ACTION_PACKET_TEMPLATE, /"action": "propose_edit_plan"/);
    assert.match(AGENT_ACTION_PACKET_TEMPLATE, /"sidecarReply"/);
    assert.match(AGENT_ACTION_PACKET_CONTRACT.join('\n'), /`record_outcome`/);
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
    assert.match(String((schema as { description?: string }).description), /not the sidecar persistence schema/);
    assert.match(policy, /Schema: \[`docs\/agent-review-thread.schema.json`\]/);
    assert.match(policy, /proposal schema, not the sidecar persistence schema/);
    assert.match(policy, /Existing\s+`openThreads` and `closedThreads` are full host-owned thread records/);
    assert.match(policy, /Action packet shape/);
    assert.match(policy, /propose_edit_plan/);
    assert.match(policy, /sidecarReply/);
    assert.match(
      AGENT_EDITING_GUIDELINES.join('\n'),
      /Do not validate, strip, or rewrite existing `openThreads` or `closedThreads`/
    );
    assert.match(
      AGENT_EDITING_GUIDELINES.join('\n'),
      /Every Markdown edit made for an `rv_\*` thread must leave thread history/
    );
    assert.match(
      AGENT_EDITING_GUIDELINES.join('\n'),
      /Do not claim a feedback-loop edit is complete until the Markdown change and sidecar reply\/history update both happened/
    );
    assert.match(
      AGENT_THREAD_CREATION_CONTRACT.join('\n'),
      /Do not apply this schema to existing sidecar `openThreads` or `closedThreads`/
    );
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
    assert.match(bootstrap, /discover only the repo context needed/);
    assert.match(bootstrap, /nearby `\.<filename>\.ai-review\.json` sidecars/);
    assert.match(bootstrap, /avoid creating inline `ai-review-\*` metadata comments/);
    assert.match(bootstrap, /avoid rewriting sidecar `openThreads` or `closedThreads` by hand/);
    assert.match(bootstrap, /proposal schema for new\s+AI-authored open feedback only/);
    assert.match(bootstrap, /not embed the context brief template/);
    assert.doesNotMatch(bootstrap, /docs\/AI-CONTEXT-BRIEF.md/);
    assert.doesNotMatch(bootstrap, /docs\/PRD.md/);
    assert.doesNotMatch(bootstrap, /\.agent\/PROJECT_STATE.md/);
    assert.doesNotMatch(AGENT_CONTEXT_BOOTSTRAP_GUIDELINES.join('\n'), /README.md/);
    assert.doesNotMatch(
      AGENT_CONTEXT_BOOTSTRAP_GUIDELINES.join('\n'),
      /docs\/AI-CONTEXT-BRIEF.md/
    );
    assert.doesNotMatch(AGENT_CONTEXT_BOOTSTRAP_GUIDELINES.join('\n'), /docs\/PRD.md/);
    assert.doesNotMatch(
      AGENT_CONTEXT_BOOTSTRAP_GUIDELINES.join('\n'),
      /\.agent\/PROJECT_STATE.md/
    );
  });
});
