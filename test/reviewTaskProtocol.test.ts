import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareReviewTaskCheckpoint,
  createReviewTaskCheckpoint,
  createReviewTaskFingerprint,
  getReviewTaskStatus,
  hasStaleReviewTaskResult,
  parseReviewTaskSidecar,
  REVIEW_TASK_GUIDANCE,
  type ReviewTaskSidecar
} from '../src/reviewTaskProtocol';
import {
  buildLegacyReviewTaskComment,
  createEmptyReviewDocument,
  createLegacyReviewSidecarPayload,
  createPortableReviewSidecarPayload,
  mergeReviewDocuments,
  migrateLegacyReviewDocuments,
  parseLegacyReviewDocument,
  parsePortableReviewSidecar
} from '../src/reviewSidecarCodec';
import type { ReviewThread } from '../src/types';

const uri = 'file:///workspace/docs/spec.md';
const now = '2026-09-11T00:00:00.000Z';

function sidecar(): ReviewTaskSidecar {
  return {
    schemaVersion: 3, document: 'spec.md', guidance: REVIEW_TASK_GUIDANCE,
    items: [{
      id: 'rv_first', rev: 2,
      target: { quote: 'the same words', line: 4, lineEnd: 5, occurrence: 1, contextBefore: 'Before', contextAfter: 'After' },
      comment: 'Make this measurable.', status: 'pending'
    }]
  };
}

function legacyThread(id: string): ReviewThread {
  return {
    id, documentUri: uri, anchor: { text: 'Exact source', lineStart: 4, lineEnd: 6, confidence: 'missing' },
    type: 'risk', severity: 'high', source: 'ai', status: 'open', comment: 'Original request',
    thread: [
      { role: 'user', text: 'Keep the fallback.\nDo not alter the default.', createdAt: now },
      { role: 'assistant', text: 'Suggested patch revision:\n\u0060\u0060\u0060diff\n-old\n+newer\n\u0060\u0060\u0060', createdAt: now }
    ],
    suggestedPatch: { mode: 'replace', original: 'old\nsource', replacement: 'new\nsource' },
    createdAt: now, updatedAt: now
  };
}

