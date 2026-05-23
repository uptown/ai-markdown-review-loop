import * as vscode from 'vscode';
import { createContextBootstrapPrompt } from './contextBootstrapPrompt';

export const AI_CONTEXT_BRIEF_RELATIVE_PATH = 'docs/AI-CONTEXT-BRIEF.md';

export async function openContextBootstrapPrompt(
  documentUri?: vscode.Uri
): Promise<vscode.TextDocument | undefined> {
  const workspaceFolder = resolveWorkspaceFolder(documentUri);

  if (!workspaceFolder) {
    return undefined;
  }

  const currentDocumentPath = documentUri
    ? vscode.workspace.asRelativePath(documentUri, false)
    : undefined;
  const prompt = createContextBootstrapPrompt({
    currentDocumentPath,
    recommendedBriefPath: AI_CONTEXT_BRIEF_RELATIVE_PATH
  });
  const document = await vscode.workspace.openTextDocument({
    content: `${prompt}\n`,
    language: 'markdown'
  });

  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
  return document;
}

function resolveWorkspaceFolder(documentUri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (documentUri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);

    if (workspaceFolder) {
      return workspaceFolder;
    }
  }

  const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
  return activeDocumentUri ? vscode.workspace.getWorkspaceFolder(activeDocumentUri) : undefined;
}
