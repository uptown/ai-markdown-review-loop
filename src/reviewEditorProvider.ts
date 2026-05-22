import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { randomUUID } from 'crypto';
import { AnchorMaintenanceController } from './anchorMaintenance';
import { createAnchor } from './anchors';
import { htmlBlockToMarkdown } from './htmlToMarkdown';
import { createMermaidFenceReplacement } from './mermaidEdits';
import {
  findStaleInlineAnchorMarkers,
  removeInlineAnchorMarkers,
  stripInlineAnchorMarkers
} from './inlineMarkers';
import {
  appendInlineReviewLogMarker,
  removeInlineAnchorMarkersFromMarkdown,
  removeInlineReviewLogMarkers,
  upsertInlineAnchorMarkersInMarkdown
} from './inlineMarkerPayloads';
import {
  applyReviewThreadUpdatesToDocuments,
  ClosedReviewThreadUpdate
} from './reviewDocumentUpdates';
import { ReviewStore } from './reviewStore';
import {
  applyReviewAwareEditToMarkdown,
  buildReviewAwareThreadUpdates,
  createLineRangeEditPlan,
  createOffsetEditPlan,
  ReviewAwareEditIntent,
  ReviewAwareEditPlan
} from './reviewAwareEdits';
import { createRestoredReviewThread, getReviewHistoryAnchorStates } from './reviewHistory';
import { ReviewUndoController } from './reviewUndo';
import { ApplyPatchResult, selectSuggestedPatchReplacement } from './suggestedPatches';
import {
  collectMarkdownTables,
  createMarkdownTableReplacement
} from './tableEdits';
import { AnchorConfidence, ReviewDocument, ReviewStatus, ReviewThread } from './types';

const viewType = 'aiMarkdownReviewLoop.reviewEditor';

interface PreviewRestoreState {
  focusThreadId?: string;
  overlayThreadIds?: string[];
  replyThreadId?: string;
}

