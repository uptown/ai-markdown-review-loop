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
  const handoff = () => h.store.prepareHandoff(h.uri, async () => true, async () => {});
  return { ...h, sidecar, read, write, handoff };
}
function finish(item: any, status = 'done') {
  Object.assign(item, { status, result: status === 'done' ? 'Updated the source.' : 'Need the desired limit.', resultFor: item.rev });
}

describe('v3 review task lifecycle and recovery', () => {
  it('writes compact self-contained JSON for the first comment without dialogue fields', async () => {
    const h = await seed(); const payload = h.read();
    assert.equal(payload.schemaVersion, 3); assert.equal(payload.document, 'spec.md');
    assert.match(payload.guidance, /resultFor/); assert.equal(payload.items.length, 2);
    assert.equal(payload.items[0].status, 'pending'); assert.equal(payload.items[0].rev, 1);
    assert.equal('thread' in payload.items[0], false); assert.equal('documentUri' in payload, false);
  });

  it('freezes ingress synchronously while draining queued writes and saves before delivery', async () => {
    const h = await seed(); let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const mutation = h.store.withDocumentTransaction(h.uri, async () => {
      entered(); await gate; await h.store.updateComment(h.uri, 'rv_one', 'Already queued edit', 1);
    });
    await ready; const order: string[] = [];
    const sending = h.store.prepareHandoff(h.uri, async () => { order.push('save'); return true; }, async (_uri, text) => {
      order.push('copy'); assert.match(text, /Already queued edit/);
    });
    assert.equal(h.store.getHandoffPhase(h.uri), 'preparing');
    await assert.rejects(h.store.addThread(h.uri, storageThread('rv_late')), /paused/);
    release(); await Promise.all([mutation, sending]);
    assert.deepEqual(order, ['save', 'copy']); assert.equal(h.store.getHandoffPhase(h.uri), 'handedOff');
  });

  it('keeps the pause and immutable request checkpoint across extension reload', async () => {
    const h = await seed(); await h.handoff();
    const restarted = h.restartStore(); assert.equal(restarted.isHandoffActive(h.uri), true);
    await assert.rejects(restarted.updateComment(h.uri, 'rv_one', 'Forbidden'), /paused/);
    const payload = h.read(); payload.items[0].comment = 'Unexpected replacement'; h.write(payload);
    await assert.rejects(restarted.resumeReview(h.uri), /request, location, or ID/);
    assert.equal(restarted.isHandoffActive(h.uri), true);
  });

  it('accepts mixed done/blocked results, archives done on the next round, and reopens history', async () => {
    const h = await seed(); await h.handoff();
    const payload = h.read(); finish(payload.items[0]); finish(payload.items[1], 'blocked'); h.write(payload);
    await h.store.resumeReview(h.uri);
    assert.deepEqual((await h.store.loadResolved(h.uri)).threads.map(t => t.id), ['rv_one']);
    assert.equal((await h.store.load(h.uri)).threads[0].taskStatus, 'blocked');
    await h.handoff(); assert.deepEqual(h.read().items.map((t: any) => t.id), ['rv_two']);
    assert.deepEqual((await h.store.loadArchived(h.uri)).map(t => t.id), ['rv_one']);
    await h.store.resumeReview(h.uri); await h.store.restoreArchivedThread(h.uri, 'rv_one');
    const reopened = h.read().items.find((t: any) => t.id === 'rv_one');
    assert.equal(reopened.status, 'pending'); assert.equal(reopened.rev, 2); assert.equal(reopened.result, undefined);
  });

  it('increments edited request revisions, resets handling reports, and rejects stale editor edits', async () => {
    const h = await seed(); const payload = h.read(); finish(payload.items[0], 'blocked'); h.write(payload);
    await h.store.load(h.uri); await h.store.updateComment(h.uri, 'rv_one', 'Limit is 20.', 1);
    const edited = h.read().items[0]; assert.equal(edited.rev, 2); assert.equal(edited.status, 'pending'); assert.equal(edited.resultFor, undefined);
    await assert.rejects(h.store.updateComment(h.uri, 'rv_one', 'Stale request', 1), /changed/);
  });

  for (const damage of ['missing-file', 'missing-item', 'malformed', 'changed-target'] as const) {
    it(`preserves the checkpoint and restores explicitly after ${damage}`, async () => {
      const h = await seed(); await h.handoff(); const original = h.read();
      if (damage === 'missing-file') h.files.delete(h.sidecar.path);
      else if (damage === 'malformed') h.files.set(h.sidecar.path, encoder.encode('{broken'));
      else { const next = h.read(); if (damage === 'missing-item') next.items.pop(); else next.items[0].target.quote = 'Wrong target'; h.write(next); }
      await assert.rejects(h.store.resumeReview(h.uri)); assert.equal(h.store.isHandoffActive(h.uri), true);
      await h.store.restoreReviewBackup(h.uri); assert.deepEqual(h.read(), original); assert.equal(h.store.isHandoffActive(h.uri), false);
    });
  }

  it('does not resurrect legacy data after a known canonical file disappears', async () => {
    const h = await seed(); const legacy = (await h.store.getReviewStateFileUris(h.uri)).find(uri => uri.path.includes('/documents/'))!;
    h.files.set(legacy.path, encoder.encode(JSON.stringify({ documentUri: h.uri.toString(), updatedAt: '', threads: [storageThread('rv_legacy')] })));
    h.files.delete(h.sidecar.path); await assert.rejects(h.restartStore().load(h.uri), /ファイル|review file is missing/);
  });

  it('rejects destructive direct-file edits even without a protected handoff', async () => {
    const h = await seed(); const value = h.read(); value.items = []; h.write(value);
    await assert.rejects(h.store.load(h.uri), /disappeared from the file/);
    await h.store.restoreReviewBackup(h.uri); assert.equal(h.read().items.length, 2);
  });

  it('keeps stale result revisions open for reprocessing', async () => {
    const h = await seed(); await h.store.updateComment(h.uri, 'rv_one', 'Revised', 1); await h.handoff();
    const value = h.read(); finish(value.items[0]); value.items[0].resultFor = 1; h.write(value);
    await h.store.resumeReview(h.uri); assert.equal((await h.store.loadResolved(h.uri)).threads.length, 0);
    assert.equal((await h.store.load(h.uri)).threads[0].taskStatus, 'done');
  });

  it('unfreezes after cancelled source save or failed clipboard delivery', async () => {
    const h = await seed();
    await assert.rejects(h.store.prepareHandoff(h.uri, async () => false, async () => {}), /document save was cancelled/);
    assert.equal(h.store.isHandoffActive(h.uri), false);
    await assert.rejects(h.store.prepareHandoff(h.uri, async () => true, async () => { throw new Error('Clipboard failed'); }), /Clipboard/);
    assert.equal(h.store.isHandoffActive(h.uri), false); assert.equal(h.read().items.length, 2);
  });

  it('refuses writes and handoff while the JSON editor has unsaved changes', async () => {
    const h = await seed(); const original = h.read();
    h.vscode.workspace.textDocuments.push({ uri: h.sidecar as any, isDirty: true });
    await assert.rejects(h.store.updateComment(h.uri, 'rv_one', 'Conflict'), /unsaved changes/);
    await assert.rejects(h.handoff(), /unsaved changes/); assert.deepEqual(h.read(), original);
  });

  it('preserves active data when recovery/archive storage cannot be written', async () => {
    const h = await seed(); await h.handoff(); const value = h.read(); finish(value.items[0]); h.write(value);
    await h.store.resumeReview(h.uri); h.failNextWrites();
    await assert.rejects(h.handoff(), /Injected write failure/); assert.deepEqual(h.read(), value);
    assert.equal(h.store.isHandoffActive(h.uri), false);
  });

  it('converts legacy requests only at handoff, retaining verbatim discussion and raw closed history', async () => {
    const h = createReviewStorageHarness('/workspace', true);
    await h.store.addThread(h.uri, storageThread('rv_legacy', { thread: [{ role: 'assistant', text: 'Keep exact wording: 雪 <tag>.', createdAt: '2026-09-09' }] }));
    await h.store.addThread(h.uri, storageThread('rv_closed'));
    await h.store.updateThread(h.uri, 'rv_closed', { status: 'rejected' });
    const sidecar = await h.store.getReviewFileUri(h.uri); const before = h.files.get(sidecar.path)!;
    assert.equal(JSON.parse(new TextDecoder().decode(before)).schemaVersion, 2);
    await h.store.prepareHandoff(h.uri, async () => true, async () => {});
    const payload = JSON.parse(new TextDecoder().decode(h.files.get(sidecar.path)));
    assert.equal(payload.schemaVersion, 3); assert.equal(payload.items.length, 1);
    assert.match(payload.items[0].comment, /Keep exact wording: 雪 <tag>\./);
    assert.equal(payload.items[0].status, 'pending');
    assert.ok(h.store.getLegacyBackupPaths(h.uri).some(file => assert.deepEqual(h.files.get(file), before) === undefined));
  });

  it('keeps passive reads byte-identical and bounds automatic valid snapshots', async () => {
    const h = await seed(); const initial = h.files.get(h.sidecar.path);
    await h.store.load(h.uri); await h.store.loadResolved(h.uri);
    assert.deepEqual(h.files.get(h.sidecar.path), initial);
    for (let i = 0; i < 8; i++) await h.store.updateComment(h.uri, 'rv_one', `Revision ${i}`);
    assert.equal([...h.files.keys()].filter(key => /valid-[01]\.json$/.test(key)).length, 2);
  });

  it('prevents old Undo entries from writing over externally handled work', async () => {
    const h = await seed(); const before = await h.undo.capture(h.uri);
    await h.store.updateThread(h.uri, 'rv_one', { anchor: { text: 'New target' } }); const after = await h.undo.capture(h.uri);
    h.undo.register(h.uri, 'old', 'new', before, after); await h.handoff();
    const value = h.read(); finish(value.items[0]); h.write(value); await h.store.resumeReview(h.uri);
    assert.equal(await h.undo.handleTextDocumentChange(h.change('old', 'undo')), false); assert.deepEqual(h.read(), value);
  });

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
    assert.equal(changed.status, 'pending');
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
    assert.equal(changed.status, 'pending');
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
    assert.equal(h.read().items[0].status, 'done');
    assert.equal(h.read().items[0].result, latest.items[0].result);
    assert.deepEqual(closed.threads.map(thread => thread.id), ['rv_one']);
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
    await h.store.prepareHandoff(h.uri, async () => true, async () => {});
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
    await assert.rejects(h.store.prepareHandoff(h.uri, async () => true, async () => {}), /no pending comments/);
    assert.equal(h.store.isHandoffActive(h.uri), false);
    assert.deepEqual(h.files.get(legacy.path), original);
    assert.ok(h.store.getLegacyBackupPaths(h.uri).some(file => Buffer.from(h.files.get(file)!).equals(Buffer.from(original))));
  });

});
