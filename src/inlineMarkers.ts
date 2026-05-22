import * as vscode from 'vscode';
import { ReviewThread } from './types';

const inlineAnchorPattern = /^<!-- ai-review-anchors?:.*?-->\r?\n?/gm;
const inlineAnchorCapturePattern = /^<!-- ai-review-anchor:(.*?)-->/gm;
const inlineAnchorsCapturePattern = /^<!-- ai-review-anchors:(.*?)-->/gm;

export interface InlineAnchorMarker {
  id: string;
  status?: string;
  hash?: string;
  sidecar?: string;
  lineStart?: number;
  lineEnd?: number;
}

export function stripInlineAnchorMarkers(markdown: string): string {
  return markdown.replace(inlineAnchorPattern, '');
}

export function readInlineAnchorMarkers(markdown: string): InlineAnchorMarker[] {
  const markers: InlineAnchorMarker[] = [];
  let match: RegExpExecArray | null;

  while ((match = inlineAnchorCapturePattern.exec(markdown)) !== null) {
    markers.push(...parseInlineAnchorPayload(match[1]));
  }

  while ((match = inlineAnchorsCapturePattern.exec(markdown)) !== null) {
    markers.push(...parseInlineAnchorPayload(match[1]));
  }

  return markers;
}

export function findStaleInlineAnchorMarkers(
  markdown: string,
  threads: ReviewThread[]
): InlineAnchorMarker[] {
  const threadsById = new Map(threads.map(thread => [thread.id, thread]));

  return readInlineAnchorMarkers(markdown).filter(marker => {
    const thread = threadsById.get(marker.id);
    return !thread || thread.status !== 'open';
  });
}

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
  const marker = createInlineAnchorMarker(dedupeMarkers(payloads));
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

  const remainingMarkers = dedupeMarkers(markers.filter(marker => !ids.has(marker.id)));
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

function createInlineAnchorMarker(payloads: InlineAnchorMarker[]): string {
  const sidecar = payloads[0]?.sidecar;

  if (sidecar && payloads.every(payload => payload.sidecar === sidecar)) {
    return `<!-- ai-review-anchors:${JSON.stringify({
      sidecar,
      ids: payloads.map(payload => payload.id)
    })} -->`;
  }

  return `<!-- ai-review-anchors:${JSON.stringify(payloads.map(compactMarker))} -->`;
}

function findInlineAnchorBlocks(
  document: vscode.TextDocument,
): { range: vscode.Range; text: string }[] {
  const text = document.getText();
  const blocks: { range: vscode.Range; text: string }[] = [];
  let match: RegExpExecArray | null;

  inlineAnchorPattern.lastIndex = 0;

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

function parseInlineAnchorPayload(payload: string): InlineAnchorMarker[] {
  try {
    const parsed = JSON.parse(payload.trim());

    if (Array.isArray(parsed)) {
      return parsed.filter(isInlineAnchorMarker);
    }

    if (isCompactInlineAnchorGroup(parsed)) {
      return parsed.ids.map(id => ({ id, sidecar: parsed.sidecar }));
    }

    return isInlineAnchorMarker(parsed) ? [parsed] : [];
  } catch {
    // Ignore malformed anchors here; invalid sidecar JSON is handled separately.
    return [];
  }
}

function compactMarker(marker: InlineAnchorMarker): InlineAnchorMarker {
  return {
    id: marker.id,
    sidecar: marker.sidecar
  };
}

function dedupeMarkers(markers: InlineAnchorMarker[]): InlineAnchorMarker[] {
  const seen = new Set<string>();
  const deduped: InlineAnchorMarker[] = [];

  for (const marker of markers) {
    if (seen.has(marker.id)) {
      continue;
    }

    seen.add(marker.id);
    deduped.push(marker);
  }

  return deduped;
}

function isInlineAnchorMarker(value: unknown): value is InlineAnchorMarker {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return false;
  }

  return optionalString(value.status)
    && optionalString(value.hash)
    && optionalString(value.sidecar)
    && optionalNumber(value.lineStart)
    && optionalNumber(value.lineEnd);
}

function isCompactInlineAnchorGroup(value: unknown): value is { sidecar: string; ids: string[] } {
  return isRecord(value)
    && typeof value.sidecar === 'string'
    && Array.isArray(value.ids)
    && value.ids.every(id => typeof id === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}
