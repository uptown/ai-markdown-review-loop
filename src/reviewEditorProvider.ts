import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { renderReviewableCodeFence } from './codeFenceRendering';
import { applyMarkdownImageSourceMapping } from './markdownImageSource';
import { createAnchor } from './anchors';
import { htmlBlockToMarkdown } from './htmlToMarkdown';
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
import {
  applyReviewAwareEditToMarkdown,
  buildReviewAwareThreadUpdates,
  createLineInsertionEditPlan,
  createLineRangeDeletePlan,
  createLineRangeEditPlan,
  ReviewAwareEditIntent,
  ReviewAwareEditPlan
} from './reviewAwareEdits';
import { ReviewUndoController } from './reviewUndo';
import { applySourceLineMapping } from './sourceMappedMarkdown';
import {
  collectMarkdownTables,
  createMarkdownTableReplacement,
  parseMarkdownTableSourceMapping
} from './tableEdits';
import { ReviewDocument, ReviewThread } from './types';
import type { ReviewSidecarSnapshot } from './reviewUndo';
import { webviewMessageTypes, type HostToWebviewMessage, type ReviewWebviewState, type PreviewRestoreState } from './webviewMessages';

const viewType = 'aiMarkdownReviewLoop.reviewEditor';
const sourceRevisionMessageTypes = new Set([
  'addComment', 'editMarkdownBlock', 'insertMarkdownBlock', 'deleteMarkdownBlock',
  'editMermaidSource', 'editMarkdownTable',
  'cleanupStaleAnchors', 'cleanupLegacyMetadata', 'convertMarkdownBlockHtml'
]);

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
    if (document.uri.scheme !== 'file') {
      webviewPanel.webview.html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body><h2>Unsupported document</h2><p>AI Markdown Review supports local Markdown files. Open a local copy to review this document.</p></body></html>';
      return;
    }
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.getLocalResourceRoots(document.uri)
    };

    let activeMutations = 0;
    let refreshPending = false;
    let pendingRestoreState: PreviewRestoreState | undefined;
    let renderSequence = 0;
    let disposed = false;
    let hasRenderedPreview = false;
    let previewId = '';
    let readyPreviewId: string | undefined;
    let renderedVersion: number | undefined;
    let renderedTrusted: boolean | undefined;
    let renderTimer: ReturnType<typeof setTimeout> | undefined;
    const postMessage = (message: HostToWebviewMessage) => webviewPanel.webview.postMessage(message);
    const mutationResults: NonNullable<PreviewRestoreState['mutationResults']> = {};
    const pendingRequests = new Set<string>();
    const trackedMutationTypes = new Set(['addComment', 'editComment', 'removeComment', 'editMarkdownBlock', 'insertMarkdownBlock', 'editMermaidSource', 'editMarkdownTable']);
    const reviewCommands = new Set(['copyReviewJson']);
    const render = async (restoreState?: PreviewRestoreState) => {
      if (disposed) return;
      if (restoreState) pendingRestoreState = restoreState;
      if (activeMutations > 0) {
        refreshPending = true;
        return;
      }
      const sequence = ++renderSequence;
      try {
        const reviewDocument = vscode.workspace.isTrusted === false
          ? await this.store.loadReadonly(document.uri)
          : await this.store.withDocumentTransaction(document.uri, async () => this.store.load(document.uri));
        if (sequence !== renderSequence) return;
        if (activeMutations > 0) {
          refreshPending = true;
          return;
        }
        const restore = { ...pendingRestoreState, mutationResults };
        if (hasRenderedPreview && renderedVersion === document.version && renderedTrusted === (vscode.workspace.isTrusted !== false)) {
          // HTML assignment does not mean its script has installed listeners.
          // Keep the latest state pending until this exact page announces readiness.
          if (readyPreviewId !== previewId) { refreshPending = true; return; }
          const delivered = await postMessage({ type: 'reviewStateUpdated', state: this.createWebviewState(document, reviewDocument, restore, previewId) });
          if (sequence !== renderSequence) return;
          if (!delivered) { readyPreviewId = undefined; refreshPending = true; return; }
        } else {
          const nextPreviewId = randomUUID();
          const html = this.renderHtml(webviewPanel.webview, document, reviewDocument, restore, nextPreviewId);
          previewId = nextPreviewId;
          readyPreviewId = undefined;
          renderedVersion = document.version;
          renderedTrusted = vscode.workspace.isTrusted !== false;
          webviewPanel.webview.html = html;
        }
        hasRenderedPreview = true;
        pendingRestoreState = undefined;
        refreshPending = false;
      } catch (error) {
        if (sequence !== renderSequence || activeMutations > 0) return;
        if (hasRenderedPreview) {
          refreshPending = true;
          if (readyPreviewId !== previewId) return;
          const delivered = await postMessage({ type: 'reviewRefreshFailed', error: formatError(error) });
          if (sequence === renderSequence && !delivered) readyPreviewId = undefined;
        } else {
          webviewPanel.webview.html = this.renderErrorHtml(document, formatError(error), webviewPanel.webview);
        }
      }
    };

    const refreshers = this.refreshers.get(document.uri.toString()) ?? new Set<() => Promise<void>>();
    refreshers.add(render);
    this.refreshers.set(document.uri.toString(), refreshers);

    const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === document.uri.toString()) {
        refreshPending = true;
        void (async () => {
          try {
            if (vscode.workspace.isTrusted !== false) await this.reviewUndo.handleTextDocumentChange(event);
          } catch (error) {
            vscode.window.showErrorMessage(`AI Markdown Review undo sync failed: ${formatError(error)}`);
          }
          clearTimeout(renderTimer);
          renderTimer = setTimeout(() => { void render(); }, 80);
        })();
      }
    });
    const sidecarSubscription = await this.watchReviewSidecars(document.uri, render);
    webviewPanel.onDidDispose(() => {
      disposed = true;
      renderSequence++;
      refreshers.delete(render);
      if (refreshers.size === 0) this.refreshers.delete(document.uri.toString());
      changeSubscription.dispose();
      sidecarSubscription.dispose();
      clearTimeout(renderTimer);
    });

    webviewPanel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) {
        this.currentDocumentUri = document.uri;
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async message => {
      if (disposed || !message || !webviewMessageTypes.has(message.type)) return;
      const sourceMarkdownAtMessage = document.getText();
      const sourceVersion = parseDocumentVersion(message?.documentVersion);
      if (message.type === 'webviewReady') {
        if (typeof message.previewId !== 'string' || message.previewId !== previewId
          || sourceVersion !== renderedVersion || !hasRenderedPreview) return;
        if (readyPreviewId === previewId && !refreshPending) return;
        readyPreviewId = previewId;
        await render();
        return;
      }
      const requestId = trackedMutationTypes.has(message?.type) && typeof message?.requestId === 'string'
        ? message.requestId.slice(0, 160) : '';
      if (requestId && mutationResults[requestId]) {
        await postMessage({ type: 'reviewMutationResult', requestId, ...mutationResults[requestId] });
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
        if (vscode.workspace.isTrusted === false) {
          throw new Error('Trust this workspace to edit documents, manage comments, or copy review content.');
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

        if (message?.type === 'convertMarkdownBlockHtml') {
          const requestId = String(message.requestId ?? '');
          const lineStart = parseSourceLine(message.lineStart) ?? 1;

          try {
            const rawMarkdown = createMarkdownBlockReplacement(
              { html: message.html },
              document.getText(),
              lineStart
            );

            await postMessage({
              type: 'convertedMarkdownBlockHtml',
              requestId,
              rawMarkdown
            });
          } catch (error) {
            await postMessage({
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
          await postMessage({ type: 'convertedMarkdownBlockHtml', requestId: message.requestId, error: mutationError });
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
          await postMessage({ type: 'reviewMutationResult', requestId, ...result });
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
      <button type="button" class="secondary compact" data-mermaid-edit hidden>Edit</button>
      <button type="button" class="secondary compact" data-mermaid-feedback>Feedback</button>
      <button type="button" class="secondary compact" data-mermaid-copy>Copy</button>
    </div>
  </div>
  <div class="mermaid-render" data-mermaid-render>${escapedSource}</div>
  <details class="mermaid-source" hidden>
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

  private createWebviewState(document: vscode.TextDocument, reviewDocument: ReviewDocument, restoreState: PreviewRestoreState = {}, previewId = ''): ReviewWebviewState {
    const documentText = document.getText();
    const preview = createPreviewMarkdown(stripInlineAnchorMarkers(documentText));
    return {
      previewId,
      threads: reviewDocument.threads,
      tables: collectMarkdownTables(preview),
      canEditMarkdown: document.uri.scheme === 'file',
      trusted: vscode.workspace.isTrusted !== false,
      reviewFileState: this.store.getReviewFileState(document.uri),
      sourceLines: documentText.split(/\r\n|\r|\n/),
      sourceLineEnding: detectLineEnding(documentText),
      documentVersion: document.version,
      documentUri: document.uri.toString(),
      sourceFingerprint: createHash('sha256').update(documentText).digest('hex'),
      restoreState
    };
  }

  private renderHtml(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    reviewDocument: ReviewDocument,
    restoreState?: PreviewRestoreState,
    previewId = randomUUID()
  ): string {
    const nonce = randomUUID();
    const documentText = document.getText();
    const previewMarkdown = createPreviewMarkdown(stripInlineAnchorMarkers(documentText));
    const renderedMarkdown = this.markdown.render(previewMarkdown, {
      documentUri: document.uri,
      webview
    });
    const reviewActions = this.renderReviewActions(document, reviewDocument);
    const storageWarning = this.renderStorageWarning(documentText, reviewDocument);
    const mermaidScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'vendor', 'mermaid.min.js')
    );
    const clientScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "webview.js"));
    const stylesheetUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "review.css"));
    const state = JSON.stringify(this.createWebviewState(document, reviewDocument, restoreState, previewId)).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Markdown Review</title>
  <link rel="stylesheet" href="${stylesheetUri}">
</head>
<body>
  <div class="layout">
    <main>
      ${reviewActions}
      ${storageWarning}
      <article id="markdown-body">${renderedMarkdown}</article>
    </main>
    <aside id="review-sidebar" aria-label="Change requests">
      <h2>Change Requests</h2>
      <div id="threads"></div>
    </aside>
  </div>
  <div id="selection-popover" class="selection-popover">
    <button id="selection-comment" class="compact" title="Comment on selection (Alt+Enter)">Comment</button>
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
  <div id="comment-overlay" class="comment-overlay" role="dialog" aria-modal="false" aria-label="Review comments"></div>
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
  <script nonce="${nonce}" src="${mermaidScriptUri}"></script>
  <script nonce="${nonce}">window.reviewInitialState = ${state};</script>
  <script nonce="${nonce}" src="${clientScriptUri}"></script>
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
    reviewDocument: ReviewDocument
  ): string {
    const open = reviewDocument.threads.filter(thread => thread.status === 'open');
    const disabled = open.length ? '' : ' disabled';
    const reviewFile = `.${path.posix.basename(document.uri.path)}.ai-review.json`;
    const removed = typeof this.store.getReviewFileState === 'function'
      && this.store.getReviewFileState(document.uri) === 'removed';
    return `<section class="review-actions" aria-label="Review requests">
    <div class="review-navigation-actions" role="group" aria-label="Review comment navigation">
      <button type="button" class="secondary compact" aria-label="Previous comment" title="Previous comment (Left Arrow)" data-review-nav="previous"${disabled}>← Previous</button>
      <span class="review-position" data-review-position role="status" aria-live="polite" aria-atomic="true">${open.length ? `${open.length} ${open.length === 1 ? 'comment' : 'comments'}` : 'No comments'}</span>
      <button type="button" class="secondary compact" aria-label="Next comment" title="Next comment (Right Arrow)" data-review-nav="next"${disabled}>Next →</button>
      <button type="button" class="secondary compact sidebar-toggle" data-toggle-sidebar aria-controls="review-sidebar" aria-expanded="true">Hide comments</button>
      <button type="button" class="secondary compact" data-toggle-edit-document aria-pressed="false"${vscode.workspace.isTrusted === false ? ' disabled' : ''}>Edit document</button>
    </div>
    <div class="review-file-actions">
      <button type="button" class="compact" data-copy-review-json${open.length && vscode.workspace.isTrusted !== false ? '' : ' disabled'}>Copy Review JSON</button>
      <code title="Canonical review file">${escapeHtml(reviewFile)}</code>
    </div>
  </section>
  ${vscode.workspace.isTrusted === false ? '<p class="workspace-trust-notice">Restricted Mode: trust this workspace to manage comments, edit documents, or copy review content.</p>' : ''}
  <p class="review-file-status" role="status"${removed ? '' : ' hidden'}>The review JSON was removed by the external agent. Review the Markdown changes and manage comments for the next pass.</p>`;
  }

  private renderErrorHtml(document: vscode.TextDocument, message: string, webview?: vscode.Webview): string {
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
  <script nonce="${nonce}">window.reviewInitialState = ${JSON.stringify({documentUri: document.uri.toString(), trusted: vscode.workspace.isTrusted !== false}).replace(/</g, "\\u003c")};</script>
  <script nonce="${nonce}" src="${webview?.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "errorWebview.js")) ?? vscode.Uri.joinPath(this.context.extensionUri, "out", "errorWebview.js")}"></script>
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
