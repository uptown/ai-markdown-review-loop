import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReanchorSelection } from '../src/reanchorThread';
import { createReviewAnchorIdentityKey } from '../src/reviewAnchorIdentity';
import { createProviderHarness, runWebview } from './helpers/providerHarness';
import type { ReviewThread } from '../src/types';

function reviewThread(): ReviewThread {
  return {
    id: 'rv_missing', documentUri: 'file:///project/spec.md',
    anchor: { text: 'Removed text', confidence: 'missing', lineStart: 1, lineEnd: 1 },
    type: 'note', source: 'human', status: 'open', severity: 'medium', comment: 'Clarify this requirement.',
    thread: [{ role: 'user', text: 'Keep this discussion.', createdAt: '2026-09-09T00:00:00Z' }],
    createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z'
  };
}

async function setup() {
  const h = await createProviderHarness('New target.\n\nOther text.');
  let thread = reviewThread();
  const review = () => ({ documentUri: thread.documentUri, threads: [thread], updatedAt: thread.updatedAt });
  const updates: any[] = [];
  h.store.load = async () => review();
  h.store.updateThread = async (_uri: unknown, id: string, update: Partial<ReviewThread>) => {
    assert.equal(id, thread.id);
    updates.push(update);
    thread = { ...thread, ...update };
    return review();
  };
  const render = () => h.provider.renderHtml(h.webview, h.document, review(), { ...review(), threads: [] });
  return { h, updates, render, thread: () => thread, setThread: (value: ReviewThread) => { thread = value; } };
}

function selectTarget(dom: ReturnType<typeof runWebview>) {
  // Layout/Selection is the browser seam; the actual registered selectionchange,
  // confirm, request and result handlers below are the shipped webview code.
  dom.evaluate(`captureCurrentSelection = () => {
    activeSelectionText = 'New target'; activeSourceLine = 1; activeSourceLineEnd = 1; return true;
  }`);
  const text = dom.document.createTextNode('New target.');
  dom.window.getSelection = () => ({ getRangeAt: () => ({ startContainer: text, startOffset: 0, endContainer: text, endOffset: 10 }) });
  dom.dispatch(dom.document, 'selectionchange');
}

function resultEvent(dom: ReturnType<typeof runWebview>, requestId: string, ok: boolean, error?: string) {
  const event = new dom.window.Event('message');
  Object.defineProperty(event, 'data', { value: { type: 'reviewMutationResult', requestId, ok, error } });
  dom.window.dispatchEvent(event);
}

