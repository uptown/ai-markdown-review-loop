import * as vscode from 'vscode';
import { renderFeedbackExport } from './exportFeedback';
import { createLocalReviewThreads } from './localReview';
import { ReviewEditorProvider, reviewEditorViewType } from './reviewEditorProvider';
import { ReviewStore } from './reviewStore';

export function activate(context: vscode.ExtensionContext): void {
  const store = new ReviewStore(context);
  const provider = new ReviewEditorProvider(context, store);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(reviewEditorViewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand('aiMarkdownReviewLoop.openReviewPreview', async () => {
      const document = await resolveMarkdownDocument(provider);

      if (!document) {
        vscode.window.showWarningMessage('Open a Markdown document before launching the review preview.');
        return;
      }

      await vscode.commands.executeCommand('vscode.openWith', document.uri, reviewEditorViewType);
    }),
    vscode.commands.registerCommand('aiMarkdownReviewLoop.reviewDocument', async () => {
      const document = await resolveMarkdownDocument(provider);

      if (!document) {
        vscode.window.showWarningMessage('Open a Markdown document before reviewing it.');
        return;
      }

      const threads = createLocalReviewThreads(document);

      if (threads.length === 0) {
        vscode.window.showInformationMessage('Local review found no obvious feedback items.');
        return;
      }

      await store.addThreads(document.uri, threads);
      vscode.window.showInformationMessage(`Added ${threads.length} local review feedback item(s).`);
      await vscode.commands.executeCommand('vscode.openWith', document.uri, reviewEditorViewType);
    }),
    vscode.commands.registerCommand('aiMarkdownReviewLoop.exportFeedback', async () => {
      const document = await resolveMarkdownDocument(provider);

      if (!document) {
        vscode.window.showWarningMessage('Open a Markdown document before exporting feedback.');
        return;
      }

      const reviewDocument = await store.load(document.uri);
      const exportText = renderFeedbackExport(reviewDocument);
      const exportDocument = await vscode.workspace.openTextDocument({
        content: exportText,
        language: 'markdown'
      });

      await vscode.window.showTextDocument(exportDocument, vscode.ViewColumn.Beside);
    })
  );
}

export function deactivate(): void {
  // No long-lived resources outside VS Code disposables.
}

async function resolveMarkdownDocument(
  provider: ReviewEditorProvider
): Promise<vscode.TextDocument | undefined> {
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
