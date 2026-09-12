import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHarness, runWebview } from './helpers/providerHarness';
import type { ReviewThread } from '../src/types';
import { chooseTargetCandidate } from '../src/webview/targetMatching';

function request(id: string, quote: string, line = 1, extra: Partial<ReviewThread['anchor']> = {}): ReviewThread {
  return { id, documentUri: 'file:///project/spec.md', anchor: { text: quote, lineStart: line, lineEnd: line, ...extra },
    type: 'note', source: 'human', status: 'open', severity: 'medium', comment: 'Clarify this requirement.',
    thread: [], taskRevision: 1, createdAt: '', updatedAt: '' };
}

async function preview(source: string, threads: ReviewThread[] = []) {
  const h = await createProviderHarness(source);
  const review = { documentUri: h.document.uri.toString(), threads, updatedAt: '' };
  h.store.load = async () => review;
  const html = h.provider.renderHtml(h.webview, h.document, review);
  return { h, review, html, dom: runWebview(html) };
}

describe('current comment-first review flow', () => {
  it('does not attach a removed quote to unrelated text at its old line (AMRL-002)', async () => {
    const { dom } = await preview('An unrelated replacement.', [request('rv_gone', 'Old payment requirement.')]);
    assert.equal(dom.document.querySelector('.review-badge'), undefined);
    assert.equal(dom.document.querySelector('.thread [data-jump-thread]').disabled, true);
    assert.ok(dom.document.querySelector('[data-edit-comment]'));
    assert.ok(dom.document.querySelector('[data-remove-comment]'));
  });

  it('finds a uniquely moved quote and rejects a surviving duplicate with conflicting context', async () => {
    const { dom } = await preview('New introduction.\n\nThe unique requirement.', [request('rv_moved', 'The unique requirement.')]);
    assert.ok(dom.document.querySelector('.review-badge'));
    const candidate = { value: 'survivor', line: 1, occurrence: 0, before: 'New surrounding section.', after: '' };
    assert.equal(chooseTargetCandidate({ text: 'Repeated.', lineStart: 1, contextBefore: 'Deleted surrounding section.' }, [candidate]), undefined);
  });

  it('decorates and navigates only the selected duplicate image occurrence (AMRL-013)', async () => {
    const image = '![Overview](./overview.png)';
    const { dom } = await preview(image + '\n\nAnother section.\n\n' + image, [request('rv_image', image, 5, { occurrence: 1 })]);
    const images = dom.document.querySelectorAll('[data-markdown-image]');
    assert.equal(images[0].querySelector('.review-badge'), undefined);
    const badge = images[1].querySelector('.review-badge');
    assert.ok(badge);
    let focused = false;
    Object.defineProperty(badge, 'focus', { value: () => { focused = true; } });
    dom.dispatch(dom.document.querySelector('.thread [data-jump-thread]'), 'click');
    assert.equal(focused, true);
  });

  it('uses original Markdown context when an image is inside a paragraph', async () => {
    const image = '![Overview](./overview.png)';
    const { dom } = await preview('Read ' + image + ' carefully.', [request('rv_inline', image, 1, { contextBefore: 'Read', contextAfter: 'carefully.' })]);
    assert.ok(dom.document.querySelector('[data-markdown-image] .review-badge'));
  });

  it('does not confuse ordinary selected text with an image alt or diagram keyword', async () => {
    const { dom } = await preview('Overview\n\nThe flowchart explains this rule.\n\n![Overview](./overview.png)\n\n```mermaid\nflowchart LR\n A --> B\n```', [
      request('rv_word', 'Overview'), request('rv_flowchart', 'The flowchart explains this rule.', 3)
    ]);
    assert.equal(dom.document.querySelector('[data-markdown-image] .review-badge'), undefined);
    assert.equal(dom.document.querySelector('[data-mermaid-diagram] .review-badge'), undefined);
    assert.equal(dom.document.querySelectorAll('#markdown-body p > .review-anchor .review-badge').length, 2);
  });

  it('persists sidebar visibility and preserves comment drafts on reload (AMRL-011)', async () => {
    const { h, html, dom } = await preview('Current target.');
    dom.dispatch(dom.document.querySelector('[data-toggle-sidebar]'), 'click');
    dom.evaluate("activeSelectionText='Current target.';activeSelectionRect={left:0,right:100,top:0,bottom:20};openComposer();");
    const input = dom.document.getElementById('comment-body');
    input.value = 'Retain this draft.'; dom.dispatch(input, 'input');
    const next = runWebview(html, dom.savedState);
    assert.equal(next.document.getElementById('review-sidebar').hidden, true);
    assert.equal(next.document.querySelector('[data-toggle-sidebar]').getAttribute('aria-expanded'), 'false');
    assert.equal(next.document.getElementById('comment-body').value, 'Retain this draft.');
    assert.equal(next.savedState.documentUri, h.document.uri.toString());
  });

  it('reveals a missing-target comment when navigating with the sidebar hidden (AMRL-012)', async () => {
    const { dom } = await preview('Current target.', [request('rv_missing', 'Removed target.', 1, { confidence: 'missing' })]);
    dom.dispatch(dom.document.querySelector('[data-toggle-sidebar]'), 'click');
    let focused = false;
    Object.defineProperty(dom.document.querySelector('.thread'), 'focus', { value: () => { focused = true; } });
    dom.dispatch(dom.document.querySelector('[data-review-nav="next"]'), 'click');
    assert.equal(dom.document.getElementById('review-sidebar').hidden, false);
    assert.equal(focused, true);
    assert.equal(dom.savedState.view.sidebarCollapsed, false);
  });

  it('never presents legacy agent results or completion states (AMRL-014)', async () => {
    const comment = { ...request('rv_result', 'Current target.'), taskRevision: 2, taskResultFor: 1, taskResult: 'Misleading old result.' };
    const { dom } = await preview('Current target.', [comment]);
    dom.dispatch(dom.document.querySelector('.review-badge'), 'click');
    assert.doesNotMatch(dom.document.getElementById('threads').textContent, /Misleading old result|Agent result/);
    assert.doesNotMatch(dom.document.getElementById('comment-overlay').textContent, /Misleading old result|Agent result/);
    assert.equal(dom.document.querySelector('.task-result'), undefined);
  });

  it('moves focus into the comment dialog and restores its trigger on dismissal (AMRL-015)', async () => {
    const { dom } = await preview('Current target.', [request('rv_focus', 'Current target.')]);
    const badge = dom.document.querySelector('.review-badge');
    let active = badge;
    Object.defineProperty(dom.document, 'activeElement', { configurable: true, get: () => active });
    Object.defineProperty(badge, 'focus', { value: () => { active = badge; } });
    const overlay = dom.document.getElementById('comment-overlay');
    const query = overlay.querySelector.bind(overlay);
    Object.defineProperty(overlay, 'querySelector', { value: (selector: string) => {
      const element = query(selector);
      if (element) Object.defineProperty(element, 'focus', { configurable: true, value: () => { active = element; } });
      return element;
    } });
    dom.dispatch(badge, 'click');
    assert.equal(active.getAttribute('data-close-comments'), '');
    dom.dispatch(active, 'click');
    assert.equal(active, badge);
    assert.equal(dom.document.getElementById('comment-overlay').style.display, 'none');
  });

  it('defaults to comments and enables retained editors through an explicit mode (AMRL-025)', async () => {
    const { html, dom } = await preview('Paragraph.\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n| A | B |\n| --- | --- |\n| one | two |');
    assert.equal(dom.document.querySelector('[data-edit-markdown-block]'), undefined);
    assert.equal(dom.document.querySelector('[data-mermaid-edit]').hidden, true);
    assert.equal(dom.document.querySelector('[data-edit-markdown-table]').hidden, true);
    assert.ok(dom.document.querySelector('[data-comment-markdown-table-cell]'));
    dom.dispatch(dom.document.querySelector('[data-toggle-edit-document]'), 'click');
    assert.ok(dom.document.querySelector('[data-edit-markdown-block]'));
    assert.equal(dom.document.querySelector('[data-mermaid-edit]').hidden, false);
    const restored = runWebview(html, dom.savedState);
    assert.equal(restored.document.querySelector('[data-toggle-edit-document]').getAttribute('aria-pressed'), 'true');
    dom.dispatch(dom.document.querySelector('[data-toggle-edit-document]'), 'click');
    assert.equal(dom.document.querySelector('[data-edit-markdown-block]'), undefined);
  });

  it('keeps the full floating editor above the viewport edge and reclamps it after resize', async () => {
    const { dom } = await preview('Current target.');
    dom.window.innerWidth = 500;
    dom.window.innerHeight = 400;
    for (const id of ['block-editor', 'table-editor', 'mermaid-editor', 'comment-composer']) {
      const editor = dom.document.getElementById(id);
      editor.style.display = 'none';
      Object.defineProperty(editor, 'getBoundingClientRect', { value: () => {
        assert.equal(editor.style.display, 'block', 'Measure visible content, including the action row');
        return { left: 0, right: 460, top: 0, bottom: 280, width: 460, height: 280 };
      } });
      dom.evaluate(`positionFloatingElement(document.getElementById('${id}'), {left:420,right:480,top:350,bottom:380}, 680)`);
      assert.equal(editor.style.display, 'none', 'Positioning preserves the caller display state');
      assert.equal(editor.style.left, '28px');
      assert.equal(editor.style.top, '108px', 'All 280px of the panel fit above the bottom margin');
      editor.style.display = 'block';
    }
    dom.window.innerHeight = 320;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    for (const id of ['block-editor', 'table-editor', 'mermaid-editor', 'comment-composer']) {
      assert.equal(dom.document.getElementById(id).style.top, '28px');
    }
  });

  it('updates sidecar-only state without replacing the source DOM or sidebar preference (AMRL-016)', async () => {
    const { h, review } = await preview('Current target.');
    await h.open();
    const originalHtml = h.webview.html;
    const dom = runWebview(originalHtml);
    await h.message(dom.messages.find(message => message.type === 'webviewReady'));
    h.postedMessages.length = 0;
    const paragraph = dom.document.querySelector('#markdown-body p');
    dom.dispatch(dom.document.querySelector('[data-toggle-sidebar]'), 'click');
    review.threads.push(request('rv_incremental', 'Current target.'));
    await h.provider.refreshDocument(h.document.uri);
    assert.equal(h.webview.html, originalHtml);
    const update = h.postedMessages.find(message => message.type === 'reviewStateUpdated');
    assert.ok(update);
    dom.receive(update);
    assert.equal(dom.document.querySelector('#markdown-body p'), paragraph);
    assert.ok(dom.document.querySelector('[data-edit-comment]'));
    assert.equal(dom.document.getElementById('review-sidebar').hidden, true);
  });

  it('coalesces a source typing burst into one full refresh', async () => {
    const h = await createProviderHarness('Original.');
    let onChange: (event: unknown) => void = () => {};
    h.vscode.workspace.onDidChangeTextDocument = (handler: typeof onChange) => { onChange = handler; return { dispose() {} }; };
    let html = '', writes = 0;
    Object.defineProperty(h.webview, 'html', { get: () => html, set: value => { html = value; writes++; } });
    await h.open();
    for (let index = 0; index < 10; index++) { h.changeText('Updated ' + index + '.'); onChange({ document: h.document }); }
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(writes, 2);
    assert.match(html, /Updated 9\./);
  });

  it('delivers the latest early sidecar state only after browser readiness, including Restricted Mode', async () => {
    for (const trusted of [true, false]) {
      const h = await createProviderHarness('Current target.');
      h.vscode.workspace.isTrusted = trusted;
      const review = { documentUri: h.document.uri.toString(), threads: [] as ReviewThread[], updatedAt: '' };
      h.store.load = async () => { assert.ok(trusted, 'Restricted readiness must not use writable storage'); return review; };
      h.store.loadReadonly = async () => review;
      await h.open();
      const initialHtml = h.webview.html;
      review.threads.push(request('rv_early', 'Current target.'));
      await h.provider.refreshDocument(h.document.uri);
      review.threads[0].comment = 'Latest change during startup.';
      await h.provider.refreshDocument(h.document.uri);
      assert.equal(h.postedMessages.length, 0, 'No update may be sent before listeners exist');
      assert.equal(h.webview.html, initialHtml);
      const dom = runWebview(initialHtml);
      const ready = dom.messages.find(message => message.type === 'webviewReady');
      assert.ok(ready, 'Restricted preview must also announce readiness');
      await h.message(ready);
      assert.equal(h.postedMessages.length, 1);
      assert.equal(h.webview.html, initialHtml, 'Readiness must not reload the HTML');
      dom.receive(h.postedMessages[0]);
      assert.match(dom.document.getElementById('threads').textContent, /Latest change during startup/);
      await h.message(ready);
      assert.equal(h.postedMessages.length, 1, 'Repeated readiness is idempotent');
      assert.equal(h.saveCount, 0);
      assert.deepEqual(h.warnings, []);
    }
  });

  it('ignores readiness and state updates from an older full render', async () => {
    const h = await createProviderHarness('Old source.');
    await h.open();
    const oldDom = runWebview(h.webview.html);
    const oldReady = oldDom.messages.find(message => message.type === 'webviewReady');
    h.changeText('Current source.');
    await h.provider.refreshDocument(h.document.uri);
    const currentHtml = h.webview.html;
    const dom = runWebview(currentHtml);
    const ready = dom.messages.find(message => message.type === 'webviewReady');
    assert.notEqual(ready.previewId, oldReady.previewId);
    await h.message(oldReady);
    await h.message({ ...ready, documentVersion: oldReady.documentVersion });
    assert.equal(h.postedMessages.length, 0);
    await h.message(ready);
    assert.equal(h.postedMessages.length, 1);
    assert.equal(h.webview.html, currentHtml);
    dom.receive({ type: 'reviewStateUpdated', state: {
      ...h.postedMessages[0].state, previewId: oldReady.previewId,
      threads: [request('rv_obsolete', 'Current source.')]
    } });
    assert.equal(dom.document.querySelector('[data-edit-comment]'), undefined);
  });

  it('retains dropped updates until the live page announces readiness again', async () => {
    const h = await createProviderHarness('Current target.');
    const review = { documentUri: h.document.uri.toString(), threads: [] as ReviewThread[], updatedAt: '' };
    h.store.load = async () => review;
    await h.open();
    const initialHtml = h.webview.html;
    const dom = runWebview(initialHtml);
    const ready = dom.messages.find(message => message.type === 'webviewReady');
    let attempts = 0;
    h.webview.postMessage = async () => { attempts++; return false; };
    await h.message(ready);
    assert.equal(attempts, 1);
    review.threads.push(request('rv_resend', 'Current target.'));
    await h.provider.refreshDocument(h.document.uri);
    assert.equal(attempts, 1, 'A non-live page must wait for readiness');
    h.webview.postMessage = async (message: unknown) => { h.postedMessages.push(message); return true; };
    await h.message(ready);
    assert.equal(h.postedMessages.length, 1);
    assert.equal(h.postedMessages[0].state.threads[0].id, 'rv_resend');
    assert.equal(h.webview.html, initialHtml);
  });

  it('does not let an older in-flight render overwrite the state sent after readiness', async () => {
    const h = await createProviderHarness('Current target.');
    await h.open();
    const dom = runWebview(h.webview.html);
    const initialHtml = h.webview.html;
    const oldReview = { documentUri: h.document.uri.toString(), threads: [], updatedAt: '' };
    const latestReview = { ...oldReview, threads: [request('rv_latest', 'Current target.')] };
    let release!: (review: typeof oldReview) => void;
    const waiting = new Promise<typeof oldReview>(resolve => { release = resolve; });
    let reads = 0;
    h.store.load = async () => ++reads === 1 ? waiting : latestReview;
    const oldRender = h.provider.refreshDocument(h.document.uri);
    await h.message(dom.messages.find(message => message.type === 'webviewReady'));
    release(oldReview);
    await oldRender;
    assert.equal(h.postedMessages.length, 1);
    assert.equal(h.postedMessages[0].state.threads[0].id, 'rv_latest');
    assert.equal(h.webview.html, initialHtml);
  });

  it('clears a refresh failure only after accepting a successful state update', async () => {
    const { h, review, dom } = await preview('Current target.');
    dom.receive({ type: 'reviewRefreshFailed', error: 'Malformed JSON.' });
    assert.ok(dom.document.getElementById('review-refresh-error'));
    const state = h.provider.createWebviewState(h.document, review, {}, dom.window.reviewInitialState.previewId);
    dom.receive({ type: 'reviewStateUpdated', state: { ...state, documentVersion: state.documentVersion + 1 } });
    assert.ok(dom.document.getElementById('review-refresh-error'));
    dom.receive({ type: 'reviewStateUpdated', state });
    assert.equal(dom.document.getElementById('review-refresh-error'), null);
  });

  it('preserves live rich and table editor nodes during a sidecar-only update', async () => {
    for (const kind of ['block', 'table'] as const) {
      const { h, review, dom } = await preview(kind === 'block' ? 'Current target.' : '| A | B |\n| --- | --- |\n| one | two |');
      dom.dispatch(dom.document.querySelector('[data-toggle-edit-document]'), 'click');
      dom.dispatch(dom.document.querySelector(kind === 'block' ? '[data-edit-markdown-block]' : '[data-edit-markdown-table]'), 'click');
      const form = dom.document.getElementById(kind + '-editor');
      const control = kind === 'block' ? dom.document.getElementById('block-editor-surface') : dom.document.querySelector('[data-table-cell]');
      if (kind === 'block') control.innerHTML = '<p>Unsaved live words.</p>';
      else control.value = 'Unsaved live words.';
      dom.dispatch(control, 'input');
      const liveNode = kind === 'block' ? control.firstChild : control;
      dom.receive({ type: 'reviewStateUpdated', state: h.provider.createWebviewState(h.document, review, {}, dom.window.reviewInitialState.previewId) });
      const currentNode = kind === 'block' ? control.firstChild : dom.document.querySelector('[data-table-cell]');
      assert.equal(currentNode, liveNode, kind + ' should retain its live DOM and selection destination');
      assert.equal(kind === 'block' ? control.textContent : currentNode.value, 'Unsaved live words.');
      assert.doesNotMatch(form.textContent, /Draft restored/);
      assert.equal(form.style.display, 'block');
    }
  });

  it('moves only a conflicting live comment draft to recovery after an external revision change', async () => {
    const comment = request('rv_conflict', 'Current target.');
    const { h, review, dom } = await preview('Current target.', [comment]);
    dom.dispatch(dom.document.querySelector('[data-edit-comment]'), 'click');
    const input = dom.document.getElementById('comment-body');
    input.value = 'My unsaved request.'; dom.dispatch(input, 'input');
    comment.comment = 'Changed in another editor.';
    comment.taskRevision = 2;
    dom.receive({ type: 'reviewStateUpdated', state: h.provider.createWebviewState(h.document, review, {}, dom.window.reviewInitialState.previewId) });
    assert.equal(dom.document.getElementById('comment-composer').style.display, 'none');
    assert.match(dom.document.querySelector('.draft-recovery').textContent, /request changed/);
    assert.equal(dom.document.querySelector('.draft-recovery textarea').value, 'My unsaved request.');
  });

  it('uses nonce-only scripts and allows read-only navigation in Restricted Mode (AMRL-027)', async () => {
    const { h, review } = await preview('Current target.', [request('rv_readonly', 'Current target.')]);
    h.vscode.workspace.isTrusted = false;
    const html = h.provider.renderHtml(h.webview, h.document, review);
    const scriptPolicy = html.match(/script-src ([^;]+);/)![1];
    assert.match(scriptPolicy, /^'nonce-[^']+'$/);
    const dom = runWebview(html);
    assert.equal(dom.document.querySelector('[data-edit-comment]').disabled, true);
    assert.equal(dom.document.querySelector('[data-copy-review-json]').disabled, true);
    assert.equal(dom.document.querySelector('[data-review-nav="next"]').disabled, false);
    await h.open();
    await h.message({ type: 'addComment', comment: 'Blocked.', anchorText: 'Current target.', documentVersion: 1, requestId: 'untrusted' });
    assert.equal(h.saveCount, 0);
    assert.match(h.warnings[0], /Trust this workspace/);
  });

  it('does not call writable storage while previewing restricted or unsupported documents', async () => {
    const h = await createProviderHarness('Read only.');
    h.vscode.workspace.isTrusted = false;
    h.store.load = async () => { throw new Error('Writable read must not run'); };
    let readonlyReads = 0;
    h.store.loadReadonly = async () => { readonlyReads++; return { documentUri: h.document.uri.toString(), threads: [], updatedAt: '' }; };
    await h.open();
    assert.equal(readonlyReads, 1);
    assert.match(h.webview.html, /Restricted Mode/);
    const other = await createProviderHarness('Virtual document.');
    other.document.uri.scheme = 'vscode-vfs';
    other.store.load = async () => { throw new Error('Unsupported document storage access'); };
    await other.open();
    assert.match(other.webview.html, /Unsupported document/);
    assert.equal(other.warnings.length, 0);
  });
});
