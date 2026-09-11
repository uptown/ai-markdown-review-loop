/*
 * Run this as a temporary smoke-driver extension with an isolated --user-data-dir,
 * --extensions-dir and workspace. Do not use --extensionTestsPath for the restart
 * check: VS Code's test mode uses in-memory storage. No APIs are mocked. 'resume'
 * deliberately waits for the real recovery confirmation dialog to be accepted.
 * Set AI_REVIEW_HOST_SMOKE_DIR to a temp directory containing a workspace/
 * directory and an .isolated-smoke marker; set AI_REVIEW_HOST_SMOKE_PHASE to
 * 'handoff' for the first process and 'resume' for the second process.
 * A file edit here simulates an external agent; no model is called.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vscode = require('vscode');

exports.activate = () => {
  void exports.run().catch(error => console.error(error)).finally(() =>
    vscode.commands.executeCommand('workbench.action.quit'));
};

exports.run = async function run() {
  const root = path.resolve(process.env.AI_REVIEW_HOST_SMOKE_DIR || '');
  const phase = process.env.AI_REVIEW_HOST_SMOKE_PHASE;
  assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep) || root.startsWith('/tmp/'));
  assert.equal(fs.readFileSync(path.join(root, '.isolated-smoke'), 'utf8').trim(), 'ai-markdown-review-loop');
  assert.ok(phase === 'handoff' || phase === 'resume');
  const workspace = path.join(root, 'workspace');
  assert.equal(fs.realpathSync(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath), fs.realpathSync(workspace));
  const evidencePath = path.join(root, 'evidence-' + phase + '.json');
  const evidence = {
    phase, vscode: vscode.version, extensionVersion: '', startedAt: new Date().toISOString(),
    apiMocks: false, externalEdit: 'Node filesystem simulation, not a model run', checks: []
  };
  const record = (check, details) => {
    evidence.checks.push({ check, ...(details ? { details } : {}) });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    console.log('[real-host-smoke] ' + check);
  };
  const execute = async (id, uri) => {
    let timer;
    try {
      return await Promise.race([
        vscode.commands.executeCommand('aiMarkdownReviewLoop.' + id, uri),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(id + ' timed out')), 45000); })
      ]);
    } finally { clearTimeout(timer); }
  };
  const previousClipboard = await vscode.env.clipboard.readText();
  try {
    const extension = vscode.extensions.getExtension('uptown.ai-markdown-review-loop');
    assert.ok(extension, 'The development extension must be loaded by VS Code.');
    await extension.activate();
    evidence.extensionVersion = extension.packageJSON.version;
    evidence.bundleSha256 = createHash('sha256').update(fs.readFileSync(path.join(extension.extensionPath, 'out/extension.js'))).digest('hex');
    const commands = await vscode.commands.getCommands(true);
    for (const retired of ['reviewDocument', 'exportFeedback', 'openContextBootstrapPrompt', 'openFeedbackLoopPrompt']) {
      assert.equal(commands.includes('aiMarkdownReviewLoop.' + retired), false, retired + ' is retired');
    }
    record('actual-extension-activated-and-retired-commands-absent');
    const sourcePath = path.join(workspace, 'spec.md');
    const sidecarPath = path.join(workspace, '.spec.md.ai-review.json');
    const uri = vscode.Uri.file(sourcePath);
    if (phase === 'handoff') {
      assert.equal(fs.existsSync(sourcePath), false, 'Use a fresh isolated fixture.');
      const policy = fs.readFileSync(path.join(extension.extensionPath, 'docs/AI-REVIEW-POLICY.md'), 'utf8');
      const initial = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(policy)[1]);
      initial.items = [
        { id: 'rv_retry', rev: 1, target: { quote: 'Retry failed requests.', line: 3 }, comment: 'Define the retry limit.', status: 'pending' },
        { id: 'rv_owner', rev: 1, target: { quote: 'An owner approves launch.', line: 5 }, comment: 'Name the launch owner.', status: 'pending' }
      ];
      fs.writeFileSync(sourcePath, '# Retry policy\n\nRetry failed requests.\n\nAn owner approves launch.\n');
      fs.writeFileSync(sidecarPath, JSON.stringify(initial, null, 2) + '\n');
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await execute('openReviewBeside', uri);
    await waitFor(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.input?.viewType === 'aiMarkdownReviewLoop.reviewEditor')), 'custom review editor tab');
    record('actual-custom-editor-opened-beside-source');
    if (phase === 'handoff') {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(document.lineCount, 0), '\nHost smoke note.\n');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(document.isDirty, true);
      await execute('handoff', uri);
      assert.equal(document.isDirty, false);
      assert.match(fs.readFileSync(sourcePath, 'utf8'), /Host smoke note/);
      const copied = await vscode.env.clipboard.readText();
      assert.match(copied, /\.spec\.md\.ai-review\.json/);
      assert.match(copied, /Stop writing/);
      const tasks = readTasks(sidecarPath);
      assert.equal(tasks.schemaVersion, 3);
      assert.equal(tasks.items.length, 2);
      record('handoff-saved-dirty-source-and-copied-short-file-request');
      // Simulate an external process; deliberately avoid WorkspaceEdit for agent changes.
      fs.writeFileSync(sourcePath, fs.readFileSync(sourcePath, 'utf8').replace('Retry failed requests.', 'Retry failed requests up to three times.'));
      tasks.items[0] = { ...tasks.items[0], status: 'done', result: 'Defined three retries.', resultFor: 1 };
      tasks.items[1] = { ...tasks.items[1], status: 'blocked', result: 'Which team owns launch approval?', resultFor: 1 };
      fs.writeFileSync(sidecarPath, JSON.stringify(tasks, null, 2) + '\n');
      await waitFor(() => document.getText().includes('up to three times'), 'external source reload');
      record('external-file-edit-with-done-and-blocked-results-observed');
      record('exit-with-handoff-active-for-second-process-persistence-check');
    } else {
      const beforeCopy = readTasks(sidecarPath);
      assert.equal(beforeCopy.items.length, 2);
      await execute('copyReviewFile', uri);
      const copied = JSON.parse(await vscode.env.clipboard.readText());
      assert.deepEqual(copied, beforeCopy, 'Persisted handoff must use the active copy branch, not archive done work as a new handoff.');
      assert.equal(readTasks(sidecarPath).items.length, 2);
      record('handoff-pause-survived-real-extension-host-process-restart');
      await execute('resumeReview', uri);
      assert.match(document.getText(), /up to three times/);
      assert.equal(readTasks(sidecarPath).items[0].status, 'done');
      record('resume-validates-results-and-preserves-revised-source');
      await execute('handoff', uri);
      const next = readTasks(sidecarPath);
      assert.deepEqual(next.items.map(item => item.id), ['rv_owner']);
      assert.equal(next.items[0].status, 'blocked');
      const archives = findFiles(root, name => name.startsWith('completed-') && name.endsWith('.json'));
      assert.ok(archives.some(file => readTasks(file).items.some(item => item.id === 'rv_retry' && item.resultFor === 1)));
      record('second-round-archives-completed-item-and-keeps-blocked-item');
      fs.writeFileSync(sidecarPath, '{ invalid external JSON');
      await execute('openReviewFile', uri);
      const inspection = vscode.window.activeTextEditor?.document;
      assert.equal(inspection?.uri.scheme, 'ai-markdown-review-loop-prompt');
      assert.match(inspection.getText(), /invalid external JSON/);
      assert.equal(fs.readFileSync(sidecarPath, 'utf8'), '{ invalid external JSON');
      record('invalid-json-opens-in-actual-read-only-content-provider');
      record('awaiting-real-recovery-confirmation-dialog');
      await execute('restoreReviewBackup', uri);
      assert.deepEqual(readTasks(sidecarPath), next);
      assert.match(fs.readFileSync(sourcePath, 'utf8'), /up to three times/);
      assert.ok(findFiles(root, name => name.startsWith('before-restore-')).some(file =>
        fs.readFileSync(file, 'utf8') === '{ invalid external JSON'));
      record('confirmed-recovery-restores-checkpoint-preserves-corrupt-copy-and-source');
      await execute('copyReviewFile', uri);
      await execute('cancelHandoff', uri);
      assert.deepEqual(readTasks(sidecarPath), next);
      record('copy-handoff-and-cancel-return-without-source-rollback');
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.result = 'passed';
  } catch (error) {
    evidence.result = 'failed';
    evidence.error = String(error?.stack || error);
    throw error;
  } finally {
    await vscode.env.clipboard.writeText(previousClipboard);
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  }
};

function readTasks(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function findFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? findFiles(file, predicate) : predicate(entry.name) ? [file] : [];
  });
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
