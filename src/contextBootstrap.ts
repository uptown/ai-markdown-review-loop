import * as vscode from 'vscode';
import { createContextBootstrapPrompt } from './contextBootstrapPrompt';
import { openReadOnlyMarkdownPrompt } from './promptDocuments';

export async function openContextBootstrapPrompt(
  documentUri?: vscode.Uri
): Promise<vscode.TextDocument | undefined> {
  const workspaceFolder = resolveWorkspaceFolder(documentUri);

  if (!workspaceFolder) {
    return undefined;
  }

  const prompt = createContextBootstrapPrompt();
  return openReadOnlyMarkdownPrompt('AI Context Bootstrap Prompt', prompt);
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
