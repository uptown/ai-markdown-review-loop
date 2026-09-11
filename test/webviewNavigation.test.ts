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
  return runWebview(h.provider.renderHtml(h.webview, h.document, document(open), document(closed)));
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

  it('distinguishes first-use empty state from completed feedback', async () => {
    const fresh = await reviewDom([]);
    assert.equal(fresh.document.getElementById('threads').textContent, 'Select text in the document to add a change request.');
    assert.equal(fresh.document.querySelector('[data-review-position]').textContent, 'No open comments');
    assert.equal(fresh.document.querySelector('[data-review-nav="next"]').disabled, true);
    const completed = await reviewDom([], [thread('rv_closed', 'Shared target.', 1, 'resolved')]);
    assert.equal(completed.document.getElementById('threads').textContent, 'No pending requests. Review the revised document again.');
    assert.ok(completed.document.querySelector('.is-closed [data-jump-thread]'));
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

  it('offers the same keyboard source destination for linked closed feedback', async () => {
    const dom = await reviewDom([], [thread('rv_closed', 'Shared target.', 1, 'resolved')]);
    const source = dom.document.querySelector('#markdown-body p');
    let focused = false;
    Object.defineProperty(source, 'focus', { value: () => { focused = true; } });
    dom.dispatch(dom.document.querySelector('.is-closed [data-jump-thread]'), 'click');
    assert.equal(focused, true);
    assert.equal(source.getAttribute('tabindex'), '-1');
    assert.equal(dom.document.querySelector('.is-closed').getAttribute('aria-current'), 'true');
  });

  it('navigates a verified multi-block history span even when Markdown syntax is absent from rendered text', async () => {
    const source = '# Updated heading\n\nFirst revised paragraph.\n\nSecond revised paragraph.';
    const closed = thread('rv_multiblock', '# Updated heading First revised paragraph. Second revised paragraph.', 1, 'accepted');
    closed.anchor.lineEnd = 5;
    const dom = await reviewDom([], [closed], source);
    const heading = dom.document.querySelector('#markdown-body h1');
    let focused = false;
    Object.defineProperty(heading, 'focus', { value: () => { focused = true; } });
    assert.equal(dom.evaluate('state.historyAnchorLocations.rv_multiblock.lineEnd'), 5);
    dom.dispatch(dom.document.querySelector('.is-closed [data-jump-thread]'), 'click');
    assert.equal(focused, true);
    assert.equal(heading.classList.contains('history-anchor-target'), true);
  });

  it('uses the verified current history location after source moved instead of a stale line hint', async () => {
    const source = 'Intro\n\nBefore\n\n# Heading\n\nRevised paragraph.\n\nAfter';
    const closed = thread('rv_moved', '# Heading Revised paragraph.', 1, 'resolved');
    closed.anchor = { ...closed.anchor, occurrence: 0, contextBefore: 'Before', contextAfter: 'After' };
    const dom = await reviewDom([], [closed], source);
    assert.equal(dom.evaluate('state.historyAnchorLocations.rv_moved.lineStart'), 5);
    assert.equal(dom.evaluate('findHistoryAnchorElement(closedThreads[0]).tagName'), 'H1');
  });

  it('does not use stale line hints as a source fallback for outdated or ambiguous closed feedback', async () => {
    const removed = thread('rv_removed', '# Removed Missing paragraph.', 1, 'resolved');
    const dom = await reviewDom([], [removed], '# Current\n\nOther paragraph.');
    assert.equal(dom.evaluate('state.historyAnchorLocations.rv_removed'), undefined);
    assert.equal(dom.evaluate('findHistoryAnchorElement(closedThreads[0])'), undefined);
    const duplicate = thread('rv_ambiguous', '# Heading Paragraph.', 99, 'resolved');
    duplicate.anchor.occurrence = 0;
    const ambiguous = await reviewDom([], [duplicate], '# Heading\n\nParagraph.\n\n# Heading\n\nParagraph.');
    assert.equal(ambiguous.evaluate('state.historyAnchorLocations.rv_ambiguous'), undefined);
    assert.equal(ambiguous.evaluate('findHistoryAnchorElement(closedThreads[0])'), undefined);
  });
});
