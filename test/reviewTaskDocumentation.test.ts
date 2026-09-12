import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseReviewTaskSidecar, REVIEW_TASK_GUIDANCE, type ReviewTaskSidecar
} from '../src/reviewTaskProtocol';

describe('published v3 task contract', () => {
  it('publishes canonical sidecars and one idempotent current-comment contract', () => {
    const policy = readFileSync('docs/AI-REVIEW-POLICY.md', 'utf8');
    const examples = [...policy.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map(match => JSON.parse(match[1]));
    assert.equal(examples.length, 1);
    const before = parseReviewTaskSidecar(examples[0]);
    assert.match(before.guidance, /Review every user comment against the current document/i);
    assert.equal(before.guidance, REVIEW_TASK_GUIDANCE);
    assert.match(REVIEW_TASK_GUIDANCE, /Save the Markdown changes, then delete this JSON/i);
    assert.match(REVIEW_TASK_GUIDANCE, /already-satisfied requests unchanged/i);
    assert.doesNotMatch(REVIEW_TASK_GUIDANCE, /reattach|pending|done|blocked/i);
    for (const filename of ['README.md', 'docs/AI-COLLABORATION-LOOP.md', 'docs/AI-CONTEXT-BOOTSTRAP.md']) {
      const contents = readFileSync(filename, 'utf8');
      assert.doesNotMatch(contents, /records? (?:a |one-)?(?:short |line )?result|after recording the outcome/i, filename);
      assert.doesNotMatch(contents, /[\uac00-\ud7af]/, filename);
      for (const match of contents.matchAll(/```json\n([\s\S]*?)\n```/g)) {
        const value = parseReviewTaskSidecar(JSON.parse(match[1]));
        assert.equal(value.guidance, REVIEW_TASK_GUIDANCE, filename);
      }
    }
  });

  it('documents one v3 file schema and rejects retired thread payloads', () => {
    const schema = JSON.parse(readFileSync('docs/review-task.schema.json', 'utf8'));
    assert.equal(schema.properties.schemaVersion.const, 3);
    assert.deepEqual(schema.required, ['schemaVersion', 'document', 'guidance', 'items']);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.$defs.item.additionalProperties, false);
    assert.equal(schema.$defs.target.additionalProperties, false);
    assert.equal(schema.$defs.item.properties.status.deprecated, true);
    assert.deepEqual(schema.$defs.item.properties.status.enum, ['pending', 'done', 'blocked']);
    assert.deepEqual(schema.$defs.item.dependentRequired, { result: ['resultFor'], resultFor: ['result'] });
    assert.equal(schema.$defs.item.properties.result.deprecated, true);
    assert.equal(schema.properties.context.additionalProperties, false);
    const contextPath = new RegExp(schema.properties.context.properties.path.pattern);
    for (const [value, valid] of [['docs/spec.md', true], ['spec.md', true], ['docs//spec.md', false], ['docs/', false], ['../spec.md', false], ['/spec.md', false], ['docs/../spec.md', false]]) {
      assert.equal(contextPath.test(value as string), valid, String(value));
    }
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
