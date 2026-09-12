import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHarness, runWebview } from './helpers/providerHarness';
import type { ReviewThread } from '../src/types';

function thread(id: string, text: string, lineStart: number, status: ReviewThread['status'] = 'open'): ReviewThread {
  return {
    id, documentUri: 'file:///project/spec.md', anchor: { text, lineStart, lineEnd: lineStart },
    type: 'note', source: 'human', status, severity: 'medium', comment: 'Clarify ' + id,
    thread: [], createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z'
  };
}

async function reviewDom(open: ReviewThread[], closed: ReviewThread[] = [], source = 'Shared target.\n\nAnother target.') {
  const h = await createProviderHarness(source);
  const document = (threads: ReviewThread[]) => ({ documentUri: h.document.uri.toString(), threads, updatedAt: '' });
  return runWebview(h.provider.renderHtml(h.webview, h.document, document(open)));
}

describe('review navigation and keyboard destinations', () => {
  it('visits every thread when two comments share one source anchor', async () => {
    const image = '![Diagram](./diagram.png)';
    const dom = await reviewDom([thread('rv_a', image, 1), thread('rv_b', image, 1), thread('rv_c', 'Another target.', 3)], [], image + '\n\nAnother target.');
    const next = dom.document.querySelector('[data-review-nav="next"]');
    const visited: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      dom.dispatch(next, 'click');
      visited.push(dom.document.querySelector('.thread.is-active').getAttribute('data-thread-id'));
    }
    assert.deepEqual(visited, ['rv_a', 'rv_b', 'rv_c', 'rv_a']);
    assert.equal(dom.document.querySelector('[data-review-position]').textContent, '1 of 3');
    dom.dispatch(dom.document.querySelector('[data-review-nav="previous"]'), 'click');
    assert.equal(dom.document.querySelector('.thread.is-active').getAttribute('data-thread-id'), 'rv_c');
    assert.equal(dom.document.querySelector('[data-review-position]').textContent, '3 of 3');
  });

  it('provides a named source jump button that moves keyboard focus to the matching source', async () => {
    const dom = await reviewDom([thread('rv_a', 'Shared target.', 1)]);
    const button = dom.document.querySelector('.thread [data-jump-thread]');
    assert.ok(button);
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.textContent, 'Show in document');
    const badge = dom.document.querySelector('.review-badge');
    let focused = false;
    Object.defineProperty(badge, 'focus', { value: () => { focused = true; } });
    dom.dispatch(button, 'click');
    assert.equal(focused, true);
    assert.equal(dom.document.querySelector('.thread').getAttribute('aria-current'), 'true');
  });

  it('supports arrow navigation without consuming arrow keys inside comment fields', async () => {
    const dom = await reviewDom([thread('rv_a', 'Shared target.', 1), thread('rv_c', 'Another target.', 3)]);
    const rightArrow = (target: any) => {
      const event = new dom.window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: 'ArrowRight' });
      target.dispatchEvent(event);
    };
    rightArrow(dom.document.body);
    assert.equal(dom.document.querySelector('.thread.is-active').getAttribute('data-thread-id'), 'rv_a');
    rightArrow(dom.document.getElementById('comment-body'));
    assert.equal(dom.document.querySelector('.thread.is-active').getAttribute('data-thread-id'), 'rv_a');
    rightArrow(dom.document.body);
    assert.equal(dom.document.querySelector('.thread.is-active').getAttribute('data-thread-id'), 'rv_c');
    assert.equal(dom.document.querySelector('[data-review-nav="previous"]').getAttribute('aria-label'), 'Previous comment');
    assert.equal(dom.document.querySelector('[data-review-nav="next"]').getAttribute('aria-label'), 'Next comment');
  });

  it('keeps missing anchors reachable and announces navigation position without pretending to locate source', async () => {
    const missing = thread('rv_missing', 'Removed text.', 5);
    missing.anchor.confidence = 'missing';
    const dom = await reviewDom([missing]);
    const card = dom.document.querySelector('.thread');
    let focused = false;
    Object.defineProperty(card, 'focus', { value: () => { focused = true; } });
    dom.dispatch(dom.document.querySelector('[data-review-nav="next"]'), 'click');
    assert.equal(focused, true);
    assert.equal(card.getAttribute('tabindex'), '-1');
    assert.equal(dom.document.querySelector('[data-review-position]').textContent, '1 of 1');
    assert.equal(dom.document.querySelector('[data-review-position]').getAttribute('aria-live'), 'polite');
    assert.equal(dom.document.querySelector('.thread [data-jump-thread]').disabled, true);
  });

  it('uses one current-comment empty state regardless of prior agent outcomes', async () => {
    const fresh = await reviewDom([]);
    assert.equal(fresh.document.getElementById('threads').textContent, 'Select text in the document to add a comment.');
    assert.equal(fresh.document.querySelector('[data-review-position]').textContent, 'No comments');
    assert.equal(fresh.document.querySelector('[data-review-nav="next"]').disabled, true);
    const completed = await reviewDom([], [thread('rv_closed', 'Shared target.', 1, 'resolved')]);
    assert.equal(completed.document.getElementById('threads').textContent, 'Select text in the document to add a comment.');
    assert.equal(completed.document.querySelector('.history-heading'), undefined);
    assert.equal(completed.document.querySelector('[data-reanchor-thread]'), undefined);
  });

  it('respects reduced motion when jumping from a thread to its source', async () => {
    const dom = await reviewDom([thread('rv_a', 'Shared target.', 1)]);
    dom.window.matchMedia = () => ({ matches: true });
    const badge = dom.document.querySelector('.review-badge');
    let behavior = '';
    badge.scrollIntoView = (options: { behavior: string }) => { behavior = options.behavior; };
    dom.dispatch(dom.document.querySelector('.thread [data-jump-thread]'), 'click');
    assert.equal(behavior, 'auto');
  });

  it('toggles the comments sidebar and keeps the control keyboard accessible', async () => {
    const dom = await reviewDom([thread('rv_a', 'Shared target.', 1)]);
    const layout = dom.document.querySelector('.layout');
    const sidebar = dom.document.getElementById('review-sidebar');
    const toggle = dom.document.querySelector('[data-toggle-sidebar]');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(sidebar.hidden, false);
    dom.dispatch(toggle, 'click');
    assert.equal(sidebar.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.textContent, 'Show comments');
    assert.equal(layout.classList.contains('sidebar-collapsed'), true);
    dom.dispatch(toggle, 'click');
    assert.equal(sidebar.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.textContent, 'Hide comments');
  });
});
