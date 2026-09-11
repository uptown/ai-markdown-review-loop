import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { renderReviewableCodeFence } from './codeFenceRendering';
import { findNormalizedTextSpan } from './normalizedText';
import { renderErrorDraftScript, renderWebviewDraftScript } from './webviewDrafts';
import { renderReanchorPanel, renderReanchorScript } from './webviewReanchor';
import { resolveReanchorSelection } from './reanchorThread';
import { applyMarkdownImageSourceMapping } from './markdownImageSource';
import { createAnchor } from './anchors';
import { htmlBlockToMarkdown } from './htmlToMarkdown';
import { collectMermaidSourceBlocks, matchMermaidReviewThreadsToBlocks } from './mermaidAnchors';
import { createMermaidFenceReplacement } from './mermaidEdits';
import {
  createMarkdownImageAnchorText,
  isRemoteMarkdownImageSource,
  markdownImageReviewLabel
} from './markdownImageAnchors';
import {
  stripInlineAnchorMarkers
} from './inlineMarkers';
import { createPreviewMarkdown } from './previewMarkdown';
import { applyReviewThreadUpdatesToDocuments } from './reviewDocumentUpdates';
import { ReviewStore } from './reviewStore';
import { createLegacyReviewSidecarPayload, createPortableReviewSidecarPayload, type ReviewDocumentPair } from './reviewSidecarCodec';
import { getReviewTaskStatus } from './reviewTaskProtocol';
import {
  applyReviewAwareEditToMarkdown,
  buildReviewAwareThreadUpdates,
  createLineInsertionEditPlan,
  createLineRangeDeletePlan,
  createLineRangeEditPlan,
  ReviewAwareEditIntent,
  ReviewAwareEditPlan
} from './reviewAwareEdits';
import { createReviewAnchorIdentityKey } from './reviewAnchorIdentity';
import { getReviewHistoryAnchorLocations } from './reviewHistory';
import { ReviewUndoController } from './reviewUndo';
import { applySourceLineMapping } from './sourceMappedMarkdown';
import {
  collectMarkdownTables,
  createMarkdownTableReplacement,
  parseMarkdownTableSourceMapping
} from './tableEdits';
import { ReviewDocument, ReviewThread } from './types';
import type { ReviewSidecarSnapshot } from './reviewUndo';

const viewType = 'aiMarkdownReviewLoop.reviewEditor';
const sourceRevisionMessageTypes = new Set([
  'addComment', 'editMarkdownBlock', 'insertMarkdownBlock', 'deleteMarkdownBlock',
  'editMermaidSource', 'editMarkdownTable',
  'cleanupStaleAnchors', 'cleanupLegacyMetadata', 'convertMarkdownBlockHtml', 'reanchorThread'
]);

interface PreviewRestoreState {
  focusThreadId?: string;
  overlayThreadIds?: string[];
  mutationResults?: Record<string, { ok: boolean; error?: string }>;
}

