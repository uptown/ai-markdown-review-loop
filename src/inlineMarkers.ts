import * as vscode from 'vscode';
import { ReviewThread } from './types';

const inlineAnchorPattern = /^<!-- ai-review-anchor:.*?-->\r?\n?/gm;
const inlineAnchorCapturePattern = /^<!-- ai-review-anchor:(.*?)-->/gm;

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
    try {
      const parsed = JSON.parse(match[1].trim());

      if (isInlineAnchorMarker(parsed)) {
        markers.push(parsed);
      }
    } catch {
      // Ignore malformed anchors here; invalid sidecar JSON is handled separately.
    }
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

  const marker = createInlineAnchorMarker(document, thread, sidecarUri);
  const insertLine = resolveMarkerInsertLine(document, thread);
  const edit = new vscode.WorkspaceEdit();

  if (insertLine >= document.lineCount) {
    const lastLine = document.lineAt(document.lineCount - 1);
    const prefix = lastLine.text.length > 0 ? '\n' : '';
    edit.insert(document.uri, lastLine.range.end, `${prefix}${marker}\n`);
  } else {
    edit.insert(document.uri, new vscode.Position(insertLine, 0), `${marker}\n`);
  }

  return vscode.workspace.applyEdit(edit);
}

function createInlineAnchorMarker(
  document: vscode.TextDocument,
  thread: ReviewThread,
  sidecarUri: vscode.Uri
): string {
  const sidecar = vscode.workspace.asRelativePath(sidecarUri, false);
  const payload = {
    id: thread.id,
    status: thread.status,
    hash: thread.anchor.hash,
    sidecar,
    lineStart: thread.anchor.lineStart,
    lineEnd: thread.anchor.lineEnd
  };

  return `<!-- ai-review-anchor:${JSON.stringify(payload)} -->`;
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