describe('manual review reattachment', () => {
  it('finds a unique current source span across whitespace and rejects ambiguous or stale selections', () => {
    const selected = resolveReanchorSelection('First\r\n  new target.', { anchorText: 'First new target', sourceLine: 1, sourceLineEnd: 2 });
    assert.equal(selected.text, 'First\r\n  new target');
    assert.equal(selected.lineEnd, 2);
    assert.throws(() => resolveReanchorSelection('New target', { anchorText: 'Old target', sourceLine: 1, sourceLineEnd: 1 }), /does not match/);
    assert.throws(() => resolveReanchorSelection('Pending and Pending', { anchorText: 'Pending', sourceLine: 1, sourceLineEnd: 1 }), /more than one/);
    assert.equal(resolveReanchorSelection('Pending and Pending', {
      anchorText: 'Pending', sourceLine: 1, sourceLineEnd: 1, contextBefore: 'Pending and'
    }).start, 12);
    assert.equal(resolveReanchorSelection('Use f(x) [a+b] once.', {
      anchorText: 'f(x) [a+b]', sourceLine: 1, sourceLineEnd: 1
    }).text, 'f(x) [a+b]');
  });

  it('keeps identity and history while explicitly replacing only the anchor', async () => {
    const { h, thread, updates } = await setup();
    const previous = structuredClone(thread());
    await h.open();
    await h.message({ type: 'reanchorThread', requestId: 'reattach-success', documentVersion: 1,
      threadId: previous.id, anchorIdentity: createReviewAnchorIdentityKey(previous),
      anchorText: 'New target', sourceLine: 1, sourceLineEnd: 1 });
    assert.equal(updates.length, 1);
    assert.equal(thread().id, previous.id);
    assert.equal(thread().status, 'open');
    assert.equal(thread().anchor.text, 'New target');
    assert.equal(thread().anchor.confidence, 'exact');
    assert.deepEqual(thread().thread[0], previous.thread[0]);
    assert.deepEqual(thread().thread, previous.thread);
    assert.equal(updates[0].thread, undefined);
    assert.equal(h.edits.length, 0);
  });

  it('refuses stale documents, changed anchors and closed threads without rewriting review state', async () => {
    for (const failure of ['version', 'anchor', 'closed'] as const) {
      const { h, thread, setThread, updates } = await setup();
      const identity = createReviewAnchorIdentityKey(thread());
      await h.open();
      if (failure === 'version') h.changeText('Changed source');
      if (failure === 'anchor') setThread({ ...thread(), anchor: { text: 'Elsewhere', lineStart: 3 } });
      if (failure === 'closed') setThread({ ...thread(), status: 'resolved' });
      await h.message({ type: 'reanchorThread', requestId: failure, documentVersion: 1,
        threadId: thread().id, anchorIdentity: identity, anchorText: 'New target', sourceLine: 1, sourceLineEnd: 1 });
      assert.equal(updates.length, 0, failure);
      assert.equal(h.edits.length, 0, failure);
      assert.ok(h.warnings.length, failure);
    }
  });

  it('requires selection and explicit confirmation, retains failed selection and waits for the matching acknowledgement', async () => {
    const { render } = await setup();
    const dom = runWebview(render());
    dom.dispatch(dom.document.querySelector('[data-reanchor-thread]'), 'click');
    const confirm = dom.document.getElementById('review-reanchor-confirm');
    assert.equal(confirm.disabled, true);
    assert.equal(dom.messages.some((message: any) => message.type === 'reanchorThread'), false);
    selectTarget(dom);
    assert.equal(confirm.disabled, false);
    dom.dispatch(confirm, 'click');
    const request = dom.messages.find((message: any) => message.type === 'reanchorThread');
    assert.equal(request.anchorText, 'New target');
    assert.equal(request.documentVersion, 1);
    assert.equal(confirm.disabled, true);
    resultEvent(dom, 'unrelated', true);
    assert.equal(dom.document.getElementById('review-reanchor').hidden, false);
    resultEvent(dom, request.requestId, false, 'Write failed. Retry.');
    assert.equal(confirm.disabled, false);
    assert.equal(dom.document.getElementById('review-reanchor-selection').textContent, 'New target');
    assert.match(dom.document.getElementById('review-reanchor-status').textContent, /Write failed/);
    dom.dispatch(confirm, 'click');
    const retry = dom.messages.filter((message: any) => message.type === 'reanchorThread').at(-1);
    assert.notEqual(retry.requestId, request.requestId);
    resultEvent(dom, retry.requestId, true);
    assert.equal(dom.document.getElementById('review-reanchor').hidden, true);
  });

  it('cancels with Escape and preserves another form draft instead of starting selection mode', async () => {
    const { render } = await setup();
    const dom = runWebview(render());
    const button = dom.document.querySelector('[data-reanchor-thread]');
    dom.dispatch(button, 'click');
    const event = new dom.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value: 'Escape' });
    dom.document.dispatchEvent(event);
    assert.equal(dom.document.getElementById('review-reanchor').hidden, true);
    const draft = dom.document.getElementById('comment-body');
    draft.value = 'Unsaved feedback.';
    dom.document.getElementById('comment-composer').style.display = 'block';
    dom.dispatch(button, 'click');
    assert.equal(draft.value, 'Unsaved feedback.');
    assert.match(dom.document.getElementById('review-reanchor-status').textContent, /draft has been kept/);
    assert.equal(dom.document.getElementById('review-reanchor-confirm').disabled, true);
  });

  it('stops selection capture if another comment draft is started during reattachment', async () => {
    const { render } = await setup();
    const dom = runWebview(render());
    dom.dispatch(dom.document.querySelector('[data-reanchor-thread]'), 'click');
    const draft = dom.document.getElementById('comment-body');
    draft.value = 'Keep this selection and feedback.';
    dom.evaluate(`activeSelectionText = 'Original draft target';`);
    selectTarget(dom);
    assert.equal(dom.evaluate('activeSelectionText'), 'Original draft target');
    assert.equal(dom.document.getElementById('review-reanchor-confirm').disabled, true);
    assert.equal(draft.value, 'Keep this selection and feedback.');
  });
  it('keeps reattachment available while an external agent works on the JSON', async () => {
    const { h, render } = await setup();
    const dom = runWebview(render());
    dom.dispatch(dom.document.querySelector('[data-reanchor-thread]'), 'click');
    selectTarget(dom);
    const confirm = dom.document.getElementById('review-reanchor-confirm');
    assert.equal(confirm.disabled, false);
    dom.dispatch(confirm,'click');
    const message = dom.messages.find(message=>message.type==='reanchorThread');
    assert.equal(message.anchorText,'New target');
    await h.open();
    await h.message(message);
    assert.equal(h.postedMessages.find(result=>result.type==='reviewMutationResult').ok,true);
  });

});
