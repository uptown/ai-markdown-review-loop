import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHarness } from './helpers/providerHarness';

const plan = { start: 0, end: 6, replacement: 'Updated.', lineStart: 1, lineEnd: 1, actor: 'user', intent: 'manual_block_edit' };

describe('review provider source safety (R02)', () => {
  it('rejects a concurrent source edit during sidecar capture without writing review state', async () => {
    const h = await createProviderHarness();
    const before = h.document.getText();
    h.provider.reviewUndo.capture = async () => { h.changeText('First.\n\nLATEST.\n'); return h.snapshot; };
    assert.equal(await h.provider.applyReviewAwareEdit(h.document, plan, before, 1), false);
    assert.equal(h.document.getText(), 'First.\n\nLATEST.\n');
    assert.equal(h.saveCount, 0);
    assert.equal(h.edits.length, 0);
  });

  it('rechecks revision after waiting for the document transaction', async () => {
    const h = await createProviderHarness();
    const before = h.document.getText();
    h.store.withDocumentTransaction = async (_uri: unknown, action: () => Promise<unknown>) => { h.changeText('First.\n\nLATEST.\n'); return action(); };
    assert.equal(await h.provider.applyReviewAwareEdit(h.document, plan, before, 1), false);
    assert.equal(h.edits.length, 0);
  });

  it('applies only the changed source range and records exactly its result', async () => {
    const h = await createProviderHarness();
    const before = h.document.getText();
    assert.equal(await h.provider.applyReviewAwareEdit(h.document, plan, before, 1), true);
    assert.equal(h.document.getText(), 'Updated.\n\nSecond.\n');
    assert.ok(h.edits[0].endOffset <= 6);
    assert.equal(h.saveCount, 1);
    assert.equal(h.registrations[0][2], 'Updated.\n\nSecond.\n');
  });

  it('registers Undo without fallible sidecar reads after a successful commit', async () => {
    const h = await createProviderHarness();
    let captures = 0;
    h.provider.reviewUndo.capture = async () => {
      if (++captures > 1) throw new Error('post-commit read failed');
      return h.snapshot;
    };
    assert.equal(await h.provider.applyReviewAwareEdit(h.document, plan, h.document.getText(), 1), true);
    assert.equal(captures, 1);
    assert.equal(h.registrations.length, 1);
    assert.deepEqual(h.registrations[0][4].documents.reviewDocument.threads, []);
  });

  it('preserves legacy closure history while committing and undoing a source edit before migration', async () => {
    const h = await createProviderHarness();
    const { store, undo } = h.useRealStore();
    const now = '2026-09-09T00:00:00Z';
    const legacy = {
      id: 'rv_legacy_closed', documentUri: h.document.uri.toString(),
      anchor: { text: 'Second.', lineStart: 3, lineEnd: 3, confidence: 'exact' },
      comment: 'Clarify the original wording.', type: 'note', source: 'human', severity: 'medium',
      status: 'accepted', closedBy: 'user', closedAt: now, createdAt: now, updatedAt: now,
      thread: [{ role: 'assistant', text: 'The user accepted this earlier change.', createdAt: now }],
      suggestedPatch: { mode: 'replace', original: 'Original.', replacement: 'Second.' }
    };
    const sidecar = await store.getReviewFileUri(h.document.uri);
    h.files.set(sidecar.toString(), new TextEncoder().encode(JSON.stringify({
      schemaVersion: 2, documentUri: h.document.uri.toString(), updatedAt: now,
      openThreads: [], closedThreads: [legacy]
    })));
    const before = h.document.getText();
    assert.equal(await h.provider.applyReviewAwareEdit(h.document, plan, before, h.document.version), true);
    const after = h.document.getText();
    assert.equal(after, 'Updated.\n\nSecond.\n');
    assert.equal(h.registrations.length, 1);
    const committed = JSON.parse(new TextDecoder().decode(h.files.get(sidecar.toString())!));
    const snapshot = JSON.parse(new TextDecoder().decode(h.registrations[0][4].reviewBytes));
    assert.equal(committed.schemaVersion, 2);
    assert.equal(snapshot.schemaVersion, 2);
    assert.deepEqual(committed.closedThreads, [legacy]);
    assert.deepEqual(snapshot.closedThreads, [legacy]);
    for (const [text, reason] of [[before, 1], [after, 2]] as const) {
      h.changeText(text);
      assert.equal(await undo.handleTextDocumentChange({ document: h.document, reason }), true);
      assert.deepEqual((await store.loadResolved(h.document.uri)).threads, [legacy]);
    }
  });

  it('records Store-normalized task revisions in Undo snapshots and replays source anchors', async () => {
    const h = await createProviderHarness();
    const { store, undo } = h.useRealStore();
    await store.addThread(h.document.uri, {
      id: 'rv_blocked', documentUri: h.document.uri.toString(),
      anchor: { text: 'First.', lineStart: 1, lineEnd: 1, confidence: 'exact' },
      comment: 'Clarify this wording.', type: 'note', source: 'human', severity: 'medium',
      status: 'open', createdAt: '', updatedAt: '', thread: [],
      taskRevision: 1, taskStatus: 'blocked', taskResult: 'Waiting for clarification.', taskResultFor: 1
    });
    const before = h.document.getText();
    assert.equal(await h.provider.applyReviewAwareEdit(h.document, plan, before, h.document.version), true);
    const after = h.document.getText();
    const current = (await store.load(h.document.uri)).threads[0];
    const recorded = h.registrations[0][4].documents.reviewDocument.threads[0];
    assert.equal(current.taskRevision, 2);
    assert.equal(recorded.taskRevision, current.taskRevision);
    assert.equal(recorded.taskStatus, 'pending');
    assert.equal(recorded.taskResult, undefined);
    assert.equal(recorded.anchor.text, current.anchor.text);
    for (const [text, reason, quote] of [[before, 1, 'First.'], [after, 2, 'Updated.']] as const) {
      h.changeText(text);
      assert.equal(await undo.handleTextDocumentChange({ document: h.document, reason }), true);
      const restored = (await store.load(h.document.uri)).threads[0];
      assert.equal(restored.anchor.text, quote);
      assert.equal(restored.taskStatus, 'pending');
      assert.ok(restored.taskRevision > 2);
    }
  });

  it('does not overwrite newer source when sidecar failure prevents a clean rollback', async () => {
    const h = await createProviderHarness();
    h.store.saveBoth = async () => { h.changeText('Updated.\n\nLATEST.\n'); throw new Error('disk failed'); };
    await assert.rejects(h.provider.applyReviewAwareEdit(h.document, plan, h.document.getText(), 1), /rollback|newer/i);
    assert.equal(h.document.getText(), 'Updated.\n\nLATEST.\n');
    assert.equal(h.edits.length, 1);
  });

  it('rolls back its own source edit when no later source change occurred', async () => {
    const h = await createProviderHarness();
    const before = h.document.getText();
    h.store.saveBoth = async () => { throw new Error('disk failed'); };
    await assert.rejects(h.provider.applyReviewAwareEdit(h.document, plan, before, 1), /disk failed/);
    assert.equal(h.document.getText(), before);
  });

  it('preserves external review bytes when a sidecar conflict rolls back source', async () => {
    const h = await createProviderHarness();
    const before = h.document.getText();
    const external = new TextEncoder().encode('external review state');
    h.store.saveBoth = async () => {
      h.files.set(h.snapshot.reviewUri.toString(), external);
      throw new h.ReviewStorageConflictError();
    };
    await assert.rejects(h.provider.applyReviewAwareEdit(h.document, plan, before, 1), /Review state changed/);
    assert.equal(h.document.getText(), before);
    assert.deepEqual(h.files.get(h.snapshot.reviewUri.toString()), external);
  });

  it('normalizes rich-editor LF replacements to CRLF before recording Undo', async () => {
    const before = 'First.\r\n\r\nSecond.\r\n';
    const h = await createProviderHarness(before);
    assert.equal(await h.provider.applyReviewAwareEdit(h.document, { ...plan, replacement: 'Updated.\nAnother.' }, before, 1), true);
    const after = 'Updated.\r\nAnother.\r\n\r\nSecond.\r\n';
    assert.equal(h.document.getText(), after);
    assert.equal(h.registrations[0][2], after);
  });

  it('does not issue an empty range for an EOL-only difference inside CRLF', async () => {
    const before = 'First.\r\nSecond.';
    const h = await createProviderHarness(before);
    assert.equal(await h.provider.replaceDocumentMarkdown(h.document, before, 'First.\nSecond.', 1), true);
    assert.equal(h.document.getText(), before);
    assert.equal(h.edits.length, 0);
  });

  it('rolls back a CRLF edit using the exact normalized result', async () => {
    const before = 'First.\r\n\r\nSecond.\r\n';
    const h = await createProviderHarness(before);
    h.store.saveBoth = async () => { throw new Error('disk failed'); };
    await assert.rejects(h.provider.applyReviewAwareEdit(h.document, { ...plan, replacement: 'Updated.\nAnother.' }, before, 1), /disk failed/);
    assert.equal(h.document.getText(), before);
  });

  it('rejects stale or missing webview revisions before processing source mutations', async () => {
    const h = await createProviderHarness();
    await h.open();
    h.changeText('LATEST.\n');
    for (const type of ['editMarkdownBlock', 'insertMarkdownBlock', 'deleteMarkdownBlock', 'editMermaidSource', 'editMarkdownTable', 'cleanupLegacyMetadata']) {
      await h.message({ type, documentVersion: 1, lineStart: 1, lineEnd: 1, afterLine: 1, rawMarkdown: 'Changed.', intent: 'manual_block_edit', source: 'graph TD; A-->B' });
    }
    await h.message({ type: 'editMarkdownBlock', lineStart: 1, lineEnd: 1, rawMarkdown: 'Changed.', intent: 'manual_block_edit' });
    assert.equal(h.document.getText(), 'LATEST.\n');
    assert.equal(h.edits.length, 0);
    assert.equal(h.warnings.length, 7);
    assert.ok(h.warnings.every(message => /changed|refresh|stale/i.test(message)));
  });
});