export class ReviewEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly markdown = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false
  });
  private readonly reviewUndo: ReviewUndoController;

  private currentDocumentUri: vscode.Uri | undefined;
  private readonly refreshers = new Map<string, Set<() => Promise<void>>>();

  resetReviewUndo(documentUri: vscode.Uri): void {
    this.reviewUndo.reset(documentUri);
  }

  async refreshDocument(documentUri: vscode.Uri): Promise<void> {
    await Promise.all([...this.refreshers.get(documentUri.toString()) ?? []].map(refresh => refresh()));
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ReviewStore
  ) {
    this.reviewUndo = new ReviewUndoController(store);
    applySourceLineMapping(this.markdown);
    applyMarkdownImageSourceMapping(this.markdown);

    this.markdown.renderer.rules.image = (tokens, index, _options, env) => {
      const token = tokens[index];
      const src = token.attrGet('src') ?? '';
      const alt = token.content ?? token.attrGet('alt') ?? '';
      const title = token.attrGet('title') ?? '';
      const label = markdownImageReviewLabel({ alt, src, title });
      const anchorText = createMarkdownImageAnchorText({ alt, src, title });
      const sourceMarkdown = token.meta?.reviewSourceMarkdown ?? anchorText;
      const imageSourceAttributes = `data-image-markdown="${escapeHtml(sourceMarkdown)}" data-image-title="${escapeHtml(title)}" contenteditable="false"`;

      if (isRemoteMarkdownImageSource(src)) {
        return `<span class="markdown-image markdown-image-remote" data-markdown-image ${imageSourceAttributes} data-image-anchor="${escapeHtml(anchorText)}" data-image-src="${escapeHtml(src)}" data-image-alt="${escapeHtml(alt)}">
  <span class="markdown-image-placeholder">
    <strong>${escapeHtml(label)}</strong>
    <span>Remote image preview is blocked by default.</span>
    <a href="${escapeHtml(src)}" rel="noreferrer noopener">Open image</a>
    <button type="button" class="secondary compact" data-image-feedback>Feedback</button>
  </span>
</span>`;
      }

      const resolvedSrc = this.resolveMarkdownImageSrc(src, env);

      if (!resolvedSrc) {
        return `<span class="markdown-image markdown-image-missing" data-markdown-image ${imageSourceAttributes} data-image-anchor="${escapeHtml(anchorText)}" data-image-src="${escapeHtml(src)}" data-image-alt="${escapeHtml(alt)}">
  <span class="markdown-image-placeholder">
    <strong>${escapeHtml(label)}</strong>
    <span>Image source could not be resolved.</span>
    <button type="button" class="secondary compact" data-image-feedback>Feedback</button>
  </span>
</span>`;
      }

      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
      return `<span class="markdown-image" data-markdown-image ${imageSourceAttributes} data-image-anchor="${escapeHtml(anchorText)}" data-image-src="${escapeHtml(src)}" data-image-alt="${escapeHtml(alt)}">
  <img src="${escapeHtml(resolvedSrc)}" alt="${escapeHtml(alt)}"${titleAttribute}>
  <span class="markdown-image-actions">
    <button type="button" class="secondary compact" data-image-feedback>Feedback</button>
  </span>
</span>`;
    };

    this.markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const language = token.info.trim().split(/\s+/)[0]?.toLowerCase();

      if (language === 'mermaid') {
        return this.renderMermaidFence(token.content, token.map?.[0], token.map?.[1]);
      }

      return renderReviewableCodeFence(token.content, token.info, token.map?.[0], token.map?.[1]);
    };
  }

  dispose(): void {
    this.refreshers.clear();
  }

  getCurrentDocumentUri(): vscode.Uri | undefined {
    return this.currentDocumentUri;
  }

  private getLocalResourceRoots(documentUri: vscode.Uri): vscode.Uri[] {
    const roots = [this.context.extensionUri];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);

    if (workspaceFolder) {
      roots.push(workspaceFolder.uri);
    }

    if (documentUri.scheme === 'file') {
      roots.push(vscode.Uri.file(path.dirname(documentUri.fsPath)));
    }

    return Array.from(new Map(roots.map(root => [root.toString(), root])).values());
  }

  private resolveMarkdownImageSrc(src: string, env: unknown): string | undefined {
    const value = src.trim();

    if (!value || /^data:/i.test(value) || isRemoteMarkdownImageSource(value)) {
      return value || undefined;
    }

    const renderContext = env as { documentUri?: vscode.Uri; webview?: vscode.Webview };

    if (!renderContext.documentUri || !renderContext.webview || renderContext.documentUri.scheme !== 'file') {
      return undefined;
    }

    const withoutQuery = value.split(/[?#]/)[0] || value;
    const imagePath = decodeMarkdownImagePath(withoutQuery);

    if (/^[a-z][a-z0-9+.-]*:/i.test(imagePath) && !/^file:/i.test(imagePath)) {
      return undefined;
    }

    const imageUri = /^file:/i.test(imagePath)
      ? vscode.Uri.parse(imagePath)
      : vscode.Uri.file(path.isAbsolute(imagePath)
        ? imagePath
        : path.resolve(path.dirname(renderContext.documentUri.fsPath), imagePath));

    return renderContext.webview.asWebviewUri(imageUri).toString();
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.currentDocumentUri = document.uri;
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.getLocalResourceRoots(document.uri)
    };

    let activeMutations = 0;
    let refreshPending = false;
    let pendingRestoreState: PreviewRestoreState | undefined;
    let renderSequence = 0;
    let hasRenderedPreview = false;
    const mutationResults: NonNullable<PreviewRestoreState['mutationResults']> = {};
    const pendingRequests = new Set<string>();
    const trackedMutationTypes = new Set(['addComment', 'editComment', 'removeComment', 'restoreThread', 'editMarkdownBlock', 'insertMarkdownBlock', 'editMermaidSource', 'editMarkdownTable', 'reanchorThread']);
    const reviewCommands = new Set(['copyReviewJson']);
    const render = async (restoreState?: PreviewRestoreState) => {
      if (restoreState) pendingRestoreState = restoreState;
      if (activeMutations > 0) {
        refreshPending = true;
        return;
      }
      const sequence = ++renderSequence;
      try {
        const [reviewDocument, resolvedReviewDocument] = await this.store.withDocumentTransaction(document.uri, async () => [
          await this.store.load(document.uri), await this.store.loadResolved(document.uri)
        ]);
        if (sequence !== renderSequence || activeMutations > 0) {
          refreshPending = true;
          return;
        }
        webviewPanel.webview.html = this.renderHtml(
          webviewPanel.webview,
          document,
          reviewDocument,
          resolvedReviewDocument,
          { ...pendingRestoreState, mutationResults }
        );
        hasRenderedPreview = true;
        pendingRestoreState = undefined;
        refreshPending = false;
      } catch (error) {
        if (sequence !== renderSequence || activeMutations > 0) return;
        if (hasRenderedPreview) {
          await webviewPanel.webview.postMessage({ type: 'reviewRefreshFailed', error: formatError(error) });
        } else {
          webviewPanel.webview.html = this.renderErrorHtml(document, formatError(error));
        }
      }
    };

    const refreshers = this.refreshers.get(document.uri.toString()) ?? new Set<() => Promise<void>>();
    refreshers.add(render);
    this.refreshers.set(document.uri.toString(), refreshers);

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
    const sidecarSubscription = await this.watchReviewSidecars(document.uri, render);
    webviewPanel.onDidDispose(() => {
      refreshers.delete(render);
      if (refreshers.size === 0) this.refreshers.delete(document.uri.toString());
      changeSubscription.dispose();
      sidecarSubscription.dispose();
    });

    webviewPanel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) {
        this.currentDocumentUri = document.uri;
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async message => {
      const sourceMarkdownAtMessage = document.getText();
      const sourceVersion = parseDocumentVersion(message?.documentVersion);
      const requestId = trackedMutationTypes.has(message?.type) && typeof message?.requestId === 'string'
        ? message.requestId.slice(0, 160) : '';
      if (requestId && mutationResults[requestId]) {
        await webviewPanel.webview.postMessage({ type: 'reviewMutationResult', requestId, ...mutationResults[requestId] });
        return;
      }
      if (requestId && pendingRequests.has(requestId)) return;
      if (requestId) {
        pendingRequests.add(requestId);
        activeMutations++;
      }
      let mutationSucceeded = false;
      let mutationError = 'Save did not complete. Your draft is kept; check the notification and retry.';
      const completeRender = async (restoreState?: PreviewRestoreState) => {
        mutationSucceeded = true;
        await render(restoreState);
      };
      try {
        if (message?.type === 'refreshPreview') {
          await render();
          return;
        }
        if (reviewCommands.has(message?.type)) {
          await vscode.commands.executeCommand('aiMarkdownReviewLoop.' + message.type, document.uri);
          return;
        }
        if (sourceRevisionMessageTypes.has(message?.type)) {
          this.ensureDocumentRevision(document, sourceVersion);
        }
        if (message?.type === 'addComment') {
          const added = await this.addComment(
            document,
            String(message.anchorText ?? ''),
            typeof message.comment === 'string' ? message.comment : undefined,
            parseOccurrence(message.anchorOccurrence),
            parseSourceLine(message.sourceLine),
            parseSourceLine(message.sourceLineEnd),
            sourceVersion
          );
          if (!added) return;
          await completeRender();
        }

        if (message?.type === 'reanchorThread') {
          await this.reanchorReviewThread(document, message, sourceVersion);
          await completeRender({ focusThreadId: String(message.threadId) });
        }

        if (message?.type === 'cleanupStaleAnchors' || message?.type === 'cleanupLegacyMetadata') {
          const cleaned = await this.cleanupLegacyReviewMetadata(document, sourceVersion);

          if (!cleaned) {
            vscode.window.showWarningMessage('Legacy review metadata could not be cleaned up.');
            return;
          }

          vscode.window.showInformationMessage('Cleaned legacy inline review metadata.');
          await completeRender();
        }

        if (message?.type === 'editComment') {
          await this.store.updateComment(document.uri, String(message.threadId ?? ''), String(message.comment ?? ''), parseDocumentVersion(message.taskRevision));
          await completeRender({ focusThreadId: String(message.threadId ?? '') });
        }

        if (message?.type === 'removeComment') {
          await this.store.removeThread(document.uri, String(message.threadId ?? ''), parseDocumentVersion(message.taskRevision));
          await completeRender();
        }

        if (message?.type === 'restoreThread') {
          const threadId = String(message.threadId ?? '');

          if (!threadId) {
            vscode.window.showWarningMessage('No review thread was selected for restore.');
            return;
          }

          await this.restoreThread(document, threadId);

          vscode.window.showInformationMessage('Restored review thread to open feedback.');
          await completeRender({ focusThreadId: threadId });
        }

        if (message?.type === 'convertMarkdownBlockHtml') {
          const requestId = String(message.requestId ?? '');
          const lineStart = parseSourceLine(message.lineStart) ?? 1;

          try {
            const rawMarkdown = createMarkdownBlockReplacement(
              { html: message.html },
              document.getText(),
              lineStart
            );

            await webviewPanel.webview.postMessage({
              type: 'convertedMarkdownBlockHtml',
              requestId,
              rawMarkdown
            });
          } catch (error) {
            await webviewPanel.webview.postMessage({
              type: 'convertedMarkdownBlockHtml',
              requestId,
              error: formatError(error)
            });
          }
          return;
        }

        if (message?.type === 'editMarkdownBlock') {
          const lineStart = parseSourceLine(message.lineStart);
          const lineEnd = parseSourceLine(message.lineEnd);
          const intent = parseReviewAwareEditIntent(message.intent);

          if (!lineStart || !lineEnd || lineEnd < lineStart || !intent) {
            vscode.window.showWarningMessage('Ignored invalid Markdown block edit.');
            return;
          }

          const sourceMarkdown = sourceMarkdownAtMessage;
          const replacementMarkdown = createMarkdownBlockReplacement(message, sourceMarkdown, lineStart);

          if (!replacementMarkdown.trim()) {
            vscode.window.showWarningMessage('Markdown block edit is empty. Use Delete to remove a block.');
            return;
          }

          const plan = createLineRangeEditPlan(sourceMarkdown, {
            lineStart,
            lineEnd,
            replacement: replacementMarkdown,
            actor: 'user',
            intent
          });
          const applied = await this.applyReviewAwareEdit(document, plan, sourceMarkdownAtMessage, sourceVersion);

          if (!applied) {
            vscode.window.showWarningMessage('Markdown block edit could not be applied.');
            return;
          }

          vscode.window.showInformationMessage('Updated Markdown and refreshed affected review anchors.');
          await completeRender();
        }

        if (message?.type === 'insertMarkdownBlock') {
          const afterLine = parseSourceLine(message.afterLine);

          if (!afterLine) {
            vscode.window.showWarningMessage('Ignored invalid Markdown block insert.');
            return;
          }

          const sourceMarkdown = sourceMarkdownAtMessage;
          const replacementMarkdown = createMarkdownBlockReplacement(message, sourceMarkdown, afterLine + 1);

          if (!replacementMarkdown.trim()) {
            vscode.window.showWarningMessage('Markdown block insert is empty.');
            return;
          }

          const plan = createLineInsertionEditPlan(sourceMarkdown, {
            afterLine,
            replacement: replacementMarkdown,
            actor: 'user',
            intent: 'insert_block'
          });
          const applied = await this.applyReviewAwareEdit(document, plan, sourceMarkdownAtMessage, sourceVersion);

          if (!applied) {
            vscode.window.showWarningMessage('Markdown block insert could not be applied.');
            return;
          }

          vscode.window.showInformationMessage('Inserted Markdown block.');
          await completeRender();
        }

        if (message?.type === 'deleteMarkdownBlock') {
          const lineStart = parseSourceLine(message.lineStart);
          const lineEnd = parseSourceLine(message.lineEnd);

          if (!lineStart || !lineEnd || lineEnd < lineStart) {
            vscode.window.showWarningMessage('Ignored invalid Markdown block delete.');
            return;
          }

          const confirmed = await vscode.window.showWarningMessage(
            `Delete Markdown block lines ${lineStart}-${lineEnd}?`,
            { modal: true },
            'Delete'
          );

          if (confirmed !== 'Delete') {
            return;
          }

          const plan = createLineRangeDeletePlan(sourceMarkdownAtMessage, {
            lineStart,
            lineEnd,
            actor: 'user',
            intent: 'delete_block'
          });
          const applied = await this.applyReviewAwareEdit(document, plan, sourceMarkdownAtMessage, sourceVersion);

          if (!applied) {
            vscode.window.showWarningMessage('Markdown block could not be deleted.');
            return;
          }

          vscode.window.showInformationMessage('Deleted Markdown block and refreshed affected review anchors.');
          await completeRender();
        }

        if (message?.type === 'editMermaidSource') {
          const lineStart = parseSourceLine(message.lineStart);
          const lineEnd = parseSourceLine(message.lineEnd);
          const source = String(message.source ?? '').trim();

          if (!lineStart || !lineEnd || lineEnd < lineStart || !source) {
            vscode.window.showWarningMessage('Ignored invalid Mermaid source edit.');
            return;
          }

          const plan = createLineRangeEditPlan(sourceMarkdownAtMessage, {
            lineStart,
            lineEnd,
            replacement: createMermaidFenceReplacement(source),
            actor: 'user',
            intent: 'manual_mermaid_edit'
          });
          const applied = await this.applyReviewAwareEdit(document, plan, sourceMarkdownAtMessage, sourceVersion);

          if (!applied) {
            vscode.window.showWarningMessage('Mermaid source edit could not be applied.');
            return;
          }

          vscode.window.showInformationMessage('Updated Mermaid source and refreshed affected review anchors.');
          await completeRender();
        }

        if (message?.type === 'editMarkdownTable') {
          const lineStart = parseSourceLine(message.lineStart);
          const lineEnd = parseSourceLine(message.lineEnd);

          if (!lineStart || !lineEnd || lineEnd < lineStart) {
            vscode.window.showWarningMessage('Ignored invalid Markdown table edit.');
            return;
          }

          const tableSourceMapping = parseMarkdownTableSourceMapping(message.tableSourceMapping);
          if (!tableSourceMapping) {
            vscode.window.showWarningMessage('Table edit is stale. Reopen the table editor and retry.');
            return;
          }

          const plan = createLineRangeEditPlan(sourceMarkdownAtMessage, {
            lineStart,
            lineEnd,
            replacement: createMarkdownTableReplacement({
              headers: message.headers,
              alignments: message.alignments,
              rows: message.rows
            }),
            actor: 'user',
            intent: 'manual_table_edit',
            tableSourceMapping
          });
          const applied = await this.applyReviewAwareEdit(document, plan, sourceMarkdownAtMessage, sourceVersion);

          if (!applied) {
            vscode.window.showWarningMessage('Markdown table edit could not be applied.');
            return;
          }

          vscode.window.showInformationMessage('Updated Markdown table and refreshed affected review anchors.');
          await completeRender();
        }

        if (message?.type === 'copyDraft') {
          const text = typeof message.html === 'string'
            ? htmlBlockToMarkdown(message.html, { sourceMarkdown: String(message.sourceMarkdown ?? ''), oneBasedLineStart: 1 })
            : message.table
              ? createMarkdownTableReplacement(message.table)
              : String(message.text ?? '');
          await vscode.env.clipboard.writeText(text);
          vscode.window.showInformationMessage('Copied draft. Review the current target before pasting.');
        }

        if (message?.type === 'copyText') {
          await vscode.env.clipboard.writeText(String(message.text ?? ''));
          vscode.window.showInformationMessage('Copied Mermaid source.');
        }
      } catch (error) {
        mutationError = formatError(error);
        if (message?.type === 'convertMarkdownBlockHtml') {
          await webviewPanel.webview.postMessage({ type: 'convertedMarkdownBlockHtml', requestId: message.requestId, error: mutationError });
        }
        vscode.window.showErrorMessage(`AI Markdown Review failed: ${formatError(error)}`);
      } finally {
        if (requestId) {
          const result = mutationSucceeded ? { ok: true } : { ok: false, error: mutationError };
          mutationResults[requestId] = result;
          pendingRequests.delete(requestId);
          activeMutations--;
          const completedIds = Object.keys(mutationResults);
          for (const id of completedIds.slice(0, Math.max(0, completedIds.length - 100))) delete mutationResults[id];
          await webviewPanel.webview.postMessage({ type: 'reviewMutationResult', requestId, ...result });
          if (mutationSucceeded || refreshPending) await render();
        }
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

  private async reanchorReviewThread(
    document: vscode.TextDocument,
    message: Record<string, unknown>,
    expectedVersion: number | undefined
  ): Promise<void> {
    await this.store.withDocumentTransaction(document.uri, async () => {
      this.ensureDocumentRevision(document, expectedVersion);
      const threadId = String(message.threadId ?? '');
      const thread = (await this.store.load(document.uri)).threads.find(candidate => candidate.id === threadId);
      if (!thread || thread.status !== 'open') {
        throw new Error('This thread is no longer open. Refresh the preview before reattaching it.');
      }
      if (message.anchorIdentity !== createReviewAnchorIdentityKey(thread)) {
        throw new Error('The review location changed. Refresh the preview and choose the new target again.');
      }
      this.ensureDocumentRevision(document, expectedVersion);
      const selection = resolveReanchorSelection(document.getText(), {
        anchorText: String(message.anchorText ?? ''),
        sourceLine: parseSourceLine(message.sourceLine) ?? 0,
        sourceLineEnd: parseSourceLine(message.sourceLineEnd) ?? 0,
        contextBefore: typeof message.contextBefore === 'string' ? message.contextBefore : undefined,
        contextAfter: typeof message.contextAfter === 'string' ? message.contextAfter : undefined
      });
      const now = new Date().toISOString();
      const anchor = createAnchor(document, selection.text, {
        occurrence: selection.occurrence,
        lineHint: selection.lineStart,
        lineEndHint: selection.lineEnd
      });
      await this.store.updateThread(document.uri, thread.id, {
        anchor: { ...anchor, confidence: 'exact', lastLocatedLine: selection.lineStart, lastLocatedAt: now },

      });
    });
  }

  private async addComment(
    document: vscode.TextDocument,
    selectedText: string,
    providedComment?: string,
    anchorOccurrence?: number,
    sourceLine?: number,
    sourceLineEnd?: number,
    expectedVersion = document.version
  ): Promise<boolean> {
    const normalizedSelection = selectedText.trim();

    if (!normalizedSelection) {
      vscode.window.showWarningMessage('Select text in the review preview before adding feedback.');
      return false;
    }

    const comment = providedComment?.trim() || await vscode.window.showInputBox({
      title: 'Add Markdown review feedback',
      prompt: 'What should the agent or author do with this text?',
      placeHolder: 'Example: clarify this acceptance criterion'
    });

    if (!comment?.trim()) {
      return false;
    }

    const now = new Date().toISOString();
    const thread: ReviewThread = {
      id: `rv_${randomUUID()}`,
      documentUri: document.uri.toString(),
      anchor: createAnchor(document, normalizedSelection, {
        occurrence: anchorOccurrence,
        lineHint: sourceLine,
        lineEndHint: sourceLineEnd
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

    await this.store.withDocumentTransaction(document.uri, async () => {
      this.ensureDocumentRevision(document, expectedVersion);
      await this.store.addThread(document.uri, thread);
    });
    return true;
  }

  private async applyReviewAwareEdit(
    document: vscode.TextDocument,
    plan: ReviewAwareEditPlan,
    beforeMarkdown = document.getText(),
    expectedVersion = document.version
  ): Promise<boolean> {
    return this.store.withDocumentTransaction(document.uri, async () => {
      this.store.assertWritable(document.uri);
      if (document.version !== expectedVersion || document.getText() !== beforeMarkdown) {
        return false;
      }
      plan = { ...plan, replacement: plan.replacement.replace(/\r\n|\r|\n/g, detectLineEnding(beforeMarkdown)) };
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

      const committed = await this.commitReviewMutation(
        document,
        beforeMarkdown,
        editedMarkdown,
        beforeSnapshot,
        expectedVersion,
        appliedUpdates,
        async () => this.store.saveBoth(
          document.uri,
          appliedUpdates.reviewDocument,
          appliedUpdates.resolvedReviewDocument
        )
      );

      if (!committed) {
        return false;
      }
      return true;
    });
  }

  private async watchReviewSidecars(
    documentUri: vscode.Uri,
    render: () => Promise<void>
  ): Promise<vscode.Disposable> {
    const watchers: vscode.FileSystemWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleRender = () => {
      if (timer) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timer = undefined;
        void render();
      }, 120);
    };

    for (const uri of await this.store.getReviewStateFileUris(documentUri)) {
      if (uri.scheme !== 'file') {
        continue;
      }

      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(path.dirname(uri.fsPath), path.basename(uri.fsPath))
      );
      watcher.onDidCreate(scheduleRender);
      watcher.onDidChange(scheduleRender);
      watcher.onDidDelete(scheduleRender);
      watchers.push(watcher);
    }

    return new vscode.Disposable(() => {
      if (timer) {
        clearTimeout(timer);
      }

      for (const watcher of watchers) {
        watcher.dispose();
      }
    });
  }

  private async restoreThread(
    document: vscode.TextDocument,
    threadId: string
  ): Promise<void> {
    await this.store.restoreThread(document.uri, threadId);
  }

  private ensureDocumentRevision(document: vscode.TextDocument, expectedVersion: number | undefined): void {
    if (expectedVersion === undefined || document.version !== expectedVersion) {
      throw new Error('The Markdown document changed. Refresh the preview and retry the edit.');
    }
  }

  private async replaceDocumentMarkdown(
    document: vscode.TextDocument,
    beforeMarkdown: string,
    afterMarkdown: string,
    expectedVersion: number
  ): Promise<boolean> {
    this.store.assertWritable(document.uri);
    if (document.version !== expectedVersion || document.getText() !== beforeMarkdown) {
      return false;
    }
    afterMarkdown = afterMarkdown.replace(/\r\n|\r|\n/g, detectLineEnding(beforeMarkdown));
    if (beforeMarkdown === afterMarkdown) {
      return true;
    }

    // Limit the WorkspaceEdit to the changed span, preserving surrounding source.
    let start = 0;
    while (start < beforeMarkdown.length && start < afterMarkdown.length
      && beforeMarkdown[start] === afterMarkdown[start]) {
      start += 1;
    }
    let end = beforeMarkdown.length;
    let replacementEnd = afterMarkdown.length;
    while (end > start && replacementEnd > start
      && beforeMarkdown[end - 1] === afterMarkdown[replacementEnd - 1]) {
      end -= 1;
      replacementEnd -= 1;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(start), document.positionAt(end)),
      afterMarkdown.slice(start, replacementEnd)
    );
    return vscode.workspace.applyEdit(edit);
  }

  private async cleanupLegacyReviewMetadata(document: vscode.TextDocument, expectedVersion = document.version): Promise<boolean> {
    this.ensureDocumentRevision(document, expectedVersion);
    const beforeMarkdown = document.getText();
    return this.replaceDocumentMarkdown(document, beforeMarkdown, stripInlineAnchorMarkers(beforeMarkdown), expectedVersion);
  }

  private async commitReviewMutation(
    document: vscode.TextDocument,
    beforeMarkdown: string,
    afterMarkdown: string,
    beforeSnapshot: ReviewSidecarSnapshot,
    expectedVersion: number,
    afterDocuments: ReviewDocumentPair,
    writeSidecars: () => Promise<void>
  ): Promise<boolean> {
    // VS Code uses one EOL convention per document. Match it before computing
    // positions or registering Undo; CRLF interiors are not addressable positions.
    afterMarkdown = afterMarkdown.replace(/\r\n|\r|\n/g, detectLineEnding(beforeMarkdown));
    const documentUpdated = await this.replaceDocumentMarkdown(document, beforeMarkdown, afterMarkdown, expectedVersion);
    if (!documentUpdated) {
      return false;
    }
    const appliedVersion = document.version;
    try {
      await writeSidecars();
    } catch (error) {
      // The store owns rollback of its I/O failures and preserves external writes.
      // A second raw snapshot restore here could overwrite those newer writes.
      const rolledBack = beforeMarkdown === afterMarkdown
        || await this.replaceDocumentMarkdown(document, afterMarkdown, beforeMarkdown, appliedVersion);
      if (!rolledBack) {
        throw new Error(`Review save failed; newer Markdown changes were preserved and rollback was not applied: ${formatError(error)}`);
      }
      throw error;
    }

    if (beforeMarkdown !== afterMarkdown) {
      // saveBoth updates these documents to the committed revision/status. Match
      // its serializer without a fallible filesystem read after a successful save.
      const serialize = afterDocuments.reviewDocument.taskSchemaVersion === 2
        || afterDocuments.resolvedReviewDocument.taskSchemaVersion === 2
        ? createLegacyReviewSidecarPayload : createPortableReviewSidecarPayload;
      const bytes = new TextEncoder().encode(JSON.stringify(serialize(
        document.uri.toString(), afterDocuments.reviewDocument,
        afterDocuments.resolvedReviewDocument, afterDocuments.reviewDocument.updatedAt
      )));
      const afterSnapshot: ReviewSidecarSnapshot = {
        documents: structuredClone(afterDocuments),
        reviewUri: beforeSnapshot.reviewUri,
        resolvedUri: beforeSnapshot.resolvedUri,
        reviewBytes: bytes,
        resolvedBytes: bytes
      };
      this.reviewUndo.register(document.uri, beforeMarkdown, afterMarkdown, beforeSnapshot, afterSnapshot);
    }
    return true;
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
    const sourceLineEnding = detectLineEnding(documentText);
    const previewMarkdown = createPreviewMarkdown(stripInlineAnchorMarkers(documentText));
    const renderedMarkdown = this.markdown.render(previewMarkdown, {
      documentUri: document.uri,
      webview
    });
    const tables = collectMarkdownTables(previewMarkdown);
    const reviewActions = this.renderReviewActions(document, reviewDocument, resolvedReviewDocument);
    const storageWarning = this.renderStorageWarning(documentText, reviewDocument);
    const markerLineHints = this.getMarkerLineHints(reviewDocument);
    const historyAnchorLocations = getReviewHistoryAnchorLocations(
      previewMarkdown,
      resolvedReviewDocument.threads
    );
    const historyAnchorStates = Object.fromEntries(resolvedReviewDocument.threads.map(thread => [
      thread.id, historyAnchorLocations[thread.id] ? 'linked' : 'outdated'
    ]));
    const mermaidThreadMatchesByFigure = matchMermaidReviewThreadsToBlocks(
      collectMermaidSourceBlocks(previewMarkdown),
      reviewDocument.threads.filter(thread => thread.status === 'open')
    );
    const canEditMarkdown = document.uri.scheme === 'file';
    const mermaidScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'vendor', 'mermaid.min.js')
    );
    const state = JSON.stringify({
      threads: reviewDocument.threads,
      resolvedThreads: resolvedReviewDocument.threads,
      historyAnchorStates,
      historyAnchorLocations,
      markerLineHints,
      anchorIdentityByThreadId: Object.fromEntries(
        reviewDocument.threads.map(thread => [thread.id, createReviewAnchorIdentityKey(thread)])
      ),
      mermaidThreadMatchesByFigure,
      tables,
      canEditMarkdown,
      reviewFileState: this.store.getReviewFileState(document.uri),
      sourceLines: documentText.split(/\r\n|\r|\n/),
      sourceLineEnding,
      documentVersion: document.version,
      documentUri: document.uri.toString(),
      sourceFingerprint: createHash('sha256').update(documentText).digest('hex'),
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
      grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
      gap: 18px;
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
    #markdown-body img {
      max-width: 100%;
      height: auto;
    }
    .markdown-image {
      position: relative;
      display: inline-flex;
      max-width: 100%;
      margin: 8px 0;
      vertical-align: middle;
    }
    .markdown-image img {
      max-width: 100%;
      height: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }
    .markdown-image-actions {
      position: absolute;
      top: 8px;
      right: 8px;
      display: none;
      gap: 6px;
    }
    .markdown-image:hover .markdown-image-actions,
    .markdown-image:focus-within .markdown-image-actions {
      display: inline-flex;
    }
    .markdown-image.has-review img,
    .markdown-image.review-anchor-block img {
      border-color: #d7a100;
      box-shadow: 0 0 0 1px rgba(215, 161, 0, 0.34);
    }
    .markdown-image-placeholder {
      display: grid;
      gap: 6px;
      padding: 12px;
      border: 1px dashed var(--border);
      border-radius: 6px;
      color: var(--muted);
      background: var(--vscode-textCodeBlock-background);
    }
    .markdown-image-placeholder a {
      color: var(--vscode-textLink-foreground);
    }
    .image-review-badge {
      position: absolute;
      top: -8px;
      right: -8px;
      z-index: 1;
    }
    aside {
      align-self: start;
      position: sticky;
      top: 16px;
      max-height: calc(100vh - 32px);
      margin: 16px 16px 16px 0;
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
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
    .review-actions {
      max-width: 900px;
      margin: 0 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .review-navigation-actions,
    .review-file-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .review-navigation-actions button {
      min-width: 32px;
      font-size: 14px;
      line-height: 1;
    }
    .review-navigation-actions {
      align-items: center;
    }
    .review-position {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .review-navigation-actions button:focus-visible,
    .thread button:focus-visible,
    .review-badge:focus-visible,
    #markdown-body [tabindex="-1"]:focus-visible {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .review-file-actions {
      justify-content: flex-end;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
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
    button.compact-active {
      color: var(--buttonFg);
      background: var(--button);
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
    .thread.is-closed.closed-accepted {
      border-top: 3px solid rgba(138, 216, 63, 0.86);
    }
    .thread.is-closed.closed-resolved {
      border-top: 3px solid rgba(77, 163, 255, 0.86);
    }
    .thread.is-closed.closed-rejected {
      border-top: 3px solid rgba(255, 116, 116, 0.86);
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
    .decision-chip,
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
    .quality-warning {
      margin: 8px 0;
      border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
      border-radius: 4px;
      padding: 7px 8px;
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-editor-foreground));
      background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.12));
      font-size: 12px;
      line-height: 1.4;
    }
    .quality-warning[hidden] {
      display: none;
    }
    .decision-chip {
      border-color: var(--border);
      color: var(--muted);
    }
    .decision-chip.decision-accepted {
      border-color: rgba(138, 216, 63, 0.72);
      color: #dff9c3;
      background: rgba(138, 216, 63, 0.2);
    }
    .decision-chip.decision-resolved {
      border-color: rgba(77, 163, 255, 0.72);
      color: #d8ecff;
      background: rgba(77, 163, 255, 0.2);
    }
    .decision-chip.decision-rejected {
      border-color: rgba(255, 116, 116, 0.72);
      color: #ffd7d7;
      background: rgba(255, 116, 116, 0.18);
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
    .anchor-state-chip.edit-outcome-chip {
      border-color: rgba(77, 163, 255, 0.62);
      color: #d8ecff;
      background: rgba(77, 163, 255, 0.14);
    }
    .thread blockquote {
      margin: 8px 0;
      padding-left: 10px;
      border-left: 3px solid var(--border);
      color: var(--muted);
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
    .block-editor-status {
      min-height: 16px;
      margin-left: auto;
      color: var(--muted);
      font-size: 12px;
    }
    .block-editor-surface code {
      border-radius: 3px;
      padding: 0 3px;
      color: var(--vscode-textPreformat-foreground);
      background: var(--vscode-textCodeBlock-background);
      font-family: var(--vscode-editor-font-family);
    }
    .block-editor-surface,
    .block-editor-raw {
      box-sizing: border-box;
      width: 100%;
      min-height: 140px;
      max-height: min(420px, calc(100vh - 220px));
      overflow: auto;
      border: 0;
      padding: 12px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      outline: none;
      line-height: 1.6;
    }
    .block-editor-raw {
      display: none;
      resize: vertical;
      font-family: var(--vscode-editor-font-family);
      line-height: 1.45;
    }
    .block-editor-raw.is-visible {
      display: block;
    }
    .block-editor-surface.is-hidden {
      display: none;
    }
    .block-editor button:disabled {
      cursor: wait;
      opacity: 0.7;
    }
    .block-editor-surface:focus,
    .block-editor-raw:focus {
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
    }
    .editable-list-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: start;
    }
    .editable-list-marker {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      user-select: none;
      padding-top: 1px;
    }
    .editable-list-body {
      min-width: 0;
    }
    .editable-list-body > :first-child {
      margin-top: 0;
    }
    .editable-list-body > :last-child {
      margin-bottom: 0;
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
      top: 6px;
      right: 6px;
      display: flex;
      gap: 4px;
      padding: 2px;
      border-radius: 5px;
      background: var(--vscode-editorWidget-background);
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 5;
    }
    .editable-markdown-block:hover > .block-edit-actions,
    .editable-markdown-table:hover > .block-edit-actions,
    .block-edit-actions:focus-within {
      opacity: 1;
    }
    body.has-comment-overlay .editable-markdown-block:hover > .block-edit-actions,
    body.has-comment-overlay .editable-markdown-table:hover > .block-edit-actions,
    body.has-comment-overlay .block-edit-actions:focus-within,
    body.has-comment-overlay .block-edit-actions {
      opacity: 0;
      pointer-events: none;
    }
    .block-edit-actions button {
      border: 1px solid var(--border);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    }
    .block-edit-actions button.danger {
      color: var(--vscode-errorForeground);
      border-color: var(--vscode-errorForeground);
    }
    .table-cell-comment {
      position: absolute;
      top: 4px;
      right: 4px;
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 3;
    }
    td.reviewable-table-cell,
    th.reviewable-table-cell {
      position: relative;
    }
    td.reviewable-table-cell:hover > .table-cell-comment,
    th.reviewable-table-cell:hover > .table-cell-comment,
    .table-cell-comment:focus {
      opacity: 1;
    }
    button.danger {
      color: var(--vscode-errorForeground);
    }
    .block-editor-actions .danger {
      margin-right: auto;
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
    ::highlight(ai-review-draft-selection) {
      background: rgba(138, 216, 63, 0.34);
      color: inherit;
    }
    .draft-selection-highlight-layer {
      position: fixed;
      inset: 0;
      z-index: 12;
      pointer-events: none;
    }
    .draft-selection-highlight-rect {
      position: fixed;
      border-radius: 3px;
      background: rgba(138, 216, 63, 0.34);
      box-shadow: inset 0 -2px 0 rgba(138, 216, 63, 0.9);
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
    .draft-recovery, .review-file-status {
      border: 1px solid var(--vscode-inputValidation-warningBorder, var(--border));
      padding: 12px;
      margin-bottom: 16px;
    }
    .draft-recovery[hidden] { display: none; }
    .task-result { border-left:3px solid var(--border); padding-left:8px; }
    .draft-recovery textarea { display: block; width: 100%; min-height: 90px; margin: 8px 0; }
    .draft-recovery button { margin-right: 8px; }
    [data-save-status] { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .review-actions {
        align-items: flex-start;
        flex-direction: column;
      }
      aside {
        position: static;
        max-height: none;
        margin: 0 12px 16px;
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
      ${reviewActions}
      ${storageWarning}
      <article id="markdown-body">${renderedMarkdown}</article>
    </main>
    <aside>
      <h2>Change Requests</h2>
      ${storageWarning}
      <div id="threads"></div>
      <details class="history-heading"><summary>History</summary>
        <div id="history"></div>
      </details>
    </aside>
  </div>
  <div id="selection-popover" class="selection-popover">
    <button id="selection-comment" class="compact">Comment</button>
  </div>
  <form id="comment-composer" class="comment-composer">
    <p class="comment-composer-label">Comment on selected text</p>
    <textarea id="comment-body" aria-label="Comment on selected text" placeholder="Add feedback for this selection"></textarea>
    <p id="comment-quality-warning" class="quality-warning" hidden></p>
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
      <button type="button" class="secondary compact" id="block-editor-raw-toggle" title="Edit raw Markdown for this block">Raw</button>
      <span id="block-editor-status" class="block-editor-status" aria-live="polite"></span>
    </div>
    <div id="block-editor-surface" class="block-editor-surface" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Markdown block content"></div>
    <textarea id="block-editor-raw" class="block-editor-raw" spellcheck="false" aria-label="Raw Markdown block"></textarea>
    <div class="block-editor-actions">
      <button type="button" id="block-editor-delete" class="secondary compact danger">Delete</button>
      <button type="button" id="block-editor-cancel" class="secondary compact">Cancel</button>
      <button type="submit" id="block-editor-submit" class="compact">Save</button>
    </div>
  </form>
  <form id="mermaid-editor" class="mermaid-editor" aria-label="Mermaid source editor">
    <div class="mermaid-editor-header">
      <strong>Edit Mermaid source</strong>
      <span id="mermaid-editor-lines"></span>
    </div>
    <textarea id="mermaid-editor-source" class="mermaid-editor-source" spellcheck="false" aria-label="Mermaid source"></textarea>
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
  ${renderReanchorPanel()}
  <script nonce="${nonce}" src="${mermaidScriptUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${state};
    const canEditMarkdown = state.canEditMarkdown !== false;
    const markerLineHints = state.markerLineHints || {};
    const anchorIdentityByThreadId = state.anchorIdentityByThreadId || {};
    const markdownTables = Array.isArray(state.tables) ? state.tables : [];
    const sourceLines = Array.isArray(state.sourceLines) ? state.sourceLines : [];
    const sourceLineEnding = typeof state.sourceLineEnding === 'string' ? state.sourceLineEnding : '\\n';
    const documentVersion = Number(state.documentVersion);
    const findNormalizedTextSpan = ${findNormalizedTextSpan.toString()};
    let draftSession;
    let activeCommentEdit;
    function postReviewMessage(message) {
      if (draftSession?.submit(message)) return;
      vscode.postMessage({ ...message, documentVersion });
    }
    const restoreState = state.restoreState || {};
    const markdownBody = document.getElementById('markdown-body');
    const selectionPopover = document.getElementById('selection-popover');
    const selectionCommentButton = document.getElementById('selection-comment');
    const commentComposer = document.getElementById('comment-composer');
    const commentBody = document.getElementById('comment-body');
    const commentQualityWarning = document.getElementById('comment-quality-warning');
    const commentCancel = document.getElementById('comment-cancel');
    const commentOverlay = document.getElementById('comment-overlay');
    const blockEditor = document.getElementById('block-editor');
    const blockEditorTitle = document.getElementById('block-editor-title');
    const blockEditorLines = document.getElementById('block-editor-lines');
    const blockEditorSurface = document.getElementById('block-editor-surface');
    const blockEditorRaw = document.getElementById('block-editor-raw');
    const blockEditorRawToggle = document.getElementById('block-editor-raw-toggle');
    const blockEditorStatus = document.getElementById('block-editor-status');
    const blockEditorCancel = document.getElementById('block-editor-cancel');
    const blockEditorDelete = document.getElementById('block-editor-delete');
    const blockEditorSubmit = document.getElementById('block-editor-submit');
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
    let activeSourceLineEnd = undefined;
    let activeSelectionRect = null;
    let activeSelectionRange = null;
    let selectionTimer = undefined;
    let activeBlockEdit = undefined;
    let pendingBlockRawConversionId = '';
    let pendingBlockRawConversionHtml = '';
    let activeMermaidEdit = undefined;
    let activeTableEdit = undefined;
    const draftSelectionHighlightLayer = document.createElement('div');
    draftSelectionHighlightLayer.className = 'draft-selection-highlight-layer';
    draftSelectionHighlightLayer.hidden = true;
    document.body.appendChild(draftSelectionHighlightLayer);

    document.addEventListener('selectionchange', () => {
      scheduleSelectionComposer(false);
    });

    markdownBody.addEventListener('pointerup', () => {
      scheduleSelectionComposer(true);
    });

    markdownBody.addEventListener('keyup', () => {
      scheduleSelectionComposer(false);
    });

    window.addEventListener('scroll', () => {
      renderDraftSelectionFallbackHighlight();
    }, true);

    window.addEventListener('resize', () => {
      renderDraftSelectionFallbackHighlight();
    });

    window.addEventListener('message', (event) => {
      const message = event.data || {};

      if (message.type !== 'convertedMarkdownBlockHtml'
        || message.requestId !== pendingBlockRawConversionId) {
        return;
      }

      pendingBlockRawConversionId = '';
      blockEditorRawToggle.disabled = false;
      if (message.error) {
        setBlockEditorStatus(String(message.error));
        focusActiveBlockEditorInput();
        return;
      }
      if (serializeBlockEditorHtml() !== pendingBlockRawConversionHtml) {
        setBlockEditorStatus('The draft changed during conversion. Try Raw again to include your latest edits.');
        focusActiveBlockEditorInput();
        return;
      }
      blockEditorRaw.value = String(message.rawMarkdown || '');
      setBlockEditorRawMode(true);
      setBlockEditorStatus('');
      focusActiveBlockEditorInput();
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

    blockEditorDelete.addEventListener('click', () => {
      if (!activeBlockEdit) {
        return;
      }

      if (activeBlockEdit.mode === 'insert') {
        hideBlockEditor();
        return;
      }

      postReviewMessage({
        type: 'deleteMarkdownBlock',
        lineStart: activeBlockEdit.lineStart,
        lineEnd: activeBlockEdit.lineEnd
      });
    });

    blockEditorRawToggle.addEventListener('click', () => {
      toggleBlockEditorRawMode();
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
      activeTableEdit?.rowSources.push(null);
      renderTableEditorGrid(table);
      focusTableCell(table.rows.length, 0);
    });

    tableEditorAddColumn.addEventListener('click', () => {
      const table = readTableEditorData();
      table.headers.push('Column ' + (table.headers.length + 1));
      activeTableEdit?.columnSources.push(null);
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
          activeTableEdit?.columnSources.splice(columnIndex, 1);
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
          activeTableEdit?.rowSources.splice(rowIndex, 1);
          renderTableEditorGrid(table);
        }
      }
    });

    blockEditor.addEventListener('submit', (event) => {
      event.preventDefault();

      if (!activeBlockEdit) {
        return;
      }

      const payload = isBlockEditorRawMode()
        ? { rawMarkdown: blockEditorRaw.value }
        : { html: serializeBlockEditorHtml() };

      if (activeBlockEdit.mode === 'insert') {
        postReviewMessage({
          type: 'insertMarkdownBlock',
          afterLine: activeBlockEdit.afterLine,
          ...payload
        });
      } else {
        postReviewMessage({
          type: 'editMarkdownBlock',
          lineStart: activeBlockEdit.lineStart,
          lineEnd: activeBlockEdit.lineEnd,
          intent: activeBlockEdit.intent,
          ...payload
        });
      }
    });

    mermaidEditor.addEventListener('submit', (event) => {
      event.preventDefault();

      if (!activeMermaidEdit) {
        return;
      }

      postReviewMessage({
        type: 'editMermaidSource',
        lineStart: activeMermaidEdit.lineStart,
        lineEnd: activeMermaidEdit.lineEnd,
        source: mermaidEditorSource.value
      });
    });

    tableEditor.addEventListener('submit', (event) => {
      event.preventDefault();

      if (!activeTableEdit) {
        return;
      }

      const table = readTableEditorData();
      postReviewMessage({
        type: 'editMarkdownTable',
        lineStart: activeTableEdit.lineStart,
        lineEnd: activeTableEdit.lineEnd,
        headers: table.headers,
        alignments: table.alignments,
        rows: table.rows,
        tableSourceMapping: { rowSources: activeTableEdit.rowSources, columnSources: activeTableEdit.columnSources }
      });
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

    blockEditor.addEventListener('mousedown', (event) => {
      const target = event.target;

      if (target instanceof HTMLElement && target.closest('.block-editor-toolbar button')) {
        event.preventDefault();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!hideCommentOverlayIfClean()) {
          return;
        }
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

        if (form === commentComposer) {
          event.preventDefault();
          form.requestSubmit();
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && commentComposer.style.display === 'block') {
        event.preventDefault();
        commentComposer.requestSubmit();
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTextEntryTarget(event.target)) {
          return;
        }

        event.preventDefault();
        navigateReviewThread(event.key === 'ArrowRight' ? 1 : -1);
      }
    });

    commentComposer.addEventListener('submit', (event) => {
      event.preventDefault();
      const body = commentBody.value.trim();

      if (!body || (!activeCommentEdit && !activeSelectionText)) {
        return;
      }

      if (activeCommentEdit) {
        postReviewMessage({ type: 'editComment', threadId: activeCommentEdit.threadId, taskRevision: activeCommentEdit.revision, comment: body });
        return;
      }
      postReviewMessage({
        type: 'addComment',
        anchorText: activeSelectionText,
        anchorOccurrence: activeSelectionOccurrence,
        sourceLine: activeSourceLine,
        sourceLineEnd: activeSourceLineEnd,
        comment: body
      });
      hideSelectionPopover();
    });

    commentBody.addEventListener('input', () => {
      updateCommentQualityWarning();
    });

    document.addEventListener('click', (event) => {
      const target = event.target;

      if (!(target instanceof HTMLElement)) {
        return;
      }

      const copyJsonButton = target.closest('[data-copy-review-json]');
      if (copyJsonButton) {
        event.preventDefault();
        event.stopPropagation();
        draftSession?.collect();
        postReviewMessage({ type: 'copyReviewJson' });
        return;
      }
      const jumpButton = target.closest('[data-jump-thread]');
      if (jumpButton && target.closest('#comment-overlay')) {
        event.stopPropagation();
        focusAnchor(jumpButton.closest('[data-thread-id]')?.getAttribute('data-thread-id'));
        return;
      }
      const editCommentButton = target.closest('[data-edit-comment]');
      if (editCommentButton) {
        event.stopPropagation();
        const thread = findThread(editCommentButton.getAttribute('data-thread-id'));
        if (thread) openCommentEditor(thread);
        return;
      }
      const removeCommentButton = target.closest('[data-remove-comment]');
      if (removeCommentButton) {
        event.stopPropagation();
        const thread = findThread(removeCommentButton.getAttribute('data-thread-id'));
        if (thread) postReviewMessage({type:'removeComment',threadId:thread.id,taskRevision:thread.taskRevision,requestId:'remove-'+Date.now()+'-'+Math.random().toString(16).slice(2)});
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

      const tableCommentButton = target.closest('[data-comment-markdown-table-cell], [data-comment-markdown-table]');

      if (tableCommentButton) {
        event.preventDefault();
        event.stopPropagation();

        if (tableCommentButton.hasAttribute('data-comment-markdown-table-cell')) {
          const cell = tableCommentButton.closest('td, th');

          if (cell) {
            openComposerForTableCell(cell);
          }
        } else {
          const wrapper = tableCommentButton.closest('[data-table-edit-wrapper]');
          const table = wrapper?.querySelector('table[data-source-line]');

          if (table) {
            openComposerForTable(table);
          }
        }

        return;
      }

      const blockAddButton = target.closest('[data-add-markdown-block]');

      if (blockAddButton) {
        event.preventDefault();
        event.stopPropagation();
        const block = blockAddButton.closest('[data-source-line]');

        if (block) {
          openInsertBlockEditor(block);
        }

        return;
      }

      const blockDeleteButton = target.closest('[data-delete-markdown-block]');

      if (blockDeleteButton) {
        event.preventDefault();
        event.stopPropagation();
        const block = blockDeleteButton.closest('[data-source-line]');
        const lineRange = block ? getEditableLineRange(block) : undefined;

        if (lineRange) {
          postReviewMessage({
            type: 'deleteMarkdownBlock',
            lineStart: lineRange.lineStart,
            lineEnd: lineRange.lineEnd
          });
        }

        return;
      }

      const blockEditButton = target.closest('[data-edit-markdown-block]');

      if (blockEditButton) {
        event.preventDefault();
        event.stopPropagation();
        const block = blockEditButton.closest('[data-source-line]');

        if (block) {
          openBlockEditor(block, 'manual_block_edit');
        }

        return;
      }

      const cleanupButton = target.closest('[data-cleanup-legacy-metadata], [data-cleanup-stale-anchors]');

      if (cleanupButton) {
        event.preventDefault();
        event.stopPropagation();
        postReviewMessage({
          type: 'cleanupLegacyMetadata'
        });
        return;
      }

      const reviewNavigationButton = target.closest('[data-review-nav]');

      if (reviewNavigationButton) {
        event.preventDefault();
        event.stopPropagation();
        navigateReviewThread(reviewNavigationButton.getAttribute('data-review-nav') === 'previous' ? -1 : 1);
        return;
      }

      const restoreButton = target.closest('[data-restore-thread]');

      if (restoreButton) {
        event.preventDefault();
        event.stopPropagation();
        postReviewMessage({
          type: 'restoreThread',
          threadId: restoreButton.getAttribute('data-thread-id')
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
          openComposerForElementText(figure, source, getSourceLine(figure), getSourceLineEnd(figure));
          return;
        }

        if (target.matches('[data-mermaid-copy]')) {
          postReviewMessage({ type: 'copyText', text: source });
          return;
        }
      }

      const imageFeedbackButton = target.closest('[data-image-feedback]');

      if (imageFeedbackButton) {
        event.preventDefault();
        event.stopPropagation();
        const image = imageFeedbackButton.closest('[data-markdown-image]');

        if (image) {
          openComposerForElementText(image, getImageReviewAnchor(image), getSourceLine(image), getSourceLineEnd(image));
        }

        return;
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

      hideCommentOverlayIfClean();
    });

    const openThreads = state.threads.filter((thread) => thread.status === 'open');
    const closedThreads = (state.resolvedThreads || [])
      .filter((thread) => thread.status !== 'open')
      .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
    const historyAnchorStates = state.historyAnchorStates || {};
    const threadsContainer = document.getElementById('threads');
    const historyContainer = document.getElementById('history');

    if (openThreads.length === 0) {
      threadsContainer.innerHTML = closedThreads.length > 0
        ? '<p class="empty">No pending requests. Review the revised document again.</p>'
        : '<p class="empty">Select text in the document to add a change request.</p>';
    } else {
      for (const thread of openThreads) {
        const element = document.createElement('section');
        element.className = 'thread ' + sourceClass(thread);
        element.dataset.threadId = thread.id;
        element.title = 'Jump to commented content';
        element.innerHTML = [
          '<header><span class="thread-meta">' + renderTaskStatus(thread) + '<span class="anchor-state-chip" data-anchor-state>Locating</span></span></header>',
          '<blockquote>' + escapeHtml(thread.anchor.text || 'Document') + '</blockquote>',
          '<p>' + escapeHtml(thread.comment) + '</p>',
          renderTaskResult(thread),
          renderThreadActions(thread)
        ].join('');

        element.addEventListener('click', (event) => {
          if (event.target instanceof HTMLElement && event.target.closest('button, textarea, form')) {
            return;
          }

          focusAnchor(thread.id);
        });

        element.querySelector('[data-jump-thread]')?.addEventListener('click', (event) => {
          event.stopPropagation();
          focusAnchor(thread.id);
        });

        threadsContainer.appendChild(element);
      }
    }

    const locatableOpenThreads = openThreads.filter(shouldAutoLocateThread);
    renderClosedHistory(closedThreads);
    decorateImageReviewBadges(locatableOpenThreads);
    decorateReviewAnchors(locatableOpenThreads);
    decorateMermaidReviewBadges(locatableOpenThreads);
    attachRelatedThreadIds(locatableOpenThreads);
    markMissingAnchors(openThreads);
    updateReviewNavigation();
    if (canEditMarkdown) {
      decorateEditableMarkdownBlocks();
      decorateEditableMarkdownTables();
    }
    restorePreviewState();
    ${renderWebviewDraftScript()}
    renderMermaidDiagrams();

    function renderClosedHistory(threads) {
      if (threads.length === 0) {
        historyContainer.innerHTML = '<p class="empty">No history for this round.</p>';
        return;
      }

      historyContainer.innerHTML = '';

      for (const thread of threads) {
        const historyState = historyAnchorStates[thread.id] === 'linked' ? 'linked' : 'outdated';
        const element = document.createElement('section');
        element.className = [
          'thread',
          'is-closed',
          'history-' + historyState,
          'closed-' + String(thread.status || 'resolved'),
          sourceClass(thread)
        ].join(' ');
        element.dataset.threadId = thread.id;
        element.title = historyState === 'linked'
          ? 'Closed thread. Click to jump to the matching content.'
          : 'Closed thread. The original anchor text no longer appears in this document.';
        element.innerHTML = [
          '<header><span class="thread-meta">' + renderTaskStatus(thread) + renderHistoryAnchorChip(historyState) + '</span></header>',
          '<blockquote>' + escapeHtml(thread.anchor.text || 'Document') + '</blockquote>',
          '<p>' + escapeHtml(thread.comment) + '</p>',
          renderTaskResult(thread),
          '<div class="thread-actions">',
          historyState === 'linked'
            ? '<button type="button" class="secondary" aria-label="Show closed comment in document: ' + escapeHtml(thread.comment) + '" data-jump-thread>Show in document</button>'
            : '',
          thread.taskStatus === 'done' ? '<button class="secondary" title="Reopen this request." data-thread-id="' + escapeHtml(thread.id) + '" data-write-action data-restore-thread>Reopen</button>' : '',
          '</div>'
        ].join('');

        element.addEventListener('click', (event) => {
          if (event.target instanceof HTMLElement && event.target.closest('button, textarea, form')) {
            return;
          }

          if (historyState === 'linked') {
            focusHistoryAnchor(thread);
          }
        });

        element.querySelector('[data-jump-thread]')?.addEventListener('click', (event) => {
          event.stopPropagation();
          focusHistoryAnchor(thread);
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

    function getImageReviewAnchor(image) {
      return String(
        image?.getAttribute('data-image-anchor')
        || image?.getAttribute('data-image-alt')
        || image?.getAttribute('data-image-src')
        || ''
      ).trim();
    }

    function getSearchableElementText(element) {
      if (element?.matches?.('[data-markdown-image]')) {
        return [
          element.getAttribute('data-image-anchor') || '',
          element.getAttribute('data-image-alt') || '',
          element.getAttribute('data-image-src') || ''
        ].join(' ');
      }

      return element?.textContent || '';
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
      markdownBody.querySelectorAll('[data-mermaid-edit]').forEach((button) => {
        button.hidden = Boolean(button.closest('li, blockquote'));
      });
      const blocks = getEditableBlocks();

      for (const block of blocks) {
        if (block.querySelector(':scope > .block-edit-actions')) {
          continue;
        }

        block.classList.add('editable-markdown-block');
        const actions = document.createElement('span');
        actions.className = 'block-edit-actions';
        actions.innerHTML = [
          '<button type="button" class="secondary compact" title="Edit this block manually and keep attached comments updated" data-edit-markdown-block>Edit</button>',
          '<button type="button" class="secondary compact" title="Add a new Markdown block on a new line below this block" data-add-markdown-block>Add Below</button>',
          '<button type="button" class="secondary compact danger" title="Delete this block and keep affected comments visible" data-delete-markdown-block>Delete</button>'
        ].join('');
        block.appendChild(actions);
      }
    }

    function getEditableBlocks() {
      const selectors = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
      return Array.from(markdownBody.querySelectorAll(selectors))
        .filter((element) => element.hasAttribute('data-source-line'))
        .filter((element) => !element.parentElement?.closest('li, blockquote'))
        .filter((element) => !element.closest('pre, code, table, .mermaid-source, [data-mermaid-diagram]'));
    }

    function decorateEditableMarkdownTables() {
      const tables = Array.from(markdownBody.querySelectorAll('table[data-source-line]'))
        .filter((table) => !table.parentElement?.closest('li, blockquote'));

      for (const table of tables) {
        if (table.closest('[data-table-edit-wrapper]')) {
          decorateReviewableTableCells(table);
          continue;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'editable-markdown-table';
        wrapper.dataset.tableEditWrapper = 'true';
        table.parentNode?.insertBefore(wrapper, table);
        wrapper.appendChild(table);

        const actions = document.createElement('span');
        actions.className = 'block-edit-actions';
        actions.innerHTML = [
          '<button type="button" class="secondary compact" title="Comment on this table" data-comment-markdown-table>Comment Table</button>',
          '<button type="button" class="secondary compact" title="Edit this Markdown table as a grid" data-edit-markdown-table>Edit Table</button>'
        ].join('');
        wrapper.appendChild(actions);
        decorateReviewableTableCells(table);
      }
    }

    function decorateReviewableTableCells(table) {
      const cells = Array.from(table.querySelectorAll('th, td'));

      for (const cell of cells) {
        cell.classList.add('reviewable-table-cell');

        if (cell.querySelector(':scope > .table-cell-comment')) {
          continue;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary compact table-cell-comment';
        button.title = 'Comment on this table cell';
        button.setAttribute('data-comment-markdown-table-cell', '');
        button.textContent = 'Comment';
        cell.appendChild(button);
      }
    }

    function openComposerForTable(table) {
      const text = getCleanTableText(table);

      if (!text) {
        return;
      }

      openComposerForElementText(
        table,
        text,
        getSourceLine(table),
        getSourceLineEnd(table)
      );
    }

    function openComposerForTableCell(cell) {
      const text = getCleanTableText(cell);

      if (!text) {
        return;
      }

      openComposerForElementText(
        cell,
        text,
        getSourceLine(cell) || getSourceLine(cell.closest('tr')) || getSourceLine(cell.closest('table')),
        getSourceLineEnd(cell) || getSourceLineEnd(cell.closest('tr')) || getSourceLineEnd(cell.closest('table'))
      );
    }

    function openComposerForElementText(element, text, lineStart, lineEnd) {
      if (protectCommentDraft()) return;
      clearDraftSelectionHighlight();
      activeSelectionText = text;
      activeSelectionOccurrence = 0;
      activeSourceLine = lineStart;
      activeSourceLineEnd = lineEnd || lineStart;
      activeSelectionRange = null;

      const rect = element.getBoundingClientRect();
      activeSelectionRect = {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };
      openComposer();
    }

    function getCleanTableText(element) {
      const clone = element.cloneNode(true);
      clone.querySelectorAll('button, .table-cell-comment, .block-edit-actions, .review-badge').forEach((child) => child.remove());
      return normalizeInline(clone.textContent || '');
    }

    function openBlockEditor(block, intent) {
      const lineRange = getEditableLineRange(block);

      if (!lineRange) {
        return;
      }

      if (!prepareBlockEditor()) {
        return;
      }

      const rawMarkdown = getSourceMarkdown(lineRange);
      const clone = block.cloneNode(true);
      clone.querySelectorAll('.review-badge, .block-edit-actions').forEach((element) => element.remove());
      clone.querySelectorAll('.review-anchor').forEach((element) => {
        element.replaceWith(document.createTextNode(element.textContent || ''));
      });

      blockEditorSurface.innerHTML = wrapEditableBlockHtml(block, clone.innerHTML);
      blockEditorRaw.value = rawMarkdown;
      setBlockEditorRawMode(Boolean(block.querySelector('table, [data-mermaid-diagram]')), { force: true });
      setBlockEditorStatus('');
      activeBlockEdit = {
        ...lineRange,
        mode: 'edit',
        intent,
        originalHtml: blockEditorSurface.innerHTML,
        originalRawMarkdown: rawMarkdown
      };
      blockEditorDelete.textContent = 'Delete';
      blockEditorDelete.hidden = false;
      blockEditorSubmit.textContent = 'Save';
      blockEditorTitle.textContent = 'Edit Markdown block';
      blockEditorLines.textContent = 'Lines ' + lineRange.lineStart + '-' + lineRange.lineEnd;
      showBlockEditorNear(block);
      blockEditorSurface.focus();
    }

    function openInsertBlockEditor(block) {
      const lineRange = getEditableLineRange(block);

      if (!lineRange) {
        return;
      }

      if (!prepareBlockEditor()) {
        return;
      }

      const emptyHtml = '<p><br></p>';
      blockEditorSurface.innerHTML = emptyHtml;
      blockEditorRaw.value = '';
      setBlockEditorRawMode(Boolean(block.querySelector('table, [data-mermaid-diagram]')), { force: true });
      setBlockEditorStatus('');
      activeBlockEdit = {
        mode: 'insert',
        afterLine: lineRange.lineEnd,
        originalHtml: emptyHtml,
        originalRawMarkdown: ''
      };
      blockEditorDelete.textContent = 'Clear';
      blockEditorDelete.hidden = false;
      blockEditorSubmit.textContent = 'Add Below';
      blockEditorTitle.textContent = 'Add block below';
      blockEditorLines.textContent = 'New block after line ' + lineRange.lineEnd;
      showBlockEditorNear(block);
      blockEditorSurface.focus();
    }

    function prepareBlockEditor() {
      if (draftSession && !draftSession.canOpen('block')) return false;
      if (commentComposer.style.display === 'block' && commentBody.value.trim()) {
        commentBody.focus();
        return false;
      }

      if (mermaidEditor.style.display === 'block'
        && activeMermaidEdit
        && mermaidEditorSource.value !== activeMermaidEdit.originalSource) {
        mermaidEditorSource.focus();
        return false;
      }

      if (tableEditor.style.display === 'block'
        && activeTableEdit
        && tableEditorSignature() !== activeTableEdit.originalSignature) {
        focusFirstTableInput();
        return false;
      }

      if (blockEditor.style.display === 'block' && isBlockEditorDirty()) {
        focusActiveBlockEditorInput();
        return false;
      }

      if (!hideCommentOverlayIfClean()) {
        return false;
      }
      hideSelectionPopover();
      hideComposerIfEmpty();
      hideMermaidEditorIfClean();
      hideTableEditorIfClean();
      return true;
    }

    function showBlockEditorNear(block) {
      const rect = block.getBoundingClientRect();
      positionFloatingElement(blockEditor, {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      }, 680);
      blockEditor.style.display = 'block';
    }

    function focusActiveBlockEditorInput() {
      if (isBlockEditorRawMode()) {
        blockEditorRaw.focus();
        return;
      }

      blockEditorSurface.focus();
    }

    function getSourceMarkdown(lineRange) {
      return sourceLines
        .slice(Math.max(0, lineRange.lineStart - 1), Math.max(0, lineRange.lineEnd))
        .join(sourceLineEnding);
    }

    function toggleBlockEditorRawMode() {
      if (!activeBlockEdit) {
        return;
      }

      if (isBlockEditorRawMode()) {
        if (isBlockEditorDirty()) {
          setBlockEditorStatus('Save raw Markdown before returning to rich edit.');
          focusActiveBlockEditorInput();
          return;
        }

        setBlockEditorRawMode(false);
        setBlockEditorStatus('');
        focusActiveBlockEditorInput();
        return;
      }

      if (isBlockEditorDirty()) {
        requestRawMarkdownForBlockEditor();
        return;
      }

      setBlockEditorRawMode(true);
      setBlockEditorStatus('');
      focusActiveBlockEditorInput();
    }

    function requestRawMarkdownForBlockEditor() {
      if (!activeBlockEdit || pendingBlockRawConversionId) {
        return;
      }

      const lineStart = activeBlockEdit.mode === 'insert'
        ? activeBlockEdit.afterLine + 1
        : activeBlockEdit.lineStart;
      pendingBlockRawConversionId = 'block-raw-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      pendingBlockRawConversionHtml = serializeBlockEditorHtml();
      blockEditorRawToggle.disabled = true;
      setBlockEditorStatus('Converting to Markdown...');
      postReviewMessage({
        type: 'convertMarkdownBlockHtml',
        requestId: pendingBlockRawConversionId,
        lineStart,
        html: pendingBlockRawConversionHtml
      });
    }

    function setBlockEditorRawMode(enabled, options = {}) {
      if (!activeBlockEdit && !options.force) {
        return;
      }

      blockEditorRaw.classList.toggle('is-visible', enabled);
      blockEditorSurface.classList.toggle('is-hidden', enabled);
      blockEditorRawToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      blockEditorRawToggle.classList.toggle('compact-active', enabled);
    }

    function setBlockEditorStatus(message) {
      blockEditorStatus.textContent = message || '';
    }

    function isBlockEditorRawMode() {
      return blockEditorRaw.classList.contains('is-visible');
    }

    function isBlockEditorDirty() {
      if (!activeBlockEdit) {
        return false;
      }

      if (isBlockEditorRawMode()) {
        return blockEditorRaw.value !== activeBlockEdit.originalRawMarkdown;
      }

      return blockEditorSurface.innerHTML !== activeBlockEdit.originalHtml;
    }

    function openTableEditor(tableElement) {
      if (draftSession && !draftSession.canOpen('table')) return;
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
        && isBlockEditorDirty()) {
        focusActiveBlockEditorInput();
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
      if (!hideCommentOverlayIfClean()) {
        return;
      }
      hideSelectionPopover();
      hideComposerIfEmpty();
      hideBlockEditorIfClean();
      hideMermaidEditorIfClean();
      activeTableEdit = {
        ...lineRange,
        rowSources: table.rows.map((_, index) => index),
        columnSources: table.headers.map((_, index) => index),
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
      if (draftSession && !draftSession.canOpen('mermaid')) return;
      if (figure.parentElement?.closest('li, blockquote')) {
        return;
      }
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
        && isBlockEditorDirty()) {
        focusActiveBlockEditorInput();
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

      if (!hideCommentOverlayIfClean()) {
        return;
      }
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

      if (tag === 'li') {
        return wrapEditableListItemHtml(block, innerHtml);
      }

      if (/^(p|h[1-6]|li|blockquote)$/.test(tag)) {
        return '<' + tag + '>' + innerHtml + '</' + tag + '>';
      }

      return '<p>' + innerHtml + '</p>';
    }

    function wrapEditableListItemHtml(block, innerHtml) {
      return [
        '<div class="editable-list-item" data-editable-list-item>',
        '<span class="editable-list-marker" contenteditable="false" aria-hidden="true">',
        escapeHtml(getListMarkerLabel(block)),
        '</span>',
        '<div class="editable-list-body" data-editable-list-body>',
        innerHtml,
        '</div>',
        '</div>'
      ].join('');
    }

    function getListMarkerLabel(block) {
      const list = block.parentElement;
      const listTag = list?.tagName?.toLowerCase();

      if (listTag === 'ol') {
        const start = Number(list.getAttribute('start')) || 1;
        const itemIndex = Array.from(list.children)
          .filter((child) => child.tagName?.toLowerCase() === 'li')
          .indexOf(block);
        return String(start + Math.max(0, itemIndex)) + '.';
      }

      return '-';
    }

    function serializeBlockEditorHtml() {
      const listBody = blockEditorSurface.querySelector('[data-editable-list-body]');

      if (listBody instanceof HTMLElement) {
        return '<li>' + listBody.innerHTML + '</li>';
      }

      return blockEditorSurface.innerHTML;
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
        toggleInlineCode();
      }
    }

    function toggleInlineCode() {
      const selection = window.getSelection();

      if (!selection || selection.rangeCount === 0 || !isSelectionInsideBlockEditor(selection)) {
        blockEditorSurface.focus();
        insertInlineCodePlaceholder();
        return;
      }

      const existingCode = closestCodeElement(selection.anchorNode);

      if (existingCode && blockEditorSurface.contains(existingCode)) {
        unwrapElement(existingCode);
        return;
      }

      const range = selection.getRangeAt(0);

      if (range.collapsed) {
        insertInlineCodePlaceholder(range);
        return;
      }

      const codeElement = document.createElement('code');
      codeElement.appendChild(range.extractContents());
      range.insertNode(codeElement);
      selectNodeContents(codeElement);
    }

    function insertInlineCodePlaceholder(range = undefined) {
      const targetRange = range || document.createRange();

      if (!range) {
        targetRange.selectNodeContents(blockEditorSurface);
        targetRange.collapse(false);
      }

      const codeElement = document.createElement('code');
      codeElement.textContent = 'code';
      targetRange.insertNode(codeElement);
      selectNodeContents(codeElement);
    }

    function isSelectionInsideBlockEditor(selection) {
      return Boolean(selection.anchorNode && blockEditorSurface.contains(selection.anchorNode));
    }

    function closestCodeElement(node) {
      const element = node?.nodeType === Node.ELEMENT_NODE
        ? node
        : node?.parentElement;
      return element?.closest?.('code');
    }

    function unwrapElement(element) {
      const parent = element.parentNode;

      if (!parent) {
        return;
      }

      const fragment = document.createDocumentFragment();

      while (element.firstChild) {
        fragment.appendChild(element.firstChild);
      }

      parent.replaceChild(fragment, element);
    }

    function selectNodeContents(node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    function applyBlockFormat(format) {
      if (format === 'h2' || format === 'h3') {
        document.execCommand('formatBlock', false, format);
      } else {
        document.execCommand('formatBlock', false, 'p');
      }
    }

    function hideBlockEditor() {
      if (blockEditor.getAttribute('aria-busy') === 'true') return;
      blockEditor.style.display = 'none';
      blockEditorSurface.innerHTML = '';
      blockEditorRaw.value = '';
      pendingBlockRawConversionId = '';
      blockEditorRawToggle.disabled = false;
      setBlockEditorStatus('');
      setBlockEditorRawMode(false, { force: true });
      activeBlockEdit = undefined;
    }

    function hideBlockEditorIfClean() {
      if (blockEditor.style.display !== 'block') {
        return;
      }

      if (isBlockEditorDirty()) {
        return;
      }

      hideBlockEditor();
    }

    function hideMermaidEditor() {
      if (mermaidEditor.getAttribute('aria-busy') === 'true') return;
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
      if (tableEditor.getAttribute('aria-busy') === 'true') return;
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

        if (!anchorText
          || anchorText.length < 2
          || looksLikeMermaidSource(anchorText)
          || looksLikeMarkdownImageAnchor(anchorText)) {
          continue;
        }

        highlightTextNode(thread, anchorText)
          || highlightContainingBlock(thread, anchorText)
          || highlightContextBlock(thread, anchorText)
          || highlightMarkerBlock(thread);
      }
    }

    function shouldAutoLocateThread(thread) {
      return String(thread.anchor?.confidence || '').toLowerCase() !== 'missing';
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
      const candidates = [];
      let occurrenceIndex = 0;
      let node = walker.nextNode();

      while (node?.nodeValue) {
        const normalizedNode = normalizeInline(node.nodeValue);
        let searchStart = 0;
        let index = normalizedNode.indexOf(anchorText, searchStart);

        while (index >= 0) {
          const rawMatch = findNormalizedTextSpan(node.nodeValue, anchorText, index);

          if (!rawMatch) {
            searchStart = index + anchorText.length;
            index = normalizedNode.indexOf(anchorText, searchStart);
            continue;
          }

          const rawIndex = rawMatch.start;
          const matchLength = rawMatch.length;

          if (matchLength > 0) {
            candidates.push({
              node,
              rawIndex,
              matchLength,
              occurrenceIndex,
              element: node.parentElement
            });
          }

          occurrenceIndex += 1;
          searchStart = index + anchorText.length;
          index = normalizedNode.indexOf(anchorText, searchStart);
        }

        node = walker.nextNode();
      }

      const selected = selectTextMatchCandidate(thread, candidates, anchorText);

      if (!selected) {
        return false;
      }

      const matchNode = selected.node.splitText(selected.rawIndex);
      const afterNode = matchNode.splitText(selected.matchLength);
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
      return true;
    }

    function highlightContainingBlock(thread, anchorText) {
      const candidates = Array.from(markdownBody.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre[data-review-code-fence], [data-markdown-image]'));
      const matches = candidates.filter((element) => {
        return !shouldSkipHighlightParent(element)
          && normalizeInline(getSearchableElementText(element)).includes(anchorText);
      });
      const target = selectElementMatchCandidate(thread, matches, anchorText);

      if (!target) {
        return false;
      }

      attachThreadToAnchorElement(target, thread, 'review-block-badge', 'exact');
      return true;
    }

    function selectTextMatchCandidate(thread, candidates, anchorText) {
      if (candidates.length === 0) {
        return undefined;
      }

      if (candidates.length === 1) {
        return candidates[0];
      }

      return candidates
        .map((candidate, index) => ({
          candidate,
          index,
          score: scoreTextMatchCandidate(candidate, thread, anchorText)
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.candidate;
    }

    function selectElementMatchCandidate(thread, candidates, anchorText) {
      if (candidates.length === 0) {
        return undefined;
      }

      if (candidates.length === 1) {
        return candidates[0];
      }

      return candidates
        .map((candidate, index) => ({
          candidate,
          index,
          score: scoreElementMatchCandidate(candidate, thread, anchorText, index)
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.candidate;
    }

    function scoreTextMatchCandidate(candidate, thread, anchorText) {
      const occurrence = getAnchorOccurrence(thread);
      const occurrenceDistance = Math.abs(candidate.occurrenceIndex - occurrence);
      const element = candidate.element;
      let score = Math.max(0, 8 - occurrenceDistance);

      if (element) {
        score += scoreLineDistance(element, thread);
        score += scoreAnchorCandidate(element, thread, anchorText);
      }

      score += scoreMatchLocalContext(candidate, thread);
      return score;
    }

    function scoreElementMatchCandidate(element, thread, anchorText, occurrenceIndex) {
      const occurrence = getAnchorOccurrence(thread);
      const occurrenceDistance = Math.abs(occurrenceIndex - occurrence);
      return Math.max(0, 8 - occurrenceDistance)
        + scoreLineDistance(element, thread)
        + scoreAnchorCandidate(element, thread, anchorText);
    }

    function highlightContextBlock(thread, anchorText) {
      const candidates = Array.from(markdownBody.querySelectorAll('[data-source-line], p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, [data-markdown-image]'));
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

      score += scoreLineDistance(element, thread) / 8;

      return score;
    }

    function scoreLineDistance(element, thread) {
      const preferredLine = preferredAnchorLine(thread);

      if (!Number.isFinite(preferredLine) || preferredLine < 1) {
        return 0;
      }

      const distance = sourceLineDistance(element, preferredLine);

      if (!Number.isFinite(distance)) {
        return 0;
      }

      return distance === 0 ? 32 : Math.max(0, 12 - Math.min(distance, 12));
    }

    function preferredAnchorLine(thread) {
      return Number(thread.anchor?.lastLocatedLine || markerLineHints[thread.id] || thread.anchor?.lineStart || 0);
    }

    function scoreMatchLocalContext(candidate, thread) {
      const text = String(candidate.node?.nodeValue || '');
      const beforeText = normalizeInline(text.slice(Math.max(0, candidate.rawIndex - 140), candidate.rawIndex));
      const afterText = normalizeInline(text.slice(candidate.rawIndex + candidate.matchLength, candidate.rawIndex + candidate.matchLength + 140));
      const before = normalizeInline(thread.anchor?.contextBefore || '');
      const after = normalizeInline(thread.anchor?.contextAfter || '');
      let score = 0;

      if (before && contextMatches(beforeText, before, 'tail')) {
        score += 10;
      }

      if (after && contextMatches(afterText, after, 'head')) {
        score += 10;
      }

      return score;
    }

    function getElementContextText(element) {
      return [
        getSearchableElementText(element.previousElementSibling),
        getSearchableElementText(element),
        getSearchableElementText(element.nextElementSibling)
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
    }

    function decorateMermaidReviewBadges(threads) {
      const figures = Array.from(document.querySelectorAll('[data-mermaid-diagram]'));
      const matchesByFigure = Array.isArray(state.mermaidThreadMatchesByFigure)
        ? state.mermaidThreadMatchesByFigure
        : [];

      for (let index = 0; index < figures.length; index += 1) {
        const figure = figures[index];
        const configuredMatches = Array.isArray(matchesByFigure[index])
          ? matchesByFigure[index]
          : [];
        const matchedEntries = configuredMatches
          .map((match) => ({
            thread: threads.find((thread) => thread.id === match.threadId),
            state: match.state === 'exact' ? 'exact' : 'approximate'
          }))
          .filter((entry) => entry.thread);
        const matches = matchedEntries.map((entry) => entry.thread);

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
        for (const entry of matchedEntries) {
          setAnchorState(entry.thread, entry.state, figure);

        }
      }
    }

    function decorateImageReviewBadges(threads) {
      const images = Array.from(document.querySelectorAll('[data-markdown-image]'));

      for (const image of images) {
        const imageAnchor = normalizeInline(getImageReviewAnchor(image));
        const imageAlt = normalizeInline(image.getAttribute('data-image-alt') || '');
        const imageSrc = normalizeInline(image.getAttribute('data-image-src') || '');
        const matches = threads.filter((thread) => {
          const anchorText = normalizeInline(thread.anchor?.text || '');

          return Boolean(anchorText)
            && (anchorText === imageAnchor
              || anchorText === imageAlt
              || anchorText === imageSrc);
        });

        if (matches.length === 0) {
          continue;
        }

        image.classList.add('has-review');

        for (const thread of matches) {
          attachThreadToAnchorElement(image, thread, 'image-review-badge', 'exact');
        }
      }
    }

    function createReviewBadge(thread, extraClass, label) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = ('review-badge ' + sourceClass(thread) + ' ' + extraClass).trim();
      badge.title = sourceLabel(thread) + ' comment';
      badge.setAttribute('aria-label', 'Open comment: ' + String(thread.comment || sourceLabel(thread) + ' comment'));
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

        }
      }
    }

    function getRelatedThreads(baseThread, threads) {
      if (!baseThread) {
        return [];
      }

      const baseText = normalizeInline(baseThread.anchor?.text || '');
      const baseIdentity = anchorIdentityByThreadId[baseThread.id];

      if (!baseText || !baseIdentity) {
        return [];
      }

      return threads.filter((thread) => {
        const anchorText = normalizeInline(thread.anchor?.text || '');
        return thread.id !== baseThread.id
          && anchorText === baseText
          && anchorIdentityByThreadId[thread.id] === baseIdentity;
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
        return 'Found nearby';
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

    function sourceKind(_thread) { return 'human'; }

    function sourceDisplay(_kind) { return { label: 'Comment', cssClass: 'source-human' }; }

    function sourceClass(thread) {
      return sourceDisplay(sourceKind(thread)).cssClass;
    }

    function sourceLabel(thread) {
      return sourceDisplay(sourceKind(thread)).label;
    }

    function sourceBadgeLabel(thread) {
      return sourceLabel(thread);
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
      document.body.classList.add('has-comment-overlay');
    }

    function renderTaskStatus(thread) {
      const status = thread.taskStatus || (thread.status === 'open' ? 'pending' : 'legacy');
      const stale = thread.taskResultFor !== undefined && thread.taskResultFor !== thread.taskRevision;
      return '<span class="meta-chip">' + (stale ? 'Stale result · review again' : status === 'done' ? 'Done' : status === 'blocked' ? 'Blocked' : status === 'legacy' ? 'Legacy' : 'Pending') + '</span>';
    }

    function renderTaskResult(thread) {
      return thread.taskResult ? '<p class="task-result">' + escapeHtml(thread.taskResult) + '</p>' : '';
    }

    function renderCommentOverlayItem(thread) {
      return [
        '<section class="comment-overlay-item" data-thread-id="' + escapeHtml(thread.id) + '">',
        renderTaskStatus(thread),
        '<p class="comment-overlay-comment">' + escapeHtml(thread.comment || '') + '</p>',
        renderTaskResult(thread),
        renderThreadActions(thread),
        '</section>'
      ].join('');
    }

    function renderThreadActions(thread) {
      return [
        '<div class="thread-actions">',
        '<button type="button" class="secondary" aria-label="Show comment in document: ' + escapeHtml(thread.comment) + '" data-jump-thread>Show in document</button>',
        '<button type="button" class="secondary" data-write-action data-edit-comment data-thread-id="' + escapeHtml(thread.id) + '">Edit</button>',
        '<button type="button" class="secondary" data-write-action data-remove-comment data-thread-id="' + escapeHtml(thread.id) + '">Delete</button>',
        '</div>'
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
      document.body.classList.remove('has-comment-overlay');
      delete commentOverlay.dataset.threadIds;
    }

    function hideCommentOverlayIfClean() {
      if (commentOverlay.style.display !== 'block') {
        return true;
      }

      hideCommentOverlay();
      return true;
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

    }

    function findOverlaySourceElement(threadId) {
      const badge = markdownBody.querySelector('.review-badge[data-thread-id="' + cssEscape(threadId) + '"]');

      if (badge) {
        return badge;
      }

      return markdownBody.querySelector('[data-thread-id="' + cssEscape(threadId) + '"]')
        || Array.from(markdownBody.querySelectorAll('.review-badge, [data-thread-ids]'))
          .find((element) => getThreadIds(element).includes(threadId));
    }

    function navigateReviewThread(direction) {
      const threadIds = getReviewNavigationIds();

      if (threadIds.length === 0) {
        return;
      }

      const currentThreadId = getCurrentReviewThreadId(threadIds);
      const currentIndex = threadIds.indexOf(currentThreadId);
      const baseIndex = currentIndex >= 0
        ? currentIndex
        : direction > 0
          ? -1
          : 0;
      const nextIndex = (baseIndex + direction + threadIds.length) % threadIds.length;
      revealReviewThread(threadIds[nextIndex]);
    }

    function getReviewNavigationIds() {
      const ids = [];
      const seen = new Set();
      const addId = (threadId) => {
        const id = String(threadId || '').trim();

        if (!id || seen.has(id) || !findThread(id)) {
          return;
        }

        seen.add(id);
        ids.push(id);
      };

      markdownBody
        .querySelectorAll('.review-badge, .review-anchor, .review-anchor-block, [data-mermaid-diagram].has-review')
        .forEach((element) => {
          getThreadIds(element).forEach(addId);
        });

      openThreads.map((thread) => thread.id).forEach(addId);
      return ids;
    }

    function getCurrentReviewThreadId(threadIds) {
      const activeThread = document.querySelector('.thread.is-active[data-thread-id]:not(.is-closed)');
      const activeThreadId = activeThread?.getAttribute('data-thread-id') || '';

      if (threadIds.includes(activeThreadId)) {
        return activeThreadId;
      }

      const overlayThreadIds = commentOverlay.style.display === 'block'
        ? getThreadIds(commentOverlay)
        : [];
      const overlayThreadId = overlayThreadIds.find((threadId) => threadIds.includes(threadId));

      if (overlayThreadId) {
        return overlayThreadId;
      }

      const activeAnchor = markdownBody.querySelector('.is-active[data-thread-id]');
      const activeAnchorId = activeAnchor?.getAttribute('data-thread-id') || '';

      if (threadIds.includes(activeAnchorId)) {
        return activeAnchorId;
      }

      return '';
    }

    function updateReviewNavigation(currentThreadId) {
      const threadIds = getReviewNavigationIds();
      const currentIndex = threadIds.indexOf(currentThreadId || getCurrentReviewThreadId(threadIds));
      const position = document.querySelector('[data-review-position]');
      if (position) {
        position.textContent = threadIds.length === 0
          ? 'No open comments'
          : currentIndex >= 0
            ? String(currentIndex + 1) + ' of ' + String(threadIds.length)
            : String(threadIds.length) + ' open';
      }
      document.querySelectorAll('[data-review-nav]').forEach((button) => {
        button.disabled = threadIds.length === 0;
      });
      document.querySelectorAll('.thread:not(.is-closed) [data-jump-thread]').forEach((button) => {
        const threadId = button.closest('.thread')?.getAttribute('data-thread-id');
        button.disabled = !findOverlaySourceElement(threadId);
        button.title = button.disabled ? 'The original text is not currently located in this document.' : 'Jump to this comment in the document.';
      });
    }

    function focusReviewElement(element, shouldFocus = true) {
      if (!element) {
        return;
      }
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
      if (shouldFocus) {
        if (!element.matches('button, a[href], input, textarea, select, [tabindex]')) {
          element.setAttribute('tabindex', '-1');
        }
        element.focus({ preventScroll: true });
      }
    }

    function revealReviewThread(threadId) {
      if (!hideCommentOverlayIfClean()) {
        return;
      }
      const sourceElement = findOverlaySourceElement(threadId);

      if (!sourceElement) {
        focusThread(threadId, true);
        return;
      }

      sourceElement.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
      const threadIds = getThreadIds(sourceElement);
      openCommentOverlay(threadIds.length > 0 ? threadIds : [threadId], sourceElement);
      focusThread(threadId, false);
    }

    function focusThread(threadId, shouldScroll) {
      document.querySelectorAll('.is-active').forEach((element) => element.classList.remove('is-active'));
      document.querySelectorAll('.thread[aria-current]').forEach((element) => element.removeAttribute('aria-current'));
      document.querySelectorAll('[data-thread-id="' + cssEscape(threadId) + '"]').forEach((element) => {
        element.classList.add('is-active');
      });
      const threadCard = document.querySelector('.thread[data-thread-id="' + cssEscape(threadId) + '"]');
      threadCard?.setAttribute('aria-current', 'true');
      updateReviewNavigation(threadId);

      if (!shouldScroll) {
        return;
      }

      focusReviewElement(threadCard);
    }

    function focusAnchor(threadId) {
      if (!hideCommentOverlayIfClean()) {
        return;
      }
      focusThread(threadId, false);
      const anchor = findOverlaySourceElement(threadId);

      if (anchor) {
        focusReviewElement(anchor);
        return;
      }

      const threadCard = document.querySelector('.thread[data-thread-id="' + cssEscape(threadId) + '"]');
      focusReviewElement(threadCard);
    }

    function focusHistoryAnchor(thread) {
      if (!hideCommentOverlayIfClean()) {
        return;
      }
      document.querySelectorAll('.is-active').forEach((element) => element.classList.remove('is-active'));
      document.querySelectorAll('.thread[aria-current]').forEach((element) => element.removeAttribute('aria-current'));
      document.querySelectorAll('[data-thread-id="' + cssEscape(thread.id) + '"]').forEach((element) => {
        element.classList.add('is-active');
      });
      document.querySelector('.thread[data-thread-id="' + cssEscape(thread.id) + '"]')?.setAttribute('aria-current', 'true');
      updateReviewNavigation(thread.id);

      const anchor = findHistoryAnchorElement(thread);

      if (!anchor) {
        return;
      }

      anchor.classList.add('history-anchor-target', 'is-active');
      focusReviewElement(anchor);
    }

    function findHistoryAnchorElement(thread) {
      const anchorText = normalizeInline(thread.anchor?.text || '');

      if (!anchorText) {
        return undefined;
      }

      const candidates = Array.from(markdownBody.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, [data-source-line], [data-markdown-image]')).filter((element) => {
        return !shouldSkipHighlightParent(element)
          && normalizeInline(getSearchableElementText(element)).includes(anchorText);
      });

      if (candidates.length === 0) {
        return findVerifiedHistorySourceBlock(thread.id);
      }

      const preferredLine = Number(thread.anchor?.lastLocatedLine || thread.anchor?.lineStart || 0);

      if (preferredLine > 0) {
        return candidates
          .map((element) => ({
            element,
            lineDistance: sourceLineDistance(element, preferredLine),
            exactness: normalizeInline(getSearchableElementText(element)) === anchorText ? 0 : 1
          }))
          .sort((left, right) => left.lineDistance - right.lineDistance || left.exactness - right.exactness)[0]?.element;
      }

      return candidates[Math.min(getAnchorOccurrence(thread), candidates.length - 1)];
    }

    function findVerifiedHistorySourceBlock(threadId) {
      const location = state.historyAnchorLocations?.[threadId];
      if (historyAnchorStates[threadId] !== 'linked' || !location
        || !Number.isSafeInteger(location.lineStart) || !Number.isSafeInteger(location.lineEnd)
        || location.lineStart < 1 || location.lineEnd < location.lineStart) {
        return undefined;
      }
      return Array.from(markdownBody.querySelectorAll('[data-source-line]'))
        .filter(element => !shouldSkipHighlightParent(element))
        .map(element => ({ element,
          start: Number(element.getAttribute('data-source-line')),
          end: Number(element.getAttribute('data-source-line-end') || element.getAttribute('data-source-line'))
        }))
        .filter(candidate => candidate.start <= location.lineStart && candidate.end >= location.lineStart)
        .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0]?.element;
    }

    function shouldSkipHighlightParent(element) {
      return Boolean(element.closest('button, textarea, .review-anchor, .comment-composer, .selection-popover, .comment-overlay, .mermaid-source'));
    }

    function isTextEntryTarget(element) {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      return Boolean(element.closest('input, textarea, select, button, [contenteditable="true"], .block-editor, .mermaid-editor, .table-editor, .comment-composer, .comment-overlay'));
    }

    function normalizeInline(value) {
      return String(value).replace(/\\s+/g, ' ').trim();
    }

    function sourceLineDistance(element, preferredLine) {
      const sourceLine = Number(element.getAttribute('data-source-line') || element.closest('[data-source-line]')?.getAttribute('data-source-line') || 0);
      const sourceLineEnd = Number(element.getAttribute('data-source-line-end') || element.closest('[data-source-line-end]')?.getAttribute('data-source-line-end') || sourceLine);

      if (!sourceLine) {
        return Number.POSITIVE_INFINITY;
      }

      if (preferredLine >= sourceLine && preferredLine <= sourceLineEnd) {
        return 0;
      }

      return Math.min(Math.abs(sourceLine - preferredLine), Math.abs(sourceLineEnd - preferredLine));
    }

    function looksLikeMermaidSource(value) {
      return /\\b(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph)\\b/i.test(value);
    }

    function looksLikeMarkdownImageAnchor(value) {
      return /^!\\[[^\\]]*\\]\\(.+\\)$/.test(String(value).trim());
    }

    function getAnchorOccurrence(thread) {
      const occurrence = Number(thread.anchor?.occurrence);
      return Number.isFinite(occurrence) ? Math.max(0, Math.floor(occurrence)) : 0;
    }

    function cssEscape(value) {
      return String(value).replace(/"/g, '\\\\"');
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
          clearDraftSelectionHighlight();
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
        clearDraftSelectionHighlight();
        return;
      }

      positionFloatingElement(selectionPopover, activeSelectionRect, 120);
      selectionPopover.style.display = 'block';
    }

    function captureCurrentSelection() {
      if (protectCommentDraft()) return false;
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
      const selectionLineRange = getSelectionSourceLineRange(range, container);
      activeSourceLine = selectionLineRange?.lineStart ?? getSourceLine(container);
      activeSourceLineEnd = selectionLineRange?.lineEnd ?? getSourceLineEnd(container);
      activeSelectionRect = {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };
      setDraftSelectionHighlight(range);

      return true;
    }

    function getSelectionSourceLineRange(range, container) {
      const sourceElements = Array.from(markdownBody.querySelectorAll('[data-source-line]'))
        .filter((element) => !shouldSkipHighlightParent(element) && selectionIntersectsElement(range, element));

      if (sourceElements.length === 0 && container instanceof HTMLElement) {
        const lineStart = getSourceLine(container);

        if (!lineStart) {
          return undefined;
        }

        return {
          lineStart,
          lineEnd: Math.max(lineStart, getSourceLineEnd(container) ?? lineStart)
        };
      }

      const ranges = sourceElements
        .map((element) => {
          const lineStart = getSourceLine(element);

          if (!lineStart) {
            return undefined;
          }

          return {
            lineStart,
            lineEnd: Math.max(lineStart, getSourceLineEnd(element) ?? lineStart)
          };
        })
        .filter(Boolean);

      if (ranges.length === 0) {
        return undefined;
      }

      return {
        lineStart: Math.min(...ranges.map((lineRange) => lineRange.lineStart)),
        lineEnd: Math.max(...ranges.map((lineRange) => lineRange.lineEnd))
      };
    }

    function selectionIntersectsElement(range, element) {
      try {
        return range.intersectsNode(element);
      } catch {
        const elementRange = document.createRange();
        elementRange.selectNodeContents(element);
        return range.compareBoundaryPoints(Range.END_TO_START, elementRange) < 0
          && range.compareBoundaryPoints(Range.START_TO_END, elementRange) > 0;
      }
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

    function setDraftSelectionHighlight(range) {
      activeSelectionRange = range.cloneRange();
      renderDraftSelectionHighlight();
    }

    function clearDraftSelectionHighlight() {
      activeSelectionRange = null;
      clearDraftSelectionCustomHighlight();
      draftSelectionHighlightLayer.replaceChildren();
      draftSelectionHighlightLayer.hidden = true;
    }

    function renderDraftSelectionHighlight() {
      if (!activeSelectionRange) {
        clearDraftSelectionHighlight();
        return;
      }

      if (supportsDraftSelectionCustomHighlight()) {
        draftSelectionHighlightLayer.replaceChildren();
        draftSelectionHighlightLayer.hidden = true;
        window.CSS.highlights.set('ai-review-draft-selection', new window.Highlight(activeSelectionRange));
        return;
      }

      renderDraftSelectionFallbackHighlight();
    }

    function renderDraftSelectionFallbackHighlight() {
      if (!activeSelectionRange || supportsDraftSelectionCustomHighlight()) {
        draftSelectionHighlightLayer.replaceChildren();
        draftSelectionHighlightLayer.hidden = true;
        return;
      }

      const rects = Array.from(activeSelectionRange.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      draftSelectionHighlightLayer.replaceChildren(...rects.map((rect) => {
        const element = document.createElement('span');
        element.className = 'draft-selection-highlight-rect';
        element.style.left = rect.left + 'px';
        element.style.top = rect.top + 'px';
        element.style.width = rect.width + 'px';
        element.style.height = rect.height + 'px';
        return element;
      }));
      draftSelectionHighlightLayer.hidden = rects.length === 0;
    }

    function supportsDraftSelectionCustomHighlight() {
      return typeof window.Highlight === 'function'
        && Boolean(window.CSS?.highlights?.set)
        && Boolean(window.CSS?.highlights?.delete);
    }

    function clearDraftSelectionCustomHighlight() {
      if (supportsDraftSelectionCustomHighlight()) {
        window.CSS.highlights.delete('ai-review-draft-selection');
      }
    }

    function openCommentEditor(thread) {
      if (protectCommentDraft()) return;
      activeCommentEdit = { threadId: thread.id, revision: thread.taskRevision, originalComment: thread.comment };
      activeSelectionText = thread.anchor.text;
      activeSelectionOccurrence = thread.anchor.occurrence || 0;
      activeSourceLine = thread.anchor.lineStart;
      activeSourceLineEnd = thread.anchor.lineEnd;
      commentBody.value = thread.comment;
      commentComposer.querySelector('.comment-composer-label').textContent = 'Edit change request';
      commentComposer.style.display = 'block';
      commentComposer.style.left = '16px';
      commentComposer.style.top = '48px';
      commentBody.focus();
    }

    function protectCommentDraft() {
      if (draftSession && !draftSession.canOpen('comment')) return true;
      if (commentComposer.style.display === 'block' && commentBody.value.trim()) {
        commentBody.focus();
        return true;
      }
      return false;
    }

    function openComposer() {
      if (protectCommentDraft()) return;
      if (!activeSelectionText || !activeSelectionRect) {
        return;
      }

      if (!hideCommentOverlayIfClean()) {
        return;
      }
      hideSelectionPopover();
      activeCommentEdit = undefined;
      commentComposer.querySelector('.comment-composer-label').textContent = 'Add a change request for the selection';
      commentBody.value = '';
      updateCommentQualityWarning();
      renderDraftSelectionHighlight();
      positionFloatingElement(commentComposer, activeSelectionRect, 340);
      commentComposer.style.display = 'block';
      commentBody.focus();
    }

    function hideSelectionPopover() {
      selectionPopover.style.display = 'none';
    }

    function hideComposer() {
      if (commentComposer.getAttribute('aria-busy') === 'true') return;
      commentComposer.style.display = 'none';
      activeCommentEdit = undefined;
      commentBody.value = '';
      updateCommentQualityWarning();
      clearDraftSelectionHighlight();
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

    function updateCommentQualityWarning() {
      const warning = commentQualityWarningText(commentBody.value);

      if (!warning || !commentBody.value.trim()) {
        commentQualityWarning.hidden = true;
        commentQualityWarning.textContent = '';
        return;
      }

      commentQualityWarning.hidden = false;
      commentQualityWarning.textContent = 'Review request hint: ' + warning;
    }

    function commentQualityWarningText(comment) {
      const normalized = String(comment || '').trim().replace(/\\s+/g, ' ');

      if (!normalized) {
        return 'Comment is empty, so an AI agent has no actionable instruction.';
      }

      if (normalized.length < 8) {
        return 'Comment is short; add the expected action or reason so the agent can apply it safely.';
      }

      if (!/[\\p{L}\\p{N}]/u.test(normalized)) {
        return 'Comment has no readable words or numbers; add a concrete action or question.';
      }

      if (/:$/.test(normalized) || /\\bbecause$/i.test(normalized)) {
        return 'Comment looks unfinished; finish the reason, decision, or requested action.';
      }

      return '';
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
    ${renderReanchorScript()}
  </script>
</body>
</html>`;
  }

  private renderStorageWarning(documentText: string, _reviewDocument: ReviewDocument): string {
    if (!hasLegacyInlineReviewMetadata(documentText)) {
      return '';
    }

    return `<section class="storage-warning" role="status">
    <strong>Legacy inline review metadata found.</strong>
    <p>Review state now lives in the hidden colocated <code>.&lt;filename&gt;.ai-review.json</code> file. These old inline markers can be removed without deleting review requests.</p>
    <div class="storage-warning-actions">
      <button type="button" class="secondary compact" data-cleanup-legacy-metadata>Clean legacy metadata</button>
    </div>
  </section>`;
  }

  private renderReviewActions(
    document: vscode.TextDocument,
    reviewDocument: ReviewDocument,
    resolvedReviewDocument: ReviewDocument
  ): string {
    const open = reviewDocument.threads.filter(thread => thread.status === 'open');
    const blocked = open.filter(thread => getReviewTaskStatus(thread) === 'blocked').length;
    const done = resolvedReviewDocument.threads.filter(thread => thread.taskStatus !== undefined && getReviewTaskStatus(thread) === 'done').length;
    const disabled = open.length ? '' : ' disabled';
    const reviewFile = `.${path.posix.basename(document.uri.path)}.ai-review.json`;
    const removed = typeof this.store.getReviewFileState === 'function'
      && this.store.getReviewFileState(document.uri) === 'removed';
    return `<section class="review-actions" aria-label="Review requests">
    <div class="review-navigation-actions" role="group" aria-label="Review comment navigation">
      <button type="button" class="secondary compact" aria-label="Previous comment" title="Previous comment (Left Arrow)" data-review-nav="previous"${disabled}>← Previous</button>
      <span class="review-position" data-review-position role="status" aria-live="polite" aria-atomic="true">${open.length ? `${open.length} open` : 'No open comments'}</span>
      <button type="button" class="secondary compact" aria-label="Next comment" title="Next comment (Right Arrow)" data-review-nav="next"${disabled}>Next →</button>
    </div>
    <div class="review-file-actions">
      <button type="button" class="compact" data-copy-review-json${open.length ? '' : ' disabled'}>Copy Review JSON</button>
      <code title="Canonical review file">${escapeHtml(reviewFile)}</code>
    </div>
  </section>
  <p class="review-position" data-review-summary>${done} done · ${open.length - blocked} pending · ${blocked} blocked</p>
  <p class="review-file-status" role="status"${removed ? '' : ' hidden'}>The review JSON was removed by the external agent. Review the Markdown changes, then add a new comment for another pass.</p>`;
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
    const nonce = randomUUID();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
    <button type="button" id="retry-preview">Retry refresh</button>
    <div id="error-drafts"></div>
  </section>
  <script nonce="${nonce}">${renderErrorDraftScript(document.uri.toString())}</script>
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

function decodeMarkdownImagePath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
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

function createMarkdownBlockReplacement(
  message: { html?: unknown; rawMarkdown?: unknown },
  sourceMarkdown: string,
  oneBasedLineStart: number
): string {
  if (typeof message.rawMarkdown === 'string') {
    return normalizeSubmittedMarkdownBlock(message.rawMarkdown);
  }

  return htmlBlockToMarkdown(String(message.html ?? ''), {
    sourceMarkdown,
    oneBasedLineStart
  });
}

function normalizeSubmittedMarkdownBlock(value: string): string {
  return value.replace(/^(?:\r\n|\r|\n)+|(?:\r\n|\r|\n)+$/g, '');
}

function detectLineEnding(value: string): string {
  return value.match(/\r\n|\r|\n/)?.[0] ?? '\n';
}

function parseDocumentVersion(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}

function hasLegacyInlineReviewMetadata(markdown: string): boolean {
  return /<!--\s*ai-review-(?:anchor|anchors|log):/.test(markdown);
}

function parseReviewAwareEditIntent(value: unknown): ReviewAwareEditIntent | undefined {
  if (value === 'manual_block_edit'
    || value === 'delete_block'
    || value === 'insert_block'
    || value === 'manual_table_edit'
    || value === 'manual_mermaid_edit'
    || value === 'rewrite_section') {
    return value;
  }

  return undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
