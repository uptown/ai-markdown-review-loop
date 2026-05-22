import * as vscode from 'vscode';
import {
  createInlineAnchorBlockPattern,
  createInlineAnchorMarker,
  dedupeInlineAnchorMarkers,
  readInlineAnchorMarkers,
  removeInlineAnchorMarkerPayloads,
  type InlineAnchorMarker
} from './inlineMarkerPayloads';
import type { ReviewThread } from './types';

export {
  findStaleInlineAnchorMarkers,
  readInlineAnchorMarkers,
  stripInlineAnchorMarkers
} from './inlineMarkerPayloads';
export type { InlineAnchorMarker } from './inlineMarkerPayloads';

export async function insertInlineAnchorMarker(
  document: vscode.TextDocument,
  thread: ReviewThread,
  sidecarUri: vscode.Uri
): Promise<boolean> {
  const markerPayload = createInlineAnchorPayload(thread, sidecarUri);
  const markerBlocks = findInlineAnchorBlocks(document);
  const payloads = [
    ...markerBlocks.flatMap(block => readInlineAnchorMarkers(block.text)),
    markerPayload
  ];
  const marker = createInlineAnchorMarker(dedupeInlineAnchorMarkers(payloads));
  const edit = new vscode.WorkspaceEdit();

  replaceInlineAnchorBlocks(edit, document, markerBlocks, marker);
  return vscode.workspace.applyEdit(edit);
}

export async function removeInlineAnchorMarker(
  document: vscode.TextDocument,
  threadId: string
): Promise<boolean> {
  return removeInlineAnchorMarkers(document, [threadId]);
}

export async function removeInlineAnchorMarkers(
  document: vscode.TextDocument,
  threadIds: Iterable<string>
): Promise<boolean> {
  const ids = new Set(threadIds);

  if (ids.size === 0) {
    return true;
  }

  const markerBlocks = findInlineAnchorBlocks(document);
  const markers = markerBlocks.flatMap(block => readInlineAnchorMarkers(block.text));

  if (!markers.some(marker => ids.has(marker.id))) {
    return true;
  }

  const remainingMarkers = removeInlineAnchorMarkerPayloads(markers, ids);
  const edit = new vscode.WorkspaceEdit();

  replaceInlineAnchorBlocks(
    edit,
    document,
    markerBlocks,
    remainingMarkers.length === 0 ? undefined : createInlineAnchorMarker(remainingMarkers)
  );
  return vscode.workspace.applyEdit(edit);
}

export async function appendClosedReviewLog(
  document: vscode.TextDocument,
  threadId: string,
  status: string,
  resolvedSidecarUri: vscode.Uri
): Promise<boolean> {
  const existingText = document.getText();

  if (existingText.includes(`ai-review-log:{"id":"${threadId}"`)
    || existingText.includes(`ai-review-log:{"id": "${threadId}"`)) {
    return true;
  }

  const sidecar = vscode.workspace.asRelativePath(resolvedSidecarUri, false);
  const marker = `<!-- ai-review-log:${JSON.stringify({
    id: threadId,
    status,
    sidecar,
    updatedAt: new Date().toISOString()
  })} -->`;
  const edit = new vscode.WorkspaceEdit();
  const lastLine = document.lineAt(document.lineCount - 1);
  const prefix = lastLine.text.length > 0 ? '\n' : '';

  edit.insert(document.uri, lastLine.range.end, `${prefix}${marker}\n`);
  return vscode.workspace.applyEdit(edit);
}

function createInlineAnchorPayload(
  thread: ReviewThread,
  sidecarUri: vscode.Uri
): InlineAnchorMarker {
  const sidecar = vscode.workspace.asRelativePath(sidecarUri, false);
  return {
    id: thread.id,
    sidecar
  };
}

function findInlineAnchorBlocks(
  document: vscode.TextDocument,
): { range: vscode.Range; text: string }[] {
  const text = document.getText();
  const blocks: { range: vscode.Range; text: string }[] = [];
  const inlineAnchorPattern = createInlineAnchorBlockPattern();
  let match: RegExpExecArray | null;

  while ((match = inlineAnchorPattern.exec(text)) !== null) {
    blocks.push({
      range: new vscode.Range(
        document.positionAt(match.index),
        document.positionAt(match.index + match[0].length)
      ),
      text: match[0]
    });
  }

  return blocks;
}

function appendDocumentAnchorMarker(
  edit: vscode.WorkspaceEdit,
  document: vscode.TextDocument,
  marker: string
): void {
  const lastLine = document.lineAt(document.lineCount - 1);
  const prefix = lastLine.text.length > 0 ? '\n' : '';

  edit.insert(document.uri, lastLine.range.end, `${prefix}${marker}\n`);
}

function replaceInlineAnchorBlocks(
  edit: vscode.WorkspaceEdit,
  document: vscode.TextDocument,
  markerBlocks: { range: vscode.Range; text: string }[],
  marker: string | undefined
): void {
  const appendPosition = document.lineAt(document.lineCount - 1).range.end;
  const markerAtAppendPosition = markerBlocks.find(block => block.range.contains(appendPosition));

  for (const block of markerBlocks) {
    if (marker && block === markerAtAppendPosition) {
      edit.replace(document.uri, block.range, `${marker}\n`);
      continue;
    }

    edit.replace(document.uri, block.range, '');
  }

  if (marker && !markerAtAppendPosition) {
    appendDocumentAnchorMarker(edit, document, marker);
  }
}
