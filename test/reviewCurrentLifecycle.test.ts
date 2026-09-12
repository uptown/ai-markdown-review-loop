import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewStorageHarness, storageThread } from './helpers/reviewStorageHarness';
import { createReviewTaskCheckpoint, parseReviewTaskSidecar, REVIEW_TASK_GUIDANCE } from '../src/reviewTaskProtocol';
import fs from 'node:fs';
import path from 'node:path';

const encoder = new TextEncoder(), decoder = new TextDecoder();
async function seed() {
  const h = createReviewStorageHarness();
  await h.store.addThread(h.uri, storageThread('rv_one', { comment: 'Original request' }));
  const sidecar = await h.store.getReviewFileUri(h.uri);
  const read = () => parseReviewTaskSidecar(JSON.parse(decoder.decode(h.files.get(sidecar.path))));
  const write = (payload: unknown) => h.files.set(sidecar.path, encoder.encode(JSON.stringify(payload)));
  return { ...h, sidecar, read, write };
}

describe('current user-owned comment lifecycle', () => {
  it('reads a first Restricted Mode preview without any filesystem or workspace-state writes', async () => {
    const h = createReviewStorageHarness(); const sidecar = await h.store.getReviewFileUri(h.uri);
    const bytes = encoder.encode(JSON.stringify({ schemaVersion: 3, document: 'spec.md', guidance: REVIEW_TASK_GUIDANCE,
      items: [{ id: 'rv_one', rev: 1, target: { quote: 'Requirement' }, comment: 'Keep this request' }] }));
    h.files.set(sidecar.path, bytes);
    const before = structuredClone([...h.files]);
    assert.equal((await h.store.loadReadonly(h.uri)).threads[0].comment, 'Keep this request');
    assert.deepEqual([...h.files], before); assert.equal(h.memento.size, 0);
    assert.equal(h.store.getDocumentEpoch(h.uri), 0);
    await h.store.load(h.uri);
    assert.ok(h.memento.size > 0);
  });

  it('does not migrate an old lock or accept a deletion during a read-only preview', async () => {
    const h = await seed(); const key = [...h.memento.keys()][0];
    h.memento.set(key, { ...(h.memento.get(key) as object), phase: 'handedOff', checkpoint: createReviewTaskCheckpoint(h.read()) });
    h.files.delete(h.sidecar.path);
    const state = structuredClone([...h.memento]), files = structuredClone([...h.files]);
    const restarted = h.restartStore();
    assert.equal((await restarted.loadReadonly(h.uri)).threads[0].comment, 'Original request');
    assert.deepEqual([...h.memento], state); assert.deepEqual([...h.files], files);
    assert.equal(restarted.getDocumentEpoch(h.uri), 0);
  });
  it('upgrades each shipped built-in prompt and preserves custom guidance and user fields', async () => {
    const fixtures = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test/fixtures/legacyReviewGuidance.json'), 'utf8')) as { version: string; guidance: string }[];
    for (const fixture of [...fixtures, { version: 'custom', guidance: 'Preserve our product-specific terms.' }]) {
      const h = createReviewStorageHarness(); const sidecar = await h.store.getReviewFileUri(h.uri);
      const original = { schemaVersion: 3, document: 'spec.md', guidance: fixture.guidance,
        items: [{ id: 'rv_one', rev: 8, target: { quote: 'Requirement', line: 4 }, comment: 'Keep this request' }] };
      h.files.set(sidecar.path, encoder.encode(JSON.stringify(original)));
      const exported = JSON.parse((await h.store.exportReviewJson(h.uri, async () => true)).contents);
      assert.equal(exported.guidance, fixture.version === 'custom' ? fixture.guidance : REVIEW_TASK_GUIDANCE, fixture.version);
      assert.deepEqual(exported.items, original.items);
      assert.equal(JSON.parse((await h.restartStore().exportReviewJson(h.uri, async () => true)).contents).guidance, exported.guidance);
    }
  });
  for (const kind of ['old-revision', 'same-revision', 'future-revision', 'target', 'added', 'removed', 'guidance', 'downgrade'] as const) {
    it(`preserves accepted comments against an external ${kind} replacement through restart and recovery`, async () => {
      const h = await seed(); const external: any = h.read();
      await h.store.updateComment(h.uri, 'rv_one', 'Latest user request', 1);
      const accepted = h.read();
      if (kind !== 'old-revision') Object.assign(external, structuredClone(accepted));
      if (kind === 'same-revision') external.items[0].comment = 'Replacement';
      if (kind === 'future-revision') external.items[0].rev++;
      if (kind === 'target') external.items[0].target.quote = 'Wrong source';
      if (kind === 'added') external.items.push({ ...external.items[0], id: 'rv_agent' });
      if (kind === 'removed') external.items = [];
      if (kind === 'guidance') external.guidance = 'New external instructions';
      if (kind === 'downgrade') Object.assign(external, { schemaVersion: 2, openThreads: [], closedThreads: [] });
      h.write(external);
      await assert.rejects(h.store.load(h.uri), /last accepted comments are preserved/);
      const restarted = h.restartStore();
      await assert.rejects(restarted.load(h.uri), /Restore Review Backup/);
      await restarted.restoreReviewBackup(h.uri);
      assert.deepEqual(h.read(), accepted);
      assert.equal([...h.files.values()].some(bytes => decoder.decode(bytes) === JSON.stringify(external)), true);
    });
  }

  it('accepts legacy result-only writes without allowing future result revisions', async () => {
    const h = await seed(); const payload = h.read();
    Object.assign(payload.items[0], { result: 'Legacy report', resultFor: 1, status: 'done' }); h.write(payload);
    assert.equal((await h.store.load(h.uri)).threads[0].comment, 'Original request');
    payload.items[0].resultFor = 2; h.write(payload);
    await assert.rejects(h.store.load(h.uri), /future revision/);
  });

  for (const phase of ['preparing', 'handedOff'] as const) {
    for (const missing of [false, true]) {
      it(`migrates persisted ${phase} state with ${missing ? 'missing' : 'present'} JSON without a lock`, async () => {
        const h = await seed(); const payload = h.read(); const key = [...h.memento.keys()][0];
        const state = h.memento.get(key) as object;
        h.memento.set(key, { ...state, phase, checkpoint: createReviewTaskCheckpoint(payload), checkpointPath: (state as any).lastValidPath });
        if (missing) h.files.delete(h.sidecar.path);
        const restarted = h.restartStore();
        await restarted.updateComment(h.uri, 'rv_one', 'After upgrade', 1);
        await restarted.exportReviewJson(h.uri, async () => true);
        assert.equal(h.read().items[0].comment, 'After upgrade');
        assert.equal((h.memento.get(key) as any).phase, undefined);
        await h.restartStore().load(h.uri);
        assert.equal('prepareHandoff' in restarted, false);
      });
    }
  }

  it('keeps user comments after an immediate legacy result write/delete and recreates JSON only on user action', async () => {
    const h = await seed(); const payload = h.read();
    Object.assign(payload.items[0], { result: 'Transient report', resultFor: 1 }); h.write(payload);
    h.files.delete(h.sidecar.path);
    const restarted = h.restartStore();
    assert.equal((await restarted.load(h.uri)).threads[0].comment, 'Original request');
    assert.equal(h.files.has(h.sidecar.path), false);
    assert.equal(restarted.getReviewFileState(h.uri), 'removed');
    await restarted.updateComment(h.uri, 'rv_one', 'Next pass', 1);
    assert.equal(restarted.getReviewFileState(h.uri), 'active');
    assert.equal(h.read().items[0].comment, 'Next pass');
    assert.doesNotMatch(REVIEW_TASK_GUIDANCE, /resultFor|record.*result|status|history/i);
    assert.match(REVIEW_TASK_GUIDANCE, /already-satisfied/);
  });

  it('invalidates old review Undo once at the deletion boundary', async () => {
    const h = await seed(); const before = await h.undo.capture(h.uri);
    await h.store.updateThread(h.uri, 'rv_one', { anchor: { text: 'Updated source' } });
    const after = await h.undo.capture(h.uri); h.undo.register(h.uri, 'old', 'new', before, after);
    h.files.delete(h.sidecar.path); await h.store.load(h.uri);
    const epoch = h.store.getDocumentEpoch(h.uri); await h.store.load(h.uri);
    assert.equal(h.store.getDocumentEpoch(h.uri), epoch);
    assert.equal(await h.undo.handleTextDocumentChange(h.change('old', 'undo')), false);
    assert.equal(h.files.has(h.sidecar.path), false);
  });

  for (const changed of [false, true]) {
    it(`recognizes ${changed ? 'changed' : 'same'} external recreations on the first read`, async () => {
      const h = await seed(); const payload = h.read(); h.files.delete(h.sidecar.path); await h.store.load(h.uri);
      if (changed) Object.assign(payload.items[0], { result: 'Legacy imported report', resultFor: 1 });
      h.write(payload); await h.store.load(h.uri);
      assert.equal(h.store.getReviewFileState(h.uri), 'active');
      const restarted = h.restartStore(); await restarted.load(h.uri);
      assert.equal(restarted.getReviewFileState(h.uri), 'active');
    });
  }

  it('recovers another valid slot before allowing an empty restart', async () => {
    const h = await seed(); await h.store.updateComment(h.uri, 'rv_one', 'New request', 1);
    h.files.delete(h.sidecar.path);
    const state = [...h.memento.values()][0] as any; h.files.delete(state.lastValidPath);
    await assert.rejects(h.store.startNewReview(h.uri), /valid comment copy/);
    await h.store.restoreReviewBackup(h.uri);
    assert.equal(h.read().items[0].comment, 'Original request');
  });

  for (const unavailable of ['missing', 'changed'] as const) {
    it(`rejects changed canonical comments when their last accepted copy is ${unavailable}`, async () => {
      const h = await seed(); await h.store.updateComment(h.uri, 'rv_one', 'Latest request', 1);
      const state = [...h.memento.values()][0] as any;
      const replacement = { ...h.read(), items: [] };
      if (unavailable === 'missing') h.files.delete(state.lastValidPath);
      else h.files.set(state.lastValidPath, encoder.encode(JSON.stringify(replacement)));
      h.write(replacement);
      const files = structuredClone([...h.files]);
      await assert.rejects(h.restartStore().load(h.uri), /last accepted copy.*missing or changed/);
      assert.deepEqual([...h.files], files, 'A rejected read must not overwrite the older accepted slot.');
      await h.restartStore().restoreReviewBackup(h.uri);
      assert.equal(h.read().items[0].comment, 'Original request');
    });
  }

  it('repairs a lost accepted slot only from byte-identical accepted canonical JSON', async () => {
    const h = await seed(); await h.store.updateComment(h.uri, 'rv_one', 'Latest request', 1);
    const state = [...h.memento.values()][0] as any; h.files.delete(state.lastValidPath);
    const accepted = h.files.get(h.sidecar.path);
    assert.equal((await h.restartStore().load(h.uri)).threads[0].comment, 'Latest request');
    const repairedState = [...h.memento.values()][0] as any;
    assert.deepEqual(h.files.get(repairedState.lastValidPath), accepted);
  });

  it('rejects changed accepted-copy bytes after canonical JSON deletion', async () => {
    const h = await seed(); const state = [...h.memento.values()][0] as any;
    h.files.set(state.lastValidPath, encoder.encode(JSON.stringify({ ...h.read(), items: [] })));
    h.files.delete(h.sidecar.path);
    await assert.rejects(h.restartStore().load(h.uri), /last accepted copy.*missing or changed/);
  });

  it('offers an explicit fresh start only after all accepted copies are unavailable', async () => {
    const h = await seed(); h.files.delete(h.sidecar.path);
    for (const file of h.files.keys()) if (/valid-[01]\.json$/.test(file)) h.files.delete(file);
    await assert.rejects(h.store.addThread(h.uri, storageThread('rv_next')), /Start New Review/);
    await h.store.startNewReview(h.uri);
    await h.store.addThread(h.uri, storageThread('rv_next'));
    assert.deepEqual(h.read().items.map(item => item.id), ['rv_next']);
    await assert.rejects(h.store.startNewReview(h.uri), /valid comments/);
  });

  it('keeps malformed bytes before a user-confirmed restart and refuses dirty JSON', async () => {
    const h = await seed();
    for (const file of h.files.keys()) if (/valid-[01]\.json$/.test(file)) h.files.delete(file);
    h.files.set(h.sidecar.path, encoder.encode('{broken'));
    h.vscode.workspace.textDocuments.push({ uri: h.sidecar as any, isDirty: true });
    await assert.rejects(h.store.startNewReview(h.uri), /unsaved changes/);
    h.vscode.workspace.textDocuments.length = 0;
    await h.store.startNewReview(h.uri);
    assert.equal(h.read().items.length, 0);
    assert.ok([...h.files.entries()].some(([file, bytes]) => file.includes('before-start-over') && decoder.decode(bytes) === '{broken'));
  });

  it('bounds named snapshots and purges deleted text while preserving current comments', async () => {
    const h = await seed(); await h.store.removeThread(h.uri, 'rv_one', 1);
    for (let index = 0; index < 12; index++) {
      await h.store.addThread(h.uri, storageThread('rv_round' + index, { comment: 'Private removed text ' + index }));
      await h.store.removeThread(h.uri, 'rv_round' + index, 1);
    }
    assert.ok([...h.files.keys()].filter(file => file.includes('/removed-')).length <= 4);
    assert.equal([...h.files.keys()].filter(file => /valid-[01]\.json$/.test(file)).length, 2);
    assert.ok(await h.store.purgeRecovery(h.uri) > 0);
    assert.equal([...h.files.values()].some(bytes => decoder.decode(bytes).includes('Private removed text')), false);
    assert.equal(h.read().items.length, 0);
    h.files.delete(h.sidecar.path);
    assert.equal((await h.restartStore().load(h.uri)).threads.length, 0);
  });

  it('does not delete unrelated files in the recovery directory', async () => {
    const h = await seed(); const state = [...h.memento.values()][0] as any;
    const unrelated = state.lastValidPath.replace(/valid-[01]\.json$/, 'user-notes.json');
    h.files.set(unrelated, encoder.encode('private user file'));
    await h.store.purgeRecovery(h.uri);
    assert.equal(decoder.decode(h.files.get(unrelated)), 'private user file');
  });

  it('never recovers a prepared-but-uncommitted alternate slot', async () => {
    const h = await seed();
    const rename = h.vscode.workspace.fs.rename;
    h.vscode.workspace.fs.rename = async (from, to) => {
      if (to.path === h.sidecar.path) throw new Error('Interrupted before commit');
      await rename(from, to);
    };
    await assert.rejects(h.store.addThread(h.uri, storageThread('rv_never_saved')), /Interrupted/);
    h.vscode.workspace.fs.rename = rename;
    const state = [...h.memento.values()][0] as any;
    h.files.delete(state.lastValidPath); h.files.delete(h.sidecar.path);
    await assert.rejects(h.restartStore().restoreReviewBackup(h.uri), /No valid review backup/);
    await h.store.startNewReview(h.uri);
    assert.equal(h.read().items.length, 0);
  });

  it('preserves an unconfirmed committed write if JSON disappears before restart reconciliation', async () => {
    const h = await seed();
    const rename = h.vscode.workspace.fs.rename;
    h.vscode.workspace.fs.rename = async (from, to) => {
      await rename(from, to);
      if (to.path === h.sidecar.path) h.failNextStateWrites();
    };
    await h.store.addThread(h.uri, storageThread('rv_saved_before_crash'));
    h.failNextStateWrites(0); h.vscode.workspace.fs.rename = rename;
    h.files.delete(h.sidecar.path);
    const restarted = h.restartStore();
    await assert.rejects(restarted.load(h.uri), /last save could be confirmed/);
    await restarted.restoreReviewBackup(h.uri);
    assert.ok([...h.files.entries()].some(([file, bytes]) => file.includes('/before-restore-') && decoder.decode(bytes).includes('rv_saved_before_crash')));
    assert.equal(h.read().items[0].id, 'rv_one');
  });

  it('enforces the named snapshot byte limit before deleting user comments', async () => {
    const h = await seed();
    await h.store.updateComment(h.uri, 'rv_one', 'x'.repeat(8 * 1024 * 1024), 1);
    const before = h.files.get(h.sidecar.path);
    await assert.rejects(h.store.removeThread(h.uri, 'rv_one', 2), /8 MiB retention limit/);
    assert.deepEqual(h.files.get(h.sidecar.path), before);
  });

  it('surfaces inaccessible recovery without overwriting the canonical JSON', async () => {
    const h = await seed(); const before = h.files.get(h.sidecar.path);
    const read = h.vscode.workspace.fs.readFile;
    h.vscode.workspace.fs.readFile = async file => {
      if (file.path.includes('/review-recovery/')) throw new Error('EACCES: repair local storage permissions');
      return read(file);
    };
    await assert.rejects(h.store.restoreReviewBackup(h.uri), /EACCES/);
    await assert.rejects(h.store.startNewReview(h.uri), /valid comments/);
    assert.deepEqual(h.files.get(h.sidecar.path), before);
  });

  it('keeps one bounded recovery directory across repeated document renames', async () => {
    const h = await seed();
    await h.store.addThread(h.uri, storageThread('rv_deleted', { comment: 'Deleted private text' }));
    await h.store.removeThread(h.uri, 'rv_deleted', 1);
    let current = h.uri;
    for (let index = 0; index < 6; index++) {
      const next = h.uriFor('/workspace/renamed-' + index + '.md');
      await h.store.migrateDocument(current, next);
      await h.store.deleteDocumentSidecars(current, next);
      current = next;
    }
    assert.deepEqual((await h.store.load(current)).threads.map(thread => thread.id), ['rv_one']);
    assert.equal(new Set([...h.files.keys()].filter(file => file.includes('/review-recovery/')).map(file => path.dirname(file))).size, 1);
    await h.store.purgeRecovery(current);
    assert.equal([...h.files.values()].some(bytes => decoder.decode(bytes).includes('Deleted private text')), false);
    assert.equal((await h.store.load(h.uri)).threads.length, 0, 'Reusing the old name must not revive its comments.');
  });

  it('retains a comment saved between split rename migration and cleanup', async () => {
    const h = await seed(); const next = h.uriFor('/workspace/renamed.md');
    await h.store.migrateDocument(h.uri, next);
    await h.store.updateComment(h.uri, 'rv_one', 'Saved while rename was completing', 1);
    const files = structuredClone([...h.files]);
    await assert.rejects(h.restartStore().deleteDocumentSidecars(h.uri, next), /changed while rename was completing/);
    assert.deepEqual([...h.files], files);
    assert.equal((await h.restartStore().load(h.uri)).threads[0].comment, 'Saved while rename was completing');
  });

  it('keeps the source when the migrated destination changes before cleanup', async () => {
    const h = await seed(); const next = h.uriFor('/workspace/renamed.md');
    await h.store.migrateDocument(h.uri, next);
    await h.store.updateComment(next, 'rv_one', 'Saved at the new name', 1);
    await assert.rejects(h.store.deleteDocumentSidecars(h.uri, next), /destination review changed/);
    assert.equal(h.files.has(h.sidecar.path), true);
    assert.equal((await h.store.load(next)).threads[0].comment, 'Saved at the new name');
  });

  it('completes an atomic rename before queued saves can edit the old comment', async () => {
    const h = await seed(); const next = h.uriFor('/workspace/renamed.md');
    const destination = await h.store.getReviewFileUri(next);
    let reachedDestination!: () => void, releaseWrite!: () => void;
    const reached = new Promise<void>(resolve => { reachedDestination = resolve; });
    const release = new Promise<void>(resolve => { releaseWrite = resolve; });
    const rename = h.vscode.workspace.fs.rename;
    h.vscode.workspace.fs.rename = async (from, to) => {
      if (to.path === destination.path) { reachedDestination(); await release; }
      await rename(from, to);
    };
    const migrating = h.store.renameDocument(h.uri, next);
    await reached;
    const saving = h.store.updateComment(h.uri, 'rv_one', 'Queued stale save', 1);
    releaseWrite();
    const results = await Promise.allSettled([migrating, saving]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(h.files.has(h.sidecar.path), false);
    assert.equal((await h.store.load(next)).threads[0].comment, 'Original request');
  });

  it('renames a document with no review state without creating a task or error', async () => {
    const h = createReviewStorageHarness(); const next = h.uriFor('/workspace/renamed.md');
    await h.store.migrateDocument(h.uri, next);
    await h.store.deleteDocumentSidecars(h.uri, next);
    assert.equal(h.files.size, 0);
  });
});
