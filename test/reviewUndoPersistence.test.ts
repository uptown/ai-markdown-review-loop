import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewStorageHarness, storageThread } from './helpers/reviewStorageHarness';
import type { ReviewReply } from '../src/types';

const editReply: ReviewReply = { role: 'assistant', text: 'Applied the Markdown edit.', createdAt: '2026-09-09T00:01:00Z' };

async function editedDocument(close = false) {
  const harness = createReviewStorageHarness('/workspace', true);
  const { store, undo, uri } = harness;
  await store.addThread(uri, storageThread('rv_original'));
  await store.addThread(uri, storageThread('rv_followup'));
  const before = await undo.capture(uri);
  await store.updateThread(uri, 'rv_original', {
    anchor: { text: 'Requirement new', lineStart: 1, lineEnd: 1, confidence: 'exact' },
    thread: [editReply],
    ...(close ? { status: 'accepted' as const, closedBy: 'user' as const, closedAt: '2026-09-09T00:01:00Z' } : {})
  });
  const after = await undo.capture(uri);
  undo.register(uri, 'Requirement old', 'Requirement new', before, after);
  return harness;
}

describe('review undo persistence', () => {
  it('retains later comments and replies while undoing and redoing only the edit outcome', async () => {
    const { store, undo, uri, change } = await editedDocument();
    await store.addThread(uri, storageThread('rv_later_comment'));
    await store.addReply(uri, 'rv_original', 'Later discussion on the edited thread.');
    await store.addReply(uri, 'rv_followup', 'Independent later discussion.');

    for (let cycle = 0; cycle < 2; cycle++) {
      assert.equal(await undo.handleTextDocumentChange(change('Requirement old', 'undo')), true);
      const undone = await store.load(uri);
      assert.deepEqual(undone.threads.map(thread => thread.id), ['rv_original', 'rv_followup', 'rv_later_comment']);
      assert.equal(undone.threads[0].anchor.text, 'Requirement old');
      assert.deepEqual(undone.threads[0].thread.map(reply => reply.text), ['Later discussion on the edited thread.']);
      assert.equal(undone.threads[1].thread[0].text, 'Independent later discussion.');

      assert.equal(await undo.handleTextDocumentChange(change('Requirement new', 'redo')), true);
      const redone = await store.load(uri);
      assert.equal(redone.threads[0].anchor.text, 'Requirement new');
      assert.deepEqual(redone.threads[0].thread.map(reply => reply.text), [editReply.text, 'Later discussion on the edited thread.']);
      assert.equal(redone.threads.length, 3);
    }
  });

  it('moves the edited thread between open and closed state without removing later threads', async () => {
    const { store, undo, uri, change } = await editedDocument(true);
    await store.addThread(uri, storageThread('rv_later_comment'));
    assert.equal(await undo.handleTextDocumentChange(change('Requirement old', 'undo')), true);
    assert.deepEqual((await store.load(uri)).threads.map(thread => thread.id).sort(), ['rv_followup', 'rv_later_comment', 'rv_original']);
    assert.equal((await store.loadResolved(uri)).threads.length, 0);
    assert.equal(await undo.handleTextDocumentChange(change('Requirement new', 'redo')), true);
    assert.deepEqual((await store.load(uri)).threads.map(thread => thread.id), ['rv_followup', 'rv_later_comment']);
    assert.equal((await store.loadResolved(uri)).threads[0].status, 'accepted');
  });

  it('preserves a later explicit user decision and its closure metadata', async () => {
    const { store, undo, uri, change } = await editedDocument(true);
    await store.restoreThread(uri, 'rv_original');
    await store.updateThread(uri, 'rv_original', { status: 'rejected', closedBy: 'user', closedAt: '2026-09-09T00:02:00Z' });
    for (const [text, reason] of [['Requirement old', 'undo'], ['Requirement new', 'redo']] as const) {
      assert.equal(await undo.handleTextDocumentChange(change(text, reason)), true);
      const thread = (await store.loadResolved(uri)).threads[0];
      assert.equal(thread.status, 'rejected');
      assert.equal(thread.closedBy, 'user');
      assert.equal(thread.closedAt, '2026-09-09T00:02:00Z');
      assert.equal((await store.load(uri)).threads.some(value => value.id === 'rv_original'), false);
    }
  });

  it('keeps an explicit Restore decision open through repeated Undo/Redo cycles', async () => {
    const { store, undo, uri, change } = await editedDocument(true);
    await store.restoreThread(uri, 'rv_original');
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const [text, reason] of [['Requirement old', 'undo'], ['Requirement new', 'redo']] as const) {
        assert.equal(await undo.handleTextDocumentChange(change(text, reason)), true);
        const restored = (await store.load(uri)).threads.find(thread => thread.id === 'rv_original')!;
        assert.equal(restored.status, 'open');
        assert.equal(restored.closedBy, undefined);
        assert.equal(restored.closedAt, undefined);
        assert.equal((await store.loadResolved(uri)).threads.length, 0);
      }
    }
  });

  it('keeps Undo and Redo entries retryable after a sidecar write fails', async () => {
    const { store, undo, uri, change, failNextWrites } = await editedDocument();
    failNextWrites();
    await assert.rejects(undo.handleTextDocumentChange(change('Requirement old', 'undo')), /Injected write failure/);
    assert.equal((await store.load(uri)).threads[0].anchor.text, 'Requirement new');
    assert.equal(await undo.handleTextDocumentChange(change('Requirement old', 'undo')), true);
    failNextWrites();
    await assert.rejects(undo.handleTextDocumentChange(change('Requirement new', 'redo')), /Injected write failure/);
    assert.equal((await store.load(uri)).threads[0].anchor.text, 'Requirement old');
    assert.equal(await undo.handleTextDocumentChange(change('Requirement new', 'redo')), true);
  });

  it('retains legacy review state through the first portable-sidecar edit and Undo', async () => {
    const { store, undo, uri, change, files } = createReviewStorageHarness();
    const legacyUri = (await store.getReviewStateFileUris(uri)).find(value => value.path.includes('/documents/'))!;
    files.set(legacyUri.path, new TextEncoder().encode(JSON.stringify({ documentUri: uri.toString(), threads: [storageThread('rv_legacy')], updatedAt: '2026-09-09T00:00:00Z' })));
    const before = await undo.capture(uri);
    await store.updateThread(uri, 'rv_legacy', { anchor: { text: 'Requirement new' }, thread: [editReply] });
    const after = await undo.capture(uri);
    undo.register(uri, 'Requirement old', 'Requirement new', before, after);
    assert.equal(await undo.handleTextDocumentChange(change('Requirement old', 'undo')), true);
    const restored = (await store.load(uri)).threads[0];
    assert.equal(restored.id, 'rv_legacy');
    assert.equal(restored.anchor.text, 'Requirement old');
    assert.deepEqual(restored.thread, []);
  });
  it('keeps v3 revisions increasing through repeated Undo and Redo while retaining later request edits', async () => {
    const h = createReviewStorageHarness();
    await h.store.addThread(h.uri, storageThread('rv_original'));
    const before = await h.undo.capture(h.uri);
    await h.store.updateThread(h.uri, 'rv_original', { anchor: { text: 'Requirement new', lineStart: 1 } });
    const after = await h.undo.capture(h.uri);
    h.undo.register(h.uri, 'Requirement old', 'Requirement new', before, after);
    await h.store.updateComment(h.uri, 'rv_original', 'Later user clarification.', 2);
    let revision = 3;
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const [text, reason] of [['Requirement old', 'undo'], ['Requirement new', 'redo']] as const) {
        assert.equal(await h.undo.handleTextDocumentChange(h.change(text, reason)), true);
        const thread = (await h.store.load(h.uri)).threads[0];
        assert.equal(thread.anchor.text, text);
        assert.equal(thread.comment, 'Later user clarification.');
        assert.equal(thread.taskRevision, ++revision);
        assert.equal(thread.taskStatus, 'pending');
        assert.equal(thread.taskResultFor, undefined);
      }
    }
  });

});
