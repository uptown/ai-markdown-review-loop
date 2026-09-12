/* Normal-mode isolated driver: no VS Code API mocks or production test hooks.
 * The companion runner installs a VSIX, owns fixture files and drives its real webview.
 * Normal mode preserves workspace storage across processes; test mode does not.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const vscode = require('vscode');
let restoreClipboard;
exports.deactivate = () => restoreClipboard?.();
exports.activate = async function activate(context) {
  const root = path.resolve(process.env.AI_REVIEW_HOST_SMOKE_DIR || '');
  const evidence = { apiMocks: false, phase: process.env.AI_REVIEW_HOST_SMOKE_PHASE, vscode: vscode.version };
  try {
    assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep) || root.startsWith('/tmp/'));
    assert.equal(fs.readFileSync(path.join(root, '.isolated-smoke'), 'utf8').trim(), 'ai-markdown-review-loop');
    const workspace = path.join(root, 'workspace');
    // VS Code normalizes Windows drive letters; realpath alone preserves that
    // casing difference. Keep native path semantics and reject other directories.
    assert.equal(path.relative(fs.realpathSync(workspace), fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath)), '', 'The driver must use its isolated workspace.');
    const sourceEvents = [];
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme !== 'file' || path.basename(event.document.uri.fsPath) !== 'spec.md') return;
      const relative = path.relative(workspace, event.document.uri.fsPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
      sourceEvents.push({ uri: event.document.uri.toString(), version: event.document.version, reason: event.reason,
        dirty: event.document.isDirty, sha256: createHash('sha256').update(event.document.getText()).digest('hex') });
      fs.writeFileSync(path.join(root, 'source-events-' + evidence.phase + '.json'), JSON.stringify(sourceEvents));
    }));
    const extension = vscode.extensions.getExtension('uptown.ai-markdown-review-loop');
    assert.ok(extension, 'The candidate must be installed in the isolated extensions directory.');
    await extension.activate();
    evidence.extensionVersion = extension.packageJSON.version;
    evidence.extensionPath = extension.extensionPath;
    const installedPath = path.relative(path.join(root, 'extensions'), extension.extensionPath);
    assert.ok(installedPath && !installedPath.startsWith('..') && !path.isAbsolute(installedPath));
    evidence.bundleSha256 = createHash('sha256').update(fs.readFileSync(path.join(extension.extensionPath, 'out/extension.js'))).digest('hex');
    evidence.trusted = vscode.workspace.isTrusted;
    const previousClipboard = await vscode.env.clipboard.readText();
    let ownedClipboard;
    restoreClipboard = async () => {
      // The desktop clipboard is shared with the user's other applications.
      // Release ownership before awaiting so quit/deactivate cannot restore twice.
      const owned = ownedClipboard;
      ownedClipboard = undefined;
      if (owned !== undefined && await vscode.env.clipboard.readText() === owned) {
        await vscode.env.clipboard.writeText(previousClipboard);
      }
    };
    const commands = await vscode.commands.getCommands(true);
    for (const name of ['handoff', 'copyReviewFile', 'resumeReview', 'cancelHandoff', 'reviewDocument', 'exportFeedback', 'openContextBootstrapPrompt', 'openFeedbackLoopPrompt']) {
      assert.equal(commands.includes('aiMarkdownReviewLoop.' + name), false, name + ' must be retired');
    }
    const open = async filename => {
      assert.ok(filename && !path.isAbsolute(filename) && !filename.split(/[\\/]/).includes('..'));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const uri = vscode.Uri.file(path.join(workspace, filename));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('aiMarkdownReviewLoop.openReviewBeside', uri);
    };
    await open('docs/spec.md');
    let busy = false;
    let seen = '';
    const timer = setInterval(async () => {
      if (busy) return;
      let request;
      try { request = JSON.parse(fs.readFileSync(path.join(root, 'control.json'), 'utf8')); } catch { return; }
      if (request.id === seen) return;
      seen = request.id;
      busy = true;
      const response = { id: request.id };
      try {
        if (request.action === 'open') await open(request.file);
        else if (request.action === 'command') {
          assert.ok(['copyReviewJson', 'restoreReviewBackup', 'startNewReview', 'purgeRecovery'].includes(request.command));
          const file = request.file || 'docs/spec.md';
          assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'));
          await vscode.commands.executeCommand('aiMarkdownReviewLoop.' + request.command, vscode.Uri.file(path.join(workspace, file)));
          if (request.command === 'copyReviewJson') {
            response.clipboard = await vscode.env.clipboard.readText();
            ownedClipboard = response.clipboard;
          }
        } else if (request.action === 'undoSource') {
          await vscode.commands.executeCommand('undo');
        } else if (request.action === 'focusSource' || request.action === 'saveSource') {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'docs/spec.md')));
          if (request.action === 'saveSource') {
            assert.equal(await document.save(), true);
          } else {
            if (commands.includes('workbench.action.closeAuxiliaryBar')) await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
            await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
            response.sourceUri = document.uri.toString();
            response.version = document.version;
          }
        } else if (request.action === 'quit') {
          await restoreClipboard();
          for (const document of vscode.workspace.textDocuments) {
            if (!document.isDirty) continue;
            const relative = path.relative(workspace, document.uri.fsPath);
            assert.ok(document.uri.scheme === 'file' && relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Only runner-owned fixture buffers may be saved on exit.');
            assert.equal(await document.save(), true);
          }
          await vscode.commands.executeCommand('workbench.action.closeAllEditors');
          setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 100);
        } else throw new Error('Unknown smoke action');
        response.ok = true;
      } catch (error) { response.error = String(error.stack || error); }
      fs.writeFileSync(path.join(root, 'control-result.json'), JSON.stringify(response));
      busy = false;
    }, 75);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    evidence.ready = true;
  } catch (error) { evidence.error = String(error.stack || error); }
  fs.writeFileSync(path.join(root, 'driver-' + evidence.phase + '.json'), JSON.stringify(evidence, null, 2));
};
