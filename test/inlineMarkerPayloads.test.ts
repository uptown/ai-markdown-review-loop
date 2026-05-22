import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendInlineReviewLogMarker,
  createInlineAnchorMarker,
  findStaleInlineAnchorMarkers,
  readInlineAnchorMarkers,
  removeInlineAnchorMarkersFromMarkdown,
  removeInlineAnchorMarkerPayloads,
  removeInlineReviewLogMarkers,
  stripInlineAnchorMarkers,
  upsertInlineAnchorMarkersInMarkdown
} from '../src/inlineMarkerPayloads';
import type { ReviewThread } from '../src/types';

const sidecar = '.ai-markdown-review/documents/spec.json';

describe('inline marker payloads', () => {
  it('reads legacy per-thread anchors and the compact document-level anchor index', () => {
    const markdown = [
      '<!-- ai-review-anchor:{"id":"rv_legacy","status":"open","hash":"sha256:abc","sidecar":".ai-markdown-review/documents/spec.json","lineStart":1,"lineEnd":1} -->',
      '<!-- ai-review-anchors:{"sidecar":".ai-markdown-review/documents/spec.json","ids":["rv_a","rv_b"]} -->'
    ].join('\n');

    assert.deepEqual(readInlineAnchorMarkers(markdown), [
      {
        id: 'rv_legacy',
        status: 'open',
        hash: 'sha256:abc',
        sidecar,
        lineStart: 1,
        lineEnd: 1
      },
      { id: 'rv_a', sidecar },
      { id: 'rv_b', sidecar }
    ]);
  });

  it('writes one compact marker for threads sharing a sidecar', () => {
    assert.equal(
      createInlineAnchorMarker([
        { id: 'rv_a', sidecar, status: 'open', hash: 'sha256:a', lineStart: 1 },
        { id: 'rv_b', sidecar, status: 'open', hash: 'sha256:b', lineStart: 2 }
      ]),
      '<!-- ai-review-anchors:{"sidecar":".ai-markdown-review/documents/spec.json","ids":["rv_a","rv_b"]} -->'
    );
  });

  it('dedupes and removes closed payloads without carrying old status metadata forward', () => {
    const remaining = removeInlineAnchorMarkerPayloads([
      { id: 'rv_open', sidecar, status: 'open', hash: 'sha256:a' },
      { id: 'rv_closed', sidecar, status: 'resolved', hash: 'sha256:b' },
      { id: 'rv_open', sidecar, status: 'open', hash: 'sha256:a' }
    ], ['rv_closed']);

    assert.deepEqual(remaining, [
      { id: 'rv_open', sidecar, status: 'open', hash: 'sha256:a' }
    ]);
    assert.equal(
      createInlineAnchorMarker(remaining),
      '<!-- ai-review-anchors:{"sidecar":".ai-markdown-review/documents/spec.json","ids":["rv_open"]} -->'
    );
  });

  it('flags missing or non-open anchors as stale', () => {
    const markdown = '<!-- ai-review-anchors:{"sidecar":".ai-markdown-review/documents/spec.json","ids":["rv_open","rv_resolved","rv_missing"]} -->';

    const stale = findStaleInlineAnchorMarkers(markdown, [
      thread('rv_open', 'open'),
      thread('rv_resolved', 'resolved')
    ]);

    assert.deepEqual(stale, [
      { id: 'rv_resolved', sidecar },
      { id: 'rv_missing', sidecar }
    ]);
  });

  it('strips inline review metadata comments from rendered Markdown source', () => {
    const markdown = [
      '# Title',
      '<!-- ai-review-anchor:{"id":"rv_legacy","sidecar":".ai-markdown-review/documents/spec.json"} -->',
      'Body',
      '<!-- ai-review-anchors:{"sidecar":".ai-markdown-review/documents/spec.json","ids":["rv_a"]} -->',
      '<!-- ai-review-log:{"id":"rv_done","status":"resolved","sidecar":".ai-markdown-review/resolved/spec.json"} -->'
    ].join('\n');

    assert.equal(stripInlineAnchorMarkers(markdown), '# Title\nBody\n');
  });

  it('strips adjacent review log comments even when they were written on one line', () => {
    const markdown = [
      'Body',
      '<!-- ai-review-log:{"id":"rv_a","status":"resolved"} --> <!-- ai-review-log:{"id":"rv_b","status":"accepted"} -->'
    ].join('\n');

    assert.equal(stripInlineAnchorMarkers(markdown), 'Body\n');
  });

  it('removes restored thread review logs without disturbing other history', () => {
    const markdown = [
      'Body',
      '<!-- ai-review-log:{"id":"rv_a","status":"resolved"} --> <!-- ai-review-log:{"id":"rv_b","status":"accepted"} -->'
    ].join('\n');

    assert.equal(
      removeInlineReviewLogMarkers(markdown, ['rv_a']),
      'Body\n <!-- ai-review-log:{"id":"rv_b","status":"accepted"} -->'
    );
  });

  it('rewrites inline anchor metadata as one compact marker for undoable document edits', () => {
    const markdown = [
      'Body',
      '<!-- ai-review-anchor:{"id":"rv_a","sidecar":".ai-markdown-review/documents/spec.json"} -->'
    ].join('\n');

    assert.equal(
      upsertInlineAnchorMarkersInMarkdown(markdown, [{ id: 'rv_b', sidecar }]),
      [
        'Body',
        '<!-- ai-review-anchors:{"sidecar":".ai-markdown-review/documents/spec.json","ids":["rv_a","rv_b"]} -->',
        ''
      ].join('\n')
    );
  });

  it('removes closed anchors and appends compact review logs in source order', () => {
    const markdown = [
      'Body',
      '<!-- ai-review-anchors:{"sidecar":".ai-markdown-review/documents/spec.json","ids":["rv_a","rv_b"]} -->'
    ].join('\n');
    const withoutClosed = removeInlineAnchorMarkersFromMarkdown(markdown, ['rv_a']);

    assert.equal(
      appendInlineReviewLogMarker(withoutClosed, {
        id: 'rv_a',
        status: 'accepted',
        sidecar: '.ai-markdown-review/resolved/spec.json',
        updatedAt: '2026-05-23T00:00:00.000Z'
      }),
      [
        'Body',
        '<!-- ai-review-anchors:{"sidecar":".ai-markdown-review/documents/spec.json","ids":["rv_b"]} -->',
        '<!-- ai-review-log:{"id":"rv_a","status":"accepted","sidecar":".ai-markdown-review/resolved/spec.json","updatedAt":"2026-05-23T00:00:00.000Z"} -->',
        ''
      ].join('\n')
    );
  });
});

function thread(id: string, status: ReviewThread['status']): ReviewThread {
  return {
    id,
    documentUri: 'file:///workspace/spec.md',
    anchor: {
      text: id
    },
    type: 'note',
    source: 'human',
    status,
    severity: 'medium',
    comment: id,
    thread: [],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z'
  };
}
