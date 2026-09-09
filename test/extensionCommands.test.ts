import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionCommandHarness } from './helpers/extensionCommandHarness';

describe('review command context and local checks', () => {
  it('keeps the existing local command ID and reports already-closed findings without recreating them', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document);
    await h.run('reviewDocument');
    const thread = (await h.store.load(document.uri)).threads[0];
    await h.store.updateThread(document.uri, thread.id, { status: 'rejected' });
    await h.run('reviewDocument');
    assert.match(h.information[0], /1 new/);
    assert.match(h.information[1], /0 new, 0 already open, 1 previously closed/);
    assert.match(h.information[1], /rule-based checks/);
    assert.equal((await h.store.load(document.uri)).threads.length, 0);
    assert.equal((await h.store.loadResolved(document.uri)).threads[0].id, thread.id);
    h.dispose();
  });

  it('explains the local-check scope when there are no matching rules', async () => {
    const h = await createExtensionCommandHarness();
    h.setActiveSource(h.addDocument('/workspace/spec.md', '# Spec\n\n## 완료 기준\n\n- Checks pass.'));
    await h.run('reviewDocument');
    assert.match(h.information[0], /no matching issues/);
    assert.match(h.information[0], /rule-based checks/);
    assert.equal(h.files.size, 0);
    h.dispose();
  });

  it('opens a generic bootstrap prompt from the command palette while only the review preview is active', async () => {
    const h = await createExtensionCommandHarness();
    h.setActivePreview(h.addDocument('/workspace/spec.md'));
    await h.run('openContextBootstrapPrompt');
    assert.equal(h.shownDocuments.length, 1);
    assert.match(h.shownDocuments[0].getText(), /AI Markdown Review Loop Agent Prompt/);
    assert.doesNotMatch(h.shownDocuments[0].getText(), /Current Markdown target:|spec\.md/);
    assert.deepEqual(h.warnings, []);
    h.dispose();
  });

  it('includes the selected review target in feedback-loop prompts from both preview and source editor', async () => {
    const h = await createExtensionCommandHarness();
    h.setActivePreview(h.addDocument('/workspace/docs/spec.md'));
    await h.run('openFeedbackLoopPrompt');
    assert.match(h.shownDocuments[0].getText(), /Current Markdown target: `docs\/spec\.md`/);
    h.setActiveSource(h.addDocument('/workspace/other.md'));
    await h.run('openFeedbackLoopPrompt');
    assert.match(h.shownDocuments[1].getText(), /Current Markdown target: `other\.md`/);
    h.dispose();
  });

  it('exports the review preview target for agent handoff', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/docs/spec.md');
    h.setActivePreview(document);
    await h.run('reviewDocument');
    await h.run('exportFeedback');
    const prompt = h.shownDocuments[0].getText();
    assert.match(prompt, /Document: file:\/\/\/workspace\/docs\/spec\.md/);
    assert.match(prompt, /Open feedback: 1/);
    h.dispose();
  });

  it('does not fall back to another Markdown file when an explicit non-Markdown target is selected', async () => {
    const h = await createExtensionCommandHarness();
    h.setActiveSource(h.addDocument('/workspace/spec.md'));
    const other = h.addDocument('/workspace/notes.txt', 'TODO: unrelated text.', 'plaintext');
    await h.run('reviewDocument', other.uri);
    assert.equal(h.files.size, 0);
    assert.match(h.warnings[0], /Open a Markdown document/);
    h.dispose();
  });
});

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

  it('leaves invalid review data untouched and does not retry when the error is dismissed', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document);
    const sidecar = await h.store.getReviewFileUri(document.uri);
    const invalid = new TextEncoder().encode('{broken');
    h.files.set(sidecar.toString(), invalid);
    await h.run('reviewDocument');
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0].message, /Run Local Checks failed for spec\.md: Review sidecar is invalid/);
    assert.deepEqual(h.files.get(sidecar.toString()), invalid);
    assert.equal(h.information.length, 0);
    h.dispose();
  });

  it('can retry after review data is repaired without duplicating an existing finding', async () => {
    const h = await createExtensionCommandHarness();
    const document = h.addDocument('/workspace/spec.md');
    h.setActivePreview(document);
    await h.run('reviewDocument');
    const sidecar = await h.store.getReviewFileUri(document.uri);
    const valid = h.files.get(sidecar.toString())!;
    h.files.set(sidecar.toString(), new TextEncoder().encode('{broken'));
    h.chooseOnError('Retry', () => h.files.set(sidecar.toString(), valid));
    await h.run('reviewDocument');
    assert.equal(h.errors.length, 1);
    assert.match(h.information[1], /0 new, 1 already open, 0 previously closed/);
    assert.equal((await h.store.load(document.uri)).threads.length, 1);
    h.dispose();
  });
});
