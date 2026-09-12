import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewStorageHarness, storageThread } from './helpers/reviewStorageHarness';

const encoder = new TextEncoder();
function fixture() { return createReviewStorageHarness(); }
async function seed() {
  const h = fixture();
  await h.store.addThread(h.uri, storageThread('rv_one'));
  await h.store.addThread(h.uri, storageThread('rv_two'));
  const sidecar = await h.store.getReviewFileUri(h.uri);
  const read = () => JSON.parse(new TextDecoder().decode(h.files.get(sidecar.path)));
  const write = (value: any) => h.files.set(sidecar.path, encoder.encode(JSON.stringify(value)));
  return { ...h, sidecar, read, write };
}
function finish(item: any, status = 'done') {
  Object.assign(item, { status, result: status === 'done' ? 'Updated the source.' : 'Need the desired limit.', resultFor: item.rev });
}

describe('v3 review task transactions and legacy migration', () => {
  it('does not identify prepared but uncommitted bytes as the last valid canonical file', async () => {
    const h = await seed();
    const beforeState = structuredClone([...h.memento.values()][0]) as any;
    const rename = h.vscode.workspace.fs.rename;
    let observed = false;
    h.vscode.workspace.fs.rename = async (from, to) => {
      if (to.path === h.sidecar.path) {
        observed = true;
        const durable = [...h.memento.values()][0] as any;
        assert.equal(durable.lastHash, beforeState.lastHash);
        assert.equal(durable.lastValidPath, beforeState.lastValidPath);
        assert.ok(durable.pendingWrite, 'Prepared recovery bytes need a recoverable commit marker');
      }
      await rename(from, to);
    };
    await h.store.addThread(h.uri, storageThread('rv_next'));
    assert.equal(observed, true);
    assert.equal(h.read().items.length, 3);
  });

  it('serializes passive read bookkeeping with a canonical write in flight', async () => {
    const h = await seed();
    const rename = h.vscode.workspace.fs.rename;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.vscode.workspace.fs.rename = async (from, to) => {
      if (to.path === h.sidecar.path) { entered(); await gate; }
      await rename(from, to);
    };
    const writing = h.store.addThread(h.uri, storageThread('rv_next'));
    await ready;
    let readCompleted = false;
    const reading = h.store.load(h.uri).then(value => { readCompleted = true; return value; });
    void reading.catch(() => {});
    await new Promise<void>(resolve => setImmediate(resolve));
    try { assert.equal(readCompleted, false); } finally { release(); }
    await writing;
    assert.equal((await reading).threads.length, 3);
  });

  it('does not report a committed write as failed when final recovery metadata storage fails', async () => {
    const h = await seed();
    const rename = h.vscode.workspace.fs.rename;
    h.vscode.workspace.fs.rename = async (from, to) => {
      await rename(from, to);
      if (to.path === h.sidecar.path) h.failNextStateWrites();
    };
    await h.store.addThread(h.uri, storageThread('rv_next'));
    h.failNextStateWrites(0);
    assert.equal((await h.restartStore().load(h.uri)).threads.length, 3);
    assert.equal((await h.store.load(h.uri)).threads.length, 3);
  });

  it('bumps an explicit target edit once even when its caller already supplied the next revision', async () => {
    const h = await seed();
    const value = h.read(); finish(value.items[0], 'blocked'); h.write(value);
    await h.store.updateThread(h.uri, 'rv_one', { anchor: { text: 'New source target', lineStart: 2 }, taskRevision: 2 });
    const changed = h.read().items[0];
    assert.equal(changed.rev, 2);
    assert.equal('status' in changed, false);
    assert.equal(changed.result, undefined);
    assert.equal(changed.resultFor, undefined);
  });

  it('normalizes target changes and clears prior outcomes at the saveBoth boundary', async () => {
    const h = await seed();
    const value = h.read(); finish(value.items[0], 'blocked'); h.write(value);
    await h.store.withDocumentTransaction(h.uri, async () => {
      const open = await h.store.load(h.uri);
      const closed = await h.store.loadResolved(h.uri);
      open.threads[0].anchor.text = 'Updated source target';
      await h.store.saveBoth(h.uri, open, closed);
    });
    const changed = h.read().items[0];
    assert.equal(changed.rev, 2);
    assert.equal('status' in changed, false);
    assert.equal(changed.resultFor, undefined);
  });

  it('rejects a cached lower-revision saveBoth instead of overwriting a newer user request', async () => {
    const h = await seed();
    const staleOpen = await h.store.load(h.uri);
    const staleClosed = await h.store.loadResolved(h.uri);
    await h.store.updateComment(h.uri, 'rv_one', 'A newer request.', 1);
    staleOpen.threads[0].anchor.text = 'Stale caller target';
    await assert.rejects(h.store.saveBoth(h.uri, staleOpen, staleClosed), /changed/);
    assert.equal(h.read().items[0].comment, 'A newer request.');
    assert.equal(h.read().items[0].rev, 2);
  });

  it('checks external edits to the old sidecar before committing its renamed copy', async () => {
    const h = await seed();
    const target = h.uriFor('/workspace/renamed.md');
    const targetSidecar = await h.store.getReviewFileUri(target);
    const value = h.read();
    value.items[0].comment = 'External change during rename';
    let inject = true;
    const write = h.vscode.workspace.fs.writeFile;
    h.vscode.workspace.fs.writeFile = async (file, bytes) => {
      await write(file, bytes);
      if (inject && file.path.startsWith(targetSidecar.path + '.tmp-')) { inject = false; h.write(value); }
    };
    await assert.rejects(h.store.migrateDocument(h.uri, target), /changed/);
    assert.deepEqual(h.read(), value);
    assert.equal(h.files.has(targetSidecar.path), false);
  });
  it('recovers the previous canonical file after an interrupted precommit and failed journal cleanup', async () => {
    const h = await seed();
    const before = h.read();
    const rename = h.vscode.workspace.fs.rename;
    h.vscode.workspace.fs.rename = async (from, to) => {
      if (to.path === h.sidecar.path) {
        h.failNextStateWrites();
        throw new Error('Interrupted before canonical commit');
      }
      await rename(from, to);
    };
    await assert.rejects(h.store.addThread(h.uri, storageThread('rv_uncommitted')), /Interrupted/);
    assert.ok(([...h.memento.values()][0] as any).pendingWrite);
    const restarted = h.restartStore();
    assert.equal((await restarted.load(h.uri)).threads.length, 2);
    assert.deepEqual(h.read(), before);
    assert.equal(([...h.memento.values()][0] as any).pendingWrite, undefined);
    h.vscode.workspace.fs.rename = rename;
    h.files.delete(h.sidecar.path);
    await restarted.restoreReviewBackup(h.uri);
    assert.deepEqual(h.read(), before);
  });

  it('preserves a newer same-revision AI report when saving an unchanged cached request', async () => {
    const h = await seed();
    const open = await h.store.load(h.uri);
    const closed = await h.store.loadResolved(h.uri);
    const latest = h.read(); finish(latest.items[0]); h.write(latest);
    await h.store.saveBoth(h.uri, open, closed);
    assert.equal('status' in h.read().items[0], false);
    assert.equal(h.read().items[0].result, latest.items[0].result);
    assert.deepEqual(closed.threads.map(thread => thread.id), []);
  });

  it('rejects a cached whole-document save that would remove a later comment', async () => {
    const h = await seed();
    const open = await h.store.load(h.uri);
    const closed = await h.store.loadResolved(h.uri);
    await h.store.addThread(h.uri, storageThread('rv_later'));
    await assert.rejects(h.store.saveBoth(h.uri, open, closed), /changed/);
    assert.equal(h.read().items.length, 3);
    await h.store.removeThread(h.uri, 'rv_later', 1);
    assert.equal(h.read().items.length, 2);
  });

  it('preserves legacy discussions through request edits before explicit migration', async () => {
    const h = createReviewStorageHarness('/workspace', true);
    await h.store.addThread(h.uri, storageThread('rv_legacy', { thread: [{ role: 'assistant', text: 'Retain this earlier requirement.', createdAt: '2026-09-09' }] }));
    await h.store.updateComment(h.uri, 'rv_legacy', 'Clarified request.');
    await h.store.exportReviewJson(h.uri, async () => true);
    const sidecar = await h.store.getReviewFileUri(h.uri);
    const payload = JSON.parse(new TextDecoder().decode(h.files.get(sidecar.path)));
    assert.match(payload.items[0].comment, /Clarified request/);
    assert.match(payload.items[0].comment, /Retain this earlier requirement/);
  });

  it('backs up closed-only legacy fallback without attempting to represent old closure as v3 done', async () => {
    const h = fixture();
    const legacy = (await h.store.getReviewStateFileUris(h.uri)).find(uri => uri.path.includes('/resolved/'))!;
    const original = encoder.encode(JSON.stringify({ threads: [storageThread('rv_old_closed', { status: 'accepted' })] }));
    h.files.set(legacy.path, original);
    await assert.rejects(h.store.exportReviewJson(h.uri, async () => true), /no comments/);
    assert.deepEqual(h.files.get(legacy.path), original);
    assert.ok([...h.files.keys()].filter(file => file.includes('/legacy-')).some(file => Buffer.from(h.files.get(file)!).equals(Buffer.from(original))));
  });

});
