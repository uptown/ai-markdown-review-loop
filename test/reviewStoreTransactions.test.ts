import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createReviewStorageHarness, storageThread } from './helpers/reviewStorageHarness';

const now = '2026-09-09T00:00:00Z';

describe('review store transactions', () => {
  it('preserves concurrent comment changes and automatic anchor updates', async () => {
    const { store, uri } = createReviewStorageHarness();
    await store.addThread(uri, storageThread('rv_original'));
    await Promise.all([
      store.updateComment(uri, 'rv_original', 'first edit'),
      store.updateThreadAnchors(uri, [{ threadId: 'rv_original', lineStart: 2, lineEnd: 2, confidence: 'recovered', locatedAt: now }]),
      store.updateComment(uri, 'rv_original', 'second edit')
    ]);
    const thread = (await store.load(uri)).threads[0];
    assert.equal(thread.comment, 'second edit');
    assert.equal(thread.taskRevision, 4);
    assert.equal(thread.anchor.lineStart, 2);
  });

  it('holds the queue across a provider read/modify/write and permits nested store operations', async () => {
    const { store, uri } = createReviewStorageHarness('/workspace', true);
    await store.addThread(uri, storageThread('rv_original'));
    let unblock!: () => void;
    let signalRead!: () => void;
    const read = new Promise<void>(resolve => { signalRead = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const providerWrite = store.withDocumentTransaction(uri, async () => {
      const document = await store.load(uri);
      signalRead();
      await gate;
      document.threads[0].comment = 'provider edit';
      await store.save(uri, document);
    });
    await read;
    const reply = store.addThread(uri, storageThread('rv_queued'));
    unblock();
    await Promise.all([providerWrite, reply]);
    const thread = (await store.load(uri)).threads[0];
    assert.equal(thread.comment, 'provider edit');
    assert.equal((await store.load(uri)).threads[1].id, 'rv_queued');
  });

  it('rejects externally changed sidecars without restoring stale bytes over them', async () => {
    const { store, uri, files, ReviewStorageConflictError } = createReviewStorageHarness('/workspace', true);
    await store.addThread(uri, storageThread('rv_original'));
    const sidecar = await store.getReviewFileUri(uri);
    let externalBytes: Uint8Array | undefined;
    await assert.rejects(store.withDocumentTransaction(uri, async () => {
      const open = await store.load(uri);
      const closed = await store.loadResolved(uri);
      const external = JSON.parse(new TextDecoder().decode(files.get(sidecar.path)));
      external.openThreads.push(storageThread('rv_external'));
      externalBytes = new TextEncoder().encode(JSON.stringify(external));
      files.set(sidecar.path, externalBytes);
      open.threads[0].comment = 'stale edit';
      await store.saveBoth(uri, open, closed);
    }), ReviewStorageConflictError);
    assert.deepEqual(files.get(sidecar.path), externalBytes);
    assert.deepEqual((await store.load(uri)).threads.map(thread => thread.id), ['rv_original', 'rv_external']);
  });

  it('releases a failed transaction so following writes can proceed', async () => {
    const { store, uri, failNextWrites } = createReviewStorageHarness('/workspace', true);
    await store.addThread(uri, storageThread('rv_original'));
    failNextWrites();
    await assert.rejects(store.updateComment(uri, 'rv_original', 'failed'), /Injected write failure/);
    await store.updateComment(uri, 'rv_original', 'survives');
    assert.equal((await store.load(uri)).threads[0].comment, 'survives');
  });
});

describe('review sidecar rename identity', () => {
  it('preserves the target sidecar when its old name points to the same physical file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-rename-test-'));
    const harness = createReviewStorageHarness(directory);
    const { store, uri, uriFor, vscode } = harness;
    vscode.workspace.fs.createDirectory = async value => { await fs.promises.mkdir(value.path, { recursive: true }); };
    vscode.workspace.fs.readFile = async value => fs.promises.readFile(value.path);
    vscode.workspace.fs.writeFile = async (value, bytes) => { await fs.promises.writeFile(value.path, bytes); };
    vscode.workspace.fs.rename = async (from, to) => { await fs.promises.rename(from.path, to.path); };
    vscode.workspace.fs.delete = async value => { await fs.promises.unlink(value.path); };
    vscode.workspace.fs.readDirectory = async value => (await fs.promises.readdir(value.path, { withFileTypes: true })).map(entry => [entry.name, entry.isFile() ? 1 : 2]);
    vscode.workspace.fs.stat = async value => {
      const stat = await fs.promises.stat(value.path);
      return { type: 1, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
    };
    const target = uriFor(path.join(directory, 'Spec.md'));
    const sourceSidecar = path.join(directory, '.spec.md.ai-review.json');
    const targetSidecar = path.join(directory, '.Spec.md.ai-review.json');
    try {
      await store.addThread(uri, storageThread('rv_original'));
      // Case-insensitive volumes already alias these names. A hard link exercises the
      // same identity condition on case-sensitive CI volumes without lowercasing paths.
      if (!fs.existsSync(targetSidecar)) { fs.linkSync(sourceSidecar, targetSidecar); }
      await store.migrateDocument(uri, target);
      await store.deleteDocumentSidecars(uri, target);
      assert.equal(fs.existsSync(targetSidecar), true);
      assert.deepEqual((await store.load(target)).threads.map(thread => thread.id), ['rv_original']);
    } finally {
      function cleanup(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) cleanup(file); else fs.unlinkSync(file);
        }
        fs.rmdirSync(dir);
      }
      cleanup(directory);
    }
  });

  it('removes a genuinely distinct old sidecar after migration', async () => {
    const { store, uri, uriFor, files } = createReviewStorageHarness('/workspace', true);
    const target = uriFor('/workspace/renamed.md');
    await store.addThread(uri, storageThread('rv_original'));
    await store.migrateDocument(uri, target);
    await store.deleteDocumentSidecars(uri, target);
    assert.equal(files.has('/workspace/.spec.md.ai-review.json'), false);
    assert.deepEqual((await store.load(target)).threads.map(thread => thread.id), ['rv_original']);
  });
});
