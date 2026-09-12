import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function runScenarios({ phase, record, rpc, reviewFrame, untilFrame, waitFor, confirmCommand, readJson, documentFile, sidecar, root, browser }) {
  let frame = await reviewFrame();
  await frame.locator('#markdown-body p').first().waitFor();
  if (phase === 'round') {
    assert.equal(await frame.locator('[data-edit-markdown-block]:visible').count(), 0);
    await frame.locator('#markdown-body p').first().click({ clickCount: 3 });
    await frame.locator('#selection-comment').click();
    await frame.locator('#comment-body').fill('Define a maximum of three attempts.');
    await frame.locator('#comment-composer button[type=submit]').click();
    const initial = await waitFor(() => { const value = readJson(sidecar); return value?.items?.length === 1 && value; }, 'user comment persisted');
    assert.equal(initial.items[0].status, undefined);
    record('actual-webview-selection-and-comment-save');
    frame = await reviewFrame();
    const badge = frame.locator('#markdown-body .review-badge').first();
    await badge.focus();
    await badge.press('Enter');
    assert.ok(await frame.locator('#comment-overlay').isVisible());
    assert.ok(await frame.evaluate(() => document.querySelector('#comment-overlay').contains(document.activeElement)));
    await frame.locator('[data-close-comments]').press('Tab');
    assert.ok(await frame.evaluate(() => document.querySelector('#comment-overlay').contains(document.activeElement)));
    await frame.locator('#comment-overlay').press('Escape');
    assert.equal(await frame.locator('#comment-overlay').isVisible(), false);
    assert.ok(await badge.evaluate(element => element === document.activeElement));
    record('actual-keyboard-overlay-focus-tab-escape-and-trigger-restoration');
    await frame.locator('[data-toggle-sidebar]').click();
    const copied = JSON.parse((await rpc('command', { command: 'copyReviewJson' })).clipboard);
    assert.deepEqual(copied.context, { workspaceFolder: 'workspace', path: 'docs/spec.md' });
    assert.doesNotMatch(copied.guidance, /record.*result|status to|handoff pause/i);
    record('compact-copy-includes-portable-unambiguous-location');
    await untilFrame(f => f.locator('#markdown-body [data-mermaid-diagram] svg').count().then(n => n > 0), 'Mermaid SVG');
    frame = await reviewFrame();
    assert.ok(await frame.locator('#markdown-body img').first().evaluate(img => img.complete && img.naturalWidth > 0));
    await frame.evaluate(() => {
      window.__unauthorizedSmokeScript = false;
      const script = document.createElement('script');
      script.textContent = 'window.__unauthorizedSmokeScript = true';
      document.body.appendChild(script);
    });
    assert.equal(await frame.evaluate(() => window.__unauthorizedSmokeScript), false);
    record('packaged-mermaid-local-image-and-nonce-csp-work');
    await verifyLiveDrafts({ frame, initial, sidecar, untilFrame, record });
    fs.writeFileSync(documentFile, fs.readFileSync(documentFile, 'utf8').replace('Retry failed requests.', 'Apply a maximum of three attempts.'));
    await untilFrame(f => f.locator('#markdown-body').textContent().then(t => t.includes('maximum of three')), 'external source update');
    frame = await reviewFrame();
    assert.equal(await frame.locator('#review-sidebar').isVisible(), false);
    assert.equal(await frame.locator('#markdown-body .review-badge').count(), 0);
    await frame.locator('[data-review-nav=next]').click();
    assert.equal(await frame.locator('#review-sidebar').isVisible(), true);
    record('source-update-preserves-sidebar-and-missing-target-navigation-is-visible');
    await frame.locator('#threads [data-edit-comment]').click();
    await frame.locator('#comment-body').fill('Keep the three-attempt limit and name the owner.');
    await frame.locator('#comment-composer button[type=submit]').click();
    await waitFor(() => { const value = readJson(sidecar); return value?.items[0]?.rev === 2 && value; }, 'comment edit revision');
    fs.writeFileSync(sidecar, JSON.stringify(initial));
    await untilFrame(f => f.locator('#review-refresh-error').isVisible(), 'visible stale-write warning');
    await confirmCommand('restoreReviewBackup', 'Restore');
    await waitFor(() => readJson(sidecar)?.items[0]?.rev === 2, 'restore latest user revision');
    await untilFrame(f => f.locator('#review-refresh-error').count().then(n => n === 0), 'successful recovery clears refresh error');
    record('stale-external-write-recovery-preserves-latest-user-comment');
    fs.writeFileSync(sidecar, '{broken');
    await confirmCommand('restoreReviewBackup', 'Restore');
    await waitFor(() => readJson(sidecar)?.items[0]?.rev === 2, 'corrupt JSON recovery');
    record('actual-confirmation-recovers-malformed-json');
    const beforeSourceEdit = fs.readFileSync(documentFile, 'utf8');
    frame = await reviewFrame();
    await frame.locator('[data-toggle-edit-document]').click();
    await frame.locator('#markdown-body p [data-edit-markdown-block]').first().click();
    await frame.locator('#block-editor-surface').fill('Apply a maximum of three attempts. Owner: engineering.');
    await frame.locator('#block-editor-submit').click();
    await untilFrame(f => f.locator('#markdown-body').textContent().then(t => t.includes('Owner: engineering.')), 'preview source edit applied');
    // Preview editors use the normal VS Code dirty-buffer model. Copy Review
    // JSON is the public handoff action that saves the Markdown to disk.
    await rpc('command', { command: 'copyReviewJson' });
    await waitFor(() => fs.readFileSync(documentFile, 'utf8').includes('Owner: engineering.'), 'actual preview source edit saved');
    const beforeDeletion = readJson(sidecar);
    fs.writeFileSync(sidecar, JSON.stringify({ ...beforeDeletion, items: [{ ...beforeDeletion.items[0], result: 'Transient legacy result', resultFor: beforeDeletion.items[0].rev }] }));
    fs.unlinkSync(sidecar);
    await untilFrame(async f => await f.locator('.review-file-status').isVisible()
      && (await f.locator('#threads').textContent()).includes('name the owner'), 'deleted-sidecar snapshot');
    record('immediate-result-write-delete-retains-user-comments-without-result-delivery-contract');
    await rpc('focusSource');
    const source = await waitFor(async () => {
      for (const context of browser.contexts()) for (const page of context.pages()) {
        const editor = page.locator('.editor-group-container.active .editor-instance .monaco-editor').first();
        if (await editor.isVisible()) return { page, editor };
      }
    }, 'active native source editor');
    await source.editor.click({ position: { x: 130, y: 40 } });
    assert.ok(await source.editor.evaluate(element => element.contains(document.activeElement)), 'Native source editor has actual browser focus before Undo');
    await rpc('undoSource');
    await untilFrame(f => f.locator('#markdown-body').textContent().then(t => !t.includes('Owner: engineering.')), 'source Undo renders');
    await rpc('saveSource');
    await waitFor(() => fs.readFileSync(documentFile, 'utf8') === beforeSourceEdit, 'source Undo restores original Markdown');
    assert.equal(fs.existsSync(sidecar), false, 'Source Undo must not recreate JSON after the deletion boundary');
    record('actual-preview-source-edit-and-undo-preserve-deleted-round-boundary');
  } else if (phase === 'restart') {
    await untilFrame(f => f.locator('#threads').textContent().then(t => t.includes('name the owner')), 'retained comments after process restart');
    assert.equal(fs.existsSync(sidecar), false);
    frame = await reviewFrame();
    await frame.locator('#threads [data-edit-comment]').click();
    await frame.locator('#comment-body').fill('Name the engineering owner.');
    await frame.locator('#comment-composer button[type=submit]').click();
    await waitFor(() => readJson(sidecar)?.items[0]?.comment === 'Name the engineering owner.', 'next-round recreation');
    record('real-process-restart-and-user-edit-recreate-next-round');
    frame = await reviewFrame();
    await frame.locator('#threads [data-remove-comment]').click();
    await waitFor(() => readJson(sidecar)?.items?.length === 0, 'user comment deletion');
    await confirmCommand('purgeRecovery', 'Purge');
    assert.equal(readJson(sidecar).items.length, 0);
    assert.match(fs.readFileSync(documentFile, 'utf8'), /maximum of three/);
    assert.equal(fs.readFileSync(path.join(root, '.isolated-smoke'), 'utf8'), 'ai-markdown-review-loop');
    const recoveryFiles = fs.readdirSync(root, { recursive: true }).filter(file => /review-recovery[\\/].*\.json$/.test(String(file)));
    assert.ok(recoveryFiles.length > 0, 'Current accepted baseline remains after purge');
    for (const file of recoveryFiles) {
      const contents = fs.readFileSync(path.join(root, file), 'utf8');
      for (const removed of ['Define a maximum of three attempts.', 'Keep the three-attempt limit and name the owner.', 'Name the engineering owner.']) {
        assert.equal(contents.includes(removed), false, 'Purged recovery must not retain deleted fixture comments: ' + file);
      }
    }
    record('user-delete-and-confirmed-private-backup-purge-preserve-source');
    await benchmarkPreview({ record, rpc, reviewFrame, untilFrame, documentFile });
  } else {
    await untilFrame(f => f.locator('#threads').textContent().then(t => t.includes('Read-only fixture comment.')), 'restricted preview');
    frame = await reviewFrame();
    assert.equal(await frame.locator('[data-copy-review-json]').isDisabled(), true);
    assert.equal(await frame.locator('#threads [data-edit-comment]').isDisabled(), true);
    assert.equal(await frame.locator('#threads [data-remove-comment]').isDisabled(), true);
    record('actual-restricted-mode-preview-has-disabled-write-actions');
  }
}

