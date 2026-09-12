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
    assert.match(payload.guidance, /Comments are user-owned/i);
    assert.deepEqual(payload.context, { workspaceFolder: 'workspace', path: 'docs/spec.md' });
    assert.equal(h.clipboard[0].includes('\n'), false);
    assert.equal(h.information.length, 1);
    h.dispose();
  });

  it('exposes the current flow and explicit recovery actions without retired handoff commands', async () => {
    const h = await createExtensionCommandHarness();
    const commands = [...h.commands.keys()].sort();
    assert.deepEqual(commands, [
      'aiMarkdownReviewLoop.copyReviewJson',
      'aiMarkdownReviewLoop.openReviewBeside',
      'aiMarkdownReviewLoop.openReviewPreview',
      'aiMarkdownReviewLoop.purgeRecovery',
      'aiMarkdownReviewLoop.restoreReviewBackup',
      'aiMarkdownReviewLoop.startNewReview'
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

  it('allows preview but refuses copy or recovery writes in Restricted Mode', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document);
    h.setTrusted(false);
    await h.run('openReviewPreview');
    assert.equal(h.executed.length, 1);
    for (const command of ['copyReviewJson', 'restoreReviewBackup', 'startNewReview', 'purgeRecovery']) {
      await h.run(command);
    }
    assert.equal(h.errors.length, 4);
    assert.equal(h.files.size, 0);
    assert.equal(h.clipboard.length, 0);
    assert.match(h.errors[0].message, /Trust this workspace/);
    h.dispose();
  });

  it('does not purge recovery when the user dismisses confirmation', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document);
    await h.store.addThread(document.uri, task(document.uri.toString()));
    const before = [...h.files].map(([name, bytes]) => [name, Array.from(bytes)]);
    await h.run('purgeRecovery');
    assert.deepEqual([...h.files].map(([name, bytes]) => [name, Array.from(bytes)]), before);
    assert.equal(h.warnings.length, 1);
    h.dispose();
  });

  for (const folders of [[], ['/workspace', '/other/workspace']]) {
    it(`refuses ${folders.length === 0 ? 'missing' : 'duplicate'} workspace context before saving or recreating JSON`, async () => {
      const h = await createExtensionCommandHarness(); const document = h.addDocument('/workspace/spec.md');
      h.setActivePreview(document);
      await h.store.addThread(document.uri, task(document.uri.toString()));
      const sidecar = await h.store.getReviewFileUri(document.uri);
      h.files.delete(sidecar.toString()); await h.store.load(document.uri);
      let saves = 0; document.save = async () => { saves++; return true; };
      h.setWorkspaceFolders(folders);
      const before = [...h.files].map(([name, bytes]) => [name, Array.from(bytes)]);
      await h.run('copyReviewJson');
      assert.equal(saves, 0); assert.equal(h.clipboard.length, 0);
      assert.equal(h.errors.length, 1);
      assert.deepEqual([...h.files].map(([name, bytes]) => [name, Array.from(bytes)]), before);
      assert.equal(h.files.has(sidecar.toString()), false);
      h.dispose();
    });
  }

  it('restores the latest accepted revision after confirmation and preserves conflicting bytes', async () => {
    const h = await createExtensionCommandHarness(); const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document); await h.store.addThread(document.uri, task(document.uri.toString()));
    const sidecar = await h.store.getReviewFileUri(document.uri);
    const stale = h.files.get(sidecar.toString())!;
    await h.store.updateComment(document.uri, 'rv_request', 'Latest user request', 1);
    h.files.set(sidecar.toString(), stale);
    h.chooseOnWarning('Restore'); await h.run('restoreReviewBackup');
    assert.equal(h.errors.length, 0);
    const restored = JSON.parse(new TextDecoder().decode(h.files.get(sidecar.toString())));
    assert.equal(restored.items[0].rev, 2); assert.equal(restored.items[0].comment, 'Latest user request');
    assert.ok([...h.files.entries()].some(([name, bytes]) => name.includes('/before-restore-') && Buffer.from(bytes).equals(Buffer.from(stale))));
    h.dispose();
  });

  it('purges deleted text from old snapshots after confirmation while retaining current baseline', async () => {
    const h = await createExtensionCommandHarness(); const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document);
    await h.store.addThread(document.uri, { ...task(document.uri.toString()), comment: 'Private deleted phrase' });
    await h.store.removeThread(document.uri, 'rv_request', 1);
    h.chooseOnWarning('Purge'); await h.run('purgeRecovery');
    assert.equal(h.errors.length, 0);
    assert.equal([...h.files.values()].some(bytes => new TextDecoder().decode(bytes).includes('Private deleted phrase')), false);
    assert.equal((await h.store.load(document.uri)).threads.length, 0);
    assert.match(h.information[0], /Removed \d+ old recovery copies/);
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
