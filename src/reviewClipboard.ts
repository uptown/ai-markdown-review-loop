import path from 'path';
import { parseReviewTaskSidecar, type ReviewTaskSidecar } from './reviewTaskProtocol';

export interface ClipboardWorkspaceFolder {
  name: string;
  fsPath: string;
}

/** Validate the destination before saving Markdown or recreating its JSON. */
export function resolveReviewClipboardContext(
  documentPath: string,
  folders: readonly ClipboardWorkspaceFolder[]
): NonNullable<ReviewTaskSidecar['context']> {
  const paths = path.win32.isAbsolute(documentPath) && !path.posix.isAbsolute(documentPath) ? path.win32 : path.posix;
  const candidates = folders.map(folder => ({ folder, relative: paths.relative(folder.fsPath, documentPath) }))
    .filter(({ relative }) => relative.length > 0 && relative !== '..'
      && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative))
    .sort((a, b) => b.folder.fsPath.length - a.folder.fsPath.length);
  const match = candidates[0];
  if (!match) {
    throw new Error('Open the Markdown folder as a workspace before copying JSON, or give the agent the sidecar file directly.');
  }
  if (!match.folder.name.trim() || folders.filter(folder => folder.name === match.folder.name).length !== 1) {
    throw new Error('Give each workspace folder a unique name before copying JSON, or give the agent the sidecar file directly.');
  }
  const context = { workspaceFolder: match.folder.name, path: match.relative.split(paths.sep).join('/') };
  // Reuse the public protocol validation for folder labels and relative paths.
  parseReviewTaskSidecar({ schemaVersion: 3, document: paths.basename(documentPath), guidance: 'Validate clipboard context.', context, items: [] });
  return context;
}

/** Copy only portable context; never disclose an absolute local path. */
export function createReviewClipboard(contents: string, documentPath: string, folders: readonly ClipboardWorkspaceFolder[]): string {
  const context = resolveReviewClipboardContext(documentPath, folders);
  const value = parseReviewTaskSidecar(JSON.parse(contents));
  return JSON.stringify(parseReviewTaskSidecar({ ...value, context }));
}
