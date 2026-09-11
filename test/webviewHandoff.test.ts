import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHarness, runWebview } from './helpers/providerHarness';
import type { ReviewThread } from '../src/types';

function task(id = 'rv_request', status: 'pending' | 'done' | 'blocked' = 'pending'): ReviewThread {
  return {
    id, documentUri: 'file:///project/spec.md', anchor: { text: 'First.', lineStart: 1, lineEnd: 1, confidence: 'exact' },
    type: 'note', source: 'human', status: status === 'done' ? 'resolved' : 'open', severity: 'medium',
    comment: 'Explain the recovery behavior.', thread: [], createdAt: '', updatedAt: '', taskRevision: 1,
    taskStatus: status, ...(status === 'pending' ? {} : { taskResult: 'Recovery steps recorded.', taskResultFor: 1 })
  };
}

async function setup(open: ReviewThread[] = [task()], closed: ReviewThread[] = []) {
  const h = await createProviderHarness('First.\n\nSecond.');
  const review = (threads: ReviewThread[]) => ({ documentUri: h.document.uri.toString(), threads, updatedAt: '', taskSchemaVersion: 3 as const });
  h.store.load = async () => review(open);
  h.store.loadResolved = async () => review(closed);
  const render = () => h.provider.renderHtml(h.webview, h.document, review(open));
  return { h, render, open, closed };
}

function startComment(dom: ReturnType<typeof runWebview>, text: string) {
  dom.evaluate(`activeSelectionText = 'First.'; activeSelectionRect = {left:0,right:100,top:0,bottom:40}; activeSourceLine = 1; activeSourceLineEnd = 1; openComposer();`);
  const input = dom.document.getElementById('comment-body');
  input.value = text;
  dom.dispatch(input, 'input');
}

describe('review JSON only webview', () => {
  it('renders one compact JSON action and no handoff or conversation controls', async () => {
    const legacy = task();
    legacy.thread = [{ role: 'assistant', text: 'An old discussion.', createdAt: '' }];
    legacy.suggestedPatch = { mode: 'replace', original: 'First.', replacement: 'Changed.' };
    const { render } = await setup([legacy]);
    const dom = runWebview(render());
    assert.equal(dom.document.querySelectorAll('[data-copy-review-json]').length, 1);
    assert.equal(dom.document.querySelector('[data-copy-review-json]').textContent, 'Copy Review JSON');
    for (const selector of ['[data-handoff-primary]', '[data-handoff-action]', '[data-reply-form]', '[data-apply-suggested-patch]', '[data-open-feedback-loop-prompt]', '[data-open-context-bootstrap-prompt]']) {
      assert.equal(dom.document.querySelector(selector), undefined, selector);
    }
    assert.ok(dom.document.querySelector('[data-edit-comment]'));
    assert.ok(dom.document.querySelector('[data-remove-comment]'));
  });

  it('dispatches only the JSON copy action from the preview', async () => {
    const { h, render } = await setup();
    await h.open();
    const dom = runWebview(render());
    dom.dispatch(dom.document.querySelector('[data-copy-review-json]'), 'click');
    assert.deepEqual(dom.messages.filter(message => message.type === 'copyReviewJson').map(message => message.type), ['copyReviewJson']);
    assert.equal(h.executedCommands.length, 0);
  });

  it('keeps comment drafts and write controls available without a handoff pause', async () => {
    const { h, render } = await setup();
    const dom = runWebview(render());
    startComment(dom, 'Keep this next review request.');
    const form = dom.document.getElementById('comment-composer');
    assert.equal(form.querySelector('button[type="submit"]').disabled, false);
    dom.dispatch(form, 'submit');
    const sent = dom.messages.find(message => message.type === 'addComment');
    assert.equal(sent.comment, 'Keep this next review request.');
    assert.equal(sent.anchorText, 'First.');
    assert.ok(sent.requestId);
    h.store.getReviewFileState = () => 'active';
  });

  it('shows a reviewable completion notice when the external agent removed the JSON', async () => {
    const { h, render } = await setup([], [task('rv_done', 'done')]);
    h.store.getReviewFileState = () => 'removed';
    const dom = runWebview(render());
    assert.match(dom.document.querySelector('.review-file-status').textContent, /removed by the external agent/);
    assert.equal(dom.document.querySelector('[data-copy-review-json]').disabled, true);
    assert.equal(dom.document.getElementById('threads').textContent, 'Select text in the document to add a comment.');
    assert.equal(dom.document.querySelector('.history-heading'), undefined);
    assert.equal(dom.document.querySelector('[data-reanchor-thread]'), undefined);
  });

  it('does not render retired conversation, patch, or prompt controls', async () => {
    const { h } = await setup();
    await h.open();
    for (const type of ['addReply', 'updateStatus', 'applySuggestedPatch', 'openContextBootstrapPrompt', 'openFeedbackLoopPrompt']) {
      await h.message({ type, documentVersion: 1, threadId: 'rv_request', text: 'Unexpected conversation' });
    }
    assert.equal(h.executedCommands.length, 0);
    assert.equal(h.edits.length, 0);
    assert.equal(h.saveCount, 0);
  });
});