async function verifyLiveDrafts({ frame, initial, sidecar, untilFrame, record }) {
  await frame.locator('[data-toggle-edit-document]').click();
  await frame.locator('#markdown-body p [data-edit-markdown-block]').first().click();
  await frame.locator('#block-editor-surface').fill('Unsaved explanatory draft.');
  await frame.evaluate(() => {
    const editor = document.querySelector('#block-editor-surface');
    window.__smokeDraftNode = editor.firstChild;
    const textNode = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT).nextNode();
    window.__smokeDraftText = textNode;
    const range = document.createRange(); range.setStart(textNode, 7); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    window.__smokeCommentUpdates = 0;
    window.__smokeCommentObserver = new MutationObserver(() => window.__smokeCommentUpdates++);
    window.__smokeCommentObserver.observe(document.querySelector('#threads'), { childList: true });
  });
  fs.writeFileSync(sidecar, JSON.stringify({ ...initial, items: [{ ...initial.items[0], result: 'Legacy rich draft observation', resultFor: 1 }] }));
  await untilFrame(f => f.evaluate(() => window.__smokeCommentUpdates > 0), 'rich draft sidecar update');
  assert.ok(await frame.evaluate(() => {
    const editor = document.querySelector('#block-editor-surface');
    const selection = window.getSelection();
    return editor.firstChild === window.__smokeDraftNode && document.activeElement === editor
      && selection.anchorNode === window.__smokeDraftText && selection.anchorOffset === 7;
  }), 'Rich draft DOM, focus and caret survive comment-only refresh');
  await frame.locator('#block-editor-raw-toggle').click();
  await frame.locator('#block-editor-raw').waitFor({ state: 'visible' });
  assert.match(await frame.locator('#block-editor-raw').inputValue(), /Unsaved explanatory draft/);
  await frame.locator('#block-editor-cancel').click();
  await frame.locator('[data-edit-markdown-table]').first().click();
  const input = frame.locator('#table-editor-grid [data-table-cell]').first();
  await input.fill('Unsaved table draft.');
  await input.evaluate(element => { window.__smokeTableInput = element; element.setSelectionRange(4, 4); window.__smokeCommentUpdates = 0; });
  fs.writeFileSync(sidecar, JSON.stringify({ ...initial, items: [{ ...initial.items[0], result: 'Legacy table draft observation', resultFor: 1 }] }));
  await untilFrame(f => f.evaluate(() => window.__smokeCommentUpdates > 0), 'table draft sidecar update');
  assert.ok(await input.evaluate(element => element === window.__smokeTableInput && document.activeElement === element
    && element.selectionStart === 4 && element.value === 'Unsaved table draft.'));
  assert.ok(await frame.locator('#table-editor').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth;
  }), 'The complete table editor fits inside the actual VS Code webview');
  await frame.locator('#table-editor-cancel').click();
  await frame.locator('[data-toggle-edit-document]').click();
  await frame.evaluate(() => window.__smokeCommentObserver.disconnect());
  record('actual-live-rich-table-drafts-preserve-focus-caret-and-raw-conversion');
}