export class ReviewEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly markdown = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false
  });
  private readonly anchorMaintenance: AnchorMaintenanceController;
  private readonly reviewUndo: ReviewUndoController;

  private currentDocumentUri: vscode.Uri | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ReviewStore
  ) {
    this.anchorMaintenance = new AnchorMaintenanceController(store);
    this.reviewUndo = new ReviewUndoController(store);
    const defaultFence = this.markdown.renderer.rules.fence;
    const sourceMappedRules = [
      'paragraph_open',
      'heading_open',
      'blockquote_open',
      'list_item_open',
      'table_open',
      'tr_open'
    ];

    for (const ruleName of sourceMappedRules) {
      const defaultRule = this.markdown.renderer.rules[ruleName];

      this.markdown.renderer.rules[ruleName] = (tokens, index, options, env, self) => {
        const token = tokens[index];
        const sourceLine = token.map?.[0];
        const sourceLineEnd = token.map?.[1];

        if (typeof sourceLine === 'number') {
          token.attrSet('data-source-line', String(sourceLine + 1));
        }

        if (typeof sourceLineEnd === 'number') {
          token.attrSet('data-source-line-end', String(sourceLineEnd));
        }

        if (defaultRule) {
          return defaultRule(tokens, index, options, env, self);
        }

        return self.renderToken(tokens, index, options);
      };
    }

    this.markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const language = token.info.trim().split(/\s+/)[0]?.toLowerCase();

      if (language === 'mermaid') {
        return this.renderMermaidFence(token.content, token.map?.[0], token.map?.[1]);
      }

      if (defaultFence) {
        return defaultFence(tokens, index, options, env, self);
      }

      return self.renderToken(tokens, index, options);
    };
  }

  dispose(): void {
    this.anchorMaintenance.dispose();
  }

  getCurrentDocumentUri(): vscode.Uri | undefined {
    return this.currentDocumentUri;
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.currentDocumentUri = document.uri;
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    const render = async (restoreState?: PreviewRestoreState) => {
      try {
        const reviewDocument = await this.store.load(document.uri);
        const resolvedReviewDocument = await this.store.loadResolved(document.uri);
        webviewPanel.webview.html = this.renderHtml(
          webviewPanel.webview,
          document,
          reviewDocument,
          resolvedReviewDocument,
          restoreState
        );
      } catch (error) {
        webviewPanel.webview.html = this.renderErrorHtml(document, formatError(error));
      }
    };

    const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === document.uri.toString()) {
        void (async () => {
          try {
            await this.reviewUndo.handleTextDocumentChange(event);
          } catch (error) {
            vscode.window.showErrorMessage(`AI Markdown Review undo sync failed: ${formatError(error)}`);
          }
          await render();
        })();
      }
    });
    const saveSubscription = vscode.workspace.onDidSaveTextDocument(event => {
      if (event.uri.toString() === document.uri.toString()) {
        void this.anchorMaintenance.flush(document);
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
      saveSubscription.dispose();
      void this.anchorMaintenance.flush(document);
    });

    webviewPanel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) {
        this.currentDocumentUri = document.uri;
      } else {
        void this.anchorMaintenance.flush(document);
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async message => {
      try {
        if (message?.type === 'addComment') {
          await this.addComment(
            document,
            String(message.anchorText ?? ''),
            typeof message.comment === 'string' ? message.comment : undefined,
          parseOccurrence(message.anchorOccurrence),
          parseSourceLine(message.sourceLine)
        );
          await render();
        }

        if (message?.type === 'updateStatus') {
          const status = parseReviewStatus(message.status);

          if (!status) {
            vscode.window.showWarningMessage('Ignored invalid review status update.');
            return;
          }

          await this.anchorMaintenance.flush(document);
          await this.updateThreadStatus(document, String(message.threadId), status);
          await render();
        }

        if (message?.type === 'cleanupStaleAnchors') {
          const threadIds = Array.isArray(message.threadIds)
            ? message.threadIds.map((threadId: unknown) => String(threadId)).filter(Boolean)
            : [];

          if (threadIds.length === 0) {
            vscode.window.showWarningMessage('No stale review anchors were selected for cleanup.');
            return;
          }

          const cleaned = await removeInlineAnchorMarkers(document, threadIds);

          if (!cleaned) {
            vscode.window.showWarningMessage('Stale review anchors could not be cleaned up.');
            return;
          }

          vscode.window.showInformationMessage(`Cleaned ${threadIds.length} stale review anchor(s).`);
          await render();
        }

        if (message?.type === 'restoreThread') {
          const threadId = String(message.threadId ?? '');

          if (!threadId) {
            vscode.window.showWarningMessage('No review thread was selected for restore.');
            return;
          }

          await this.restoreThread(document, threadId);

          vscode.window.showInformationMessage('Restored review thread to open feedback.');
          await render({ focusThreadId: threadId });
        }

        if (message?.type === 'anchorLocated') {
          const sourceLine = parseSourceLine(message.sourceLine);
          const threadId = String(message.threadId ?? '');
          const confidence = parseAnchorConfidence(message.confidence);
          const documentVersion = parseDocumentVersion(message.documentVersion);

          if (sourceLine && threadId && confidence && documentVersion !== undefined) {
            this.anchorMaintenance.observe(document, {
              threadId,
              sourceLine,
              confidence,
              documentVersion
            });
          }
        }

        if (message?.type === 'addReply') {
          const replyText = String(message.text ?? '').trim();
          const threadId = String(message.threadId ?? '');

          if (!replyText || !threadId) {
            vscode.window.showWarningMessage('Reply text is empty.');
            return;
          }

          await this.store.addReply(
            document.uri,
            threadId,
            replyText
          );
          await render({
            focusThreadId: threadId,
            overlayThreadIds: message.origin === 'overlay'
              ? parseThreadIds(message.threadIds, threadId)
              : undefined,
            replyThreadId: threadId
          });
        }

        if (message?.type === 'applySuggestedPatch') {
          await this.anchorMaintenance.flush(document);

          const threadId = String(message.threadId ?? '');
          const reviewDocument = await this.store.load(document.uri);
          const thread = reviewDocument.threads.find(candidate => candidate.id === threadId);

          if (!thread) {
            vscode.window.showWarningMessage('Review thread was not found.');
            return;
          }

          const result = await this.applySuggestedPatch(document, thread);

          if (result !== 'applied') {
            vscode.window.showWarningMessage(formatApplyPatchResult(result));
            return;
          }

          vscode.window.showInformationMessage('Applied suggested edit, refreshed review anchors, and marked the thread accepted.');
          await render();
        }

        if (message?.type === 'editMarkdownBlock') {
          const lineStart = parseSourceLine(message.lineStart);
          const lineEnd = parseSourceLine(message.lineEnd);
          const replacement = htmlBlockToMarkdown(String(message.html ?? ''));
          const intent = parseReviewAwareEditIntent(message.intent);

          if (!lineStart || !lineEnd || lineEnd < lineStart || !intent) {
            vscode.window.showWarningMessage('Ignored invalid Markdown block edit.');
            return;
          }

          await this.anchorMaintenance.flush(document);
          const plan = createLineRangeEditPlan(document.getText(), {
            lineStart,
            lineEnd,
            replacement,
            actor: 'user',
            intent
          });
          const applied = await this.applyReviewAwareEdit(document, plan);

          if (!applied) {
            vscode.window.showWarningMessage('Markdown block edit could not be applied.');
            return;
          }

          vscode.window.showInformationMessage('Updated Markdown and refreshed affected review anchors.');
          await render();
        }

        if (message?.type === 'editMermaidSource') {
          const lineStart = parseSourceLine(message.lineStart);
          const lineEnd = parseSourceLine(message.lineEnd);
          const source = String(message.source ?? '').trim();

          if (!lineStart || !lineEnd || lineEnd < lineStart || !source) {
            vscode.window.showWarningMessage('Ignored invalid Mermaid source edit.');
            return;
          }

          await this.anchorMaintenance.flush(document);
          const plan = createLineRangeEditPlan(document.getText(), {
            lineStart,
            lineEnd,
            replacement: createMermaidFenceReplacement(source),
            actor: 'user',
            intent: 'manual_mermaid_edit'
          });
          const applied = await this.applyReviewAwareEdit(document, plan);

          if (!applied) {
            vscode.window.showWarningMessage('Mermaid source edit could not be applied.');
            return;
          }

          vscode.window.showInformationMessage('Updated Mermaid source and refreshed affected review anchors.');
          await render();
        }

        if (message?.type === 'editMarkdownTable') {
          const lineStart = parseSourceLine(message.lineStart);
          const lineEnd = parseSourceLine(message.lineEnd);

          if (!lineStart || !lineEnd || lineEnd < lineStart) {
            vscode.window.showWarningMessage('Ignored invalid Markdown table edit.');
            return;
          }

          await this.anchorMaintenance.flush(document);
          const plan = createLineRangeEditPlan(document.getText(), {
            lineStart,
            lineEnd,
            replacement: createMarkdownTableReplacement({
              headers: message.headers,
              alignments: message.alignments,
              rows: message.rows
            }),
            actor: 'user',
            intent: 'manual_table_edit'
          });
          const applied = await this.applyReviewAwareEdit(document, plan);

          if (!applied) {
            vscode.window.showWarningMessage('Markdown table edit could not be applied.');
            return;
          }

          vscode.window.showInformationMessage('Updated Markdown table and refreshed affected review anchors.');
          await render();
        }

        if (message?.type === 'copyText') {
          await vscode.env.clipboard.writeText(String(message.text ?? ''));
          vscode.window.showInformationMessage('Copied Mermaid source.');
        }
      } catch (error) {
        vscode.window.showErrorMessage(`AI Markdown Review failed: ${formatError(error)}`);
      }
    });

    await render();
  }

  private renderMermaidFence(
    source: string,
    zeroBasedSourceLine?: number,
    zeroBasedEndLine?: number
  ): string {
    const escapedSource = escapeHtml(source.trim());
    const sourceLine = typeof zeroBasedSourceLine === 'number'
      ? ` data-source-line="${zeroBasedSourceLine + 1}"`
      : '';
    const sourceLineEnd = typeof zeroBasedEndLine === 'number'
      ? ` data-source-line-end="${zeroBasedEndLine}"`
      : '';

    return `<figure class="mermaid-figure" data-mermaid-diagram${sourceLine}${sourceLineEnd}>
  <div class="mermaid-toolbar">
    <span>Mermaid</span>
    <div class="mermaid-actions">
      <button type="button" class="secondary compact" data-mermaid-edit>Edit</button>
      <button type="button" class="secondary compact" data-mermaid-feedback>Feedback</button>
      <button type="button" class="secondary compact" data-mermaid-copy>Copy</button>
    </div>
  </div>
  <div class="mermaid-render" data-mermaid-render>${escapedSource}</div>
  <details class="mermaid-source">
    <summary>Source</summary>
    <pre><code>${escapedSource}</code></pre>
  </details>
</figure>`;
  }

  private async addComment(
    document: vscode.TextDocument,
    selectedText: string,
    providedComment?: string,
    anchorOccurrence?: number,
    sourceLine?: number
  ): Promise<void> {
    const normalizedSelection = selectedText.trim();

    if (!normalizedSelection) {
      vscode.window.showWarningMessage('Select text in the review preview before adding feedback.');
      return;
    }

    const comment = providedComment?.trim() || await vscode.window.showInputBox({
      title: 'Add Markdown review feedback',
      prompt: 'What should the agent or author do with this text?',
      placeHolder: 'Example: clarify this acceptance criterion'
    });

    if (!comment?.trim()) {
      return;
    }

    const now = new Date().toISOString();
    const thread: ReviewThread = {
      id: `rv_${randomUUID()}`,
      documentUri: document.uri.toString(),
      anchor: createAnchor(document, normalizedSelection, {
        occurrence: anchorOccurrence,
        lineHint: sourceLine
      }),
      type: 'note',
      source: 'human',
      status: 'open',
      severity: 'medium',
      comment: comment.trim(),
      thread: [],
      createdAt: now,
      updatedAt: now
    };

    const beforeMarkdown = document.getText();
    const beforeSnapshot = await this.reviewUndo.capture(document.uri);
    const sidecarUri = await this.store.getReviewFileUri(document.uri);
    const reviewDocument = await this.store.load(document.uri);
    reviewDocument.threads.push(thread);

    const afterMarkdown = upsertInlineAnchorMarkersInMarkdown(beforeMarkdown, [{
      id: thread.id,
      sidecar: vscode.workspace.asRelativePath(sidecarUri, false)
    }]);
    const markerInserted = await this.replaceDocumentMarkdown(document, beforeMarkdown, afterMarkdown);

    if (!markerInserted) {
      vscode.window.showWarningMessage('Feedback could not be anchored in Markdown.');
      return;
    }

    await this.store.save(document.uri, reviewDocument);
    const afterSnapshot = await this.reviewUndo.capture(document.uri);
    this.reviewUndo.register(document.uri, beforeMarkdown, document.getText(), beforeSnapshot, afterSnapshot);
  }

  private async updateThreadStatus(
    document: vscode.TextDocument,
    threadId: string,
    status: ReviewStatus,
    update: Partial<ReviewThread> = {}
  ): Promise<void> {
    const beforeMarkdown = document.getText();
    const beforeSnapshot = await this.reviewUndo.capture(document.uri);
    const now = new Date().toISOString();
    const reviewDocument = await this.store.load(document.uri);
    const resolvedReviewDocument = await this.store.loadResolved(document.uri);

    if (!reviewDocument.threads.some(thread => thread.id === threadId)) {
      throw new Error(`Review thread not found: ${threadId}`);
    }

    const appliedUpdates = applyReviewThreadUpdatesToDocuments(
      reviewDocument,
      resolvedReviewDocument,
      [{
        threadId,
        update: { ...update, status }
      }],
      now
    );
    const afterMarkdown = appliedUpdates.closedThreads.length > 0
      ? this.applyClosedThreadMarkers(
        beforeMarkdown,
        appliedUpdates.closedThreads,
        now,
        vscode.workspace.asRelativePath(await this.store.getResolvedReviewFileUri(document.uri), false)
      )
      : beforeMarkdown;

    if (!await this.replaceDocumentMarkdown(document, beforeMarkdown, afterMarkdown)) {
      vscode.window.showWarningMessage('Review status was updated, but the Markdown markers could not be updated.');
      return;
    }

    await this.store.save(document.uri, appliedUpdates.reviewDocument);
    if (appliedUpdates.closedThreads.length > 0) {
      await this.store.saveResolved(document.uri, appliedUpdates.resolvedReviewDocument);
    }
    const afterSnapshot = await this.reviewUndo.capture(document.uri);
    this.reviewUndo.register(document.uri, beforeMarkdown, document.getText(), beforeSnapshot, afterSnapshot);
  }

  private async applyReviewAwareEdit(
    document: vscode.TextDocument,
    plan: ReviewAwareEditPlan
  ): Promise<boolean> {
    const beforeMarkdown = document.getText();
    const beforeSnapshot = await this.reviewUndo.capture(document.uri);
    const now = new Date().toISOString();
    const reviewDocument = await this.store.load(document.uri);
    const resolvedReviewDocument = await this.store.loadResolved(document.uri);
    const updates = buildReviewAwareThreadUpdates(
      beforeMarkdown,
      reviewDocument.threads,
      plan,
      now
    );
    const appliedUpdates = applyReviewThreadUpdatesToDocuments(
      reviewDocument,
      resolvedReviewDocument,
      updates,
      now
    );
    const editedMarkdown = applyReviewAwareEditToMarkdown(beforeMarkdown, plan);
    const afterMarkdown = appliedUpdates.closedThreads.length > 0
      ? this.applyClosedThreadMarkers(
        editedMarkdown,
        appliedUpdates.closedThreads,
        now,
        vscode.workspace.asRelativePath(await this.store.getResolvedReviewFileUri(document.uri), false)
      )
      : editedMarkdown;

    if (!await this.replaceDocumentMarkdown(document, beforeMarkdown, afterMarkdown)) {
      return false;
    }

    await this.store.save(document.uri, appliedUpdates.reviewDocument);
    if (appliedUpdates.closedThreads.length > 0) {
      await this.store.saveResolved(document.uri, appliedUpdates.resolvedReviewDocument);
    }
    const afterSnapshot = await this.reviewUndo.capture(document.uri);
    this.reviewUndo.register(document.uri, beforeMarkdown, document.getText(), beforeSnapshot, afterSnapshot);
    return true;
  }

  private async restoreThread(
    document: vscode.TextDocument,
    threadId: string
  ): Promise<void> {
    const beforeMarkdown = document.getText();
    const beforeSnapshot = await this.reviewUndo.capture(document.uri);
    const now = new Date().toISOString();
    const reviewDocument = await this.store.load(document.uri);
    const existingOpenThread = reviewDocument.threads.find(thread => thread.id === threadId);

    if (existingOpenThread) {
      return;
    }

    const resolvedReviewDocument = await this.store.loadResolved(document.uri);
    const resolvedIndex = resolvedReviewDocument.threads.findIndex(thread => thread.id === threadId);

    if (resolvedIndex < 0) {
      throw new Error(`Resolved review thread not found: ${threadId}`);
    }

    const restoredThread = createRestoredReviewThread(
      resolvedReviewDocument.threads[resolvedIndex],
      now
    );
    const sidecarUri = await this.store.getReviewFileUri(document.uri);
    const afterMarkdown = upsertInlineAnchorMarkersInMarkdown(
      removeInlineReviewLogMarkers(beforeMarkdown, [threadId]),
      [{
        id: restoredThread.id,
        sidecar: vscode.workspace.asRelativePath(sidecarUri, false)
      }]
    );

    if (!await this.replaceDocumentMarkdown(document, beforeMarkdown, afterMarkdown)) {
      throw new Error('Markdown markers could not be updated.');
    }

    resolvedReviewDocument.threads.splice(resolvedIndex, 1);
    reviewDocument.threads.push(restoredThread);
    await this.store.save(document.uri, reviewDocument);
    await this.store.saveResolved(document.uri, resolvedReviewDocument);
    const afterSnapshot = await this.reviewUndo.capture(document.uri);
    this.reviewUndo.register(document.uri, beforeMarkdown, document.getText(), beforeSnapshot, afterSnapshot);
  }

  private applyClosedThreadMarkers(
    markdown: string,
    closedThreads: ClosedReviewThreadUpdate[],
    now: string,
    resolvedSidecarPath: string
  ): string {
    if (closedThreads.length === 0) {
      return markdown;
    }

    let nextMarkdown = removeInlineAnchorMarkersFromMarkdown(
      markdown,
      closedThreads.map(thread => thread.threadId)
    );

    for (const thread of closedThreads) {
      nextMarkdown = appendInlineReviewLogMarker(nextMarkdown, {
        id: thread.threadId,
        status: thread.status,
        sidecar: resolvedSidecarPath,
        updatedAt: now
      });
    }

    return nextMarkdown;
  }

  private async replaceDocumentMarkdown(
    document: vscode.TextDocument,
    beforeMarkdown: string,
    afterMarkdown: string
  ): Promise<boolean> {
    if (beforeMarkdown === afterMarkdown) {
      return true;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(beforeMarkdown.length)),
      afterMarkdown
    );
    return vscode.workspace.applyEdit(edit);
  }

  private async applySuggestedPatch(
    document: vscode.TextDocument,
    thread: ReviewThread
  ): Promise<ApplyPatchResult> {
    const selection = selectSuggestedPatchReplacement(
      document.getText(),
      thread.suggestedPatch,
      thread.anchor
    );

    if (selection.result !== 'applied') {
      return selection.result;
    }

    const plan = createOffsetEditPlan(document.getText(), {
      start: selection.start,
      end: selection.end,
      replacement: selection.replacement,
      actor: 'user',
      intent: 'apply_suggestion',
      targetThreadId: thread.id,
      closeTargetAs: 'accepted'
    });

    return await this.applyReviewAwareEdit(document, plan) ? 'applied' : 'failed';
  }

  private renderHtml(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    reviewDocument: ReviewDocument,
    resolvedReviewDocument: ReviewDocument,
    restoreState?: PreviewRestoreState
  ): string {
    const nonce = randomUUID();
    const documentText = document.getText();
    const previewMarkdown = stripInlineAnchorMarkers(documentText);
    const renderedMarkdown = this.markdown.render(previewMarkdown);
    const tables = collectMarkdownTables(previewMarkdown);
    const storageWarning = this.renderStorageWarning(documentText, reviewDocument);
    const markerLineHints = this.getMarkerLineHints(reviewDocument);
    const historyAnchorStates = getReviewHistoryAnchorStates(
      previewMarkdown,
      resolvedReviewDocument.threads
    );
    const mermaidScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'vendor', 'mermaid.min.js')
    );
    const state = JSON.stringify({
      threads: reviewDocument.threads,
      resolvedThreads: resolvedReviewDocument.threads,
      historyAnchorStates,
      markerLineHints,
      tables,
      documentVersion: document.version,
      restoreState: restoreState ?? {}
    }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Markdown Review</title>
  <style>
    :root {
      --border: var(--vscode-editorWidget-border);
      --muted: var(--vscode-descriptionForeground);
      --panel: var(--vscode-sideBar-background);
      --button: var(--vscode-button-background);
      --buttonFg: var(--vscode-button-foreground);
      --text: var(--vscode-editor-foreground);
    }
    body {
      margin: 0;
      color: var(--text);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      min-height: 100vh;
    }
    main {
      padding: 28px 40px;
      min-width: 0;
    }
    #markdown-body {
      max-width: 900px;
      line-height: 1.65;
      font-size: 15px;
    }
    #markdown-body pre {
      overflow: auto;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-textCodeBlock-background);
    }
    #markdown-body code {
      font-family: var(--vscode-editor-font-family);
    }
    aside {
      border-left: 1px solid var(--border);
      background: var(--panel);
      padding: 16px;
      overflow: auto;
    }
    .storage-warning {
      max-width: 900px;
      margin: 0 0 16px;
      border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
      border-radius: 6px;
      padding: 12px;
      color: var(--vscode-editorWarning-foreground, var(--text));
      background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.16));
    }
    .storage-warning strong {
      display: block;
      margin-bottom: 6px;
    }
    .storage-warning p {
      margin: 0;
      line-height: 1.45;
    }
    .storage-warning-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    button {
      border: 0;
      border-radius: 4px;
      padding: 7px 10px;
      color: var(--buttonFg);
      background: var(--button);
      cursor: pointer;
      font: inherit;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.compact {
      padding: 4px 8px;
      font-size: 12px;
    }
    .thread {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
      background: var(--vscode-editor-background);
      cursor: pointer;
    }
    .history-heading {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    .thread.is-closed {
      cursor: default;
      opacity: 0.9;
    }
    .thread.is-closed.history-linked {
      cursor: pointer;
    }
    .thread.is-closed.history-outdated {
      border-style: dashed;
      border-color: var(--vscode-inputValidation-warningBorder, #cca700);
    }
    .thread.is-active {
      border-color: #8ad83f;
      box-shadow: inset 3px 0 0 #8ad83f;
    }
    .thread.source-human {
      border-left: 3px solid #4da3ff;
    }
    .thread.source-ai {
      border-left: 3px solid #c792ea;
    }
    .thread.source-mixed {
      border-left: 3px solid #d7a100;
    }
    .thread.anchor-recovered {
      box-shadow: inset 0 0 0 1px rgba(215, 161, 0, 0.24);
    }
    .thread.anchor-approximate {
      box-shadow: inset 0 0 0 1px rgba(215, 161, 0, 0.42);
    }
    .thread.anchor-missing {
      border-style: dashed;
      border-color: var(--vscode-inputValidation-warningBorder, #cca700);
    }
    .thread header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .thread-meta,
    .comment-overlay-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .source-chip,
    .meta-chip,
    .anchor-state-chip {
      display: inline-flex;
      align-items: center;
      min-height: 18px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 11px;
      line-height: 1.35;
      color: var(--muted);
      background: var(--vscode-badge-background, rgba(127, 127, 127, 0.16));
    }
    .source-chip.source-human,
    .meta-chip.source-human {
      border-color: rgba(77, 163, 255, 0.72);
      color: #d8ecff;
      background: rgba(77, 163, 255, 0.22);
    }
    .source-chip.source-ai,
    .meta-chip.source-ai {
      border-color: rgba(199, 146, 234, 0.72);
      color: #f2ddff;
      background: rgba(199, 146, 234, 0.22);
    }
    .source-chip.source-mixed,
    .meta-chip.source-mixed {
      border-color: rgba(215, 161, 0, 0.72);
      color: #ffe9a3;
      background: rgba(215, 161, 0, 0.22);
    }
    .anchor-state-chip {
      border-color: rgba(138, 216, 63, 0.42);
      color: var(--muted);
    }
    .anchor-state-chip.anchor-recovered,
    .anchor-state-chip.anchor-approximate {
      border-color: rgba(215, 161, 0, 0.72);
      color: #ffe9a3;
      background: rgba(215, 161, 0, 0.18);
    }
    .anchor-state-chip.anchor-missing {
      border-color: var(--vscode-inputValidation-warningBorder, #cca700);
      color: var(--vscode-editorWarning-foreground, #ffe9a3);
      background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.16));
    }
    .anchor-state-chip.history-linked {
      border-color: rgba(138, 216, 63, 0.62);
      color: #dfffd0;
      background: rgba(138, 216, 63, 0.16);
    }
    .anchor-state-chip.history-outdated {
      border-color: var(--vscode-inputValidation-warningBorder, #cca700);
      color: var(--vscode-editorWarning-foreground, #ffe9a3);
      background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.16));
    }
    .thread blockquote {
      margin: 8px 0;
      padding-left: 10px;
      border-left: 3px solid var(--border);
      color: var(--muted);
    }
    .suggested-patch {
      margin-top: 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      background: var(--vscode-editor-background);
    }
    .suggested-patch summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 12px;
    }
    .suggested-patch pre {
      margin: 8px 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .suggested-patch-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 8px;
    }
    .thread-actions {
      display: flex;
      gap: 6px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .thread-actions button {
      cursor: pointer;
    }
    .empty {
      color: var(--muted);
      font-size: 13px;
    }
    .mermaid-figure {
      margin: 20px 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .mermaid-figure.has-review {
      border-color: #d7a100;
      box-shadow: inset 0 0 0 1px rgba(215, 161, 0, 0.34);
    }
    .mermaid-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      background: var(--vscode-editorWidget-background);
      font-size: 12px;
    }
    .mermaid-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .mermaid-render {
      min-height: 80px;
      overflow: auto;
      padding: 18px;
      text-align: center;
    }
    .mermaid-render svg {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 0 auto;
    }
    .mermaid-render.is-error {
      text-align: left;
      color: var(--vscode-errorForeground);
      background: var(--vscode-inputValidation-errorBackground);
    }
    .mermaid-render.is-error pre {
      white-space: pre-wrap;
      margin-bottom: 0;
    }
    .mermaid-source {
      border-top: 1px solid var(--border);
      padding: 8px 10px;
    }
    .mermaid-source summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 12px;
    }
    .mermaid-source pre {
      margin: 8px 0 0;
    }
    .selection-popover,
    .comment-composer,
    .comment-overlay,
    .block-editor,
    .mermaid-editor,
    .table-editor {
      position: fixed;
      z-index: 20;
      display: none;
      max-width: min(360px, calc(100vw - 24px));
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
      background: var(--vscode-editorWidget-background);
    }
    .selection-popover {
      padding: 6px;
    }
    .comment-composer {
      width: 320px;
      padding: 10px;
    }
    .comment-overlay {
      box-sizing: border-box;
      width: 360px;
      max-height: min(520px, calc(100vh - 24px));
      overflow: auto;
      padding: 12px;
    }
    .block-editor {
      box-sizing: border-box;
      z-index: 30;
      width: min(680px, calc(100vw - 24px));
      max-width: min(680px, calc(100vw - 24px));
      padding: 0;
    }
    .mermaid-editor {
      box-sizing: border-box;
      z-index: 30;
      width: min(680px, calc(100vw - 24px));
      max-width: min(680px, calc(100vw - 24px));
      padding: 0;
    }
    .table-editor {
      box-sizing: border-box;
      z-index: 30;
      width: min(920px, calc(100vw - 24px));
      max-width: min(920px, calc(100vw - 24px));
      padding: 0;
    }
    .block-editor-header,
    .block-editor-toolbar,
    .block-editor-actions,
    .mermaid-editor-header,
    .mermaid-editor-actions,
    .table-editor-header,
    .table-editor-toolbar,
    .table-editor-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
    }
    .block-editor-header,
    .mermaid-editor-header,
    .table-editor-header {
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
    }
    .block-editor-toolbar,
    .table-editor-toolbar {
      flex-wrap: wrap;
      border-bottom: 1px solid var(--border);
    }
    .block-editor-surface {
      box-sizing: border-box;
      min-height: 140px;
      max-height: min(420px, calc(100vh - 220px));
      overflow: auto;
      padding: 12px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      outline: none;
      line-height: 1.6;
    }
    .block-editor-surface:focus {
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
    }
    .mermaid-editor-source {
      box-sizing: border-box;
      width: 100%;
      min-height: 220px;
      max-height: min(480px, calc(100vh - 180px));
      resize: vertical;
      border: 0;
      padding: 12px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      outline: none;
      font-family: var(--vscode-editor-font-family);
      line-height: 1.45;
    }
    .mermaid-editor-source:focus {
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
    }
    .block-editor-actions,
    .mermaid-editor-actions,
    .table-editor-actions {
      justify-content: flex-end;
      border-top: 1px solid var(--border);
    }
    .table-editor-grid {
      box-sizing: border-box;
      max-height: min(520px, calc(100vh - 220px));
      overflow: auto;
      padding: 10px;
      background: var(--vscode-input-background);
    }
    .table-editor-grid table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .table-editor-grid th,
    .table-editor-grid td {
      min-width: 120px;
      border: 1px solid var(--border);
      padding: 4px;
      vertical-align: top;
    }
    .table-editor-grid th:first-child,
    .table-editor-grid td:first-child {
      width: 44px;
      min-width: 44px;
      text-align: center;
      color: var(--muted);
      background: var(--vscode-editorWidget-background);
    }
    .table-editor-grid input,
    .table-editor-grid select {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid transparent;
      border-radius: 3px;
      padding: 5px 6px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
    }
    .table-editor-grid input:focus,
    .table-editor-grid select:focus {
      border-color: var(--vscode-focusBorder);
      outline: none;
    }
    .table-cell-tools {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 4px;
      margin-top: 4px;
    }
    .editable-markdown-block {
      position: relative;
    }
    .editable-markdown-table {
      position: relative;
      overflow-x: auto;
      margin: 1em 0;
    }
    .editable-markdown-table > table {
      margin: 0;
    }
    .block-edit-actions {
      position: absolute;
      top: -12px;
      left: -10px;
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 5;
    }
    .editable-markdown-block:hover > .block-edit-actions,
    .editable-markdown-table:hover > .block-edit-actions,
    .block-edit-actions:focus-within {
      opacity: 1;
    }
    .block-edit-actions button {
      border: 1px solid var(--border);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    }
    .comment-overlay-item + .comment-overlay-item {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    .comment-overlay-meta {
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .comment-overlay-comment {
      margin: 0;
      line-height: 1.45;
    }
    .comment-overlay-actions {
      display: flex;
      gap: 6px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .reply-list {
      margin-top: 10px;
      border-left: 2px solid var(--border);
      padding-left: 10px;
    }
    .reply-item {
      margin-top: 8px;
      border-left: 2px solid transparent;
      padding-left: 8px;
    }
    .reply-item.source-human {
      border-left-color: rgba(77, 163, 255, 0.72);
    }
    .reply-item.source-ai {
      border-left-color: rgba(199, 146, 234, 0.72);
    }
    .reply-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 3px;
    }
    .reply-text {
      margin: 0;
      line-height: 1.45;
    }
    .reply-form {
      margin-top: 10px;
    }
    .reply-form textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 64px;
      resize: vertical;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
    }
    .reply-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 6px;
    }
    .comment-composer textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 86px;
      resize: vertical;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
    }
    .comment-composer-label {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .comment-composer-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
    .review-anchor {
      border-radius: 3px;
      background: rgba(255, 203, 64, 0.28);
      box-shadow: inset 0 -2px 0 rgba(215, 161, 0, 0.9);
    }
    .review-anchor.source-human,
    .review-anchor-block.source-human {
      background: rgba(77, 163, 255, 0.13);
      outline-color: rgba(77, 163, 255, 0.58);
      box-shadow: inset 0 -2px 0 rgba(77, 163, 255, 0.82);
    }
    .review-anchor.source-ai,
    .review-anchor-block.source-ai {
      background: rgba(199, 146, 234, 0.14);
      outline-color: rgba(199, 146, 234, 0.64);
      box-shadow: inset 0 -2px 0 rgba(199, 146, 234, 0.86);
    }
    .review-anchor.source-mixed,
    .review-anchor-block.source-mixed {
      background: rgba(255, 203, 64, 0.14);
      outline-color: rgba(215, 161, 0, 0.65);
      box-shadow: inset 0 -2px 0 rgba(215, 161, 0, 0.9);
    }
    .review-anchor.anchor-recovered,
    .review-anchor-block.anchor-recovered {
      outline-style: solid;
      outline-width: 2px;
    }
    .review-anchor.anchor-approximate,
    .review-anchor-block.anchor-approximate {
      outline-style: dashed;
      outline-width: 2px;
    }
    .review-anchor-block {
      position: relative;
      border-radius: 4px;
      outline: 1px solid rgba(215, 161, 0, 0.65);
      background: rgba(255, 203, 64, 0.12);
    }
    .review-anchor.is-active,
    .review-anchor-block.is-active {
      background: rgba(138, 216, 63, 0.22);
      outline: 2px solid rgba(138, 216, 63, 0.9);
      box-shadow: inset 0 -2px 0 #8ad83f;
    }
    .history-anchor-target.is-active {
      border-radius: 4px;
      outline: 2px solid rgba(138, 216, 63, 0.9);
      background: rgba(138, 216, 63, 0.16);
    }
    .review-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      margin-left: 5px;
      padding: 0 5px;
      border: 1px solid rgba(31, 36, 40, 0.24);
      border-radius: 999px;
      color: #172018;
      background: #8ad83f;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      vertical-align: text-top;
      cursor: pointer;
      user-select: none;
    }
    .review-badge.source-human {
      color: #061724;
      background: #4da3ff;
    }
    .review-badge.source-ai {
      color: #1e0d2b;
      background: #c792ea;
    }
    .review-badge.source-mixed {
      color: #201700;
      background: #d7a100;
    }
    .review-block-badge {
      position: absolute;
      top: -10px;
      right: -10px;
    }
    .mermaid-review-badge {
      margin-left: 0;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }
      aside {
        border-left: 0;
        border-top: 1px solid var(--border);
      }
      main {
        padding: 20px;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <main>
      ${storageWarning}
      <article id="markdown-body">${renderedMarkdown}</article>
    </main>
    <aside>
      <h2>Review Threads</h2>
      ${storageWarning}
      <div id="threads"></div>
      <h2 class="history-heading">Closed History</h2>
      <div id="history"></div>
    </aside>
  </div>
  <div id="selection-popover" class="selection-popover">
    <button id="selection-comment" class="compact">Comment</button>
  </div>
  <form id="comment-composer" class="comment-composer">
    <p class="comment-composer-label">Comment on selected text</p>
    <textarea id="comment-body" placeholder="Add feedback for this selection"></textarea>
    <div class="comment-composer-actions">
      <button type="button" id="comment-cancel" class="secondary compact">Cancel</button>
      <button type="submit" class="compact">Save</button>
    </div>
  </form>
  <div id="comment-overlay" class="comment-overlay" role="dialog" aria-label="Review comments"></div>
  <form id="block-editor" class="block-editor" aria-label="Markdown block editor">
    <div class="block-editor-header">
      <strong id="block-editor-title">Edit Markdown block</strong>
      <span id="block-editor-lines"></span>
    </div>
    <div class="block-editor-toolbar" aria-label="Formatting">
      <button type="button" class="secondary compact" data-format-block="p" title="Paragraph">P</button>
      <button type="button" class="secondary compact" data-format-block="h2" title="Heading 2">H2</button>
      <button type="button" class="secondary compact" data-format-block="h3" title="Heading 3">H3</button>
      <button type="button" class="secondary compact" data-inline-format="bold" title="Bold">B</button>
      <button type="button" class="secondary compact" data-inline-format="italic" title="Italic">I</button>
      <button type="button" class="secondary compact" data-inline-format="code" title="Inline code">Code</button>
    </div>
    <div id="block-editor-surface" class="block-editor-surface" contenteditable="true"></div>
    <div class="block-editor-actions">
      <button type="button" id="block-editor-cancel" class="secondary compact">Cancel</button>
      <button type="submit" class="compact">Save</button>
    </div>
  </form>
  <form id="mermaid-editor" class="mermaid-editor" aria-label="Mermaid source editor">
    <div class="mermaid-editor-header">
      <strong>Edit Mermaid source</strong>
      <span id="mermaid-editor-lines"></span>
    </div>
    <textarea id="mermaid-editor-source" class="mermaid-editor-source" spellcheck="false"></textarea>
    <div class="mermaid-editor-actions">
      <button type="button" id="mermaid-editor-cancel" class="secondary compact">Cancel</button>
      <button type="submit" class="compact">Save</button>
    </div>
  </form>
  <form id="table-editor" class="table-editor" aria-label="Markdown table editor">
    <div class="table-editor-header">
      <strong>Edit Markdown table</strong>
      <span id="table-editor-lines"></span>
    </div>
    <div class="table-editor-toolbar">
      <button type="button" class="secondary compact" id="table-editor-add-row">Add Row</button>
      <button type="button" class="secondary compact" id="table-editor-add-column">Add Column</button>
    </div>
    <div id="table-editor-grid" class="table-editor-grid"></div>
    <div class="table-editor-actions">
      <button type="button" id="table-editor-cancel" class="secondary compact">Cancel</button>
      <button type="submit" class="compact">Save</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${mermaidScriptUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${state};
    const markerLineHints = state.markerLineHints || {};
    const markdownTables = Array.isArray(state.tables) ? state.tables : [];
    const documentVersion = Number(state.documentVersion);
    const restoreState = state.restoreState || {};
    const markdownBody = document.getElementById('markdown-body');
    const selectionPopover = document.getElementById('selection-popover');
    const selectionCommentButton = document.getElementById('selection-comment');
    const commentComposer = document.getElementById('comment-composer');
    const commentBody = document.getElementById('comment-body');
    const commentCancel = document.getElementById('comment-cancel');
    const commentOverlay = document.getElementById('comment-overlay');
    const blockEditor = document.getElementById('block-editor');
    const blockEditorTitle = document.getElementById('block-editor-title');
    const blockEditorLines = document.getElementById('block-editor-lines');
    const blockEditorSurface = document.getElementById('block-editor-surface');
    const blockEditorCancel = document.getElementById('block-editor-cancel');
    const mermaidEditor = document.getElementById('mermaid-editor');
    const mermaidEditorLines = document.getElementById('mermaid-editor-lines');
    const mermaidEditorSource = document.getElementById('mermaid-editor-source');
    const mermaidEditorCancel = document.getElementById('mermaid-editor-cancel');
    const tableEditor = document.getElementById('table-editor');
    const tableEditorLines = document.getElementById('table-editor-lines');
    const tableEditorGrid = document.getElementById('table-editor-grid');
    const tableEditorCancel = document.getElementById('table-editor-cancel');
    const tableEditorAddRow = document.getElementById('table-editor-add-row');
    const tableEditorAddColumn = document.getElementById('table-editor-add-column');
    let activeSelectionText = '';
    let activeSelectionOccurrence = 0;
    let activeSourceLine = undefined;
    let activeSelectionRect = null;
    let selectionTimer = undefined;
    let activeBlockEdit = undefined;
    let activeMermaidEdit = undefined;
    let activeTableEdit = undefined;

    document.addEventListener('selectionchange', () => {
      scheduleSelectionComposer(false);
    });

    markdownBody.addEventListener('pointerup', () => {
      scheduleSelectionComposer(true);
    });

    markdownBody.addEventListener('keyup', () => {
      scheduleSelectionComposer(false);
    });

    selectionCommentButton.addEventListener('click', () => {
      openComposer();
    });

    commentCancel.addEventListener('click', () => {
      hideComposer();
    });

    blockEditorCancel.addEventListener('click', () => {
      hideBlockEditor();
    });

    mermaidEditorCancel.addEventListener('click', () => {
      hideMermaidEditor();
    });

    tableEditorCancel.addEventListener('click', () => {
      hideTableEditor();
    });

    tableEditorAddRow.addEventListener('click', () => {
      const table = readTableEditorData();
      table.rows.push(Array.from({ length: table.headers.length }, () => ''));
      renderTableEditorGrid(table);
      focusTableCell(table.rows.length, 0);
    });

    tableEditorAddColumn.addEventListener('click', () => {
      const table = readTableEditorData();
      table.headers.push('Column ' + (table.headers.length + 1));
      table.alignments.push('none');
      table.rows = table.rows.map((row) => [...row, '']);
      renderTableEditorGrid(table);
      focusTableCell(0, table.headers.length - 1);
    });

    tableEditorGrid.addEventListener('click', (event) => {
      const target = event.target;

      if (!(target instanceof HTMLElement)) {
        return;
      }

      const removeColumnButton = target.closest('[data-remove-table-column]');

      if (removeColumnButton) {
        const columnIndex = Number(removeColumnButton.getAttribute('data-column'));
        const table = readTableEditorData();

        if (table.headers.length > 1 && Number.isFinite(columnIndex)) {
          table.headers.splice(columnIndex, 1);
          table.alignments.splice(columnIndex, 1);
          table.rows = table.rows.map((row) => row.filter((_, index) => index !== columnIndex));
          renderTableEditorGrid(table);
        }

        return;
      }

      const removeRowButton = target.closest('[data-remove-table-row]');

      if (removeRowButton) {
        const rowIndex = Number(removeRowButton.getAttribute('data-row'));
        const table = readTableEditorData();

        if (Number.isFinite(rowIndex)) {
          table.rows.splice(rowIndex, 1);
          renderTableEditorGrid(table);
        }
      }
    });

    blockEditor.addEventListener('submit', (event) => {
      event.preventDefault();

      if (!activeBlockEdit) {
        return;
      }

      vscode.postMessage({
        type: 'editMarkdownBlock',
        lineStart: activeBlockEdit.lineStart,
        lineEnd: activeBlockEdit.lineEnd,
        html: blockEditorSurface.innerHTML,
        intent: activeBlockEdit.intent
      });
      hideBlockEditor();
    });

    mermaidEditor.addEventListener('submit', (event) => {
      event.preventDefault();

      if (!activeMermaidEdit) {
        return;
      }

      vscode.postMessage({
        type: 'editMermaidSource',
        lineStart: activeMermaidEdit.lineStart,
        lineEnd: activeMermaidEdit.lineEnd,
        source: mermaidEditorSource.value
      });
      hideMermaidEditor();
    });

    tableEditor.addEventListener('submit', (event) => {
      event.preventDefault();

      if (!activeTableEdit) {
        return;
      }

      const table = readTableEditorData();
      vscode.postMessage({
        type: 'editMarkdownTable',
        lineStart: activeTableEdit.lineStart,
        lineEnd: activeTableEdit.lineEnd,
        headers: table.headers,
        alignments: table.alignments,
        rows: table.rows
      });
      hideTableEditor();
    });

    blockEditor.addEventListener('click', (event) => {
      const target = event.target;

      if (!(target instanceof HTMLElement)) {
        return;
      }

      const inlineButton = target.closest('[data-inline-format]');
      const blockButton = target.closest('[data-format-block]');

      if (inlineButton) {
        event.preventDefault();
        blockEditorSurface.focus();
        applyInlineFormat(inlineButton.getAttribute('data-inline-format'));
        return;
      }

      if (blockButton) {
        event.preventDefault();
        blockEditorSurface.focus();
        applyBlockFormat(blockButton.getAttribute('data-format-block'));
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideCommentOverlay();
        hideSelectionPopover();
        hideComposerIfEmpty();
        hideBlockEditorIfClean();
        hideMermaidEditorIfClean();
        hideTableEditorIfClean();
      }

      if (event.key === 'Enter'
        && !event.shiftKey
        && !event.isComposing
        && event.target instanceof HTMLTextAreaElement) {
        const form = event.target.closest('form');

        if (form === commentComposer || form?.matches('[data-reply-form]')) {
          event.preventDefault();
          form.requestSubmit();
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && commentComposer.style.display === 'block') {
        event.preventDefault();
        commentComposer.requestSubmit();
      }
    });

    commentComposer.addEventListener('submit', (event) => {
      event.preventDefault();
      const body = commentBody.value.trim();

      if (!body || !activeSelectionText) {
        return;
      }

      vscode.postMessage({
        type: 'addComment',
        anchorText: activeSelectionText,
        anchorOccurrence: activeSelectionOccurrence,
        sourceLine: activeSourceLine,
        comment: body
      });
      hideSelectionPopover();
      hideComposer();
      window.getSelection()?.removeAllRanges();
    });

    document.addEventListener('submit', (event) => {
      const target = event.target;

      if (!(target instanceof HTMLFormElement) || !target.matches('[data-reply-form]')) {
        return;
      }

      event.preventDefault();
      const textArea = target.querySelector('textarea');
      const text = String(textArea?.value || '').trim();

      if (!text) {
        return;
      }

      vscode.postMessage({
        type: 'addReply',
        threadId: target.getAttribute('data-thread-id'),
        threadIds: getThreadIds(commentOverlay),
        origin: target.closest('#comment-overlay') ? 'overlay' : 'thread',
        text
      });
    });

    document.addEventListener('click', (event) => {
      const target = event.target;

      if (!(target instanceof HTMLElement)) {
        return;
      }

      hideComposerIfEmpty(target);

      if (target.closest('#block-editor')) {
        return;
      }

      hideBlockEditorIfClean();

      if (target.closest('#mermaid-editor')) {
        return;
      }

      hideMermaidEditorIfClean();

      if (target.closest('#table-editor')) {
        return;
      }

      hideTableEditorIfClean();

      const tableEditButton = target.closest('[data-edit-markdown-table]');

      if (tableEditButton) {
        event.preventDefault();
        event.stopPropagation();
        const wrapper = tableEditButton.closest('[data-table-edit-wrapper]');
        const table = wrapper?.querySelector('table[data-source-line]');

        if (table) {
          openTableEditor(table);
        }

        return;
      }

      const blockEditButton = target.closest('[data-edit-markdown-block], [data-rewrite-markdown-block]');

      if (blockEditButton) {
        event.preventDefault();
        event.stopPropagation();
        const block = blockEditButton.closest('[data-source-line]');
        const intent = blockEditButton.hasAttribute('data-rewrite-markdown-block')
          ? 'rewrite_section'
          : 'manual_block_edit';

        if (block) {
          openBlockEditor(block, intent);
        }

        return;
      }

      const applyPatchButton = target.closest('[data-apply-suggested-patch]');

      if (applyPatchButton) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({
          type: 'applySuggestedPatch',
          threadId: applyPatchButton.getAttribute('data-thread-id')
        });
        return;
      }

      const cleanupButton = target.closest('[data-cleanup-stale-anchors]');

      if (cleanupButton) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({
          type: 'cleanupStaleAnchors',
          threadIds: String(cleanupButton.getAttribute('data-thread-ids') || '')
            .split(',')
            .map((threadId) => threadId.trim())
            .filter(Boolean)
        });
        return;
      }

      const restoreButton = target.closest('[data-restore-thread]');

      if (restoreButton) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({
          type: 'restoreThread',
          threadId: restoreButton.getAttribute('data-thread-id')
        });
        return;
      }

      const overlayAction = target.closest('[data-overlay-status]');

      if (overlayAction) {
        event.stopPropagation();
        vscode.postMessage({
          type: 'updateStatus',
          threadId: overlayAction.getAttribute('data-thread-id'),
          status: overlayAction.getAttribute('data-overlay-status')
        });
        return;
      }

      if (target.closest('#comment-overlay')) {
        return;
      }

      const figure = target.closest('[data-mermaid-diagram]');

      if (figure) {
        const source = getMermaidSource(figure);

        if (target.matches('[data-mermaid-edit]')) {
          openMermaidEditor(figure, source);
          return;
        }

        if (target.matches('[data-mermaid-feedback]')) {
          activeSelectionText = source;
          activeSelectionOccurrence = 0;
          activeSourceLine = getSourceLine(figure);
          const rect = target.getBoundingClientRect();
          activeSelectionRect = {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom
          };
          openComposer();
          return;
        }

        if (target.matches('[data-mermaid-copy]')) {
          vscode.postMessage({ type: 'copyText', text: source });
          return;
        }
      }

      const commentTarget = target.closest('.review-badge, .review-anchor, .review-anchor-block, [data-mermaid-diagram].has-review');

      if (commentTarget) {
        const threadIds = getThreadIds(commentTarget);

        if (threadIds.length > 0) {
          event.stopPropagation();
          const sourceElement = target.closest('.review-badge') || commentTarget;
          openCommentOverlay(threadIds, sourceElement);
          focusThread(threadIds[0], false);
          return;
        }
      }

      hideCommentOverlay();
    });

    const openThreads = state.threads.filter((thread) => thread.status === 'open');
    const closedThreads = (state.resolvedThreads || [])
      .filter((thread) => thread.status !== 'open')
      .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
    const historyAnchorStates = state.historyAnchorStates || {};
    const threadsContainer = document.getElementById('threads');
    const historyContainer = document.getElementById('history');

    if (openThreads.length === 0) {
      threadsContainer.innerHTML = '<p class="empty">No open feedback yet.</p>';
    } else {
      for (const thread of openThreads) {
        const element = document.createElement('section');
        element.className = 'thread ' + sourceClass(thread);
        element.dataset.threadId = thread.id;
        element.title = 'Jump to commented content';
        element.innerHTML = [
          '<header><span class="thread-meta">' + renderSourceChip(thread) + renderMetaChip('Type', thread.type) + '<span class="anchor-state-chip" data-anchor-state>Locating</span></span>' + renderMetaChip('Severity', thread.severity) + '</header>',
          '<blockquote>' + escapeHtml(thread.anchor.text || 'Document') + '</blockquote>',
          '<p>' + escapeHtml(thread.comment) + '</p>',
          renderSuggestedPatch(thread),
          renderReplies(thread),
          renderReplyForm(thread),
          '<div class="thread-actions">',
          '<button class="secondary" title="Agree with this feedback and close the thread." data-status="accepted">Accept</button>',
          '<button class="secondary" title="Close because the underlying issue has been handled." data-status="resolved">Resolve</button>',
          '<button class="secondary" title="Decline this recommendation and close the thread." data-status="rejected">Reject</button>',
          '</div>'
        ].join('');

        element.addEventListener('click', (event) => {
          if (event.target instanceof HTMLElement && event.target.closest('button, textarea, form, .reply-list')) {
            return;
          }

          focusAnchor(thread.id);
        });

        for (const button of element.querySelectorAll('button[data-status]')) {
          button.addEventListener('click', () => {
            vscode.postMessage({
              type: 'updateStatus',
              threadId: thread.id,
              status: button.getAttribute('data-status')
            });
          });
        }

        threadsContainer.appendChild(element);
      }
    }

    renderClosedHistory(closedThreads);
    decorateReviewAnchors(openThreads);
    decorateMermaidReviewBadges(openThreads);
    attachRelatedThreadIds(openThreads);
    markMissingAnchors(openThreads);
    decorateEditableMarkdownBlocks();
    decorateEditableMarkdownTables();
    restorePreviewState();
    renderMermaidDiagrams();

    function renderClosedHistory(threads) {
      if (threads.length === 0) {
        historyContainer.innerHTML = '<p class="empty">No closed review history yet.</p>';
        return;
      }

      historyContainer.innerHTML = '';

      for (const thread of threads) {
        const historyState = historyAnchorStates[thread.id] === 'linked' ? 'linked' : 'outdated';
        const element = document.createElement('section');
        element.className = 'thread is-closed history-' + historyState + ' ' + sourceClass(thread);
        element.dataset.threadId = thread.id;
        element.title = historyState === 'linked'
          ? 'Closed thread. Click to jump to the matching content.'
          : 'Closed thread. The original anchor text no longer appears in this document.';
        element.innerHTML = [
          '<header><span class="thread-meta">' + renderSourceChip(thread) + renderMetaChip('Status', thread.status) + renderMetaChip('Type', thread.type) + renderHistoryAnchorChip(historyState) + '</span>' + renderMetaChip('Updated', formatDate(thread.updatedAt)) + '</header>',
          '<blockquote>' + escapeHtml(thread.anchor.text || 'Document') + '</blockquote>',
          '<p>' + escapeHtml(thread.comment) + '</p>',
          renderReplies(thread),
          '<div class="thread-actions">',
          '<button class="secondary" title="Restore this closed review thread to open feedback." data-thread-id="' + escapeHtml(thread.id) + '" data-restore-thread>Restore</button>',
          '</div>'
        ].join('');

        element.addEventListener('click', (event) => {
          if (event.target instanceof HTMLElement && event.target.closest('button, textarea, form, .reply-list')) {
            return;
          }

          if (historyState === 'linked') {
            focusHistoryAnchor(thread);
          }
        });

        historyContainer.appendChild(element);
      }
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function getMermaidSource(figure) {
      const sourceElement = figure.querySelector('.mermaid-source code');
      return String(sourceElement?.textContent || '').trim();
    }

    function getSourceLine(element) {
      const sourceElement = element?.closest?.('[data-source-line]');
      const sourceLine = Number(sourceElement?.getAttribute('data-source-line'));
      return Number.isFinite(sourceLine) && sourceLine > 0 ? Math.floor(sourceLine) : undefined;
    }

    function getSourceLineEnd(element) {
      const sourceElement = element?.closest?.('[data-source-line-end]');
      const sourceLineEnd = Number(sourceElement?.getAttribute('data-source-line-end'));
      return Number.isFinite(sourceLineEnd) && sourceLineEnd > 0 ? Math.floor(sourceLineEnd) : undefined;
    }

    function decorateEditableMarkdownBlocks() {
      const blocks = getEditableBlocks();

      for (const block of blocks) {
        if (block.querySelector(':scope > .block-edit-actions')) {
          continue;
        }

        block.classList.add('editable-markdown-block');
        const actions = document.createElement('span');
        actions.className = 'block-edit-actions';
        actions.innerHTML = [
          '<button type="button" class="secondary compact" title="Edit this rendered Markdown block" data-edit-markdown-block>Edit</button>',
          '<button type="button" class="secondary compact" title="Rewrite this block and keep attached comments updated" data-rewrite-markdown-block>Rewrite</button>'
        ].join('');
        block.appendChild(actions);
      }
    }

    function getEditableBlocks() {
      const selectors = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
      return Array.from(markdownBody.querySelectorAll(selectors))
        .filter((element) => element.hasAttribute('data-source-line'))
        .filter((element) => !element.closest('pre, code, table, .mermaid-source, [data-mermaid-diagram]'));
    }

    function decorateEditableMarkdownTables() {
      const tables = Array.from(markdownBody.querySelectorAll('table[data-source-line]'));

      for (const table of tables) {
        if (table.closest('[data-table-edit-wrapper]')) {
          continue;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'editable-markdown-table';
        wrapper.dataset.tableEditWrapper = 'true';
        table.parentNode?.insertBefore(wrapper, table);
        wrapper.appendChild(table);

        const actions = document.createElement('span');
        actions.className = 'block-edit-actions';
        actions.innerHTML = '<button type="button" class="secondary compact" title="Edit this Markdown table as a grid" data-edit-markdown-table>Edit Table</button>';
        wrapper.appendChild(actions);
      }
    }

    function openBlockEditor(block, intent) {
      const lineRange = getEditableLineRange(block);

      if (!lineRange) {
        return;
      }

      if (commentComposer.style.display === 'block' && commentBody.value.trim()) {
        commentBody.focus();
        return;
      }

      if (mermaidEditor.style.display === 'block'
        && activeMermaidEdit
        && mermaidEditorSource.value !== activeMermaidEdit.originalSource) {
        mermaidEditorSource.focus();
        return;
      }

      if (tableEditor.style.display === 'block'
        && activeTableEdit
        && tableEditorSignature() !== activeTableEdit.originalSignature) {
        focusFirstTableInput();
        return;
      }

      if (blockEditor.style.display === 'block'
        && activeBlockEdit
        && blockEditorSurface.innerHTML !== activeBlockEdit.originalHtml) {
        blockEditorSurface.focus();
        return;
      }

      hideCommentOverlay();
      hideSelectionPopover();
      hideComposerIfEmpty();
      hideMermaidEditorIfClean();
      hideTableEditorIfClean();
      activeBlockEdit = {
        ...lineRange,
        intent,
        originalHtml: blockEditorSurface.innerHTML
      };
      const clone = block.cloneNode(true);
      clone.querySelectorAll('.review-badge, .block-edit-actions').forEach((element) => element.remove());
      clone.querySelectorAll('.review-anchor').forEach((element) => {
        element.replaceWith(document.createTextNode(element.textContent || ''));
      });

      blockEditorSurface.innerHTML = wrapEditableBlockHtml(block, clone.innerHTML);
      activeBlockEdit.originalHtml = blockEditorSurface.innerHTML;
      blockEditorTitle.textContent = intent === 'rewrite_section'
        ? 'Rewrite Markdown block'
        : 'Edit Markdown block';
      blockEditorLines.textContent = 'Lines ' + lineRange.lineStart + '-' + lineRange.lineEnd;
      const rect = block.getBoundingClientRect();
      positionFloatingElement(blockEditor, {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      }, 680);
      blockEditor.style.display = 'block';
      blockEditorSurface.focus();
    }

    function openTableEditor(tableElement) {
      const lineRange = getEditableLineRange(tableElement);

      if (!lineRange) {
        return;
      }

      if (commentComposer.style.display === 'block' && commentBody.value.trim()) {
        commentBody.focus();
        return;
      }

      if (blockEditor.style.display === 'block'
        && activeBlockEdit
        && blockEditorSurface.innerHTML !== activeBlockEdit.originalHtml) {
        blockEditorSurface.focus();
        return;
      }

      if (mermaidEditor.style.display === 'block'
        && activeMermaidEdit
        && mermaidEditorSource.value !== activeMermaidEdit.originalSource) {
        mermaidEditorSource.focus();
        return;
      }

      if (tableEditor.style.display === 'block'
        && activeTableEdit
        && tableEditorSignature() !== activeTableEdit.originalSignature) {
        focusFirstTableInput();
        return;
      }

      const table = findTableEditData(lineRange) || readTableDataFromDom(tableElement);
      hideCommentOverlay();
      hideSelectionPopover();
      hideComposerIfEmpty();
      hideBlockEditorIfClean();
      hideMermaidEditorIfClean();
      activeTableEdit = {
        ...lineRange,
        originalSignature: ''
      };
      renderTableEditorGrid(table);
      activeTableEdit.originalSignature = tableEditorSignature();
      tableEditorLines.textContent = 'Lines ' + lineRange.lineStart + '-' + lineRange.lineEnd;
      const rect = tableElement.getBoundingClientRect();
      positionFloatingElement(tableEditor, {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      }, 920);
      tableEditor.style.display = 'block';
      focusFirstTableInput();
    }

    function findTableEditData(lineRange) {
      return markdownTables.find((table) => {
        return Number(table.lineStart) === lineRange.lineStart
          && Number(table.lineEnd) === lineRange.lineEnd;
      });
    }

    function readTableDataFromDom(tableElement) {
      const headers = Array.from(tableElement.querySelectorAll('thead th')).map((cell) => cell.textContent || '');
      const bodyRows = Array.from(tableElement.querySelectorAll('tbody tr')).map((row) => {
        return Array.from(row.querySelectorAll('td, th')).map((cell) => cell.textContent || '');
      });
      const fallbackRows = bodyRows.length > 0
        ? bodyRows
        : Array.from(tableElement.querySelectorAll('tr')).slice(1).map((row) => {
          return Array.from(row.querySelectorAll('td, th')).map((cell) => cell.textContent || '');
        });
      const columnCount = Math.max(1, headers.length, ...fallbackRows.map((row) => row.length));
      return normalizeTableData({
        headers: padTableCells(headers.length > 0 ? headers : Array.from({ length: columnCount }, (_, index) => 'Column ' + (index + 1)), columnCount),
        alignments: Array.from({ length: columnCount }, () => 'none'),
        rows: fallbackRows.map((row) => padTableCells(row, columnCount))
      });
    }

    function normalizeTableData(table) {
      const rows = Array.isArray(table?.rows) ? table.rows.filter(Array.isArray) : [];
      const headers = Array.isArray(table?.headers) ? table.headers.map(String) : [];
      const alignments = Array.isArray(table?.alignments) ? table.alignments.map(normalizeAlignment) : [];
      const columnCount = Math.max(1, headers.length, alignments.length, ...rows.map((row) => row.length));
      return {
        headers: padTableCells(headers, columnCount),
        alignments: padTableAlignments(alignments, columnCount),
        rows: rows.map((row) => padTableCells(row.map(String), columnCount))
      };
    }

    function padTableCells(cells, columnCount) {
      return Array.from({ length: columnCount }, (_, index) => cells[index] || '');
    }

    function padTableAlignments(alignments, columnCount) {
      return Array.from({ length: columnCount }, (_, index) => normalizeAlignment(alignments[index]));
    }

    function normalizeAlignment(value) {
      return value === 'left' || value === 'center' || value === 'right' ? value : 'none';
    }

    function renderTableEditorGrid(table) {
      const normalizedTable = normalizeTableData(table);
      tableEditorGrid.innerHTML = [
        '<table>',
        '<thead>',
        '<tr>',
        '<th></th>',
        ...normalizedTable.headers.map((header, columnIndex) => [
          '<th>',
          '<input data-table-header data-column="' + columnIndex + '" value="' + escapeHtml(header) + '" aria-label="Column ' + (columnIndex + 1) + ' header">',
          '<div class="table-cell-tools">',
          '<select data-table-align data-column="' + columnIndex + '" aria-label="Column ' + (columnIndex + 1) + ' alignment">',
          renderAlignmentOptions(normalizedTable.alignments[columnIndex]),
          '</select>',
          '<button type="button" class="secondary compact" title="Remove column" data-remove-table-column data-column="' + columnIndex + '">-</button>',
          '</div>',
          '</th>'
        ].join('')),
        '</tr>',
        '</thead>',
        '<tbody>',
        ...normalizedTable.rows.map((row, rowIndex) => [
          '<tr>',
          '<td><button type="button" class="secondary compact" title="Remove row" data-remove-table-row data-row="' + rowIndex + '">-</button></td>',
          ...row.map((cell, columnIndex) => [
            '<td>',
            '<input data-table-cell data-row="' + rowIndex + '" data-column="' + columnIndex + '" value="' + escapeHtml(cell) + '" aria-label="Row ' + (rowIndex + 1) + ', column ' + (columnIndex + 1) + '">',
            '</td>'
          ].join('')),
          '</tr>'
        ].join('')),
        '</tbody>',
        '</table>'
      ].join('');
    }

    function renderAlignmentOptions(selected) {
      return ['none', 'left', 'center', 'right'].map((alignment) => {
        return '<option value="' + alignment + '"' + (alignment === selected ? ' selected' : '') + '>' + formatMetaValue(alignment) + '</option>';
      }).join('');
    }

    function readTableEditorData() {
      const headers = Array.from(tableEditorGrid.querySelectorAll('[data-table-header]'))
        .sort(sortByColumn)
        .map((input) => input.value);
      const alignments = Array.from(tableEditorGrid.querySelectorAll('[data-table-align]'))
        .sort(sortByColumn)
        .map((select) => normalizeAlignment(select.value));
      const rowElements = Array.from(tableEditorGrid.querySelectorAll('tbody tr'));
      const rows = rowElements.map((row) => {
        return Array.from(row.querySelectorAll('[data-table-cell]'))
          .sort(sortByColumn)
          .map((input) => input.value);
      });
      return normalizeTableData({ headers, alignments, rows });
    }

    function sortByColumn(left, right) {
      return Number(left.getAttribute('data-column')) - Number(right.getAttribute('data-column'));
    }

    function tableEditorSignature() {
      return JSON.stringify(readTableEditorData());
    }

    function focusTableCell(rowIndex, columnIndex) {
      const selector = rowIndex === 0
        ? '[data-table-header][data-column="' + columnIndex + '"]'
        : '[data-table-cell][data-row="' + (rowIndex - 1) + '"][data-column="' + columnIndex + '"]';
      const input = tableEditorGrid.querySelector(selector);
      input?.focus();
    }

    function focusFirstTableInput() {
      tableEditorGrid.querySelector('input, select')?.focus();
    }

    function openMermaidEditor(figure, source) {
      const lineRange = getEditableLineRange(figure);

      if (!lineRange) {
        return;
      }

      if (commentComposer.style.display === 'block' && commentBody.value.trim()) {
        commentBody.focus();
        return;
      }

      if (blockEditor.style.display === 'block'
        && activeBlockEdit
        && blockEditorSurface.innerHTML !== activeBlockEdit.originalHtml) {
        blockEditorSurface.focus();
        return;
      }

      if (mermaidEditor.style.display === 'block'
        && activeMermaidEdit
        && mermaidEditorSource.value !== activeMermaidEdit.originalSource) {
        mermaidEditorSource.focus();
        return;
      }

      if (tableEditor.style.display === 'block'
        && activeTableEdit
        && tableEditorSignature() !== activeTableEdit.originalSignature) {
        focusFirstTableInput();
        return;
      }

      hideCommentOverlay();
      hideSelectionPopover();
      hideComposerIfEmpty();
      hideBlockEditorIfClean();
      hideTableEditorIfClean();
      activeMermaidEdit = {
        ...lineRange,
        originalSource: source
      };
      mermaidEditorSource.value = source;
      mermaidEditorLines.textContent = 'Lines ' + lineRange.lineStart + '-' + lineRange.lineEnd;
      const rect = figure.getBoundingClientRect();
      positionFloatingElement(mermaidEditor, {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      }, 680);
      mermaidEditor.style.display = 'block';
      mermaidEditorSource.focus();
    }

    function wrapEditableBlockHtml(block, innerHtml) {
      const tag = block.tagName.toLowerCase();

      if (/^(p|h[1-6]|li|blockquote)$/.test(tag)) {
        return '<' + tag + '>' + innerHtml + '</' + tag + '>';
      }

      return '<p>' + innerHtml + '</p>';
    }

    function getEditableLineRange(block) {
      const lineStart = getSourceLine(block);

      if (!lineStart) {
        return undefined;
      }

      const sourceLineEnd = getSourceLineEnd(block);

      if (sourceLineEnd) {
        return { lineStart, lineEnd: Math.max(lineStart, sourceLineEnd) };
      }

      const nextLine = getEditableBlocks()
        .map(getSourceLine)
        .filter((line) => Number.isFinite(line) && line > lineStart)
        .sort((left, right) => left - right)[0];
      const lineEnd = Math.max(lineStart, nextLine ? nextLine - 1 : lineStart);
      return { lineStart, lineEnd };
    }

    function applyInlineFormat(format) {
      if (format === 'bold') {
        document.execCommand('bold');
      } else if (format === 'italic') {
        document.execCommand('italic');
      } else if (format === 'code') {
        document.execCommand('fontName', false, 'monospace');
      }
    }

    function applyBlockFormat(format) {
      if (format === 'h2' || format === 'h3') {
        document.execCommand('formatBlock', false, format);
      } else {
        document.execCommand('formatBlock', false, 'p');
      }
    }

    function hideBlockEditor() {
      blockEditor.style.display = 'none';
      blockEditorSurface.innerHTML = '';
      activeBlockEdit = undefined;
    }

    function hideBlockEditorIfClean() {
      if (blockEditor.style.display !== 'block') {
        return;
      }

      if (activeBlockEdit && blockEditorSurface.innerHTML !== activeBlockEdit.originalHtml) {
        return;
      }

      hideBlockEditor();
    }

    function hideMermaidEditor() {
      mermaidEditor.style.display = 'none';
      mermaidEditorSource.value = '';
      activeMermaidEdit = undefined;
    }

    function hideMermaidEditorIfClean() {
      if (mermaidEditor.style.display !== 'block') {
        return;
      }

      if (activeMermaidEdit && mermaidEditorSource.value !== activeMermaidEdit.originalSource) {
        return;
      }

      hideMermaidEditor();
    }

    function hideTableEditor() {
      tableEditor.style.display = 'none';
      tableEditorGrid.innerHTML = '';
      activeTableEdit = undefined;
    }

    function hideTableEditorIfClean() {
      if (tableEditor.style.display !== 'block') {
        return;
      }

      if (activeTableEdit && tableEditorSignature() !== activeTableEdit.originalSignature) {
        return;
      }

      hideTableEditor();
    }

    function decorateReviewAnchors(threads) {
      for (const thread of threads) {
        const anchorText = normalizeInline(thread.anchor?.text || '');

        if (!anchorText || anchorText.length < 2 || looksLikeMermaidSource(anchorText)) {
          continue;
        }

        highlightTextNode(thread, anchorText)
          || highlightContainingBlock(thread, anchorText)
          || highlightContextBlock(thread, anchorText)
          || highlightMarkerBlock(thread);
      }
    }

    function highlightTextNode(thread, anchorText) {
      const walker = document.createTreeWalker(markdownBody, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;

          if (!parent || shouldSkipHighlightParent(parent)) {
            return NodeFilter.FILTER_REJECT;
          }

          return node.nodeValue && normalizeInline(node.nodeValue).includes(anchorText)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        }
      });
      let remaining = getAnchorOccurrence(thread);
      let node = walker.nextNode();

      while (node?.nodeValue) {
        const normalizedNode = normalizeInline(node.nodeValue);
        let searchStart = 0;
        let index = normalizedNode.indexOf(anchorText, searchStart);

        while (index >= 0) {
          if (remaining > 0) {
            remaining -= 1;
            searchStart = index + anchorText.length;
            index = normalizedNode.indexOf(anchorText, searchStart);
            continue;
          }

          const rawIndex = findRawIndexForNormalizedText(node.nodeValue, anchorText, index);

          if (rawIndex < 0) {
            return false;
          }

          const matchLength = findRawLengthForNormalizedText(node.nodeValue.slice(rawIndex), anchorText);

          if (matchLength <= 0) {
            return false;
          }

          const matchNode = node.splitText(rawIndex);
          const afterNode = matchNode.splitText(matchLength);
          const marker = document.createElement('span');
          marker.className = 'review-anchor ' + sourceClass(thread);
          marker.dataset.threadId = thread.id;
          marker.title = sourceLabel(thread) + ' comment';
          marker.textContent = matchNode.nodeValue;

          const badge = createReviewBadge(thread, '', sourceBadgeLabel(thread));
          marker.appendChild(badge);
          matchNode.parentNode?.insertBefore(marker, matchNode);
          matchNode.remove();
          afterNode.parentElement?.normalize();
          setAnchorState(thread, 'exact', marker);
          reportLocatedAnchor(marker, thread, 'exact');
          return true;
        }

        node = walker.nextNode();
      }

      return false;
    }

    function highlightContainingBlock(thread, anchorText) {
      const candidates = Array.from(markdownBody.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote'));
      let remaining = getAnchorOccurrence(thread);
      let target;

      for (const element of candidates) {
        if (shouldSkipHighlightParent(element) || !normalizeInline(element.textContent || '').includes(anchorText)) {
          continue;
        }

        if (remaining > 0) {
          remaining -= 1;
          continue;
        }

        target = element;
        break;
      }

      if (!target) {
        return false;
      }

      attachThreadToAnchorElement(target, thread, 'review-block-badge', 'exact');
      return true;
    }

    function highlightContextBlock(thread, anchorText) {
      const candidates = Array.from(markdownBody.querySelectorAll('[data-source-line], p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote'));
      let best;
      let bestScore = 0;

      for (const element of candidates) {
        if (shouldSkipHighlightParent(element)) {
          continue;
        }

        const score = scoreAnchorCandidate(element, thread, anchorText);

        if (score > bestScore) {
          best = element;
          bestScore = score;
        }
      }

      if (!best || bestScore < 3) {
        return false;
      }

      attachThreadToAnchorElement(
        best,
        thread,
        'review-block-badge',
        bestScore >= 6 ? 'recovered' : 'approximate'
      );
      return true;
    }

    function scoreAnchorCandidate(element, thread, anchorText) {
      const text = normalizeInline(getElementContextText(element));
      const before = normalizeInline(thread.anchor?.contextBefore || '');
      const after = normalizeInline(thread.anchor?.contextAfter || '');
      let score = 0;

      if (anchorText) {
        const overlap = tokenOverlapRatio(anchorText, text);

        if (overlap >= 0.55) {
          score += 4 * overlap;
        }
      }

      if (before && contextMatches(text, before, 'tail')) {
        score += 3;
      }

      if (after && contextMatches(text, after, 'head')) {
        score += 3;
      }

      const sourceLine = Number(element.getAttribute('data-source-line'));
      const lineHint = Number(markerLineHints[thread.id]);

      if (Number.isFinite(sourceLine) && Number.isFinite(lineHint)) {
        const distance = Math.abs(sourceLine - lineHint);
        score += Math.max(0, 1.5 - Math.min(distance, 30) / 20);
      }

      return score;
    }

    function getElementContextText(element) {
      return [
        element.previousElementSibling?.textContent || '',
        element.textContent || '',
        element.nextElementSibling?.textContent || ''
      ].join(' ');
    }

    function contextMatches(haystack, context, edge) {
      return contextSnippets(context, edge).some((snippet) => haystack.includes(snippet));
    }

    function contextSnippets(context, edge) {
      const normalized = normalizeInline(context);
      const lengths = [90, 60, 36, 24];

      return lengths
        .filter((length) => normalized.length >= length)
        .map((length) => edge === 'tail'
          ? normalized.slice(normalized.length - length)
          : normalized.slice(0, length));
    }

    function tokenOverlapRatio(needle, haystack) {
      const needleTokens = uniqueTokens(needle);

      if (needleTokens.length === 0) {
        return 0;
      }

      const haystackTokens = new Set(uniqueTokens(haystack));
      const matches = needleTokens.filter((token) => haystackTokens.has(token)).length;
      return matches / needleTokens.length;
    }

    function uniqueTokens(value) {
      return Array.from(new Set(
        normalizeInline(value)
          .split(/[^\\p{L}\\p{N}_-]+/u)
          .filter((token) => token.length >= 4)
      ));
    }

    function highlightMarkerBlock(thread) {
      const lineHint = Number(markerLineHints[thread.id]);

      if (!Number.isFinite(lineHint)) {
        return false;
      }

      const candidates = Array.from(markdownBody.querySelectorAll('[data-source-line]'));
      let target;
      let targetLine = 0;

      for (const element of candidates) {
        if (shouldSkipHighlightParent(element)) {
          continue;
        }

        const sourceLine = Number(element.getAttribute('data-source-line'));

        if (!Number.isFinite(sourceLine) || sourceLine > lineHint || sourceLine < targetLine) {
          continue;
        }

        target = element;
        targetLine = sourceLine;
      }

      if (!target) {
        return false;
      }

      attachThreadToAnchorElement(target, thread, 'review-block-badge', 'approximate');
      return true;
    }

    function attachThreadToAnchorElement(element, thread, badgeClass, anchorState) {
      element.classList.add('review-anchor-block');
      element.title = sourceLabel(thread) + ' comment';

      const existingIds = getThreadIds(element);
      const nextIds = existingIds.includes(thread.id) ? existingIds : [...existingIds, thread.id];
      element.dataset.threadId = nextIds[0];
      element.dataset.threadIds = nextIds.join(',');

      let badge = element.querySelector(':scope > .review-badge');

      if (!badge) {
        badge = createReviewBadge(thread, badgeClass);
        element.appendChild(badge);
      }

      badge.dataset.threadId = nextIds[0];
      badge.dataset.threadIds = element.dataset.threadIds;
      syncSourceClasses(element, badge, nextIds);
      setAnchorState(thread, anchorState, element);
      reportLocatedAnchor(element, thread, anchorState);
    }

    function reportLocatedAnchor(element, thread, confidence) {
      const sourceLine = getSourceLine(element);

      if (!Number.isFinite(sourceLine) || sourceLine < 1) {
        return;
      }

      vscode.postMessage({
        type: 'anchorLocated',
        threadId: thread.id,
        sourceLine,
        confidence,
        documentVersion
      });
    }

    function decorateMermaidReviewBadges(threads) {
      const figures = Array.from(document.querySelectorAll('[data-mermaid-diagram]'));

      for (const figure of figures) {
        const source = normalizeInline(getMermaidSource(figure));
        const matches = threads.filter((thread) => {
          const anchorText = normalizeInline(thread.anchor?.text || '');
          return anchorText && (anchorText === source || source.includes(anchorText) || anchorText.includes(source));
        });

        if (matches.length === 0) {
          continue;
        }

        figure.classList.add('has-review');
        figure.dataset.threadId = matches[0].id;
        figure.dataset.threadIds = matches.map((thread) => thread.id).join(',');
        const actions = figure.querySelector('.mermaid-actions');
        const badge = createReviewBadge(matches[0], 'mermaid-review-badge', matches.length === 1 ? sourceBadgeLabel(matches[0]) : String(matches.length));
        syncSourceClasses(figure, badge, matches.map((thread) => thread.id));
        actions?.prepend(badge);
        for (const thread of matches) {
          setAnchorState(thread, 'exact', figure);
          reportLocatedAnchor(figure, thread, 'exact');
        }
      }
    }

    function createReviewBadge(thread, extraClass, label) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = ('review-badge ' + sourceClass(thread) + ' ' + extraClass).trim();
      badge.title = sourceLabel(thread) + ' comment';
      badge.textContent = label || '1';
      badge.dataset.threadId = thread.id;
      return badge;
    }

    function attachRelatedThreadIds(threads) {
      const anchors = Array.from(markdownBody.querySelectorAll('.review-anchor, .review-anchor-block'));

      for (const anchor of anchors) {
        const baseThread = findThread(anchor.dataset.threadId);
        const relatedThreads = getRelatedThreads(baseThread, threads);

        if (relatedThreads.length === 0) {
          continue;
        }

        const nextIds = [
          ...getThreadIds(anchor),
          ...relatedThreads.map((thread) => thread.id)
        ].filter((threadId, index, threadIds) => threadIds.indexOf(threadId) === index);

        anchor.dataset.threadId = nextIds[0];
        anchor.dataset.threadIds = nextIds.join(',');
        const badge = anchor.querySelector('.review-badge');

        if (badge) {
          badge.dataset.threadId = nextIds[0];
          badge.dataset.threadIds = anchor.dataset.threadIds;
          syncSourceClasses(anchor, badge, nextIds);
        }

        const anchorState = getAnchorElementState(anchor);

        for (const relatedThread of relatedThreads) {
          setAnchorState(relatedThread, anchorState, anchor);
          reportLocatedAnchor(anchor, relatedThread, anchorState);
        }
      }
    }

    function getRelatedThreads(baseThread, threads) {
      if (!baseThread) {
        return [];
      }

      const baseText = normalizeInline(baseThread.anchor?.text || '');

      return threads.filter((thread) => {
        const anchorText = normalizeInline(thread.anchor?.text || '');
        return anchorText && anchorText === baseText;
      });
    }

    function setAnchorState(thread, state, anchorElement) {
      const threadCard = document.querySelector('.thread[data-thread-id="' + cssEscape(thread.id) + '"]');

      if (!threadCard) {
        return;
      }

      const current = threadCard.dataset.anchorState || '';

      if (anchorStateRank(current) >= anchorStateRank(state)) {
        return;
      }

      const classNames = ['anchor-exact', 'anchor-recovered', 'anchor-approximate', 'anchor-missing'];
      threadCard.dataset.anchorState = state;
      threadCard.classList.remove(...classNames);
      threadCard.classList.add('anchor-' + state);
      const label = threadCard.querySelector('[data-anchor-state]');

      if (label) {
        label.classList.remove(...classNames);
        label.classList.add('anchor-' + state);
        label.textContent = anchorStateLabel(state);
      }

      if (anchorElement) {
        anchorElement.classList.remove(...classNames);
        anchorElement.classList.add('anchor-' + state);
      }
    }

    function markMissingAnchors(threads) {
      for (const thread of threads) {
        const threadCard = document.querySelector('.thread[data-thread-id="' + cssEscape(thread.id) + '"]');

        if (!threadCard?.dataset.anchorState) {
          setAnchorState(thread, 'missing');
        }
      }
    }

    function anchorStateRank(state) {
      if (state === 'exact') {
        return 4;
      }

      if (state === 'recovered') {
        return 3;
      }

      if (state === 'approximate') {
        return 2;
      }

      if (state === 'missing') {
        return 1;
      }

      return 0;
    }

    function anchorStateLabel(state) {
      if (state === 'exact') {
        return 'Located';
      }

      if (state === 'recovered') {
        return 'Recovered';
      }

      if (state === 'approximate') {
        return 'Approximate';
      }

      return 'Needs re-anchor';
    }

    function getAnchorElementState(element) {
      if (element.classList.contains('anchor-exact')) {
        return 'exact';
      }

      if (element.classList.contains('anchor-recovered')) {
        return 'recovered';
      }

      if (element.classList.contains('anchor-approximate')) {
        return 'approximate';
      }

      return 'missing';
    }

    function syncSourceClasses(anchor, badge, threadIds) {
      const threads = threadIds.map(findThread).filter(Boolean);
      const source = aggregateSource(threads);
      const classNames = ['source-human', 'source-ai', 'source-mixed'];

      anchor.classList.remove(...classNames);
      badge.classList.remove(...classNames);
      anchor.classList.add(source.cssClass);
      badge.classList.add(source.cssClass);
      badge.textContent = threadIds.length === 1 ? source.label : String(threadIds.length);
      badge.title = threadIds.length === 1
        ? source.label + ' comment'
        : source.label + ' comments';
    }

    function aggregateSource(threads) {
      const sourceKinds = Array.from(new Set(threads.map(sourceKind)));

      if (sourceKinds.length === 1) {
        return sourceDisplay(sourceKinds[0]);
      }

      return sourceDisplay('mixed');
    }

    function sourceKind(thread) {
      const source = String(thread?.source || 'human');
      return source === 'human' ? 'human' : 'ai';
    }

    function sourceDisplay(kind) {
      if (kind === 'human') {
        return { label: 'You', cssClass: 'source-human' };
      }

      if (kind === 'mixed') {
        return { label: 'Mixed', cssClass: 'source-mixed' };
      }

      return { label: 'AI', cssClass: 'source-ai' };
    }

    function sourceClass(thread) {
      return sourceDisplay(sourceKind(thread)).cssClass;
    }

    function sourceLabel(thread) {
      return sourceDisplay(sourceKind(thread)).label;
    }

    function sourceBadgeLabel(thread) {
      return sourceLabel(thread);
    }

    function renderSourceChip(thread) {
      return '<span class="source-chip ' + sourceClass(thread) + '">' + escapeHtml(sourceLabel(thread)) + '</span>';
    }

    function renderMetaChip(label, value) {
      return '<span class="meta-chip">' + escapeHtml(label) + ': ' + escapeHtml(formatMetaValue(value)) + '</span>';
    }

    function renderHistoryAnchorChip(state) {
      return '<span class="anchor-state-chip history-' + escapeHtml(state) + '">' + escapeHtml(historyAnchorLabel(state)) + '</span>';
    }

    function historyAnchorLabel(state) {
      return state === 'linked' ? 'Linked' : 'Outdated';
    }

    function formatMetaValue(value) {
      return String(value || '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (character) => character.toUpperCase());
    }

    function isReviewUpdateReply(reply) {
      const text = String(reply?.text || '');
      return text.startsWith('Review update:') || text.startsWith('Edit outcome:');
    }

    function formatReplyText(text) {
      const value = String(text || '');

      if (value === 'Edit outcome: applied the suggested Markdown edit and refreshed this thread anchor.') {
        return 'Review update: applied the suggested edit and kept this thread attached.';
      }

      if (value === 'Edit outcome: rewrote overlapping Markdown through the review-aware edit pipeline and refreshed this thread anchor.') {
        return 'Review update: rewrote the reviewed text and kept this comment attached.';
      }

      if (value === 'Edit outcome: edited overlapping Mermaid source through the review-aware edit pipeline and refreshed this thread anchor.') {
        return 'Review update: edited the Mermaid source and kept this comment attached.';
      }

      if (value === 'Edit outcome: edited overlapping Markdown through the review-aware edit pipeline and refreshed this thread anchor.') {
        return 'Review update: edited the reviewed text and kept this comment attached.';
      }

      return value;
    }

    function replyRoleKind(reply) {
      if (isReviewUpdateReply(reply)) {
        return 'mixed';
      }

      return String(reply?.role || 'user') === 'assistant' ? 'ai' : 'human';
    }

    function replyRoleClass(reply) {
      return sourceDisplay(replyRoleKind(reply)).cssClass;
    }

    function replyRoleLabel(reply) {
      if (isReviewUpdateReply(reply)) {
        return 'Review';
      }

      return sourceDisplay(replyRoleKind(reply)).label;
    }

    function renderReplyRoleChip(reply) {
      return '<span class="source-chip ' + replyRoleClass(reply) + '">' + escapeHtml(replyRoleLabel(reply)) + '</span>';
    }

    function getThreadIds(element) {
      const encodedIds = element.getAttribute('data-thread-ids');

      if (encodedIds) {
        return encodedIds.split(',').map((value) => value.trim()).filter(Boolean);
      }

      const threadId = element.getAttribute('data-thread-id');
      return threadId ? [threadId] : [];
    }

    function findThread(threadId) {
      return openThreads.find((thread) => thread.id === threadId);
    }

    function openCommentOverlay(threadIds, sourceElement) {
      const threads = threadIds.map(findThread).filter(Boolean);

      if (threads.length === 0) {
        hideCommentOverlay();
        return;
      }

      commentOverlay.innerHTML = threads.map(renderCommentOverlayItem).join('');
      commentOverlay.dataset.threadIds = threads.map((thread) => thread.id).join(',');
      const rect = sourceElement.getBoundingClientRect();
      positionFloatingElement(commentOverlay, {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      }, 360);
      commentOverlay.style.display = 'block';
    }

    function renderCommentOverlayItem(thread) {
      return [
        '<section class="comment-overlay-item ' + sourceClass(thread) + '" data-thread-id="' + escapeHtml(thread.id) + '">',
        '<div class="comment-overlay-meta">',
        renderSourceChip(thread),
        renderMetaChip('Type', thread.type || 'note'),
        renderMetaChip('Severity', thread.severity || 'medium'),
        renderMetaChip('Status', thread.status || 'open'),
        '</div>',
        '<p class="comment-overlay-comment">' + escapeHtml(thread.comment || '') + '</p>',
        renderSuggestedPatch(thread),
        renderReplies(thread),
        renderReplyForm(thread),
        '<div class="comment-overlay-actions">',
        '<button class="secondary compact" title="Agree with this feedback and close the thread." data-thread-id="' + escapeHtml(thread.id) + '" data-overlay-status="accepted">Accept</button>',
        '<button class="secondary compact" title="Close because the underlying issue has been handled." data-thread-id="' + escapeHtml(thread.id) + '" data-overlay-status="resolved">Resolve</button>',
        '<button class="secondary compact" title="Decline this recommendation and close the thread." data-thread-id="' + escapeHtml(thread.id) + '" data-overlay-status="rejected">Reject</button>',
        '</div>',
        '</section>'
      ].join('');
    }

    function renderSuggestedPatch(thread) {
      const patch = thread.suggestedPatch;

      if (!patch || patch.mode !== 'replace') {
        return '';
      }

      return [
        '<details class="suggested-patch">',
        '<summary>Suggested edit</summary>',
        '<pre><code>- ' + escapeHtml(patch.original || '') + '\\n+ ' + escapeHtml(patch.replacement || '') + '</code></pre>',
        '<div class="suggested-patch-actions">',
        '<button type="button" class="compact" title="Apply this replacement and close the thread as accepted." data-thread-id="' + escapeHtml(thread.id) + '" data-apply-suggested-patch>Apply Edit</button>',
        '</div>',
        '</details>'
      ].join('');
    }

    function renderReplies(thread) {
      const replies = Array.isArray(thread.thread) ? thread.thread : [];

      if (replies.length === 0) {
        return '';
      }

      return [
        '<div class="reply-list">',
        ...replies.map((reply) => [
          '<div class="reply-item ' + replyRoleClass(reply) + '">',
          '<div class="reply-meta">' + renderReplyRoleChip(reply) + '<span>' + escapeHtml(formatDate(reply.createdAt)) + '</span></div>',
          '<p class="reply-text">' + escapeHtml(formatReplyText(reply.text || '')) + '</p>',
          '</div>'
        ].join('')),
        '</div>'
      ].join('');
    }

    function renderReplyForm(thread) {
      return [
        '<form class="reply-form" data-reply-form data-thread-id="' + escapeHtml(thread.id) + '">',
        '<textarea placeholder="Reply to this thread"></textarea>',
        '<div class="reply-actions">',
        '<button type="submit" class="compact">Reply</button>',
        '</div>',
        '</form>'
      ].join('');
    }

    function formatDate(value) {
      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return '';
      }

      return date.toLocaleString();
    }

    function timestamp(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? 0 : date.getTime();
    }

    function hideCommentOverlay() {
      commentOverlay.style.display = 'none';
      commentOverlay.innerHTML = '';
      delete commentOverlay.dataset.threadIds;
    }

    function restorePreviewState() {
      const focusThreadId = String(restoreState.focusThreadId || '');
      const overlayThreadIds = Array.isArray(restoreState.overlayThreadIds)
        ? restoreState.overlayThreadIds.map(String).filter(Boolean)
        : [];

      if (focusThreadId) {
        focusThread(focusThreadId, overlayThreadIds.length === 0);
      }

      if (overlayThreadIds.length > 0) {
        const sourceElement = findOverlaySourceElement(overlayThreadIds[0]);

        if (sourceElement) {
          openCommentOverlay(overlayThreadIds, sourceElement);
          focusThread(focusThreadId || overlayThreadIds[0], false);
        }
      }

      const replyThreadId = String(restoreState.replyThreadId || focusThreadId || overlayThreadIds[0] || '');

      if (replyThreadId) {
        focusReplyInput(replyThreadId);
      }
    }

    function findOverlaySourceElement(threadId) {
      const badge = markdownBody.querySelector('.review-badge[data-thread-id="' + cssEscape(threadId) + '"]');

      if (badge) {
        return badge;
      }

      return markdownBody.querySelector('[data-thread-id="' + cssEscape(threadId) + '"]');
    }

    function focusReplyInput(threadId) {
      const openOverlayInput = commentOverlay.style.display === 'block'
        ? commentOverlay.querySelector('[data-reply-form][data-thread-id="' + cssEscape(threadId) + '"] textarea')
        : undefined;
      const input = openOverlayInput
        || document.querySelector('.thread [data-reply-form][data-thread-id="' + cssEscape(threadId) + '"] textarea');

      input?.focus();
    }

    function focusThread(threadId, shouldScroll) {
      document.querySelectorAll('.is-active').forEach((element) => element.classList.remove('is-active'));
      document.querySelectorAll('[data-thread-id="' + cssEscape(threadId) + '"]').forEach((element) => {
        element.classList.add('is-active');
      });

      if (!shouldScroll) {
        return;
      }

      const threadCard = document.querySelector('.thread[data-thread-id="' + cssEscape(threadId) + '"]');
      threadCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function focusAnchor(threadId) {
      document.querySelectorAll('.is-active').forEach((element) => element.classList.remove('is-active'));
      document.querySelectorAll('[data-thread-id="' + cssEscape(threadId) + '"]').forEach((element) => {
        element.classList.add('is-active');
      });

      const anchor = markdownBody.querySelector('[data-thread-id="' + cssEscape(threadId) + '"]');

      if (anchor) {
        anchor.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        return;
      }

      const threadCard = document.querySelector('.thread[data-thread-id="' + cssEscape(threadId) + '"]');
      threadCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function focusHistoryAnchor(thread) {
      document.querySelectorAll('.is-active').forEach((element) => element.classList.remove('is-active'));
      document.querySelectorAll('[data-thread-id="' + cssEscape(thread.id) + '"]').forEach((element) => {
        element.classList.add('is-active');
      });

      const anchor = findHistoryAnchorElement(thread);

      if (!anchor) {
        return;
      }

      anchor.classList.add('history-anchor-target', 'is-active');
      anchor.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }

    function findHistoryAnchorElement(thread) {
      const anchorText = normalizeInline(thread.anchor?.text || '');

      if (!anchorText) {
        return undefined;
      }

      const candidates = Array.from(markdownBody.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, [data-source-line]'));

      return candidates.find((element) => {
        return !shouldSkipHighlightParent(element)
          && normalizeInline(element.textContent || '').includes(anchorText);
      });
    }

    function shouldSkipHighlightParent(element) {
      return Boolean(element.closest('button, textarea, pre, code, .review-anchor, .comment-composer, .selection-popover, .comment-overlay, .mermaid-source'));
    }

    function normalizeInline(value) {
      return String(value).replace(/\\s+/g, ' ').trim();
    }

    function looksLikeMermaidSource(value) {
      return /\\b(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph)\\b/i.test(value);
    }

    function getAnchorOccurrence(thread) {
      const occurrence = Number(thread.anchor?.occurrence);
      return Number.isFinite(occurrence) ? Math.max(0, Math.floor(occurrence)) : 0;
    }

    function cssEscape(value) {
      return String(value).replace(/"/g, '\\\\"');
    }

    function findRawIndexForNormalizedText(rawText, normalizedNeedle, normalizedIndex) {
      let normalizedCursor = 0;
      let inWhitespace = false;

      for (let rawIndex = 0; rawIndex < rawText.length; rawIndex += 1) {
        const char = rawText[rawIndex];
        const isWhitespace = /\\s/.test(char);

        if (isWhitespace) {
          if (!inWhitespace) {
            if (normalizedCursor === normalizedIndex) {
              return rawIndex;
            }
            normalizedCursor += 1;
          }
          inWhitespace = true;
        } else {
          inWhitespace = false;
          if (normalizedCursor === normalizedIndex) {
            return rawIndex;
          }
          normalizedCursor += 1;
        }

        if (normalizedCursor > normalizedIndex + normalizedNeedle.length) {
          break;
        }
      }

      return normalizedIndex;
    }

    function findRawLengthForNormalizedText(rawText, normalizedNeedle) {
      let normalizedValue = '';

      for (let rawIndex = 0; rawIndex < rawText.length; rawIndex += 1) {
        normalizedValue = normalizeInline(rawText.slice(0, rawIndex + 1));

        if (normalizedValue.length >= normalizedNeedle.length) {
          return rawIndex + 1;
        }
      }

      return rawText.length;
    }

    function scheduleSelectionComposer(openImmediately) {
      window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(() => {
        if (commentComposer.style.display === 'block') {
          return;
        }

        const hasSelection = captureCurrentSelection();

        if (!hasSelection) {
          hideSelectionPopover();
          return;
        }

        if (openImmediately) {
          openComposer();
        } else {
          positionFloatingElement(selectionPopover, activeSelectionRect, 120);
          selectionPopover.style.display = 'block';
        }
      }, openImmediately ? 80 : 160);
    }

    function updateSelectionPopover() {
      if (commentComposer.style.display === 'block') {
        return;
      }

      if (!captureCurrentSelection()) {
        hideSelectionPopover();
        return;
      }

      positionFloatingElement(selectionPopover, activeSelectionRect, 120);
      selectionPopover.style.display = 'block';
    }

    function captureCurrentSelection() {
      const selection = window.getSelection();

      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return false;
      }

      const selectedText = String(selection).trim();

      if (!selectedText) {
        return false;
      }

      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;

      if (!container || !markdownBody.contains(container)) {
        return false;
      }

      const rect = getBestSelectionRect(range);

      if (!rect || rect.width === 0 && rect.height === 0) {
        return false;
      }

      activeSelectionText = selectedText;
      activeSelectionOccurrence = countPriorOccurrences(range, selectedText);
      activeSourceLine = getSourceLine(container);
      activeSelectionRect = {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };

      return true;
    }

    function countPriorOccurrences(range, selectedText) {
      const needle = normalizeInline(selectedText);

      if (!needle) {
        return 0;
      }

      const priorRange = range.cloneRange();
      priorRange.selectNodeContents(markdownBody);
      priorRange.setEnd(range.startContainer, range.startOffset);
      return countOccurrences(normalizeInline(priorRange.toString()), needle);
    }

    function countOccurrences(haystack, needle) {
      let count = 0;
      let index = haystack.indexOf(needle);

      while (index >= 0) {
        count += 1;
        index = haystack.indexOf(needle, index + Math.max(1, needle.length));
      }

      return count;
    }

    function getBestSelectionRect(range) {
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);

      if (rects.length > 0) {
        return rects[rects.length - 1];
      }

      return range.getBoundingClientRect();
    }

    function openComposer() {
      if (!activeSelectionText || !activeSelectionRect) {
        return;
      }

      hideCommentOverlay();
      hideSelectionPopover();
      commentBody.value = '';
      positionFloatingElement(commentComposer, activeSelectionRect, 340);
      commentComposer.style.display = 'block';
      commentBody.focus();
    }

    function hideSelectionPopover() {
      selectionPopover.style.display = 'none';
    }

    function hideComposer() {
      commentComposer.style.display = 'none';
      commentBody.value = '';
    }

    function hideComposerIfEmpty(target) {
      if (commentComposer.style.display !== 'block') {
        return;
      }

      if (target?.closest?.('.comment-composer, .selection-popover')) {
        return;
      }

      if (commentBody.value.trim()) {
        return;
      }

      hideComposer();
    }

    function positionFloatingElement(element, rect, preferredWidth) {
      const margin = 12;
      const availableWidth = window.innerWidth - margin * 2;
      const width = Math.min(preferredWidth, availableWidth);
      const left = Math.max(margin, Math.min(rect.right + 8, window.innerWidth - width - margin));
      const top = Math.max(margin, Math.min(rect.top - 4, window.innerHeight - 140));

      element.style.left = left + 'px';
      element.style.top = top + 'px';
    }

    async function renderMermaidDiagrams() {
      const mermaidApi = window.mermaid;
      const containers = Array.from(document.querySelectorAll('[data-mermaid-render]'));

      if (containers.length === 0) {
        return;
      }

      if (!mermaidApi) {
        for (const container of containers) {
          showMermaidError(container, 'Mermaid runtime did not load.', container.textContent || '');
        }
        return;
      }

      const isDark = document.body.classList.contains('vscode-dark')
        || document.body.classList.contains('vscode-high-contrast');

      mermaidApi.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: isDark ? 'dark' : 'default',
        flowchart: {
          htmlLabels: false,
          useMaxWidth: true
        },
        sequence: {
          useMaxWidth: true
        },
        gantt: {
          useMaxWidth: true
        }
      });

      for (const [index, container] of containers.entries()) {
        const source = String(container.textContent || '').trim();

        try {
          const id = 'amrl-mermaid-' + index + '-' + Date.now();
          const result = await mermaidApi.render(id, source);
          container.classList.remove('is-error');
          container.innerHTML = result.svg;
          result.bindFunctions?.(container);
        } catch (error) {
          showMermaidError(container, error?.message || String(error), source);
        }
      }
    }

    function showMermaidError(container, message, source) {
      container.classList.add('is-error');
      container.innerHTML = [
        '<strong>Mermaid render error</strong>',
        '<pre>' + escapeHtml(message) + '</pre>',
        '<details open>',
        '<summary>Diagram source</summary>',
        '<pre><code>' + escapeHtml(source) + '</code></pre>',
        '</details>'
      ].join('');
    }
  </script>
</body>
</html>`;
  }

  private renderStorageWarning(documentText: string, reviewDocument: ReviewDocument): string {
    const missingMarkers = findStaleInlineAnchorMarkers(documentText, reviewDocument.threads);

    if (missingMarkers.length === 0) {
      return '';
    }

    const sidecar = missingMarkers.find(marker => marker.sidecar)?.sidecar ?? '.ai-markdown-review/documents/*.json';
    const markerLabel = missingMarkers.length === 1 ? 'anchor' : 'anchors';
    const markerIds = missingMarkers.map(marker => marker.id).join(',');

    return `<section class="storage-warning" role="status">
    <strong>Review anchors need cleanup.</strong>
    <p>This Markdown file still contains ${missingMarkers.length} stale ai-review-anchor ${markerLabel}. The matching review thread data is missing from <code>${escapeHtml(sidecar)}</code> or no longer open. Comment text cannot be rebuilt from inline anchors; restore the sidecar JSON from backup/source control, or clean the stale anchors if the comments are no longer needed.</p>
    <div class="storage-warning-actions">
      <button type="button" class="secondary compact" data-cleanup-stale-anchors data-thread-ids="${escapeHtml(markerIds)}">Clean stale anchors</button>
    </div>
  </section>`;
  }

  private getMarkerLineHints(reviewDocument: ReviewDocument): Record<string, number> {
    const hints: Record<string, number> = {};

    for (const thread of reviewDocument.threads) {
      if (thread.status !== 'open') {
        continue;
      }

      const lineHint = thread.anchor.lineEnd ?? thread.anchor.lineStart;

      if (lineHint !== undefined) {
        hints[thread.id] = Math.max(1, lineHint);
      }
    }

    return hints;
  }

  private renderErrorHtml(document: vscode.TextDocument, message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Markdown Review</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    .error {
      max-width: 760px;
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 6px;
      padding: 16px;
      background: var(--vscode-inputValidation-errorBackground);
    }
    code {
      font-family: var(--vscode-editor-font-family);
    }
  </style>
</head>
<body>
  <section class="error">
    <h2>Review data needs attention</h2>
    <p>The sidecar for <code>${escapeHtml(document.fileName)}</code> could not be loaded, so this preview is paused to avoid overwriting existing review feedback.</p>
    <p>${escapeHtml(message)}</p>
  </section>
</body>
</html>`;
  }
}

