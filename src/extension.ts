import * as vscode from 'vscode';
import path from 'path';
import { ReviewEditorProvider, reviewEditorViewType } from './reviewEditorProvider';
import { ReviewStore } from './reviewStore';
import { createReviewClipboard, resolveReviewClipboardContext } from './reviewClipboard';

export function activate(context: vscode.ExtensionContext): void {
  const store = new ReviewStore(context);
  const provider = new ReviewEditorProvider(context, store);

  context.subscriptions.push(
    provider,
    vscode.window.registerCustomEditorProvider(reviewEditorViewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.workspace.onDidRenameFiles(event => {
      if (vscode.workspace.isTrusted !== false) void migrateRenamedMarkdownReviews(store, event.files);
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
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.copyReviewJson', 'Copy Review JSON', async document => {
      const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => ({ name: folder.name, fsPath: folder.uri.fsPath }));
      resolveReviewClipboardContext(document.uri.fsPath, folders);
      const exported = await store.exportReviewJson(document.uri, async () => document.save());
      const copied = createReviewClipboard(exported.contents, document.uri.fsPath, folders);
      await vscode.env.clipboard.writeText(copied);
      vscode.window.showInformationMessage(`Copied review JSON for ${path.basename(document.uri.fsPath)}. The agent should review the current Markdown and delete the JSON after saving changes.`);
      await provider.refreshDocument(document.uri);
    }, true),
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.restoreReviewBackup', 'Restore Review Backup', async document => {
      const choice = await vscode.window.showWarningMessage('Restore the latest valid comments? The current JSON will be backed up first. Markdown will not change.', { modal: true }, 'Restore');
      if (choice !== 'Restore') return;
      await store.restoreReviewBackup(document.uri);
      await provider.refreshDocument(document.uri);
    }, true),
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.startNewReview', 'Start New Review', async document => {
      const choice = await vscode.window.showWarningMessage('Start an empty review when no valid comments can be recovered? This resets unavailable review state and preserves the Markdown.', { modal: true }, 'Start New Review');
      if (choice !== 'Start New Review') return;
      await store.startNewReview(document.uri);
      await provider.refreshDocument(document.uri);
    }, true),
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.purgeRecovery', 'Purge Recovery Data', async document => {
      const choice = await vscode.window.showWarningMessage('Permanently remove old recovery copies for this document? Current comments, Markdown, and the latest recovery copy are kept.', { modal: true }, 'Purge');
      if (choice !== 'Purge') return;
      const count = await store.purgeRecovery(document.uri);
      vscode.window.showInformationMessage(`Removed ${count} old recovery copies.`);
    }, true)
  );
}

export function deactivate(): void {
  // No long-lived resources outside VS Code disposables.
}

function registerMarkdownCommand(
  provider: ReviewEditorProvider,
  id: string,
  label: string,
  run: (document: vscode.TextDocument) => Promise<void>,
  requiresTrust = false
): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (targetUri?: vscode.Uri) => {
    // Keep Retry attached to the original target even if focus changes while the
    // error notification is visible. No retry runs until the user selects it.
    const activeDocument = vscode.window.activeTextEditor?.document;
    let retryTarget = targetUri ?? (activeDocument && isReviewableMarkdown(activeDocument)
      ? activeDocument.uri : provider.getCurrentDocumentUri());
    for (;;) {
      try {
        if (requiresTrust && vscode.workspace.isTrusted === false) {
          throw new Error('Trust this workspace before changing or copying review data. Preview remains available in Restricted Mode.');
        }
        if (retryTarget && retryTarget.scheme !== 'file') {
          throw new Error('Only saved local Markdown files are supported. Save the document to a local folder first.');
        }
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
    if (file.oldUri.scheme !== 'file' || file.newUri.scheme !== 'file' || !looksLikeMarkdownUri(file.newUri)) {
      continue;
    }

    try {
      await store.renameDocument(file.oldUri, file.newUri);
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
