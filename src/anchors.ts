import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { ReviewAnchor } from './types';

export function createAnchor(document: vscode.TextDocument, selectedText: string): ReviewAnchor {
  const exact = selectedText.trim();
  const normalized = normalizeAnchorText(selectedText);
  const fullText = document.getText();
  let index = exact.length > 0 ? fullText.indexOf(exact) : -1;
  let matchLength = exact.length;

  if (index < 0) {
    index = normalized.length > 0 ? fullText.indexOf(normalized) : -1;
    matchLength = normalized.length;
  }

  if (index < 0) {
    return {
      text: normalized,
      hash: hashAnchor(normalized)
    };
  }

  const start = document.positionAt(index);
  const end = document.positionAt(index + matchLength);

  return {
    text: normalized,
    lineStart: start.line + 1,
    lineEnd: end.line + 1,
    hash: hashAnchor(normalized)
  };
}

export function normalizeAnchorText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function hashAnchor(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}