export { viewType as reviewEditorViewType };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseOccurrence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

function parseSourceLine(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.floor(value);
}

function parseDocumentVersion(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}

function parseAnchorConfidence(value: unknown): AnchorConfidence | undefined {
  if (value === 'exact'
    || value === 'recovered'
    || value === 'approximate'
    || value === 'missing'
    || value === 'ambiguous') {
    return value;
  }

  return undefined;
}

function parseReviewStatus(value: unknown): ReviewStatus | undefined {
  if (value === 'open' || value === 'accepted' || value === 'rejected' || value === 'resolved') {
    return value;
  }

  return undefined;
}

function parseThreadIds(value: unknown, fallbackThreadId: string): string[] {
  const threadIds = Array.isArray(value)
    ? value.map(threadId => String(threadId).trim()).filter(Boolean)
    : [];

  if (threadIds.length > 0) {
    return threadIds;
  }

  return fallbackThreadId ? [fallbackThreadId] : [];
}

function parseReviewAwareEditIntent(value: unknown): ReviewAwareEditIntent | undefined {
  if (value === 'manual_block_edit'
    || value === 'manual_table_edit'
    || value === 'manual_mermaid_edit'
    || value === 'rewrite_section') {
    return value;
  }

  return undefined;
}

function formatApplyPatchResult(result: ApplyPatchResult): string {
  switch (result) {
    case 'ambiguous':
      return 'Suggested edit matched multiple locations. Reply or re-anchor before applying it.';
    case 'failed':
      return 'Suggested edit could not be applied.';
    case 'lowConfidenceAnchor':
      return 'This thread needs a more reliable anchor before applying its suggested edit.';
    case 'missingPatch':
      return 'This review thread does not include an applicable suggested edit.';
    case 'originalNotFound':
      return 'Suggested edit could not find its original text in the current Markdown.';
    case 'applied':
      return 'Suggested edit applied.';
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
