import * as vscode from 'vscode';
import path from 'path';
import { openReadOnlyMarkdownPrompt, registerPromptDocumentProvider } from './promptDocuments';
import { ReviewEditorProvider, reviewEditorViewType } from './reviewEditorProvider';
import { ReviewStore } from './reviewStore';

export function activate(context: vscode.ExtensionContext): void {
  const store = new ReviewStore(context);
  const provider = new ReviewEditorProvider(context, store);

  context.subscriptions.push(
    provider,
    registerPromptDocumentProvider(),
    vscode.window.registerCustomEditorProvider(reviewEditorViewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.workspace.onDidRenameFiles(event => {
      void migrateRenamedMarkdownReviews(store, event.files);
    }),
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.openReviewPreview', 'Open Review Preview', async document => {
      await vscode.commands.executeCommand('vscode.openWith', document.uri, reviewEditorViewType);
    }),
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.openReviewBeside', 'Open Review Beside', async document => {
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Active
      });
      await vscode.commands.executeCommand('vscode.openWith', document.uri, reviewEditorViewType, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside
      });
    }),
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.handoff', 'Send to Agent', async document => {
      try {
        await store.prepareHandoff(document.uri, async () => document.save(), async (sidecar) => {
          const baseDirectory = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
            ?? path.dirname(document.uri.fsPath);
          const relative = path.relative(baseDirectory, sidecar.fsPath);
          await vscode.env.clipboard.writeText(`Base directory: ${JSON.stringify(baseDirectory)}.\nRead ${JSON.stringify(relative)}. Follow its guidance, edit the referenced Markdown, and update each item's status/result/resultFor. Stop writing both files before I review the result.`);
        });
        provider.resetReviewUndo(document.uri);
        vscode.window.showInformationMessage('Copied handoff instructions. Paste them into your AI agent. When it finishes, choose Review Changes.');
      } finally { await provider.refreshDocument(document.uri); }
    }),
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.copyReviewFile', 'Copy Review File', async document => {
      try {
        if (store.isHandoffActive(document.uri)) {
          await store.load(document.uri);
          const sidecar = await store.getReviewFileUri(document.uri);
          await vscode.env.clipboard.writeText(new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecar)));
        } else {
          await store.prepareHandoff(document.uri, async () => document.save(), async (_sidecar, contents) => {
            await vscode.env.clipboard.writeText(contents);
          });
          provider.resetReviewUndo(document.uri);
        }
        vscode.window.showInformationMessage('Copied the review JSON with AI guidance. Provide both the Markdown document and review file so the agent can edit them.');
      } finally { await provider.refreshDocument(document.uri); }
    }),
    ...['resumeReview', 'cancelHandoff'].map(id => registerMarkdownCommand(provider, `aiMarkdownReviewLoop.${id}`, id === 'resumeReview' ? 'Review Changes' : 'Cancel Handoff', async document => {
      await store.resumeReview(document.uri);
      provider.resetReviewUndo(document.uri);
      await provider.refreshDocument(document.uri);
    })),
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.openReviewFile', 'Inspect Review File', async document => {
      const sidecar = await store.getReviewFileUri(document.uri);
      const contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecar));
      await openReadOnlyMarkdownPrompt('Inspect Review File', '```json\n' + contents + '\n```');
    }),
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.openReviewHistory', 'Review History', async document => {
      const archived = await store.loadArchived(document.uri);
      const legacy = store.getLegacyBackupPaths(document.uri);
      const choices = [
        ...archived.map(thread => ({ label: thread.comment.split('\n')[0], description: thread.taskResult ?? '', thread, backup: '' })),
        ...legacy.map(backup => ({ label: 'Legacy source backup', description: path.basename(backup), thread: undefined, backup }))
      ];
      if (!choices.length) { vscode.window.showInformationMessage('No archived review history. Completed items from this round remain in the review view.'); return; }
      const choice = await vscode.window.showQuickPick(choices, { placeHolder: 'Select a history item to inspect or reopen' });
      if (!choice) return;
      if (choice.backup) {
        const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(choice.backup)));
        await openReadOnlyMarkdownPrompt('Legacy Review Source', '```json\n' + raw + '\n```');
      } else if (choice.thread) {
        const thread = choice.thread;
        await openReadOnlyMarkdownPrompt('Review History Item', `# Comment\n\n${thread.comment}\n\n# Agent Result\n\n${thread.taskResult ?? ''}\n\nID: ${thread.id}`);
        if (await vscode.window.showInformationMessage('Reopen this comment as a pending request?', 'Reopen') === 'Reopen') {
          await store.restoreArchivedThread(document.uri, thread.id);
          await provider.refreshDocument(document.uri);
        }
      }
    }),
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.restoreReviewBackup', 'Restore Review Backup', async document => {
      const choice = await vscode.window.showWarningMessage('Stop the agent before restoring. The saved review backup will replace the current review JSON, and the current JSON will be preserved separately. The Markdown source is unchanged.', { modal: true }, 'Restore');
      if (choice !== 'Restore') return;
      await store.restoreReviewBackup(document.uri);
      provider.resetReviewUndo(document.uri);
      await provider.refreshDocument(document.uri);
    })
  );
}

