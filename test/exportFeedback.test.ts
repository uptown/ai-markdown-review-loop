import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFeedbackExport } from '../src/exportFeedback';
import type { ReviewDocument } from '../src/types';

describe('renderFeedbackExport', () => {
  it('exports agent editing rules and per-thread closure guardrails', () => {
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
        }
      ]
    } satisfies ReviewDocument);

    assert.match(output, /## Agent Editing Guidelines/);
    assert.match(output, /Do not mark a thread `accepted`, `resolved`, or `rejected`/);
    assert.match(output, /## rv_open/);
    assert.match(output, /- Anchor confidence: recovered/);
    assert.match(output, /- Allowed to close: no/);
    assert.match(output, /Suggested patch:/);
    assert.doesNotMatch(output, /rv_closed/);
  });
});