describe('compact review task protocol', () => {
  it('roundtrips mixed outcomes as one current comment list through engine adapters', () => {
    const payload = sidecar();
    payload.guidance = 'Preserve product constraints. 사용자 지침.';
    payload.items.unshift({
      ...structuredClone(payload.items[0]), id: 'rv_done', status: 'done', result: 'Applied the documented fallback.', resultFor: 2
    });
    payload.items.push({
      ...structuredClone(payload.items[1]), id: 'rv_blocked', status: 'blocked', result: 'Need an allowed timeout.', resultFor: 2
    });
    const pair = parsePortableReviewSidecar(uri, payload);
    assert.deepEqual(pair.reviewDocument.threads.map(thread => thread.id), ['rv_done', 'rv_first', 'rv_blocked']);
    assert.equal(pair.resolvedReviewDocument.threads.length, 0);
    const canonical = structuredClone(payload);
    for (const item of canonical.items) delete item.status;
    assert.deepEqual(createPortableReviewSidecarPayload(uri, pair.reviewDocument, pair.resolvedReviewDocument, now), canonical);
    assert.deepEqual(parsePortableReviewSidecar(uri, payload), pair, 'Repeated reads must not fabricate new dates');
  });

  it('retains stale done/blocked results for inspection without hiding their requests', () => {
    for (const status of ['done', 'blocked'] as const) {
      const payload = sidecar();
      Object.assign(payload.items[0], { status, result: 'Old outcome', resultFor: 1 });
      const pair = parsePortableReviewSidecar(uri, payload);
      const thread = pair.reviewDocument.threads[0];
      assert.equal(pair.resolvedReviewDocument.threads.length, 0);
      assert.equal(thread.status, 'open');
      assert.equal(thread.taskStatus, status);
      assert.equal(getReviewTaskStatus(thread), 'pending');
      assert.equal(hasStaleReviewTaskResult(thread), true);
      const canonical = structuredClone(payload);
      delete canonical.items[0].status;
      assert.deepEqual(createPortableReviewSidecarPayload(uri, pair.reviewDocument, pair.resolvedReviewDocument, now), canonical);
    }
  });

  it('preserves missing and ambiguous targets through save/reload', () => {
    for (const state of ['missing', 'ambiguous'] as const) {
      const payload = sidecar();
      payload.items[0].target.state = state;
      const pair = parsePortableReviewSidecar(uri, payload);
      assert.equal(pair.reviewDocument.threads[0].anchor.confidence, state);
      assert.equal(createPortableReviewSidecarPayload(uri, pair.reviewDocument, pair.resolvedReviewDocument, now).items[0].target.state, state);
    }
  });

  it('keeps full image, table, diagram, code, and repeated-text locator content', () => {
    const quotes = ['![제목](./image.png "caption")', '| name | value |\n| alpha | \u0060  a  \u0060 |',
      '\u0060\u0060\u0060mermaid\nflowchart LR\n A --> B\n\u0060\u0060\u0060',
      '\u0060\u0060\u0060ts\n  const x = "a";\n\u0060\u0060\u0060', 'same same'];
    for (const quote of quotes) {
      const payload = sidecar();
      payload.items[0].target.quote = quote;
      const pair = parsePortableReviewSidecar(uri, payload);
      const canonical = structuredClone(payload);
      delete canonical.items[0].status;
      assert.deepEqual(createPortableReviewSidecarPayload(uri, pair.reviewDocument, pair.resolvedReviewDocument, now), canonical);
    }
  });

  it('creates compact new files without fabricating a location or engine metadata', () => {
    const empty = createEmptyReviewDocument(uri);
    const thread = legacyThread('rv_no_line');
    thread.anchor = { text: 'unique source' };
    thread.thread = [];
    thread.suggestedPatch = undefined;
    empty.threads.push(thread);
    const payload = createPortableReviewSidecarPayload(uri, empty, createEmptyReviewDocument(uri), now);
    assert.deepEqual(payload.items[0].target, { quote: 'unique source' });
    assert.equal(payload.document, 'spec.md');
    assert.equal('status' in payload.items[0], false);
    for (const removed of ['documentUri', 'updatedAt', 'openThreads', 'closedThreads', 'thread', 'severity']) {
      assert.equal(JSON.stringify(payload).includes('"' + removed + '":'), false);
    }
  });

  it('rejects malformed records, future schemas, duplicate IDs, and unknown extension fields', () => {
    const malformed: unknown[] = [null, [], false, { ...sidecar(), schemaVersion: 4 }, { ...sidecar(), extension: {} },
      { ...sidecar(), items: [null] }, { ...sidecar(), items: [false] },
      { ...sidecar(), items: [sidecar().items[0], sidecar().items[0]] }];
    for (const payload of malformed) assert.throws(() => parseReviewTaskSidecar(payload));
    for (const addition of [{ thread: [] }, { target: { quote: 'q', hash: 'external assertion' } }]) {
      const payload = sidecar();
      Object.assign(payload.items[0], addition);
      assert.throws(() => parseReviewTaskSidecar(payload), /unsupported field/);
    }
  });

  it('validates revisions, states, paired single-line results, and locator bounds', () => {
    for (const addition of [
      { rev: 0 }, { rev: 1.5 }, { rev: Number.MAX_SAFE_INTEGER + 1 }, { id: '' }, { comment: ' ' },
      { status: 'accepted' }, { status: 'done' }, { status: 'blocked', result: 'Why?' },
      { status: 'done', result: 'one\ntwo', resultFor: 2 }, { resultFor: 2 },
      { status: 'done', result: 'yes', resultFor: 0 }, { target: { quote: 'q', line: 0 } },
      { target: { quote: 'q', line: 4, lineEnd: 3 } }, { target: { quote: 'q', lineEnd: 3 } },
      { target: { quote: 'q', occurrence: -1 } }, { target: { quote: 'q', state: 'exact' } }
    ]) {
      const payload = sidecar();
      Object.assign(payload.items[0], addition);
      assert.throws(() => parseReviewTaskSidecar(payload), JSON.stringify(addition));
    }
  });

  it('rejects target paths outside the adjacent Markdown filename', () => {
    for (const document of ['../spec.md', 'docs/spec.md', '/spec.md', 'C:\\spec.md', 'spec.txt', 'spec.md\n']) {
      assert.throws(() => parseReviewTaskSidecar({ ...sidecar(), document }));
    }
    assert.equal(parseReviewTaskSidecar({ ...sidecar(), document: '검수 문서.MD' }).document, '검수 문서.MD');
  });

  it('verifies document identity against the Markdown URI without normalizing case or changing a different filename', () => {
    assert.throws(() => parsePortableReviewSidecar('file:///workspace/other.md', sidecar()), /does not match/);
    assert.throws(() => parsePortableReviewSidecar('file:///workspace/SPEC.md', sidecar()), /does not match/);
    const named = { ...sidecar(), document: '검수 문서.md' };
    assert.equal(parsePortableReviewSidecar('file:///workspace/%EA%B2%80%EC%88%98%20%EB%AC%B8%EC%84%9C.md', named).reviewDocument.threads.length, 1);
  });

  it('checks immutable content independently of outcomes and property ordering', () => {
    const payload = sidecar();
    const checkpoint = JSON.parse(JSON.stringify(createReviewTaskCheckpoint(payload)));
    const changed = structuredClone(payload);
    Object.assign(changed.items[0], { status: 'done', result: 'done', resultFor: 2 });
    changed.items[0].target = {
      contextAfter: 'After', occurrence: 1, lineEnd: 5, contextBefore: 'Before', line: 4, quote: 'the same words'
    };
    assert.equal(compareReviewTaskCheckpoint(checkpoint, changed).valid, true);
    assert.equal(createReviewTaskFingerprint(payload.items[0]), createReviewTaskFingerprint(changed.items[0]));
    changed.items[0].comment = 'A different requirement with the same rev';
    assert.deepEqual(compareReviewTaskCheckpoint(checkpoint, changed).changedIds, ['rv_first']);
    assert.equal(compareReviewTaskCheckpoint(checkpoint, changed).valid, false);
  });

  it('detects deleted/new items, target changes, guidance changes, and a different document', () => {
    const payload = sidecar();
    const checkpoint = createReviewTaskCheckpoint(payload);
    const changed = structuredClone(payload);
    changed.items = [{ ...changed.items[0], id: 'rv_other' }];
    changed.guidance += ' changed';
    changed.document = 'different.md';
    const diff = compareReviewTaskCheckpoint(checkpoint, changed);
    assert.deepEqual(diff.missingIds, ['rv_first']);
    assert.deepEqual(diff.addedIds, ['rv_other']);
    assert.equal(diff.documentChanged, true);
    assert.equal(diff.guidanceChanged, true);
    payload.items[0].target.state = 'missing';
    assert.deepEqual(compareReviewTaskCheckpoint(checkpoint, payload).changedIds, ['rv_first']);
  });

  it('does not mutate parsed input or checkpoint state', () => {
    const payload = sidecar();
    const before = structuredClone(payload);
    const parsed = parseReviewTaskSidecar(payload);
    parsed.items[0].target.quote = 'edited copy';
    assert.deepEqual(payload, before);
    const checkpoint = createReviewTaskCheckpoint(payload);
    const serialized = JSON.stringify(checkpoint);
    compareReviewTaskCheckpoint(checkpoint, payload);
    assert.equal(JSON.stringify(checkpoint), serialized);
  });
});

