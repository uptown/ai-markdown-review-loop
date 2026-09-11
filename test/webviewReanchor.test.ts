import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHarness, runWebview } from './helpers/providerHarness';
import type { ReviewThread } from '../src/types';

function reviewThread(): ReviewThread {
  return {
    id: 'rv_missing', documentUri: 'file:///project/spec.md',
    anchor: { text: 'Removed text', confidence: 'missing', lineStart: 1, lineEnd: 1 },
    type: 'note', source: 'human', status: 'open', severity: 'medium', comment: 'Clarify this requirement.',
    thread: [], createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
    taskRevision: 1, taskStatus: 'pending'
  };
}

async function setup() {
  const h = await createProviderHarness('New target.\n\nOther text.');
  const thread = reviewThread();
  const review = (threads: ReviewThread[]) => ({
    documentUri: thread.documentUri, threads, updatedAt: '', taskSchemaVersion: 3 as const
  });
  const render = () => h.provider.renderHtml(h.webview, h.document, review([thread]));
  return { h, render };
}

describe('simplified comment management', () => {
  it('does not render reattach controls, history, or location status labels', async () => {
    const { render } = await setup();
    const dom = runWebview(render());
    for (const selector of ['[data-reanchor-thread]', '#review-reanchor', '.history-heading', '.is-closed']) {
      assert.equal(dom.document.querySelector(selector), undefined, selector);
    }
    const visibleReviewText = [
      dom.document.querySelector('.review-actions')?.textContent || '',
      dom.document.querySelector('#review-sidebar')?.textContent || ''
    ].join(' ');
    assert.doesNotMatch(visibleReviewText, /Reattach|Reanchor|Locating|Located|pending/i);
  });

  it('keeps the user comment edit and delete controls', async () => {
    const { render } = await setup();
    const dom = runWebview(render());
    assert.ok(dom.document.querySelector('[data-edit-comment]'));
    assert.ok(dom.document.querySelector('[data-remove-comment]'));
  });

  it('ignores retired reattach and conversation messages', async () => {
    const { h } = await setup();
    await h.open();
    for (const type of ['reanchorThread', 'restoreThread', 'addReply', 'updateStatus']) {
      await h.message({ type, requestId: type, documentVersion: 1, threadId: 'rv_missing' });
    }
    assert.equal(h.edits.length, 0);
    assert.equal(h.saveCount, 0);
    assert.equal(h.warnings.length, 0);
  });
});
