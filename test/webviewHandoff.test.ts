import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHarness, runWebview } from './helpers/providerHarness';
import type { ReviewThread } from '../src/types';

function task(id = 'rv_request', status: 'pending' | 'done' | 'blocked' = 'pending'): ReviewThread {
  return {
    id, documentUri: 'file:///project/spec.md', anchor: { text: 'First.', lineStart: 1, lineEnd: 1, confidence: 'exact' },
    type: 'note', source: 'human', status: status === 'done' ? 'resolved' : 'open', severity: 'medium',
    comment: 'Explain the recovery behavior.', thread: [], createdAt: '', updatedAt: '',
    taskRevision: 1, taskStatus: status, ...(status === 'pending' ? {} : { taskResult: 'Recovery steps recorded.', taskResultFor: 1 })
  };
}

async function setup(open: ReviewThread[] = [task()], closed: ReviewThread[] = []) {
  const h = await createProviderHarness('First.\n\nSecond.');
  const review = (threads: ReviewThread[]) => ({ documentUri: h.document.uri.toString(), threads, updatedAt: '', taskSchemaVersion: 3 as const });
  h.store.load = async () => review(open);
  h.store.loadResolved = async () => review(closed);
  const render = () => h.provider.renderHtml(h.webview, h.document, review(open), review(closed));
  return { h, render, open, closed };
}

function startComment(dom: ReturnType<typeof runWebview>, text: string) {
  dom.evaluate(`activeSelectionText = 'First.'; activeSelectionRect = {left:0,right:100,top:0,bottom:40}; activeSourceLine = 1; activeSourceLineEnd = 1; openComposer();`);
  const input = dom.document.getElementById('comment-body');
  input.value = text;
  dom.dispatch(input, 'input');
}

function editRequest(dom: ReturnType<typeof runWebview>, text: string) {
  dom.dispatch(dom.document.querySelector('[data-edit-comment]'), 'click');
  const input = dom.document.getElementById('comment-body');
  input.value = text;
  dom.dispatch(input, 'input');
}

