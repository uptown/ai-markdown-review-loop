import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSuggestedPatchResults,
  selectSuggestedPatchReplacement
} from '../src/suggestedPatches';
import type { ReviewAnchor, ReviewThread, SuggestedPatch } from '../src/types';

const replacePatch: SuggestedPatch = {
  mode: 'replace',
  original: 'old sentence',
  replacement: 'new sentence'
};

describe('selectSuggestedPatchReplacement', () => {
  it('selects a single exact replacement target', () => {
    const result = selectSuggestedPatchReplacement(
      'Intro\nold sentence\nOutro',
      replacePatch,
      anchor({ lineStart: 2 })
    );

    assert.deepEqual(result, {
      result: 'applied',
      start: 6,
      end: 18,
      replacement: 'new sentence'
    });
  });

  it('uses the anchor line to disambiguate repeated replacement text', () => {
    const result = selectSuggestedPatchReplacement(
      'old sentence\nmiddle\nold sentence',
      replacePatch,
      anchor({ lineStart: 3 })
    );

    assert.equal(result.result, 'applied');
    assert.equal(result.start, 20);
  });

  it('blocks repeated replacement text when the anchor line is also ambiguous', () => {
    const result = selectSuggestedPatchReplacement(
      'old sentence and old sentence',
      replacePatch,
      anchor({ lineStart: 1 })
    );

    assert.deepEqual(result, { result: 'ambiguous' });
  });

  it('blocks replacement when the anchor confidence is low', () => {
    const result = selectSuggestedPatchReplacement(
      'old sentence',
      replacePatch,
      anchor({ lineStart: 1, confidence: 'approximate' })
    );

    assert.deepEqual(result, { result: 'lowConfidenceAnchor' });
  });

  it('reports missing original text without mutating state', () => {
    const result = selectSuggestedPatchReplacement(
      'already changed',
      replacePatch,
      anchor({ lineStart: 1 })
    );

    assert.deepEqual(result, { result: 'originalNotFound' });
  });

  it('reports absent patch data', () => {
    const result = selectSuggestedPatchReplacement(
      'old sentence',
      undefined,
      anchor({ lineStart: 1 })
    );

    assert.deepEqual(result, { result: 'missingPatch' });
  });

  it('summarizes patch applicability before the webview renders apply actions', () => {
    assert.deepEqual(
      getSuggestedPatchResults('old sentence', [
        thread('rv_ready', replacePatch, anchor({ lineStart: 1 })),
        thread('rv_stale', {
          mode: 'replace',
          original: 'stale sentence',
          replacement: 'new sentence'
        }, anchor({ text: 'stale sentence', lineStart: 1 })),
        thread('rv_low_confidence', replacePatch, anchor({ lineStart: 1, confidence: 'approximate' }))
      ]),
      {
        rv_ready: 'applied',
        rv_stale: 'originalNotFound',
        rv_low_confidence: 'lowConfidenceAnchor'
      }
    );
  });
});

function anchor(overrides: Partial<ReviewAnchor>): ReviewAnchor {
  return {
    text: 'old sentence',
    ...overrides
  };
}

function thread(
  id: string,
  suggestedPatch: SuggestedPatch,
  reviewAnchor: ReviewAnchor,
  anchorText = reviewAnchor.text
): ReviewThread {
  return {
    id,
    documentUri: 'file:///doc.md',
    anchor: {
      ...reviewAnchor,
      text: anchorText
    },
    type: 'suggestion',
    source: 'ai',
    status: 'open',
    severity: 'medium',
    comment: 'Apply this edit.',
    suggestedPatch,
    thread: [],
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z'
  };
}
