import * as vscode from 'vscode';
import { openContextBootstrapPrompt } from './contextBootstrap';
import { renderFeedbackExport } from './exportFeedback';
import { openFeedbackLoopPrompt } from './feedbackLoopPrompt';
import { createLocalReviewThreads } from './localReview';
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
    vscode.commands.registerCommand('aiMarkdownReviewLoop.openReviewPreview', async (targetUri?: vscode.Uri) => {
      const document = await resolveMarkdownDocument(provider, targetUri);

      if (!document) {
        vscode.window.showWarningMessage('Open a Markdown document before launching the review preview.');
        return;
      }

      await vscode.commands.executeCommand('vscode.openWith', document.uri, reviewEditorViewType);
    }),
    vscode.commands.registerCommand('aiMarkdownReviewLoop.openReviewBeside', async (targetUri?: vscode.Uri) => {
      const document = await resolveMarkdownDocument(provider, targetUri);

      if (!document) {
        vscode.window.showWarningMessage('Open a Markdown document before launching the review split view.');
        return;
      }

      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Active
      });
      await vscode.commands.executeCommand('vscode.openWith', document.uri, reviewEditorViewType, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside
      });
    }),
    vscode.commands.registerCommand('aiMarkdownReviewLoop.reviewDocument', async (targetUri?: vscode.Uri) => {
      const document = await resolveMarkdownDocument(provider, targetUri);

      if (!document) {
        vscode.window.showWarningMessage('Open a Markdown document before reviewing it.');
        return;
      }

      const threads = createLocalReviewThreads(document);

      if (threads.length === 0) {
        vscode.window.showInformationMessage('Local review found no obvious feedback items.');
        return;
      }

      const { addedThreads } = await store.addThreads(document.uri, threads);

      if (addedThreads.length === 0) {
        vscode.window.showInformationMessage('Local review found no new feedback items.');
        await vscode.commands.executeCommand('vscode.openWith', document.uri, reviewEditorViewType);
        return;
      }

      vscode.window.showInformationMessage(`Added ${addedThreads.length} local review feedback item(s).`);
      await vscode.commands.executeCommand('vscode.openWith', document.uri, reviewEditorViewType);
    }),
    vscode.commands.registerCommand('aiMarkdownReviewLoop.exportFeedback', async (targetUri?: vscode.Uri) => {
      const document = await resolveMarkdownDocument(provider, targetUri);

      if (!document) {
        vscode.window.showWarningMessage('Open a Markdown document before exporting feedback.');
        return;
      }

      const reviewDocument = await store.load(document.uri);
      const exportText = renderFeedbackExport(reviewDocument);
      await openReadOnlyMarkdownPrompt('AI Review Feedback Export', exportText);
    }),
    vscode.commands.registerCommand('aiMarkdownReviewLoop.openContextBootstrapPrompt', async (targetUri?: vscode.Uri) => {
      const opened = await openContextBootstrapPrompt(targetUri);

      if (!opened) {
        vscode.window.showWarningMessage('Open a workspace Markdown file before preparing an AI context bootstrap prompt.');
      }
    }),
    vscode.commands.registerCommand('aiMarkdownReviewLoop.openFeedbackLoopPrompt', async (targetUri?: vscode.Uri) => {
      const opened = await openFeedbackLoopPrompt(targetUri);

      if (!opened) {
        vscode.window.showWarningMessage('Open a workspace Markdown file before preparing an AI feedback loop prompt.');
      }
    })
  );
}

export function deactivate(): void {
  // No long-lived resources outside VS Code disposables.
}

async function resolveMarkdownDocument(
  provider: ReviewEditorProvider,
  targetUri?: vscode.Uri
): Promise<vscode.TextDocument | undefined> {
  if (targetUri) {
    const document = await vscode.workspace.openTextDocument(targetUri);
    if (isMarkdown(document)) {
      return document;
    }
  }

  const activeDocument = vscode.window.activeTextEditor?.document;

  if (activeDocument && isMarkdown(activeDocument)) {
    return activeDocument;
  }

  const currentUri = provider.getCurrentDocumentUri();

  if (currentUri) {
    const document = await vscode.workspace.openTextDocument(currentUri);
    if (isMarkdown(document)) {
      return document;
    }
  }

  return undefined;
}

function isMarkdown(document: vscode.TextDocument): boolean {
  return document.languageId === 'markdown' || document.fileName.toLowerCase().endsWith('.md');
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
      await store.deleteDocumentSidecars(file.oldUri);
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
