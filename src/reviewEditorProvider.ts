import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { randomUUID } from 'crypto';
import { createAnchor } from './anchors';
import { ReviewStore } from './reviewStore';
import { ReviewDocument, ReviewThread } from './types';

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

    this.markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const language = token.info.trim().split(/\s+/)[0]?.toLowerCase();

      if (language === 'mermaid') {
        return this.renderMermaidFence(token.content);
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
      const reviewDocument = await this.store.load(document.uri);
      webviewPanel.webview.html = this.renderHtml(webviewPanel.webview, document, reviewDocument);
    };

    const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === document.uri.toString()) {
        void render();
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'addComment') {
        await this.addComment(
          document,
          String(message.anchorText ?? ''),
          typeof message.comment === 'string' ? message.comment : undefined
        );
        await render();
      }

      if (message?.type === 'updateStatus') {
        await this.store.updateThread(
          document.uri,
          String(message.threadId),
          { status: message.status }
        );
        await render();
      }

      if (message?.type === 'copyText') {
        await vscode.env.clipboard.writeText(String(message.text ?? ''));
        vscode.window.showInformationMessage('Copied Mermaid source.');
      }
    });

    await render();
  }

  private renderMermaidFence(source: string): string {
    const escapedSource = escapeHtml(source.trim());

    return `<figure class="mermaid-figure" data-mermaid-diagram>
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
    providedComment?: string
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
      anchor: createAnchor(document, normalizedSelection),
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
  }

  private renderHtml(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    reviewDocument: ReviewDocument
  ): string {
    const nonce = randomUUID();
    const renderedMarkdown = this.markdown.render(document.getText());
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
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 0 16px;
      background: var(--vscode-editor-background);
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
    .hint {
      color: var(--muted);
      font-size: 12px;
    }
    .thread {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
      background: var(--vscode-editor-background);
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
    .comment-composer {
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
      <div class="toolbar">
        <button id="add-comment">Add Feedback</button>
        <span class="hint">Select rendered text, then add feedback.</span>
      </div>
      <article id="markdown-body">${renderedMarkdown}</article>
    </main>
    <aside>
      <h2>Review Threads</h2>
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
    let activeSelectionText = '';
    let activeSelectionRect = null;
    let selectionTimer = undefined;

    renderMermaidDiagrams();

    document.getElementById('add-comment').addEventListener('click', () => {
      const selection = String(window.getSelection() || '').trim();
      vscode.postMessage({ type: 'addComment', anchorText: selection });
    });

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
        hideSelectionPopover();
        hideComposer();
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
        comment: body
      });
      hideSelectionPopover();
      hideComposer();
      window.getSelection()?.removeAllRanges();
    });

    document.addEventListener('click', (event) => {
      const target = event.target;

      if (!(target instanceof HTMLElement)) {
        return;
      }

      const figure = target.closest('[data-mermaid-diagram]');

      if (!figure) {
        return;
      }

      const source = getMermaidSource(figure);

      if (target.matches('[data-mermaid-feedback]')) {
        activeSelectionText = source;
        const rect = target.getBoundingClientRect();
        activeSelectionRect = {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom
        };
        openComposer();
      }

      if (target.matches('[data-mermaid-copy]')) {
        vscode.postMessage({ type: 'copyText', text: source });
      }
    });

    const threadsContainer = document.getElementById('threads');
    const openThreads = state.threads.filter((thread) => thread.status === 'open');

    if (openThreads.length === 0) {
      threadsContainer.innerHTML = '<p class="empty">No open feedback yet.</p>';
    } else {
      for (const thread of openThreads) {
        const element = document.createElement('section');
        element.className = 'thread';
        element.innerHTML = [
          '<header><span>' + escapeHtml(thread.type) + ' · ' + escapeHtml(thread.source) + '</span><span>' + escapeHtml(thread.severity) + '</span></header>',
          '<blockquote>' + escapeHtml(thread.anchor.text || 'Document') + '</blockquote>',
          '<p>' + escapeHtml(thread.comment) + '</p>',
          '<div class="thread-actions">',
          '<button class="secondary" data-status="resolved">Resolve</button>',
          '<button class="secondary" data-status="rejected">Reject</button>',
          '</div>'
        ].join('');

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
      activeSelectionRect = {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };

      return true;
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
