import * as vscode from 'vscode';

export class MarkdownCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isMarkdown(document)) {
      return [];
    }

    const range = new vscode.Range(0, 0, 0, 0);

    return [
      new vscode.CodeLens(range, {
        title: 'Open AI Review',
        command: 'aiMarkdownReviewLoop.openReviewPreview',
        arguments: [document.uri]
      }),
      new vscode.CodeLens(range, {
        title: 'Review Document',
        command: 'aiMarkdownReviewLoop.reviewDocument',
        arguments: [document.uri]
      }),
      new vscode.CodeLens(range, {
        title: 'Export Feedback',
        command: 'aiMarkdownReviewLoop.exportFeedback',
        arguments: [document.uri]
      })
    ];
  }
}

function isMarkdown(document: vscode.TextDocument): boolean {
  return document.languageId === 'markdown' || document.uri.path.toLowerCase().endsWith('.md');
}
