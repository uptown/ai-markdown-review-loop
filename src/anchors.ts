import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { ReviewAnchor } from './types';

interface AnchorOptions {
  occurrence?: number;
  lineHint?: number;
}

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
  const startOffset = lineHint
    ? document.offsetAt(new vscode.Position(lineHint - 1, 0))
    : undefined;
  let match = exact.length > 0
    ? pickOccurrence(findAllMatches(fullText, exact, startOffset), occurrence, startOffset)
    : undefined;

  if (!match && normalized.length > 0) {
    match = pickOccurrence(findAllMatches(fullText, normalized, startOffset), occurrence, startOffset);
  }

  if (!match) {
    return {
      text: normalized,
      lineStart: lineHint,
      lineEnd: lineHint,
      hash: hashAnchor(normalized),
      occurrence
    };
  }

  const start = document.positionAt(match.index);
  const end = document.positionAt(match.index + match.length);

  return {
    text: normalized,
    lineStart: start.line + 1,
    lineEnd: end.line + 1,
    hash: hashAnchor(normalized),
    occurrence
  };
}

export function normalizeAnchorText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function hashAnchor(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function normalizeOccurrence(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function normalizeLineHint(document: vscode.TextDocument, value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(1, Math.min(document.lineCount, Math.floor(value)));
}

function findAllMatches(
  text: string,
  needle: string,
  startOffset = 0
): Array<{ index: number; length: number }> {
  const matches: Array<{ index: number; length: number }> = [];
  let index = text.indexOf(needle, startOffset);

  while (index >= 0) {
    matches.push({ index, length: needle.length });
    index = text.indexOf(needle, index + Math.max(1, needle.length));
  }

  return matches;
}

function pickOccurrence(
  matches: Array<{ index: number; length: number }>,
  occurrence: number,
  startOffset?: number
): { index: number; length: number } | undefined {
  if (matches.length === 0) {
    return undefined;
  }

  if (typeof startOffset === 'number') {
    return matches[0];
  }

  return matches[Math.min(occurrence, matches.length - 1)];
}
