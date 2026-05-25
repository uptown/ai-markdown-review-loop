import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFeedbackExport } from '../src/exportFeedback';
import type { ReviewDocument } from '../src/types';

describe('renderFeedbackExport', () => {
  it('exports agent editing rules, commenting rules, and per-thread closure guardrails', () => {
    const output = renderFeedbackExport({
      documentUri: 'file:///workspace/spec.md',
      updatedAt: '2026-05-22T00:00:00.000Z',
      threads: [
        {
          id: 'rv_open',
          documentUri: 'file:///workspace/spec.md',
          anchor: {
            text: 'Requirement text',
            lineStart: 3,
            confidence: 'recovered'
          },
          type: 'suggestion',
          source: 'ai',
          status: 'open',
          severity: 'medium',
          comment: 'Clarify this requirement.',
          suggestedPatch: {
            mode: 'replace',
            original: 'Requirement text',
            replacement: 'Requirement text with owner'
          },
          thread: [
            {
              role: 'user',
              text: 'Keep the scope narrow.',
              createdAt: '2026-05-22T00:01:00.000Z'
            }
          ],
          createdAt: '2026-05-22T00:00:00.000Z',
          updatedAt: '2026-05-22T00:00:00.000Z'
        },
        {
          id: 'rv_closed',
          documentUri: 'file:///workspace/spec.md',
          anchor: {
            text: 'Closed text'
          },
          type: 'note',
          source: 'human',
          status: 'resolved',
          severity: 'low',
          comment: 'Already handled.',
          thread: [],
          createdAt: '2026-05-22T00:00:00.000Z',
          updatedAt: '2026-05-22T00:00:00.000Z'
        },
        {
          id: 'rv_vague',
          documentUri: 'file:///workspace/spec.md',
          anchor: {
            text: 'Vague text',
            lineStart: 5,
            confidence: 'exact'
          },
          type: 'note',
          source: 'human',
          status: 'open',
          severity: 'medium',
          comment: 'ㄴㅇ',
          thread: [],
          createdAt: '2026-05-22T00:00:00.000Z',
          updatedAt: '2026-05-22T00:00:00.000Z'
        }
      ]
    } satisfies ReviewDocument);

    assert.match(output, /## Open Review Threads/);
    assert.ok(output.indexOf('## Open Review Threads') < output.indexOf('## Agent Editing Guidelines'));
    assert.ok(output.indexOf('## rv_open') < output.indexOf('## Agent Editing Guidelines'));
    assert.match(output, /## Agent Editing Guidelines/);
    assert.match(output, /## Agent Commenting Guidelines/);
    assert.match(output, /## Agent Thread Creation Contract/);
    assert.match(output, /## Human-AI Feedback Loop/);
    assert.match(output, /## Initial Context Bootstrap/);
    assert.match(output, /## Review Session Context/);
    assert.match(output, /active review session brief/);
    assert.match(output, /review goal, focus areas, non-goals, constraints/);
    assert.match(output, /Canonical review policy: docs\/AI-REVIEW-POLICY.md/);
    assert.match(output, /Canonical creation schema: docs\/agent-review-thread.schema.json/);
    assert.match(output, /sidecar is extension-owned persistence/i);
    assert.match(output, /Do not validate, strip, or rewrite existing `openThreads` or `closedThreads`/);
    assert.match(output, /only for proposing new AI-authored open review threads/);
    assert.match(output, /Do not apply this schema to existing sidecar `openThreads` or `closedThreads`/);
    assert.match(output, /Canonical collaboration loop: docs\/AI-COLLABORATION-LOOP.md/);
    assert.match(output, /Canonical context bootstrap: docs\/AI-CONTEXT-BOOTSTRAP.md/);
    assert.match(output, /bootstrap prompt, not from a status panel or a blank context file/);
    assert.match(output, /canonical source material instead of copying full templates or examples/);
    assert.doesNotMatch(output, /# AI Context Brief/);
    assert.doesNotMatch(output, /"source": "ai"/);
    assert.match(output, /Do not mark a thread `accepted`, `resolved`, or `rejected`/);
    assert.match(output, /## rv_open/);
    assert.match(output, /- Anchor confidence: recovered/);
    assert.match(output, /- Allowed to close: no/);
    assert.match(output, /- Handoff quality: ready/);
    assert.match(output, /Outcome vocabulary:/);
    assert.match(output, /needs human decision means stop before deciding and leave the thread open/);
    assert.match(output, /## rv_vague/);
    assert.match(output, /- Handoff quality: needs_detail/);
    assert.match(output, /Comment is too short for reliable AI handoff/);
    assert.match(output, /Suggested patch:/);
    assert.doesNotMatch(output, /rv_closed/);
  });
});