async function benchmarkPreview({ record, rpc, reviewFrame, untilFrame, documentFile }) {
  const workspace = path.resolve(documentFile, '../..');
  for (const [paragraphs, comments] of [[100, 10], [500, 50], [1000, 100]]) {
    const file = 'performance-' + paragraphs + '.md';
    const source = Array.from({ length: paragraphs }, (_, i) => 'Performance requirement ' + String(i).padStart(4, '0') + ' needs a documented decision.').join('\n\n') + '\n';
    const items = Array.from({ length: comments }, (_, i) => ({ id: 'rv_perf_' + i, rev: 1,
      target: { quote: 'Performance requirement ' + String(i * 10).padStart(4, '0') + ' needs a documented decision.', line: i * 20 + 1 }, comment: 'Clarify the acceptance rule for requirement ' + i + '.' }));
    const review = { schemaVersion: 3, document: file, guidance: 'Review current comments, save Markdown and delete this JSON.', items };
    const taskPath = path.join(workspace, '.' + file + '.ai-review.json');
    fs.writeFileSync(path.join(workspace, file), source);
    fs.writeFileSync(taskPath, JSON.stringify(review));
    const started = performance.now();
    await rpc('open', { file });
    await untilFrame(f => f.locator('#threads .thread').count().then(n => n === comments), 'performance fixture render');
    let frame = await reviewFrame();
    const initialMs = Math.round(performance.now() - started);
    assert.ok(initialMs < 8000, 'Initial real-host render exceeds the 8s cold-open budget');
    const timeOrigin = await frame.evaluate(() => performance.timeOrigin);
    const page = frame.page();
    const previewUrl = frame.url();
    let navigations = 0;
    const countNavigation = candidate => { if (candidate === frame || candidate.url() === previewUrl) navigations++; };
    page.on('framenavigated', countNavigation);
    await frame.evaluate(() => {
      window.__smokePerformanceUpdates = 0;
      window.__smokePerformanceObserver = new MutationObserver(() => window.__smokePerformanceUpdates++);
      window.__smokePerformanceObserver.observe(document.querySelector('#threads'), { childList: true });
    });
    review.items[0].result = 'Legacy observation'; review.items[0].resultFor = 1;
    fs.writeFileSync(taskPath, JSON.stringify(review));
    await untilFrame(f => f.evaluate(() => window.__smokePerformanceUpdates > 0), 'observed sidecar-only comment refresh');
    frame = await reviewFrame();
    assert.equal(await frame.evaluate(() => performance.timeOrigin), timeOrigin, 'Sidecar-only update must keep the webview document');
    await frame.evaluate(() => window.__smokePerformanceObserver.disconnect());
    const sidecarNavigations = navigations;
    assert.equal(sidecarNavigations, 0, 'Sidecar-only update must not navigate the rendered document');
    const burst = performance.now();
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(workspace, file), source + '\nSource burst ' + i + '.\n');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    await untilFrame(f => f.locator('#markdown-body').textContent().then(t => t.includes('Source burst 9.')), 'coalesced source burst');
    const burstMs = Math.round(performance.now() - burst);
    assert.ok(burstMs < 5000, 'Source burst exceeds the 5s settled-update budget');
    page.off('framenavigated', countNavigation);
    record('real-host-render-budget-and-sidecar-document-reuse', { paragraphs, comments, initialMs, burstMs, sourceEvents: 10,
      sidecarDocumentNavigations: sidecarNavigations, sourceDocumentNavigations: navigations - sidecarNavigations });
  }
  const diagrams = 20;
  const file = 'performance-mermaid.md';
  const source = Array.from({ length: diagrams }, (_, i) => '## Diagram ' + i + '\n\n```mermaid\nflowchart LR\n A[Read] --> B[Review ' + i + '] --> C[Save]\n```\n').join('\n');
  fs.writeFileSync(path.join(workspace, file), source);
  const started = performance.now();
  await rpc('open', { file });
  await untilFrame(f => f.locator('#markdown-body [data-mermaid-diagram] svg').count().then(n => n === diagrams), 'Mermaid-heavy initial render');
  const initialMs = Math.round(performance.now() - started);
  assert.ok(initialMs < 8000, 'Mermaid-heavy preview exceeds the 8s cold-open budget');
  const burst = performance.now();
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(workspace, file), source + '\nDiagram burst ' + i + '.\n');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  await untilFrame(async f => (await f.locator('#markdown-body').textContent()).includes('Diagram burst 9.')
    && await f.locator('#markdown-body [data-mermaid-diagram] svg').count() === diagrams, 'Mermaid-heavy settled burst');
  const burstMs = Math.round(performance.now() - burst);
  assert.ok(burstMs < 5000, 'Mermaid-heavy source burst exceeds the 5s settled-update budget');
  record('real-host-mermaid-heavy-render-budget', { diagrams, initialMs, burstMs, sourceEvents: 10 });
}
