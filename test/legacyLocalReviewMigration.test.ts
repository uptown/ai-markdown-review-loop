import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewStorageHarness, storageThread } from './helpers/reviewStorageHarness';

describe('legacy machine-created review migration', () => {
  it('preserves an open legacy request and its context without restoring closed findings', async () => {
    const h = createReviewStorageHarness();
    const sidecar = await h.store.getReviewFileUri(h.uri);
    const open = storageThread('rv_legacy', { source: 'local', comment: 'Resolve this placeholder.',
      thread: [{ role: 'user', text: 'Retain this original requirement.', createdAt: '2026-09-09' }] });
    const closed = storageThread('rv_closed', { source: 'local', status: 'rejected' });
    const original = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, openThreads: [open], closedThreads: [closed] }));
    h.files.set(sidecar.path, original);
    const exported = JSON.parse((await h.store.exportReviewJson(h.uri, async () => true)).contents);
    assert.deepEqual(exported.items.map((item: { id: string }) => item.id), ['rv_legacy']);
    assert.match(exported.items[0].comment, /Retain this original requirement/);
    assert.equal([...h.files.values()].some(bytes => Buffer.from(bytes).equals(Buffer.from(original))), true);
    assert.equal('addLocalReviewThreads' in h.store, false);
    assert.equal('addReply' in h.store, false);
  });
});
