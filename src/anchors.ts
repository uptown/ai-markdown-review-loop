import * as vscode from 'vscode';
import { selectAnchorMatch } from './anchorMatching';
import { hashAnchor, normalizeAnchorText } from './anchorText';
import type { ReviewAnchor } from './types';

export { hashAnchor, normalizeAnchorText } from './anchorText';

interface AnchorOptions {
  occurrence?: number;
  lineHint?: number;
  lineEndHint?: number;
}

const contextRadius = 180;

export function createAnchor(
  document: vscode.TextDocument,
  selectedText: string,
  options: AnchorOptions = {}
): ReviewAnchor {
  const exact = selectedText.trim();
  const normalized = normalizeAnchorText(selectedText);
  const fullText = document.getText();
  const occurrence = normalizeOccurrence(options.occurrence);
  const lineHint = normalizeLineHint(document, options.lineHint);
  const lineEndHint = normalizeLineEndHint(document, lineHint, options.lineEndHint);
  let match = exact.length > 0
    ? selectAnchorMatch(fullText, exact, {
      occurrence,
      lineStartHint: lineHint,
      lineEndHint
    })
    : undefined;

  if (!match && normalized.length > 0) {
    match = selectAnchorMatch(fullText, normalized, {
      occurrence,
      lineStartHint: lineHint,
      lineEndHint
    });
  }

  if (!match) {
    const lineContext = createLineContext(document, lineHint);

    return {
      text: normalized,
      lineStart: lineHint,
      lineEnd: lineHint,
      hash: hashAnchor(normalized),
      occurrence,
      contextBefore: lineContext.contextBefore,
      contextAfter: lineContext.contextAfter
    };
  }

  const start = document.positionAt(match.index);
  const end = document.positionAt(match.index + match.length);
  const context = createOffsetContext(fullText, match.index, match.length);

  return {
    text: normalized,
    lineStart: start.line + 1,
    lineEnd: end.line + 1,
    hash: hashAnchor(normalized),
    occurrence,
    contextBefore: context.contextBefore,
    contextAfter: context.contextAfter
  };
}

function normalizeOccurrence(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

function normalizeLineHint(document: vscode.TextDocument, value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(1, Math.min(document.lineCount, Math.floor(value)));
}

function normalizeLineEndHint(
  document: vscode.TextDocument,
  lineStart: number | undefined,
  value: number | undefined
): number | undefined {
  const lineEnd = normalizeLineHint(document, value);

  if (!lineStart || !lineEnd) {
    return lineEnd;
  }

  return Math.max(lineStart, lineEnd);
}

function createOffsetContext(
  fullText: string,
  matchIndex: number,
  matchLength: number
): Pick<ReviewAnchor, 'contextBefore' | 'contextAfter'> {
  const before = fullText.slice(Math.max(0, matchIndex - contextRadius), matchIndex);
  const after = fullText.slice(matchIndex + matchLength, matchIndex + matchLength + contextRadius);

  return {
    contextBefore: normalizeAnchorText(before) || undefined,
    contextAfter: normalizeAnchorText(after) || undefined
  };
}

function createLineContext(
  document: vscode.TextDocument,
  lineHint: number | undefined
): Pick<ReviewAnchor, 'contextBefore' | 'contextAfter'> {
  if (!lineHint) {
    return {};
  }

  const line = Math.max(0, Math.min(document.lineCount - 1, lineHint - 1));
  const lineRange = document.lineAt(line).range;
  return createOffsetContext(
    document.getText(),
    document.offsetAt(lineRange.start),
    document.offsetAt(lineRange.end) - document.offsetAt(lineRange.start)
  );
}