export function deactivate(): void {
  // No long-lived resources outside VS Code disposables.
}

function registerMarkdownCommand(
  provider: ReviewEditorProvider,
  id: string,
  label: string,
  run: (document: vscode.TextDocument) => Promise<void>
): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (targetUri?: vscode.Uri) => {
    // Keep Retry attached to the original target even if focus changes while the
    // error notification is visible. No retry runs until the user selects it.
    const activeDocument = vscode.window.activeTextEditor?.document;
    let retryTarget = targetUri ?? (activeDocument && isReviewableMarkdown(activeDocument)
      ? activeDocument.uri : provider.getCurrentDocumentUri());
    for (;;) {
      try {
        const document = await resolveMarkdownDocument(provider, retryTarget);
        if (!document) {
          vscode.window.showWarningMessage(`Open a Markdown document before using ${label}.`);
          return;
        }
        retryTarget = document.uri;
        await run(document);
        return;
      } catch (error) {
        const target = retryTarget ? path.basename(retryTarget.path) : 'the current Markdown document';
        const choice = await vscode.window.showErrorMessage(
          `${label} failed for ${target}: ${formatError(error)}`,
          'Retry'
        );
        if (choice !== 'Retry') {
          return;
        }
      }
    }
  });
}

async function resolveMarkdownDocument(
  provider: ReviewEditorProvider,
  targetUri?: vscode.Uri
): Promise<vscode.TextDocument | undefined> {
  if (targetUri) {
    const document = await vscode.workspace.openTextDocument(targetUri);
    return isReviewableMarkdown(document) ? document : undefined;
  }

  const activeDocument = vscode.window.activeTextEditor?.document;

  if (activeDocument && isReviewableMarkdown(activeDocument)) {
    return activeDocument;
  }

  const currentUri = provider.getCurrentDocumentUri();

  if (currentUri) {
    const document = await vscode.workspace.openTextDocument(currentUri);
    if (isReviewableMarkdown(document)) {
      return document;
    }
  }

  return undefined;
}

function isReviewableMarkdown(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file'
    && (document.languageId === 'markdown' || document.fileName.toLowerCase().endsWith('.md'));
}

async function migrateRenamedMarkdownReviews(
  store: ReviewStore,
  files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]
): Promise<void> {
  for (const file of files) {
    if (!looksLikeMarkdownUri(file.newUri)) {
      continue;
    }

    try {
      await store.migrateDocument(file.oldUri, file.newUri);
      await store.deleteDocumentSidecars(file.oldUri, file.newUri);
    } catch (error) {
      vscode.window.showWarningMessage(`AI Markdown Review could not migrate review state after rename: ${formatError(error)}`);
    }
  }
}

function looksLikeMarkdownUri(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.md');
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