describe('legacy to task conversion', () => {
  it('preserves all-role replies and original/revised patch requests without mutating v2', () => {
    const original = legacyThread('rv_original');
    const closed = { ...legacyThread('rv_closed'), status: 'rejected' as const };
    const old = createLegacyReviewSidecarPayload(uri, { documentUri: uri, threads: [original], updatedAt: now },
      { documentUri: uri, threads: [closed], updatedAt: now }, now);
    const raw = JSON.stringify(old);
    const pair = parsePortableReviewSidecar(uri, old);
    assert.equal(pair.reviewDocument.taskSchemaVersion, 2);
    assert.equal(JSON.stringify(old), raw);
    const migrated = migrateLegacyReviewDocuments(pair);
    const thread = migrated.reviewDocument.threads[0];
    for (const required of [original.comment, ...original.thread.map(reply => reply.text), original.suggestedPatch!.original, original.suggestedPatch!.replacement]) {
      assert.equal(thread.comment.includes(required), true, required);
    }
    assert.equal(thread.taskStatus, 'pending');
    assert.equal(thread.id, original.id);
    assert.deepEqual(thread.anchor, original.anchor);
    assert.equal(migrated.resolvedReviewDocument.threads.length, 0);
    assert.deepEqual(pair.resolvedReviewDocument.threads[0], closed);
    assert.equal(JSON.stringify(old), raw);
    assert.equal(createPortableReviewSidecarPayload(uri, migrated.reviewDocument, migrated.resolvedReviewDocument, now).items[0].target.state, 'missing');
  });

  it('does not repeatedly append old context or reset results when conversion is retried', () => {
    const original = legacyThread('rv_original');
    const pair = parsePortableReviewSidecar(uri, { threads: [original] });
    const converted = migrateLegacyReviewDocuments(pair);
    assert.equal(buildLegacyReviewTaskComment(converted.reviewDocument.threads[0]), converted.reviewDocument.threads[0].comment);
    assert.deepEqual(migrateLegacyReviewDocuments(converted), converted);
  });

  it('does not serialize resolved history into the v3 current comment list', () => {
    const current = parsePortableReviewSidecar(uri, sidecar()).reviewDocument;
    const history = { documentUri: uri, threads: [{ ...legacyThread('rv_closed'), status: 'resolved' as const }], updatedAt: now };
    const payload = createPortableReviewSidecarPayload(uri, current, history, now);
    assert.deepEqual(payload.items.map(item => item.id), ['rv_first']);
  });

  it('rejects falsy malformed legacy threads and unsupported versions without treating them as empty', () => {
    for (const bad of [null, false, 0, '', undefined]) {
      assert.throws(() => parsePortableReviewSidecar(uri, { threads: [bad] }));
    }
    assert.throws(() => parsePortableReviewSidecar(uri, { schemaVersion: 99, threads: [] }), /Unsupported/);
    assert.throws(() => parseLegacyReviewDocument(uri, { schemaVersion: 99, threads: [] }), /Unsupported/);
    const thread = legacyThread('rv_duplicate');
    assert.throws(() => parsePortableReviewSidecar(uri, { schemaVersion: 2, openThreads: [thread], closedThreads: [thread] }), /Duplicate/);
  });

  it('retains custom guidance on relocation and refuses to merge different populated contracts', () => {
    const parsed = parsePortableReviewSidecar(uri, { ...sidecar(), guidance: 'Keep user constraints.' });
    const movedUri = 'file:///workspace/docs/renamed.md';
    const moved = mergeReviewDocuments(createEmptyReviewDocument(movedUri), parsed.reviewDocument, movedUri);
    const payload = createPortableReviewSidecarPayload(movedUri, moved, createEmptyReviewDocument(movedUri), now);
    assert.equal(payload.document, 'renamed.md');
    assert.equal(payload.guidance, 'Keep user constraints.');
    assert.throws(() => mergeReviewDocuments({ ...moved, guidance: 'Different rules.' }, parsed.reviewDocument, movedUri), /different guidance/);
  });

  it('does not use synthesized adapter dates to overwrite a conflicting task ID on rename', () => {
    const original = parsePortableReviewSidecar(uri, sidecar()).reviewDocument;
    const another = structuredClone(original);
    another.threads[0].comment = 'A new user request at the destination';
    assert.throws(() => mergeReviewDocuments(another, original, uri), /Conflicting review item ID/);
    const outcome = structuredClone(original);
    Object.assign(outcome.threads[0], { taskStatus: 'blocked', taskResult: 'Need a decision.', taskResultFor: 2 });
    assert.throws(() => mergeReviewDocuments(outcome, original, uri), /Conflicting review item ID/);
    assert.equal(mergeReviewDocuments(original, structuredClone(original), uri).threads.length, 1);
  });
});
