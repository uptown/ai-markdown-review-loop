import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { randomUUID } from 'crypto';
import { createAnchor } from './anchors';
import { findMissingInlineAnchorMarkers, insertInlineAnchorMarker, stripInlineAnchorMarkers } from './inlineMarkers';
import { ReviewStore } from './reviewStore';
import { ReviewDocument, ReviewStatus, ReviewThread } from './types';

const viewType = 'aiMarkdownReviewLoop.reviewEditor';

export class ReviewEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly markdown = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false
  });

  private currentDocumentUri: vscode.Uri | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ReviewStore
  ) {
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

        if (typeof sourceLine === 'number') {
          token.attrSet('data-source-line', String(sourceLine + 1));
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
        return this.renderMermaidFence(token.content, token.map?.[0]);
      }

      if (defaultFence) {
        return defaultFence(tokens, index, options, env, self);
      }

      return self.renderToken(tokens, index, options);
    };
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

    const render = async () => {
      try {
        const reviewDocument = await this.store.load(document.uri);
        webviewPanel.webview.html = this.renderHtml(webviewPanel.webview, document, reviewDocument);
      } catch (error) {
        webviewPanel.webview.html = this.renderErrorHtml(document, formatError(error));
      }
    };

    const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === document.uri.toString()) {
        void render();
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
    });

    webviewPanel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) {
        this.currentDocumentUri = document.uri;
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

          await this.store.updateThread(
            document.uri,
            String(message.threadId),
            { status }
          );
          await render();
        }

        if (message?.type === 'addReply') {
          const replyText = String(message.text ?? '').trim();

          if (!replyText) {
            vscode.window.showWarningMessage('Reply text is empty.');
            return;
          }

          await this.store.addReply(
            document.uri,
            String(message.threadId),
            replyText
          );
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

  private renderMermaidFence(source: string, zeroBasedSourceLine?: number): string {
    const escapedSource = escapeHtml(source.trim());
    const sourceLine = typeof zeroBasedSourceLine === 'number'
      ? ` data-source-line="${zeroBasedSourceLine + 1}"`
      : '';

    return `<figure class="mermaid-figure" data-mermaid-diagram${sourceLine}>
  <div class="mermaid-toolbar">
    <span>Mermaid</span>
    <div class="mermaid-actions">
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

    await this.store.addThread(document.uri, thread);
    const sidecarUri = await this.store.getReviewFileUri(document.uri);
    const markerInserted = await insertInlineAnchorMarker(document, thread, sidecarUri);

    if (!markerInserted) {
      vscode.window.showWarningMessage('Feedback was saved, but the Markdown anchor marker could not be inserted.');
    }
  }

  private renderHtml(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    reviewDocument: ReviewDocument
  ): string {
    const nonce = randomUUID();
    const documentText = document.getText();
    const renderedMarkdown = this.markdown.render(stripInlineAnchorMarkers(documentText));
    const storageWarning = this.renderStorageWarning(documentText, reviewDocument);
    const mermaidScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'vendor', 'mermaid.min.js')
    );
    const state = JSON.stringify({
      threads: reviewDocument.threads
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
    .thread.is-active {
      border-color: #8ad83f;
      box-shadow: inset 3px 0 0 #8ad83f;
    }
    .thread header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
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
    .comment-overlay {
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
    .comment-overlay-item + .comment-overlay-item {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    .comment-overlay-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
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
    }
    .reply-meta {
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
  <script nonce="${nonce}" src="${mermaidScriptUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${state};
    const markdownBody = document.getElementById('markdown-body');
    const selectionPopover = document.getElementById('selection-popover');
    const selectionCommentButton = document.getElementById('selection-comment');
    const commentComposer = document.getElementById('comment-composer');
    const commentBody = document.getElementById('comment-body');
    const commentCancel = document.getElementById('comment-cancel');
    const commentOverlay = document.getElementById('comment-overlay');
    let activeSelectionText = '';
    let activeSelectionOccurrence = 0;
    let activeSourceLine = undefined;
    let activeSelectionRect = null;
    let selectionTimer = undefined;

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

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideCommentOverlay();
        hideSelectionPopover();
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
        text
      });
    });

    document.addEventListener('click', (event) => {
      const target = event.target;

      if (!(target instanceof HTMLElement)) {
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
    const threadsContainer = document.getElementById('threads');

    if (openThreads.length === 0) {
      threadsContainer.innerHTML = '<p class="empty">No open feedback yet.</p>';
    } else {
      for (const thread of openThreads) {
        const element = document.createElement('section');
        element.className = 'thread';
        element.dataset.threadId = thread.id;
        element.title = 'Jump to commented content';
        element.innerHTML = [
          '<header><span>' + escapeHtml(thread.type) + ' · ' + escapeHtml(thread.source) + '</span><span>' + escapeHtml(thread.severity) + '</span></header>',
          '<blockquote>' + escapeHtml(thread.anchor.text || 'Document') + '</blockquote>',
          '<p>' + escapeHtml(thread.comment) + '</p>',
          renderReplies(thread),
          renderReplyForm(thread),
          '<div class="thread-actions">',
          '<button class="secondary" data-status="resolved">Resolve</button>',
          '<button class="secondary" data-status="rejected">Reject</button>',
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

    decorateReviewAnchors(openThreads);
    decorateMermaidReviewBadges(openThreads);
    attachRelatedThreadIds(openThreads);
    renderMermaidDiagrams();

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

    function decorateReviewAnchors(threads) {
      for (const thread of threads) {
        const anchorText = normalizeInline(thread.anchor?.text || '');

        if (!anchorText || anchorText.length < 2 || looksLikeMermaidSource(anchorText)) {
          continue;
        }

        if (!highlightTextNode(thread, anchorText)) {
          highlightContainingBlock(thread, anchorText);
        }
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
          marker.className = 'review-anchor';
          marker.dataset.threadId = thread.id;
          marker.title = 'Open comment';
          marker.textContent = matchNode.nodeValue;

          const badge = createReviewBadge(thread, '');
          marker.appendChild(badge);
          matchNode.parentNode?.insertBefore(marker, matchNode);
          matchNode.remove();
          afterNode.parentElement?.normalize();
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
        return;
      }

      target.classList.add('review-anchor-block');
      target.dataset.threadId = thread.id;
      target.title = 'Open comment';
      target.appendChild(createReviewBadge(thread, 'review-block-badge'));
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
        actions?.prepend(createReviewBadge(matches[0], 'mermaid-review-badge', String(matches.length)));
      }
    }

    function createReviewBadge(thread, extraClass, label) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = ('review-badge ' + extraClass).trim();
      badge.title = 'Open comment';
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

        anchor.dataset.threadIds = relatedThreads.map((thread) => thread.id).join(',');
        const badge = anchor.querySelector('.review-badge');

        if (badge) {
          badge.dataset.threadId = relatedThreads[0].id;
          badge.dataset.threadIds = anchor.dataset.threadIds;
          badge.textContent = String(relatedThreads.length);
          badge.title = relatedThreads.length === 1 ? 'Open comment' : 'Open comments';
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
        '<section class="comment-overlay-item">',
        '<div class="comment-overlay-meta">',
        '<span>' + escapeHtml(thread.type || 'note') + '</span>',
        '<span>' + escapeHtml(thread.source || 'human') + '</span>',
        '<span>' + escapeHtml(thread.severity || 'medium') + '</span>',
        '<span>' + escapeHtml(thread.status || 'open') + '</span>',
        '</div>',
        '<p class="comment-overlay-comment">' + escapeHtml(thread.comment || '') + '</p>',
        renderReplies(thread),
        renderReplyForm(thread),
        '<div class="comment-overlay-actions">',
        '<button class="secondary compact" data-thread-id="' + escapeHtml(thread.id) + '" data-overlay-status="resolved">Resolve</button>',
        '<button class="secondary compact" data-thread-id="' + escapeHtml(thread.id) + '" data-overlay-status="rejected">Reject</button>',
        '</div>',
        '</section>'
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
          '<div class="reply-item">',
          '<div class="reply-meta">' + escapeHtml(reply.role || 'user') + ' · ' + escapeHtml(formatDate(reply.createdAt)) + '</div>',
          '<p class="reply-text">' + escapeHtml(reply.text || '') + '</p>',
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

    function hideCommentOverlay() {
      commentOverlay.style.display = 'none';
      commentOverlay.innerHTML = '';
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
      anchor?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
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
    const missingMarkers = findMissingInlineAnchorMarkers(
      documentText,
      reviewDocument.threads.map(thread => thread.id)
    );

    if (missingMarkers.length === 0) {
      return '';
    }

    const sidecar = missingMarkers.find(marker => marker.sidecar)?.sidecar ?? '.ai-markdown-review/documents/*.json';
    const markerLabel = missingMarkers.length === 1 ? 'anchor' : 'anchors';

    return `<section class="storage-warning" role="status">
    <strong>Review sidecar data is missing or incomplete.</strong>
    <p>This Markdown file still contains ${missingMarkers.length} ai-review-anchor ${markerLabel}, but the matching review thread data was not found in <code>${escapeHtml(sidecar)}</code>. Comment text cannot be rebuilt from inline anchors; restore the sidecar JSON from backup/source control, or remove the stale anchors if the comments are no longer needed.</p>
  </section>`;
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

function parseReviewStatus(value: unknown): ReviewStatus | undefined {
  if (value === 'open' || value === 'accepted' || value === 'rejected' || value === 'resolved') {
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
