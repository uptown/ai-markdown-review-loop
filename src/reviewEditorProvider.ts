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
        await this.addComment(document, String(message.anchorText ?? ''));
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

  private async addComment(document: vscode.TextDocument, selectedText: string): Promise<void> {
    const normalizedSelection = selectedText.trim();

    if (!normalizedSelection) {
      vscode.window.showWarningMessage('Select text in the review preview before adding feedback.');
      return;
    }

    const comment = await vscode.window.showInputBox({
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
  <script nonce="${nonce}" src="${mermaidScriptUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${state};

    renderMermaidDiagrams();

    document.getElementById('add-comment').addEventListener('click', () => {
      const selection = String(window.getSelection() || '').trim();
      vscode.postMessage({ type: 'addComment', anchorText: selection });
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
        vscode.postMessage({ type: 'addComment', anchorText: source });
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
