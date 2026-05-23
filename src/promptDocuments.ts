import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

const promptDocumentScheme = 'ai-markdown-review-loop-prompt';

let promptDocumentProvider: PromptDocumentProvider | undefined;

export function registerPromptDocumentProvider(): vscode.Disposable {
  if (promptDocumentProvider) {
    return new vscode.Disposable(() => undefined);
  }

  const provider = new PromptDocumentProvider();
  const registration = vscode.workspace.registerTextDocumentContentProvider(promptDocumentScheme, provider);
  promptDocumentProvider = provider;

  return new vscode.Disposable(() => {
    registration.dispose();
    provider.dispose();
    if (promptDocumentProvider === provider) {
      promptDocumentProvider = undefined;
    }
  });
}

export async function openReadOnlyMarkdownPrompt(
  title: string,
  content: string,
  viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside
): Promise<vscode.TextDocument> {
  if (!promptDocumentProvider) {
    throw new Error('AI Markdown Review prompt document provider is not registered.');
  }

  const document = await promptDocumentProvider.open(title, content);
  const markdownDocument = document.languageId === 'markdown'
    ? document
    : await vscode.languages.setTextDocumentLanguage(document, 'markdown');

  await vscode.window.showTextDocument(markdownDocument, {
    preview: false,
    viewColumn
  });
  return markdownDocument;
}

class PromptDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.changeEmitter.event;

  async open(title: string, content: string): Promise<vscode.TextDocument> {
    const uri = vscode.Uri.from({
      scheme: promptDocumentScheme,
      path: `/${slugTitle(title)}-${randomUUID()}.md`
    });
    this.documents.set(uri.toString(), ensureTrailingNewline(content));
    this.changeEmitter.fire(uri);
    return vscode.workspace.openTextDocument(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.documents.clear();
    this.changeEmitter.dispose();
  }
}

function slugTitle(title: string): string {
  return title
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'AI-Markdown-Review-Prompt';
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}
