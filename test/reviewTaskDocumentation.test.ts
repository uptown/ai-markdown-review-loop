import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseReviewTaskSidecar, REVIEW_TASK_GUIDANCE, type ReviewTaskSidecar
} from '../src/reviewTaskProtocol';

describe('published v3 task contract', () => {
  it('provides a copyable sidecar and outcome that pass the runtime parser with canonical guidance', () => {
    const policy = readFileSync('docs/AI-REVIEW-POLICY.md', 'utf8');
    const examples = [...policy.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map(match => JSON.parse(match[1]));
    assert.equal(examples.length, 2);
    const before = parseReviewTaskSidecar(examples[0]);
    assert.equal(before.guidance, REVIEW_TASK_GUIDANCE);
    const after = parseReviewTaskSidecar({ ...before, items: [examples[1]] });
    assert.equal(after.items[0].resultFor, before.items[0].rev);
    assert.equal(after.items[0].status, 'done');
    assert.deepEqual(
      { ...after.items[0], status: 'pending', result: undefined, resultFor: undefined },
      { ...before.items[0], result: undefined, resultFor: undefined }
    );
  });

  it('documents one v3 file schema and rejects retired thread payloads', () => {
    const schema = JSON.parse(readFileSync('docs/review-task.schema.json', 'utf8'));
    assert.equal(schema.properties.schemaVersion.const, 3);
    assert.deepEqual(schema.required, ['schemaVersion', 'document', 'guidance', 'items']);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.$defs.item.additionalProperties, false);
    assert.equal(schema.$defs.target.additionalProperties, false);
    assert.deepEqual(schema.$defs.item.properties.status.enum, ['pending', 'done', 'blocked']);
    assert.deepEqual(schema.$defs.item.dependentRequired, { result: ['resultFor'], resultFor: ['result'] });
    assert.deepEqual(schema.$defs.target.properties.state.enum, ['missing', 'ambiguous']);
    assert.throws(() => parseReviewTaskSidecar({ schemaVersion: 2, openThreads: [], closedThreads: [] }));
  });

  it('keeps the schema filename rule aligned with basename-only runtime validation', () => {
    const schema = JSON.parse(readFileSync('docs/review-task.schema.json', 'utf8'));
    const filenamePattern = new RegExp(schema.properties.document.pattern);
    for (const [document, valid] of [
      ['spec.md', true], ['한글 공백.MD', true], ['.md', true],
      ['docs/spec.md', false], ['..\\spec.md', false], ['spec.txt', false], ['spec\n.md', false]
    ] as const) {
      const value: ReviewTaskSidecar = { schemaVersion: 3, document, guidance: REVIEW_TASK_GUIDANCE, items: [] };
      assert.equal(filenamePattern.test(document), valid, 'Schema filename: ' + JSON.stringify(document));
      if (valid) assert.equal(parseReviewTaskSidecar(value).document, document);
      else assert.throws(() => parseReviewTaskSidecar(value));
    }
  });
});
