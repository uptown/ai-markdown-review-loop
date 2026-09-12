import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHarness, runWebviewInEditMode as runWebview } from './helpers/providerHarness';

function change(dom: ReturnType<typeof runWebview>, id: string, value: string) {
  const input = dom.document.getElementById(id);
  if (input.tagName === 'DIV') input.querySelector('p').textContent = value;
  else input.value = value;
  dom.dispatch(input, 'input');
}

function openBlock(dom: ReturnType<typeof runWebview>) {
  dom.dispatch(dom.document.querySelector('[data-edit-markdown-block]'), 'click');
}

describe('draft persistence and save confirmation', () => {
  it('keeps an edit until acknowledged, blocks duplicate Save, and retains it on failure for retry', async () => {
    const h = await createProviderHarness('First.');
    const dom = runWebview(h.render());
    openBlock(dom);
    change(dom, 'block-editor-surface', 'My draft.');
    const form = dom.document.getElementById('block-editor');
    dom.dispatch(form, 'submit');
    dom.dispatch(form, 'submit');
    const submitted = dom.messages.filter(value => value.type === 'editMarkdownBlock');
    assert.equal(submitted.length, 1);
    assert.equal(form.style.display, 'block');
    assert.equal(form.getAttribute('aria-busy'), 'true');
    assert.equal(dom.document.getElementById('block-editor-submit').disabled, true);
    dom.receive({ type: 'reviewMutationResult', requestId: submitted[0].requestId, ok: false, error: 'Disk full. Retry after freeing space.' });
    assert.equal(dom.document.getElementById('block-editor-surface').textContent, 'My draft.');
    assert.equal(dom.document.getElementById('block-editor-submit').disabled, false);
    assert.match(form.textContent, /Disk full/);
    dom.dispatch(form, 'submit');
    const retry = dom.messages.filter(value => value.type === 'editMarkdownBlock')[1];
    assert.notEqual(retry.requestId, submitted[0].requestId);
    dom.receive({ type: 'reviewMutationResult', requestId: retry.requestId, ok: true });
    assert.equal(form.style.display, 'none');
    assert.deepEqual(dom.savedState.drafts, {});
  });

  it('restores rich edits after a sidecar-only render and clears only after a confirmed save', async () => {
    const h = await createProviderHarness('First.');
    const first = runWebview(h.render());
    openBlock(first);
    change(first, 'block-editor-surface', 'Unsaved words.');
    const next = runWebview(h.render(), first.savedState);
    assert.equal(next.document.getElementById('block-editor-surface').textContent, 'Unsaved words.');
    assert.equal(next.document.getElementById('block-editor').style.display, 'block');
    next.dispatch(next.document.getElementById('block-editor'), 'submit');
    assert.match(next.messages.find(value => value.type === 'editMarkdownBlock').html, /Unsaved words/);
  });

  it('recovers an old source draft for explicit copy without applying it to the new source', async () => {
    const h = await createProviderHarness('Original.');
    const first = runWebview(h.render());
    openBlock(first);
    change(first, 'block-editor-surface', 'My unsaved update.');
    h.changeText('Someone else rewrote this paragraph.');
    const next = runWebview(h.render(), first.savedState);
    const recovery = next.document.querySelector('.draft-recovery');
    assert.equal(recovery.hidden, false);
    assert.match(recovery.textContent, /document changed/i);
    assert.equal(recovery.querySelector('textarea').value, 'My unsaved update.');
    assert.equal(next.document.getElementById('block-editor').style.display, '');
    next.dispatch(recovery.querySelector('button'), 'click');
    const copy = next.messages.find(value => value.type === 'copyDraft');
    await h.open();
    await h.message(copy);
    assert.deepEqual(h.copiedTexts, ['My unsaved update.']);
    assert.equal(h.document.getText(), 'Someone else rewrote this paragraph.');
    next.dispatch(recovery.querySelectorAll('button')[1], 'click');
    assert.equal(recovery.hidden, true);
    assert.deepEqual(next.savedState.drafts, {});
  });

  it('preserves Mermaid and table drafts including row identities during refresh', async () => {
    const mermaid = await createProviderHarness('```mermaid\nflowchart TD\n A --> B\n```');
    const first = runWebview(mermaid.render());
    first.dispatch(first.document.querySelector('[data-mermaid-edit]'), 'click');
    change(first, 'mermaid-editor-source', 'flowchart TD\n A --> C');
    const restored = runWebview(mermaid.render(), first.savedState);
    assert.equal(restored.document.getElementById('mermaid-editor-source').value, 'flowchart TD\n A --> C');

    const h = await createProviderHarness('| A | B |\n| --- | --- |\n| one | two |\n| three | four |');
    const table = runWebview(h.render());
    table.dispatch(table.document.querySelector('[data-edit-markdown-table]'), 'click');
    table.dispatch(table.document.querySelector('[data-remove-table-row][data-row="0"]'), 'click');
    const next = runWebview(h.render(), table.savedState);
    next.dispatch(next.document.getElementById('table-editor'), 'submit');
    const message = next.messages.find(value => value.type === 'editMarkdownTable');
    assert.deepEqual(JSON.parse(JSON.stringify(message.rows)), [['three', 'four']]);
    assert.deepEqual(JSON.parse(JSON.stringify(message.tableSourceMapping.rowSources)), [1]);
  });

  it('restores a selected comment draft and preserves legacy reply drafts for copy recovery', async () => {
    const h = await createProviderHarness('First.');
    const dom = runWebview(h.render());
    dom.evaluate(`activeSelectionText = 'First.'; activeSelectionRect = {left:0,right:100,top:0,bottom:40}; activeSourceLine = 1; openComposer();`);
    change(dom, 'comment-body', 'Please clarify this requirement.');
    const saved = dom.savedState;
    saved.drafts['reply:rv_later'] = {kind:'reply', threadId:'rv_later', text:'Keep this independent reply.'};
    const next = runWebview(h.render(), saved);
    assert.equal(next.document.getElementById('comment-body').value, 'Please clarify this requirement.');
    next.dispatch(next.document.getElementById('comment-composer'), 'submit');
    const message = next.messages.find(value => value.type === 'addComment');
    next.receive({type:'reviewMutationResult', requestId:message.requestId, ok:true});
    assert.equal(next.savedState.drafts.comment, undefined);
    assert.equal(next.savedState.drafts['reply:rv_later'].text, 'Keep this independent reply.');
    assert.match(next.document.querySelector('.draft-recovery').textContent, /draft from an earlier reply/);
  });

  it('uses render-carried confirmations when an earlier webview missed the save response', async () => {
    const h = await createProviderHarness('First.');
    const dom = runWebview(h.render());
    openBlock(dom);
    change(dom, 'block-editor-surface', 'Saved change.');
    dom.dispatch(dom.document.getElementById('block-editor'), 'submit');
    await h.open();
    await h.message(dom.messages.find(value => value.type === 'editMarkdownBlock'));
    const next = runWebview(h.webview.html, dom.savedState);
    assert.deepEqual(next.savedState.drafts, {});
    assert.equal(next.document.querySelector('.draft-recovery').hidden, true);
    assert.equal(h.document.getText(), 'Saved change.');
  });

  it('keeps an unconfirmed submission available for copy and never silently resubmits after reload', async () => {
    const h = await createProviderHarness('First.');
    const dom = runWebview(h.render());
    openBlock(dom);
    change(dom, 'block-editor-surface', 'Unconfirmed change.');
    dom.dispatch(dom.document.getElementById('block-editor'), 'submit');
    const next = runWebview(h.render(), dom.savedState);
    assert.match(next.document.querySelector('.draft-recovery').textContent, /confirmation is unavailable/);
    assert.equal(next.messages.filter(value => value.type === 'editMarkdownBlock').length, 0);
  });

  it('does not restore another document drafts and removes active markup from restored rich HTML', async () => {
    const h = await createProviderHarness('First.');
    const dom = runWebview(h.render());
    openBlock(dom);
    change(dom, 'block-editor-surface', 'Kept.');
    const saved = dom.savedState;
    saved.drafts.block.html += '<script>window.pwned = true</script><img src="javascript:alert(1)" onerror="alert(1)">';
    const restored = runWebview(h.render(), saved);
    assert.ok(!restored.document.querySelector('#block-editor-surface script'));
    assert.ok(!restored.document.querySelector('#block-editor-surface [onerror]'));
    assert.equal(restored.document.querySelector('#block-editor-surface img').hasAttribute('src'), false);
    saved.documentUri = 'file:///different.md';
    const other = runWebview(h.render(), saved);
    assert.deepEqual(other.savedState.drafts, {});
  });

  it('does not bring a deliberately cancelled draft back on refresh', async () => {
    const h = await createProviderHarness('First.');
    const dom = runWebview(h.render());
    openBlock(dom);
    change(dom, 'block-editor-surface', 'Discarded.');
    dom.dispatch(dom.document.getElementById('block-editor-cancel'), 'click');
    const next = runWebview(h.render(), dom.savedState);
    assert.deepEqual(next.savedState.drafts, {});
    assert.equal(next.document.getElementById('block-editor').style.display, '');
  });

  it('keeps legacy reply drafts available for copy without recreating a conversation UI', async () => {
    const h = await createProviderHarness('Shared target.');
    const initial = runWebview(h.render());
    const saved = initial.savedState;
    saved.drafts['reply:rv_previous'] = {kind:'reply',threadId:'rv_previous',text:'Keep the earlier decision.'};
    const dom = runWebview(h.render(), saved);
    assert.equal(dom.document.querySelector('[data-reply-form]'), undefined);
    assert.match(dom.document.querySelector('.draft-recovery').textContent, /draft from an earlier reply/);
    dom.dispatch(dom.document.querySelector('.draft-recovery button'), 'click');
    assert.equal(dom.messages.find(value => value.type === 'copyDraft').text, 'Keep the earlier decision.');
    assert.equal(dom.savedState.drafts['reply:rv_previous'].text, 'Keep the earlier decision.');
  });

  it('does not replace a pending table edit with another table target', async () => {
    const h = await createProviderHarness('| A | B |\n| --- | --- |\n| one | two |\n\n| C | D |\n| --- | --- |\n| three | four |');
    const dom = runWebview(h.render());
    const controls = dom.document.querySelectorAll('[data-edit-markdown-table]');
    dom.dispatch(controls[0], 'click');
    dom.dispatch(dom.document.getElementById('table-editor'), 'submit');
    dom.dispatch(controls[1], 'click');
    const cell = dom.document.querySelector('[data-table-cell]');
    assert.equal(cell.value, 'one');
    assert.equal(cell.disabled, true);
    assert.equal(dom.savedState.drafts.table.edit.lineStart, 1);
  });

  it('drops a draft when local Undo restores the original block, table or Mermaid content', async () => {
    const h = await createProviderHarness('First.');
    const dom = runWebview(h.render());
    openBlock(dom);
    change(dom, 'block-editor-surface', 'Edited.');
    change(dom, 'block-editor-surface', 'First.');
    assert.equal(dom.savedState.drafts.block, undefined);
    const mermaid = await createProviderHarness('```mermaid\nflowchart TD\n A --> B\n```');
    const m = runWebview(mermaid.render());
    m.dispatch(m.document.querySelector('[data-mermaid-edit]'), 'click');
    const original = m.document.getElementById('mermaid-editor-source').value;
    change(m, 'mermaid-editor-source', 'flowchart LR\n A --> C');
    change(m, 'mermaid-editor-source', original);
    assert.equal(m.savedState.drafts.mermaid, undefined);
    const table = await createProviderHarness('| A | B |\n| --- | --- |\n| one | two |');
    const t = runWebview(table.render());
    t.dispatch(t.document.querySelector('[data-edit-markdown-table]'), 'click');
    const cell = t.document.querySelector('[data-table-cell]');
    cell.value = 'Changed'; t.dispatch(cell,'input');
    cell.value = 'one'; t.dispatch(cell,'input');
    assert.equal(t.savedState.drafts.table, undefined);
  });

  it('keeps the original comment text and anchor when another table cell requests feedback', async () => {
    const h = await createProviderHarness('| A | B |\n| --- | --- |\n| one | two |');
    const dom = runWebview(h.render());
    const controls = dom.document.querySelectorAll('[data-comment-markdown-table-cell]');
    dom.dispatch(controls[0], 'click');
    change(dom, 'comment-body', 'Keep my unsaved feedback.');
    const anchor = dom.savedState.drafts.comment.anchorText;
    dom.dispatch(controls[1], 'click');
    assert.equal(dom.document.getElementById('comment-body').value, 'Keep my unsaved feedback.');
    assert.equal(dom.savedState.drafts.comment.anchorText, anchor);
    dom.dispatch(dom.document.getElementById('comment-composer'), 'submit');
    assert.equal(dom.messages.find(value => value.type === 'addComment').anchorText, anchor);
  });

  it('shows draft copy and retry even when the first sidecar read prevents a preview', async () => {
    const h = await createProviderHarness('First.');
    const initial = runWebview(h.render());
    openBlock(initial);
    change(initial, 'block-editor-surface', 'Rescue this draft.');
    h.store.load = async () => {throw new Error('Sidecar unavailable');};
    await h.open();
    const error = runWebview(h.webview.html,initial.savedState);
    assert.equal(error.document.querySelector('#error-drafts textarea').value, 'Rescue this draft.');
    error.dispatch(error.document.querySelector('#error-drafts button'), 'click');
    await h.message(error.messages.find(value => value.type==='copyDraft'));
    assert.equal(h.copiedTexts[0], 'Rescue this draft.');
    error.dispatch(error.document.getElementById('retry-preview'), 'click');
    assert.equal(error.messages.some(value=>value.type==='refreshPreview'),true);
  });

  it('accepts the actual host rawMarkdown response and ignores a malformed conversion payload', async () => {
    const h = await createProviderHarness('First.');
    await h.open();
    const dom = runWebview(h.webview.html);
    openBlock(dom); change(dom, 'block-editor-surface', 'Converted draft.');
    dom.dispatch(dom.document.getElementById('block-editor-raw-toggle'), 'click');
    const request = dom.messages.find(value => value.type === 'convertMarkdownBlockHtml');
    dom.receive({ type: 'convertedMarkdownBlockHtml', requestId: request.requestId, markdown: 'Wrong field.' });
    assert.equal(dom.document.getElementById('block-editor-raw').classList.contains('is-visible'), false);
    assert.equal(dom.document.getElementById('block-editor-raw-toggle').disabled, true);
    await h.message(request);
    const response = h.postedMessages.find(value => value.type === 'convertedMarkdownBlockHtml');
    assert.equal(response.rawMarkdown, 'Converted draft.');
    dom.receive(response);
    assert.equal(dom.document.getElementById('block-editor-raw').value, 'Converted draft.');
    assert.equal(dom.document.getElementById('block-editor-raw').classList.contains('is-visible'), true);
    assert.equal(dom.document.getElementById('block-editor-raw-toggle').disabled, false);
  });

  it('does not replace newly typed rich text with an older Raw conversion result', async () => {
    const h = await createProviderHarness('First.');
    const dom = runWebview(h.render());
    openBlock(dom); change(dom,'block-editor-surface','First draft.');
    dom.dispatch(dom.document.getElementById('block-editor-raw-toggle'),'click');
    const message=dom.messages.find(value=>value.type==='convertMarkdownBlockHtml');
    change(dom,'block-editor-surface','Newer draft typed while waiting.');
    dom.receive({type:'convertedMarkdownBlockHtml',requestId:message.requestId,rawMarkdown:'First draft.'});
    assert.equal(dom.document.getElementById('block-editor-surface').textContent,'Newer draft typed while waiting.');
    assert.equal(dom.document.getElementById('block-editor-raw').classList.contains('is-visible'),false);
    assert.equal(dom.document.getElementById('block-editor-raw-toggle').disabled,false);
    assert.match(dom.document.getElementById('block-editor-status').textContent,/draft changed/);
  });
});

