import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionCommandHarness } from './helpers/extensionCommandHarness';

describe('review task command handoff', () => {
  it('saves, copies the sidecar path, pauses writes, and resumes the preview target', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/docs/spec.md'); h.setActivePreview(document);
    await h.store.addThread(document.uri, task(document.uri.toString()));
    await h.run('handoff'); assert.match(h.clipboard[0], /docs\/\.spec.md.ai-review.json/);
    assert.equal(h.store.isHandoffActive(document.uri), true);
    await h.run('resumeReview'); assert.equal(h.store.isHandoffActive(document.uri), false);
    assert.deepEqual(h.errors, []); h.dispose();
  });
  it('copies self-contained JSON and freezes writes', async () => {
    const h = await createExtensionCommandHarness(); const document = h.addDocument('/workspace/spec.md');
    h.setActiveSource(document); await h.store.addThread(document.uri, task(document.uri.toString()));
    await h.run('copyReviewFile'); const payload = JSON.parse(h.clipboard[0]);
    assert.equal(payload.schemaVersion, 3); assert.match(payload.guidance, /resultFor/);
    assert.equal(h.store.isHandoffActive(document.uri), true); h.dispose();
  });
  it('includes an unambiguous quoted path base for multi-root and standalone documents', async () => {
    for (const [filename, base, relative] of [
      ['/projects/client two/docs/spec.md', '/projects/client two', 'docs/.spec.md.ai-review.json'],
      ['/outside/customer "signed"/spec.md', '/outside/customer "signed"', '.spec.md.ai-review.json']
    ]) {
      const h = await createExtensionCommandHarness();
      h.setWorkspaceFolders(['/projects/client one', '/projects/client two']);
      const other = h.addDocument('/projects/client one/docs/spec.md');
      h.setActiveSource(other);
      const document = h.addDocument(filename);
      await h.store.addThread(document.uri, task(document.uri.toString()));
      await h.run('handoff', document.uri);
      assert.ok(h.clipboard[0].startsWith(`Base directory: ${JSON.stringify(base)}.\nRead ${JSON.stringify(relative)}.`));
      assert.equal(h.store.isHandoffActive(document.uri), true);
      assert.equal(h.store.isHandoffActive(other.uri), false);
      assert.deepEqual(h.errors, []);
      h.dispose();
    }
  });
  it('inspects even malformed JSON as a read-only snapshot without handing off or modifying it', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/spec.md'); h.setActivePreview(document);
    const sidecar = await h.store.getReviewFileUri(document.uri);
    const invalid = new TextEncoder().encode('{broken'); h.files.set(sidecar.toString(), invalid);
    await h.run('openReviewFile');
    assert.equal(h.shownDocuments.length, 1);
    assert.equal(h.shownDocuments[0].uri.scheme, 'ai-markdown-review-loop-prompt');
    assert.match(h.shownDocuments[0].getText(), /\{broken/);
    assert.deepEqual(h.files.get(sidecar.toString()), invalid);
    assert.equal(h.store.isHandoffActive(document.uri), false);
    assert.deepEqual(h.errors, []); h.dispose();
  });
  it('does not deliver or stay paused when saving the source is cancelled', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/spec.md'); h.setActivePreview(document);
    await h.store.addThread(document.uri, task(document.uri.toString()));
    const sidecar = await h.store.getReviewFileUri(document.uri);
    const before = h.files.get(sidecar.toString());
    document.save = async () => false;
    await h.run('handoff');
    assert.equal(h.clipboard.length, 0);
    assert.match(h.errors[0].message, /document save was cancelled/);
    assert.deepEqual(h.files.get(sidecar.toString()), before);
    assert.equal(h.store.isHandoffActive(document.uri), false); h.dispose();
  });
  it('does not register the removed conversation, local-check, and prompt commands', async () => {
    const h = await createExtensionCommandHarness();
    for (const id of ['reviewDocument','exportFeedback','openContextBootstrapPrompt','openFeedbackLoopPrompt']) {
      assert.equal(h.commands.has('aiMarkdownReviewLoop.' + id), false);
    } h.dispose();
  });
  it('does not fall back to another file for an explicit non-Markdown target', async () => {
    const h = await createExtensionCommandHarness(); h.setActiveSource(h.addDocument('/workspace/spec.md'));
    const other = h.addDocument('/workspace/notes.txt', 'Unrelated', 'plaintext');
    await h.run('handoff', other.uri); assert.equal(h.files.size, 0); assert.match(h.warnings[0], /Open a Markdown/); h.dispose();
  });
  it('reports clipboard failures without leaving a permanent pause', async () => {
    const h = await createExtensionCommandHarness(); const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document); await h.store.addThread(document.uri, task(document.uri.toString())); h.failClipboard();
    await h.run('handoff'); assert.match(h.errors[0].message, /Clipboard unavailable/);
    assert.equal(h.store.isHandoffActive(document.uri), false); h.dispose();
  });
});

function task(documentUri: string) {
  return { id: 'rv_request', documentUri, anchor: { text: 'Spec', lineStart: 1, confidence: 'exact' },
    type: 'note', source: 'human', status: 'open', severity: 'medium', comment: 'Clarify the scope.', thread: [],
    createdAt: '2026-09-09', updatedAt: '2026-09-09' };
}

describe('review command error recovery', () => {
  it('offers explicit retry and keeps the original target when editor focus changes', async () => {
    const h = await createExtensionCommandHarness();
    const original = h.addDocument('/workspace/original.md');
    const other = h.addDocument('/workspace/other.md');
    h.setActivePreview(original);
    h.failNextOpen(original);
    h.chooseOnError('Retry', () => h.setActiveSource(other));
    await h.run('openReviewPreview');
    assert.match(h.errors[0].message, /Open Review Preview failed for original\.md/);
    assert.deepEqual(h.errors[0].actions, ['Retry']);
    assert.deepEqual(h.openAttempts, [original.uri.toString(), original.uri.toString()]);
    assert.equal(h.executed[0].args[0].toString(), original.uri.toString());
    h.dispose();
  });

  it('leaves invalid review data untouched and does not retry when the error is dismissed', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document);
    const sidecar = await h.store.getReviewFileUri(document.uri);
    const invalid = new TextEncoder().encode('{broken');
    h.files.set(sidecar.toString(), invalid);
    await h.run('handoff');
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0].message, /Send to Agent failed for spec\.md: Review sidecar is invalid/);
    assert.deepEqual(h.files.get(sidecar.toString()), invalid);
    assert.equal(h.information.length, 0);
    h.dispose();
  });

  it('retries repaired JSON against the original document and hands off once', async () => {
    const h = await createExtensionCommandHarness(); const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document); await h.store.addThread(document.uri, task(document.uri.toString()));
    const sidecar = await h.store.getReviewFileUri(document.uri); const valid = h.files.get(sidecar.toString())!;
    h.files.set(sidecar.toString(), new TextEncoder().encode('{broken'));
    h.chooseOnError('Retry', () => h.files.set(sidecar.toString(), valid));
    await h.run('handoff'); assert.equal(h.errors.length, 1); assert.equal(h.clipboard.length, 1);
    assert.equal((await h.store.load(document.uri)).threads.length, 1); h.dispose();
  });
});
