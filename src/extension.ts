import * as vscode from 'vscode';
import { renderFeedbackExport } from './exportFeedback';
import { insertInlineAnchorMarker } from './inlineMarkers';
import { createLocalReviewThreads } from './localReview';
import { MarkdownCodeLensProvider } from './markdownCodeLensProvider';
import { ReviewEditorProvider, reviewEditorViewType } from './reviewEditorProvider';
import { ReviewStore } from './reviewStore';

export function activate(context: vscode.ExtensionContext): void {
  const store = new ReviewStore(context);
  const provider = new ReviewEditorProvider(context, store);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: 'markdown', scheme: 'file' },
      new MarkdownCodeLensProvider()
    ),
    vscode.window.registerCustomEditorProvider(reviewEditorViewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
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

      await store.addThreads(document.uri, threads);
      const sidecarUri = await store.getReviewFileUri(document.uri);

      for (const thread of [...threads].sort((left, right) => {
        return (right.anchor.lineEnd ?? 0) - (left.anchor.lineEnd ?? 0);
      })) {
        await insertInlineAnchorMarker(document, thread, sidecarUri);
      }

      vscode.window.showInformationMessage(`Added ${threads.length} local review feedback item(s).`);
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