describe('provider save acknowledgements', () => {
  it('acknowledges only after sidecar commit and makes repeated request IDs idempotent', async () => {
    const h = await createProviderHarness('First.');
    await h.open();
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let saving!: () => void;
    const started = new Promise<void>(resolve => { saving = resolve; });
    let writes = 0;
    h.store.saveBoth = async () => { writes++; saving(); await paused; };
    const message = {type:'editMarkdownBlock', requestId:'same-save', documentVersion:1, lineStart:1, lineEnd:1, intent:'manual_block_edit', rawMarkdown:'Updated.'};
    const operation = h.message(message);
    await started;
    assert.equal(h.postedMessages.length, 0);
    await h.message(message);
    assert.equal(writes, 1);
    release();
    await operation;
    assert.equal(h.postedMessages[0].ok, true);
    await h.message(message);
    assert.equal(writes, 1);
    assert.equal(h.edits.length, 1);
  });

  it('reports stale and storage failure as failed saves, not success', async () => {
    const h = await createProviderHarness('First.');
    await h.open();
    const message = {type:'editMarkdownBlock', requestId:'failed-save', documentVersion:1, lineStart:1, lineEnd:1, intent:'manual_block_edit', rawMarkdown:'Updated.'};
    h.store.saveBoth = async () => { throw new Error('Disk full'); };
    await h.message(message);
    assert.equal(h.postedMessages[0].ok, false);
    assert.match(h.postedMessages[0].error, /Disk full/);
    assert.equal(h.document.getText(), 'First.');
    h.changeText('Newer source.');
    await h.message({...message, requestId:'stale-save'});
    assert.equal(h.postedMessages[1].ok, false);
    assert.equal(h.document.getText(), 'Newer source.');
  });

  it('does not acknowledge an invalid empty selection as a saved comment', async () => {
    const h = await createProviderHarness('First.');
    await h.open();
    await h.message({type:'addComment',requestId:'empty',documentVersion:1,anchorText:' ',comment:'Keep this draft.'});
    assert.equal(h.postedMessages[0].ok,false);
  });

  it('returns a failed conversion response so a stale Raw request can be retried', async () => {
    const h=await createProviderHarness('First.');
    await h.open();
    h.changeText('Changed elsewhere.');
    await h.message({type:'convertMarkdownBlockHtml',requestId:'raw-stale',documentVersion:1,lineStart:1,html:'<p>Draft.</p>'});
    assert.equal(h.postedMessages[0].type,'convertedMarkdownBlockHtml');
    assert.equal(h.postedMessages[0].requestId,'raw-stale');
    assert.ok(h.postedMessages[0].error);
  });

  it('keeps the last usable preview and drafts when rollback is followed by sidecar read failure', async () => {
    const h = await createProviderHarness('First.');
    let onChange: any;
    h.vscode.workspace.onDidChangeTextDocument = (handler: any) => {onChange=handler;return {dispose(){}};};
    const apply = h.vscode.workspace.applyEdit;
    h.vscode.workspace.applyEdit = async (edit:any) => {const result=await apply(edit);onChange({document:h.document});return result;};
    await h.open();
    const originalHtml = h.webview.html;
    const dom = runWebview(originalHtml);
    await h.message(dom.messages.find(value => value.type === 'webviewReady'));
    openBlock(dom); change(dom,'block-editor-surface','My retained update.');
    dom.dispatch(dom.document.getElementById('block-editor'),'submit');
    h.store.saveBoth = async () => {h.store.load=async()=>{throw new Error('Sidecar read failed');};throw new Error('Storage failed');};
    await h.message(dom.messages.find(value=>value.type==='editMarkdownBlock'));
    assert.equal(h.webview.html,originalHtml);
    for(const message of h.postedMessages)dom.receive(message);
    assert.equal(dom.document.getElementById('block-editor-surface').textContent,'My retained update.');
    assert.match(dom.document.getElementById('review-refresh-error').textContent,/Sidecar read failed/);
    dom.dispatch(dom.document.querySelector('#review-refresh-error button'),'click');
    assert.equal(dom.messages.some(value=>value.type==='refreshPreview'),true);
  });
});
