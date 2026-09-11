import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionCommandHarness } from './helpers/extensionCommandHarness';

describe('review JSON commands', () => {
  it('copies the canonical JSON without entering a handoff or write lock', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/docs/spec.md');
    h.setActivePreview(document);
    await h.store.addThread(document.uri, task(document.uri.toString()));
    await h.run('copyReviewJson');

    const payload = JSON.parse(h.clipboard[0]);
    assert.equal(payload.schemaVersion, 3);
    assert.equal('status' in payload.items[0], false);
    assert.match(payload.guidance, /user comment/i);
    assert.match(payload.guidance, /do not add replies/i);
    assert.equal(h.store.isHandoffActive(document.uri), false);
    assert.equal(h.information.length, 1);
    h.dispose();
  });

  it('keeps the command surface limited to preview, beside, and JSON copy', async () => {
    const h = await createExtensionCommandHarness();
    const commands = [...h.commands.keys()].sort();
    assert.deepEqual(commands, [
      'aiMarkdownReviewLoop.copyReviewJson',
      'aiMarkdownReviewLoop.openReviewBeside',
      'aiMarkdownReviewLoop.openReviewPreview'
    ]);
    h.dispose();
  });

  it('rejects a non-Markdown target without touching another open document', async () => {
    const h = await createExtensionCommandHarness();
    const markdown = h.addDocument('/workspace/spec.md');
    h.setActiveSource(markdown);
    const other = h.addDocument('/workspace/notes.txt', 'Unrelated', 'plaintext');
    await h.run('copyReviewJson', other.uri);
    assert.equal(h.files.size, 0);
    assert.match(h.warnings[0], /Open a Markdown/);
    h.dispose();
  });

  it('keeps malformed JSON unchanged and reports an export error', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document);
    const sidecar = await h.store.getReviewFileUri(document.uri);
    const invalid = new TextEncoder().encode('{broken');
    h.files.set(sidecar.toString(), invalid);
    await h.run('copyReviewJson');
    assert.equal(h.clipboard.length, 0);
    assert.match(h.errors[0].message, /Copy Review JSON failed/);
    assert.deepEqual(h.files.get(sidecar.toString()), invalid);
    h.dispose();
  });
});

function task(documentUri: string) {
  return {
    id: 'rv_request', documentUri, anchor: { text: 'Spec', lineStart: 1, confidence: 'exact' },
    type: 'note', source: 'human', status: 'open', severity: 'medium', comment: 'Clarify the scope.', thread: [],
    createdAt: '2026-09-09', updatedAt: '2026-09-09'
  };
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
});
