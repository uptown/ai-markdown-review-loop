import * as vscode from 'vscode';
import path from 'path';
import { registerPromptDocumentProvider } from './promptDocuments';
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
    registerMarkdownCommand(provider, 'aiMarkdownReviewLoop.copyReviewJson', 'Copy Review JSON', async document => {
      const exported = await store.exportReviewJson(document.uri, async () => document.save());
      await vscode.env.clipboard.writeText(exported.contents);
      vscode.window.showInformationMessage(`Copied review JSON for ${path.basename(exported.sidecar.fsPath)}. The external agent can update the Markdown and remove the JSON when finished.`);
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
