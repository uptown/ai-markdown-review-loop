import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createColocatedReviewSidecarFileName,
  isColocatedReviewSidecarFileName
} from '../src/reviewSidecarPaths';
import {
  REVIEW_SIDECAR_SCHEMA_VERSION,
  createPortableReviewSidecarPayload,
  parseLegacyReviewDocument,
  parsePortableReviewSidecar
} from '../src/reviewSidecarCodec';
import type { ReviewThread } from '../src/types';

const documentUri = 'file:///workspace/docs/spec.md';
const movedDocumentUri = 'file:///workspace/docs/renamed-spec.md';
const now = '2026-05-23T00:00:00.000Z';

describe('review sidecar storage', () => {
  it('names colocated review sidecars as hidden files beside the Markdown document', () => {
    assert.equal(createColocatedReviewSidecarFileName('spec.md'), '.spec.md.ai-review.json');
    assert.equal(createColocatedReviewSidecarFileName('README.md'), '.README.md.ai-review.json');
    assert.equal(isColocatedReviewSidecarFileName('.spec.md.ai-review.json'), true);
    assert.equal(isColocatedReviewSidecarFileName('spec.md.ai-review.json'), false);
  });

  it('serializes open and closed threads into one portable sidecar file', () => {
    const payload = createPortableReviewSidecarPayload(
      documentUri,
      {
        documentUri,
        threads: [thread('rv_open', 'open')],
        updatedAt: now
      },
      {
        documentUri,
        threads: [thread('rv_closed', 'accepted')],
        updatedAt: now
      },
      now
    );

    assert.equal(payload.schemaVersion, REVIEW_SIDECAR_SCHEMA_VERSION);
    assert.deepEqual(payload.openThreads.map(item => item.id), ['rv_open']);
    assert.deepEqual(payload.closedThreads.map(item => item.id), ['rv_closed']);

    const parsed = parsePortableReviewSidecar(movedDocumentUri, payload);

    assert.deepEqual(parsed.reviewDocument.threads.map(item => item.id), ['rv_open']);
    assert.deepEqual(parsed.resolvedReviewDocument.threads.map(item => item.id), ['rv_closed']);
    assert.equal(parsed.reviewDocument.threads[0].documentUri, movedDocumentUri);
    assert.equal(parsed.resolvedReviewDocument.threads[0].documentUri, movedDocumentUri);
  });

  it('keeps legacy thread-only sidecars readable for migration', () => {
    const legacy = {
      documentUri,
      threads: [thread('rv_legacy', 'open')],
      updatedAt: now
    };
    const parsedDocument = parseLegacyReviewDocument(movedDocumentUri, legacy);
    const parsedSidecar = parsePortableReviewSidecar(movedDocumentUri, legacy);

    assert.deepEqual(parsedDocument.threads.map(item => item.id), ['rv_legacy']);
    assert.equal(parsedDocument.threads[0].documentUri, movedDocumentUri);
    assert.deepEqual(parsedSidecar.reviewDocument.threads.map(item => item.id), ['rv_legacy']);
    assert.deepEqual(parsedSidecar.resolvedReviewDocument.threads, []);
  });

  it('keeps rich closed-thread anchor metadata instead of requiring proposed-thread shape', () => {
    const payload = createPortableReviewSidecarPayload(
      documentUri,
      {
        documentUri,
        threads: [],
        updatedAt: now
      },
      {
        documentUri,
        threads: [{
          ...thread('rv_closed_rich_anchor', 'resolved'),
          closedBy: 'user',
          closedAt: now,
          anchor: {
            text: 'Reviewed text',
            lineStart: 12,
            lineEnd: 13,
            hash: 'sha256:abc123',
            occurrence: 2,
            contextBefore: 'Before snippet',
            contextAfter: 'After snippet',
            confidence: 'recovered',
            lastLocatedLine: 12,
            lastLocatedAt: now
          }
        }],
        updatedAt: now
      },
      now
    );
    const parsed = parsePortableReviewSidecar(movedDocumentUri, payload);
    const closedThread = parsed.resolvedReviewDocument.threads[0];

    assert.equal(closedThread.anchor.hash, 'sha256:abc123');
    assert.equal(closedThread.anchor.confidence, 'recovered');
    assert.equal(closedThread.anchor.lastLocatedLine, 12);
    assert.equal(closedThread.anchor.lastLocatedAt, now);
    assert.equal(closedThread.anchor.contextBefore, 'Before snippet');
    assert.equal(closedThread.closedBy, 'user');
    assert.equal(closedThread.closedAt, now);
  });
});

function thread(id: string, status: ReviewThread['status']): ReviewThread {
  return {
    id,
    documentUri,
    anchor: {
      text: id,
      lineStart: 1,
      lineEnd: 1,
      confidence: 'exact'
    },
    type: 'note',
    source: 'human',
    status,
    severity: 'medium',
    comment: id,
    thread: [],
    createdAt: now,
    updatedAt: now
  };
}
