import { normalizeAnchorText } from './anchorText';

export interface SourceAnchorMatch {
  start: number;
  length: number;
  lineStart: number;
  lineEnd: number;
}

/** Locate whitespace-normalized snippets without losing their original source range. */
export function findSourceAnchorMatches(markdown: string, selectedText: string): SourceAnchorMatch[] {
  const needle = normalizeAnchorText(selectedText);
  if (!needle) {
    return [];
  }

  const pattern = new RegExp(needle.split(' ').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  const lineStarts = [0, ...Array.from(markdown.matchAll(/\r\n|\r|\n/g), match => match.index! + match[0].length)];
  const lineAt = (offset: number) => {
    let lower = 0;
    let upper = lineStarts.length;
    while (lower + 1 < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (lineStarts[middle] <= offset) lower = middle;
      else upper = middle;
    }
    return lower + 1;
  };
  const matches: SourceAnchorMatch[] = [];
  for (const match of markdown.matchAll(pattern)) {
    const start = match.index!;
    const length = match[0].length;
    matches.push({ start, length, lineStart: lineAt(start), lineEnd: lineAt(start + length - 1) });
  }
  return matches;
}
