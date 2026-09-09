import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewStorageHarness, storageThread } from './helpers/reviewStorageHarness';

const finding = (id: string) => storageThread(id, {
  source: 'local', type: 'question', comment: 'Resolve this placeholder.',
  anchor: { text: 'TODO: choose a limit.', lineStart: 4, lineEnd: 4, contextBefore: '## Retry policy', contextAfter: 'The server retries.' }
});

describe('local review decision preservation', () => {
  it('deduplicates already open local findings and reports the reason', async () => {
    const { store, uri } = createReviewStorageHarness();
    await store.addLocalReviewThreads(uri, [finding('rv_first')]);
    const result = await store.addLocalReviewThreads(uri, [finding('rv_second')]);
    assert.equal(result.addedThreads.length, 0);
    assert.equal(result.existingOpenCount, 1);
    assert.equal(result.previouslyClosedCount, 0);
    assert.equal(result.reviewDocument.threads[0].id, 'rv_first');
  });

  it('keeps unchanged declined and resolved local findings closed on repeated checks', async () => {
    for (const status of ['rejected', 'resolved'] as const) {
      const { store, uri } = createReviewStorageHarness();
      await store.addLocalReviewThreads(uri, [finding('rv_first')]);
      await store.addReply(uri, 'rv_first', 'This is intentional.');
      await store.updateThread(uri, 'rv_first', { status, closedBy: 'user', closedAt: '2026-09-09T00:01:00Z' });
      const result = await store.addLocalReviewThreads(uri, [finding('rv_second')]);
      assert.equal(result.addedThreads.length, 0);
      assert.equal(result.previouslyClosedCount, 1);
      assert.equal(result.reviewDocument.threads.length, 0);
      const closed = (await store.loadResolved(uri)).threads[0];
      assert.equal(closed.id, 'rv_first');
      assert.equal(closed.status, status);
      assert.equal(closed.thread[0].text, 'This is intentional.');
    }
  });

  it('allows a new finding when reviewed source or its context actually changed', async () => {
    for (const anchorChange of [{ text: 'TODO: choose a different limit.' }, { contextAfter: 'A changed requirement.' }, { lineStart: 8, lineEnd: 8 }]) {
      const { store, uri } = createReviewStorageHarness();
      await store.addLocalReviewThreads(uri, [finding('rv_first')]);
      await store.updateThread(uri, 'rv_first', { status: 'rejected' });
      const incoming = finding('rv_changed');
      Object.assign(incoming.anchor, anchorChange);
      const result = await store.addLocalReviewThreads(uri, [incoming]);
      assert.equal(result.addedThreads.length, 1);
      assert.equal(result.previouslyClosedCount, 0);
    }
  });

  it('keeps separate local rules and preserves ordinary import behavior', async () => {
    const { store, uri } = createReviewStorageHarness();
    await store.addLocalReviewThreads(uri, [finding('rv_first')]);
    await store.updateThread(uri, 'rv_first', { status: 'rejected' });
    const otherRule = { ...finding('rv_other_rule'), type: 'suggestion' as const, comment: 'Shorten this line.' };
    assert.equal((await store.addLocalReviewThreads(uri, [otherRule])).addedThreads.length, 1);
    assert.equal((await store.addThreads(uri, [finding('rv_regular_import')])).addedThreads.length, 1);
  });

  it('does not use human or AI decisions to suppress a local rule and rejects nonlocal input', async () => {
    const { store, uri } = createReviewStorageHarness();
    await store.addThread(uri, { ...finding('rv_human'), source: 'human' });
    await store.updateThread(uri, 'rv_human', { status: 'resolved' });
    assert.equal((await store.addLocalReviewThreads(uri, [finding('rv_local')])).addedThreads.length, 1);
    await assert.rejects(store.addLocalReviewThreads(uri, [{ ...finding('rv_ai'), source: 'ai' }]), /only create local/);
  });
});
