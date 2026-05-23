import * as vscode from 'vscode';
import { createContextBootstrapPrompt } from './contextBootstrapPrompt';

export const AI_CONTEXT_BRIEF_RELATIVE_PATH = 'docs/AI-CONTEXT-BRIEF.md';
export const AI_CONTEXT_SOURCE_PATHS = [
  AI_CONTEXT_BRIEF_RELATIVE_PATH,
  'docs/PRD.md',
  '.agent/PROJECT_STATE.md',
  'README.md'
] as const;

export async function openContextBootstrapPrompt(
  documentUri?: vscode.Uri
): Promise<vscode.TextDocument | undefined> {
  const workspaceFolder = resolveWorkspaceFolder(documentUri);

  if (!workspaceFolder) {
    return undefined;
  }

  const availableSources = await getAvailableContextSources(workspaceFolder);
  const currentDocumentPath = documentUri
    ? vscode.workspace.asRelativePath(documentUri, false)
    : undefined;
  const prompt = createContextBootstrapPrompt({
    availableSources,
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

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function getAvailableContextSources(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<string[]> {
  return (
    await Promise.all(AI_CONTEXT_SOURCE_PATHS.map(async (relativePath) => {
      const exists = await fileExists(vscode.Uri.joinPath(workspaceFolder.uri, relativePath));
      return exists ? relativePath : undefined;
    }))
  ).filter((value): value is typeof AI_CONTEXT_SOURCE_PATHS[number] => value !== undefined);
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