describe('external agent handoff webview', () => {
  it('initializes a restored handoff before waiting for webview message readiness', async () => {
    for (const phase of ['preparing', 'handedOff'] as const) {
      const { h } = await setup(); h.setHandoffPhase(phase);
      let ready!: () => void;
      const readiness = new Promise<void>(resolve => { ready = resolve; });
      let messagesBeforeReady = 0;
      h.webview.postMessage = async () => { messagesBeforeReady++; await readiness; return true; };
      const opening = h.open();
      await new Promise(resolve => setImmediate(resolve));
      const initialHtml = h.webview.html;
      const initialMessages = messagesBeforeReady;
      ready(); await opening;
      assert.match(initialHtml, /data-handoff-primary/);
      assert.match(initialHtml, new RegExp(phase === 'preparing' ? 'Preparing Handoff' : 'Review Changes'));
      assert.equal(initialMessages, 0);
      h.setHandoffPhase(undefined);
      await h.provider.refreshDocument(h.document.uri);
      assert.equal(messagesBeforeReady, 1, 'existing previews still receive phase updates');
    }
  });

  it('replaces conversations and patch approval with one handoff and request actions', async () => {
    const legacy = task();
    legacy.source = 'ai';
    legacy.thread = [{ role: 'assistant', text: 'An old discussion.', createdAt: '' }];
    legacy.suggestedPatch = { mode: 'replace', original: 'First.', replacement: 'Changed.' };
    const { render } = await setup([legacy]);
    const dom = runWebview(render());
    assert.equal(dom.document.querySelectorAll('[data-handoff-primary]').length, 1);
    assert.equal(dom.document.querySelector('[data-handoff-primary]').textContent, 'Send to Agent');
    for (const selector of ['[data-reply-form]', '[data-reply-template]', '[data-apply-suggested-patch]', '[data-open-feedback-loop-prompt]', '[data-open-context-bootstrap-prompt]']) {
      assert.equal(dom.document.querySelector(selector), undefined, selector);
    }
    assert.ok(dom.document.querySelector('[data-edit-comment]'));
    assert.ok(dom.document.querySelector('[data-remove-comment]'));
    assert.equal(dom.document.getElementById('threads').textContent.includes('An old discussion.'), false);
    assert.equal(dom.document.querySelector('.review-badge').textContent, 'Comment');
    assert.equal(dom.messages.some(message => message.type === 'anchorLocated'), false);
  });

  it('dispatches every handoff and recovery command against the viewed Markdown', async () => {
    const { h } = await setup();
    await h.open();
    for (const type of ['handoff', 'resumeReview', 'cancelHandoff', 'copyReviewFile', 'openReviewFile', 'openReviewHistory', 'restoreReviewBackup']) {
      await h.message({type});
      const [command, uri] = h.executedCommands.at(-1);
      assert.equal(command, 'aiMarkdownReviewLoop.' + type);
      assert.equal(uri, h.document.uri);
    }
    assert.equal(h.edits.length, 0);
  });

  it('stores a new comment as a local draft during handoff and saves only after resuming', async () => {
    const { h, render } = await setup();
    h.setHandoffPhase('handedOff');
    const dom = runWebview(render());
    startComment(dom, 'Keep this next-review request.');
    const form = dom.document.getElementById('comment-composer');
    assert.equal(form.querySelector('button[type="submit"]').disabled, true);
    dom.dispatch(form, 'submit');
    assert.equal(dom.messages.some(message => message.type === 'addComment'), false);
    assert.equal(dom.savedState.drafts.comment.text, 'Keep this next-review request.');
    assert.equal(dom.document.querySelector('[data-handoff-primary]').textContent, 'Review Changes');
    h.setHandoffPhase(undefined);
    const resumed = runWebview(render(), dom.savedState);
    const resumedForm = resumed.document.getElementById('comment-composer');
    assert.equal(resumedForm.querySelector('button[type="submit"]').disabled, false);
    resumed.dispatch(resumedForm, 'submit');
    const sent = resumed.messages.find(message => message.type === 'addComment');
    assert.equal(sent.comment, 'Keep this next-review request.');
    assert.equal(sent.anchorText, 'First.');
    assert.ok(sent.requestId);
  });

  it('recovers next-review draft text without submitting the old target after external source changes', async () => {
    const { h, render } = await setup();
    h.setHandoffPhase('handedOff');
    const dom = runWebview(render());
    startComment(dom, 'An unsaved request on the earlier source.');
    h.changeText('The agent replaced the paragraph.');
    h.setHandoffPhase(undefined);
    const resumed = runWebview(render(), dom.savedState);
    assert.match(resumed.document.querySelector('.draft-recovery').textContent, /document changed/);
    assert.equal(resumed.document.querySelector('.draft-recovery textarea').value, 'An unsaved request on the earlier source.');
    assert.equal(resumed.messages.some(message => message.type === 'addComment'), false);
  });

  it('pauses existing editor drafts and visible write controls as soon as preparation starts', async () => {
    const { render } = await setup();
    const dom = runWebview(render());
    dom.dispatch(dom.document.querySelector('[data-edit-markdown-block]'), 'click');
    const surface = dom.document.getElementById('block-editor-surface');
    surface.querySelector('p').textContent = 'Keep my rich draft.';
    dom.dispatch(surface, 'input');
    dom.receive({type:'handoffPhase',phase:'preparing'});
    assert.equal(dom.document.getElementById('block-editor-submit').disabled, true);
    assert.equal(dom.document.querySelector('[data-edit-comment]').disabled, true);
    assert.equal(dom.document.querySelector('[data-handoff-primary]').disabled, true);
    assert.match(dom.document.querySelector('[data-handoff-status]').textContent, /Preparing handoff/);
    dom.dispatch(dom.document.getElementById('block-editor'), 'submit');
    assert.equal(dom.messages.some(message => message.type === 'editMarkdownBlock'), false);
    assert.match(dom.savedState.drafts.block.html, /Keep my rich draft/);
    dom.receive({type:'handoffPhase'});
    assert.equal(dom.document.getElementById('block-editor-submit').disabled, false);
    assert.equal(surface.textContent, 'Keep my rich draft.');
  });

  it('rejects direct stale webview writes at the host boundary while handed off', async () => {
    const { h } = await setup();
    await h.open();
    h.setHandoffPhase('handedOff');
    for (const type of ['addComment','editComment','removeComment','restoreThread','reanchorThread','editMarkdownBlock','insertMarkdownBlock','editMarkdownTable','editMermaidSource']) {
      await h.message({type,requestId:type,documentVersion:1,threadId:'rv_request',comment:'Lost update?',anchorText:'First.',lineStart:1,lineEnd:1,intent:'manual_block_edit',rawMarkdown:'Changed.'});
      const result = h.postedMessages.find(message => message.type === 'reviewMutationResult' && message.requestId === type);
      assert.equal(result.ok, false, type);
      assert.match(result.error, /writes are paused/, type);
    }
    await h.message({type:'deleteMarkdownBlock',documentVersion:1,lineStart:1,lineEnd:1});
    assert.equal(h.edits.length, 0);
    assert.equal(h.saveCount, 0);
  });

  it('unlocks an optimistic preparation after command failure even if the preview cannot reload', async () => {
    const { h, render } = await setup();
    await h.open();
    const dom = runWebview(render());
    startComment(dom, 'Keep the unsaved request.');
    dom.dispatch(dom.document.querySelector('[data-handoff-primary]'), 'click');
    assert.equal(dom.document.querySelector('[data-handoff-primary]').disabled, true);
    h.vscode.commands.executeCommand = async () => { throw new Error('Clipboard unavailable'); };
    h.store.load = async () => { throw new Error('Sidecar temporarily unreadable'); };
    await h.message(dom.messages.find(message => message.type === 'handoff'));
    for (const message of h.postedMessages) dom.receive(message);
    assert.equal(dom.document.querySelector('[data-handoff-primary]').disabled, false);
    assert.equal(dom.document.querySelector('[data-handoff-primary]').textContent, 'Send to Agent');
    assert.equal(dom.document.getElementById('comment-body').value, 'Keep the unsaved request.');
    assert.match(dom.document.getElementById('review-refresh-error').textContent, /Sidecar temporarily unreadable/);
  });

  it('keeps table-cell comment drafting available while direct table edits are paused', async () => {
    const h = await createProviderHarness('| A | B |\n| --- | --- |\n| one | two |');
    h.setHandoffPhase('handedOff');
    const dom = runWebview(h.render());
    assert.equal(dom.document.querySelector('[data-edit-markdown-table]').disabled, true);
    const comment = dom.document.querySelector('[data-comment-markdown-table-cell]');
    assert.ok(comment);
    dom.dispatch(comment, 'click');
    const input = dom.document.getElementById('comment-body');
    input.value = 'Review this cell in the next pass.';
    dom.dispatch(input, 'input');
    assert.equal(dom.savedState.drafts.comment.anchorText, 'A');
    assert.equal(dom.document.getElementById('comment-composer').querySelector('button[type="submit"]').disabled, true);
  });

  it('edits a request with its revision, retaining the text on a failed save', async () => {
    const { h, render } = await setup();
    const changes: any[] = [];
    h.store.updateComment = async (...args: any[]) => { changes.push(args); throw new Error('Conflict; request was changed.'); };
    await h.open();
    const dom = runWebview(render());
    editRequest(dom, 'Explain exactly how to retry.');
    dom.dispatch(dom.document.getElementById('comment-composer'), 'submit');
    const message = dom.messages.find(value => value.type === 'editComment');
    assert.equal(message.taskRevision, 1);
    assert.equal(message.threadId, 'rv_request');
    await h.message(message);
    const result = h.postedMessages.find(value => value.type === 'reviewMutationResult');
    dom.receive(result);
    assert.equal(changes[0][3], 1);
    assert.equal(dom.document.getElementById('comment-body').value, 'Explain exactly how to retry.');
    assert.equal(dom.document.getElementById('comment-composer').querySelector('button[type="submit"]').disabled, false);
    assert.match(dom.document.getElementById('comment-composer').textContent, /Conflict/);
  });

  it('keeps an edited-request draft as copy recovery when the request revision changed', async () => {
    const { render, open } = await setup();
    const dom = runWebview(render());
    editRequest(dom, 'My updated requirement.');
    open[0].comment = 'A different current request.';
    open[0].taskRevision = 2;
    const next = runWebview(render(), dom.savedState);
    assert.match(next.document.querySelector('.draft-recovery').textContent, /change request changed/);
    assert.equal(next.document.querySelector('.draft-recovery textarea').value, 'My updated requirement.');
    assert.equal(next.messages.some(value => value.type === 'editComment'), false);
  });

  it('shows task outcomes and optional reopen without treating legacy closure as agent completion', async () => {
    const legacy = task('rv_legacy');
    delete legacy.taskStatus;
    delete legacy.taskRevision;
    legacy.status = 'accepted';
    const { render } = await setup([task('rv_pending'),task('rv_blocked','blocked')],[task('rv_done','done'),legacy]);
    const dom = runWebview(render());
    assert.equal(dom.document.querySelector('[data-review-summary]').textContent, '1 done · 1 pending · 1 blocked');
    assert.equal(dom.document.querySelector('.history-heading').hasAttribute('open'), false);
    assert.match(dom.document.querySelector('.is-closed[data-thread-id="rv_done"]').textContent, /Done.*Recovery steps recorded/);
    assert.ok(dom.document.querySelector('.is-closed[data-thread-id="rv_done"] [data-restore-thread]'));
    assert.equal(dom.document.querySelector('.is-closed[data-thread-id="rv_legacy"] [data-restore-thread]'), undefined);
    assert.match(dom.document.querySelector('.is-closed[data-thread-id="rv_legacy"]').textContent, /Legacy/);
  });

  it('counts outdated blocked reports as pending and keeps review resumption available with no open requests', async () => {
    const stale = task('rv_stale', 'blocked'); stale.taskRevision = 2;
    const { render, h, open } = await setup([stale], [task('rv_done', 'done')]);
    assert.equal(runWebview(render()).document.querySelector('[data-review-summary]').textContent, '1 done · 1 pending · 0 blocked');
    open.splice(0);
    const empty = runWebview(render());
    assert.equal(empty.document.querySelector('[data-handoff-primary]').disabled, true);
    h.setHandoffPhase('handedOff');
    const paused = runWebview(render());
    assert.equal(paused.document.querySelector('[data-handoff-primary]').disabled, false);
    assert.equal(paused.document.querySelector('[data-handoff-primary]').textContent, 'Review Changes');
  });

  it('ignores retired conversation, patch and prompt messages without changing source', async () => {
    const { h } = await setup();
    await h.open();
    for (const type of ['addReply','updateStatus','applySuggestedPatch','openContextBootstrapPrompt','openFeedbackLoopPrompt']) {
      await h.message({type,documentVersion:1,threadId:'rv_request',text:'Unexpected conversation'});
    }
    assert.equal(h.executedCommands.length, 0);
    assert.equal(h.edits.length, 0);
    assert.equal(h.saveCount, 0);
  });
});
