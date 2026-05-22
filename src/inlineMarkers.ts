import * as vscode from 'vscode';
import { ReviewThread } from './types';

const inlineAnchorPattern = /^<!-- ai-review-anchors?:.*?-->\r?\n?/gm;
const inlineAnchorCapturePattern = /^<!-- ai-review-anchor:(.*?)-->/gm;
const inlineAnchorsCapturePattern = /^<!-- ai-review-anchors:(.*?)-->/gm;
const inlineAnchorLinePattern = /^<!-- ai-review-anchors?:.*?-->\s*$/;

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

export function findMissingInlineAnchorMarkers(
  markdown: string,
  knownThreadIds: Iterable<string>
): InlineAnchorMarker[] {
  const knownIds = new Set(knownThreadIds);
  return readInlineAnchorMarkers(markdown).filter(marker => !knownIds.has(marker.id));
}

export async function insertInlineAnchorMarker(
  document: vscode.TextDocument,
  thread: ReviewThread,
  sidecarUri: vscode.Uri
): Promise<boolean> {
  const existingText = document.getText();

  if (existingText.includes(`"id":"${thread.id}"`) || existingText.includes(`"id": "${thread.id}"`)) {
    return true;
  }

  const markerPayload = createInlineAnchorPayload(document, thread, sidecarUri);
  const insertLine = resolveMarkerInsertLine(document, thread);
  const markerBlock = findAdjacentMarkerBlock(document, insertLine);
  const payloads = markerBlock
    ? [...readInlineAnchorMarkers(markerBlock.text), markerPayload]
    : [markerPayload];
  const marker = createInlineAnchorMarker(dedupeMarkers(payloads));
  const edit = new vscode.WorkspaceEdit();

  if (markerBlock) {
    edit.replace(document.uri, markerBlock.range, `${marker}\n`);
  } else if (insertLine >= document.lineCount) {
    const lastLine = document.lineAt(document.lineCount - 1);
    const prefix = lastLine.text.length > 0 ? '\n' : '';
    edit.insert(document.uri, lastLine.range.end, `${prefix}${marker}\n`);
  } else {
    edit.insert(document.uri, new vscode.Position(insertLine, 0), `${marker}\n`);
  }

  return vscode.workspace.applyEdit(edit);
}

export async function removeInlineAnchorMarker(
  document: vscode.TextDocument,
  threadId: string
): Promise<boolean> {
  const text = document.getText();
  const edit = new vscode.WorkspaceEdit();
  let changed = false;
  let match: RegExpExecArray | null;

  inlineAnchorPattern.lastIndex = 0;

  while ((match = inlineAnchorPattern.exec(text)) !== null) {
    const markers = readInlineAnchorMarkers(match[0]);

    if (!markers.some(marker => marker.id === threadId)) {
      continue;
    }

    const remainingMarkers = markers.filter(marker => marker.id !== threadId);
    const replacement = remainingMarkers.length === 0
      ? ''
      : `${createInlineAnchorMarker(remainingMarkers)}${getTrailingNewline(match[0])}`;
    const range = new vscode.Range(
      document.positionAt(match.index),
      document.positionAt(match.index + match[0].length)
    );

    edit.replace(document.uri, range, replacement);
    changed = true;
  }

  return changed ? vscode.workspace.applyEdit(edit) : true;
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
  document: vscode.TextDocument,
  thread: ReviewThread,
  sidecarUri: vscode.Uri
): InlineAnchorMarker {
  const sidecar = vscode.workspace.asRelativePath(sidecarUri, false);
  return {
    id: thread.id,
    status: thread.status,
    hash: thread.anchor.hash,
    sidecar,
    lineStart: thread.anchor.lineStart,
    lineEnd: thread.anchor.lineEnd
  };
}

function createInlineAnchorMarker(payloads: InlineAnchorMarker[]): string {
  if (payloads.length === 1) {
    return `<!-- ai-review-anchor:${JSON.stringify(payloads[0])} -->`;
  }

  return `<!-- ai-review-anchors:${JSON.stringify(payloads)} -->`;
}

function resolveMarkerInsertLine(document: vscode.TextDocument, thread: ReviewThread): number {
  const lineEnd = thread.anchor.lineEnd;

  if (!lineEnd) {
    return Math.min(1, document.lineCount);
  }

  const zeroBasedEndLine = Math.max(0, Math.min(lineEnd - 1, document.lineCount - 1));

  if (isLineInsideFence(document, zeroBasedEndLine)) {
    const closingFenceLine = findClosingFenceLine(document, zeroBasedEndLine);
    return closingFenceLine === undefined ? zeroBasedEndLine + 1 : closingFenceLine + 1;
  }

  return zeroBasedEndLine + 1;
}

function isLineInsideFence(document: vscode.TextDocument, targetLine: number): boolean {
  let insideFence = false;
  let fenceMarker = '';

  for (let line = 0; line <= targetLine; line += 1) {
    const text = document.lineAt(line).text.trim();
    const match = text.match(/^(```+|~~~+)/);

    if (!match) {
      continue;
    }

    if (!insideFence) {
      insideFence = true;
      fenceMarker = match[1][0];
    } else if (match[1][0] === fenceMarker) {
      insideFence = false;
      fenceMarker = '';
    }
  }

  return insideFence;
}

function findClosingFenceLine(document: vscode.TextDocument, startLine: number): number | undefined {
  for (let line = startLine + 1; line < document.lineCount; line += 1) {
    if (/^(```+|~~~+)/.test(document.lineAt(line).text.trim())) {
      return line;
    }
  }

  return undefined;
}

function findAdjacentMarkerBlock(
  document: vscode.TextDocument,
  insertLine: number
): { range: vscode.Range; text: string } | undefined {
  if (document.lineCount === 0 || insertLine >= document.lineCount) {
    return undefined;
  }

  let startLine = insertLine;
  let endLine = insertLine;

  if (!isInlineAnchorLine(document.lineAt(startLine).text)) {
    return undefined;
  }

  while (endLine + 1 < document.lineCount && isInlineAnchorLine(document.lineAt(endLine + 1).text)) {
    endLine += 1;
  }

  const start = new vscode.Position(startLine, 0);
  const end = endLine + 1 < document.lineCount
    ? new vscode.Position(endLine + 1, 0)
    : document.lineAt(endLine).rangeIncludingLineBreak.end;
  const range = new vscode.Range(start, end);

  return {
    range,
    text: document.getText(range)
  };
}

function isInlineAnchorLine(text: string): boolean {
  return inlineAnchorLinePattern.test(text);
}

function parseInlineAnchorPayload(payload: string): InlineAnchorMarker[] {
  try {
    const parsed = JSON.parse(payload.trim());

    if (Array.isArray(parsed)) {
      return parsed.filter(isInlineAnchorMarker);
    }

    return isInlineAnchorMarker(parsed) ? [parsed] : [];
  } catch {
    // Ignore malformed anchors here; invalid sidecar JSON is handled separately.
    return [];
  }
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

function getTrailingNewline(value: string): string {
  if (value.endsWith('\r\n')) {
    return '\r\n';
  }

  if (value.endsWith('\n')) {
    return '\n';
  }

  return '';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}
