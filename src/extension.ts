import * as vscode from 'vscode';
import { openContextBootstrapPrompt } from './contextBootstrap';
import { renderFeedbackExport } from './exportFeedback';
import { openFeedbackLoopPrompt } from './feedbackLoopPrompt';
import { findStaleInlineAnchorMarkers, insertInlineAnchorMarker } from './inlineMarkers';
import { rebaseInlineReviewMetadataSidecars } from './inlineMarkerPayloads';
import { createLocalReviewThreads } from './localReview';
import { ReviewEditorProvider, reviewEditorViewType } from './reviewEditorProvider';
import { ReviewStore } from './reviewStore';

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

      const sidecarUri = await store.getReviewFileUri(document.uri);

      for (const thread of [...addedThreads].sort((left, right) => {
        return (right.anchor.lineEnd ?? 0) - (left.anchor.lineEnd ?? 0);
      })) {
        await insertInlineAnchorMarker(document, thread, sidecarUri);
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
      const missingMarkers = findStaleInlineAnchorMarkers(document.getText(), reviewDocument.threads);

      if (missingMarkers.length > 0) {
        vscode.window.showWarningMessage(
          `Review sidecar data is missing, incomplete, or closed for ${missingMarkers.length} inline anchor(s). Clean stale anchors or restore the sidecar JSON before treating this export as complete.`
        );
      }

      const exportText = appendStorageWarning(renderFeedbackExport(reviewDocument), missingMarkers);
      const exportDocument = await vscode.workspace.openTextDocument({
        content: exportText,
        language: 'markdown'
      });

      await vscode.window.showTextDocument(exportDocument, vscode.ViewColumn.Beside);
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

function appendStorageWarning(
  exportText: string,
  missingMarkers: Array<{ sidecar?: string }>
): string {
  if (missingMarkers.length === 0) {
    return exportText;
  }

  const sidecar = missingMarkers.find(marker => marker.sidecar)?.sidecar ?? '.<filename>.ai-review.json';

  return [
    exportText,
    '',
    '## Review Storage Warning',
    '',
    `This Markdown file contains ${missingMarkers.length} stale ai-review-anchor marker(s) whose matching thread data is missing from ${sidecar} or no longer open. The original comment text is unavailable from inline anchors alone; clean stale anchors or restore the sidecar JSON from backup before treating this export as complete.`
  ].join('\n');
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
      await rebaseRenamedDocumentMetadata(store, file.oldUri, file.newUri);
      await store.deleteDocumentSidecars(file.oldUri);
    } catch (error) {
      vscode.window.showWarningMessage(`AI Markdown Review could not migrate review state after rename: ${formatError(error)}`);
    }
  }
}

async function rebaseRenamedDocumentMetadata(
  store: ReviewStore,
  oldUri: vscode.Uri,
  newUri: vscode.Uri
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(newUri);

  if (!isMarkdown(document)) {
    return;
  }

  const rewritten = rebaseInlineReviewMetadataSidecars(
    document.getText(),
    await store.getSidecarPathRewrites(oldUri, newUri)
  );

  if (rewritten === document.getText()) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    rewritten
  );

  if (!await vscode.workspace.applyEdit(edit)) {
    throw new Error('Markdown metadata rewrite was rejected by VS Code.');
  }

  await document.save();
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
