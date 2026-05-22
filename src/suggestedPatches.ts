import type { ReviewAnchor, SuggestedPatch } from './types';

export type ApplyPatchResult =
  | 'applied'
  | 'ambiguous'
  | 'failed'
  | 'lowConfidenceAnchor'
  | 'missingPatch'
  | 'originalNotFound';

export type SuggestedPatchSelection =
  | {
      result: 'applied';
      start: number;
      end: number;
      replacement: string;
    }
  | {
      result: Exclude<ApplyPatchResult, 'applied' | 'failed'>;
    };

export function selectSuggestedPatchReplacement(
  markdown: string,
  patch: SuggestedPatch | undefined,
  anchor: ReviewAnchor
): SuggestedPatchSelection {
  if (!patch || patch.mode !== 'replace' || patch.original.length === 0) {
    return { result: 'missingPatch' };
  }

  if (anchor.confidence === 'approximate'
    || anchor.confidence === 'missing'
    || anchor.confidence === 'ambiguous') {
    return { result: 'lowConfidenceAnchor' };
  }

  const matches = findAllPatchMatches(markdown, patch.original);

  if (matches.length === 0) {
    return { result: 'originalNotFound' };
  }

  const match = selectPatchMatch(markdown, patch.original.length, anchor, matches);

  if (!match) {
    return { result: 'ambiguous' };
  }

  return {
    result: 'applied',
    start: match.index,
    end: match.index + patch.original.length,
    replacement: patch.replacement
  };
}

function findAllPatchMatches(text: string, original: string): Array<{ index: number }> {
  const matches: Array<{ index: number }> = [];
  let index = text.indexOf(original);

  while (index >= 0) {
    matches.push({ index });
    index = text.indexOf(original, index + Math.max(1, original.length));
  }

  return matches;
}

function selectPatchMatch(
  markdown: string,
  originalLength: number,
  anchor: ReviewAnchor,
  matches: Array<{ index: number }>
): { index: number } | undefined {
  if (matches.length === 1) {
    return matches[0];
  }

  const lineHint = anchor.lastLocatedLine ?? anchor.lineStart;

  if (!lineHint) {
    return undefined;
  }

  const lineStart = Math.max(1, lineHint);
  const lineEnd = Math.max(lineStart, anchor.lineEnd ?? lineStart);
  const matchingLineMatches = matches.filter(match => {
    const startLine = lineNumberAtOffset(markdown, match.index);
    const endLine = lineNumberAtOffset(markdown, match.index + originalLength);
    return startLine <= lineEnd && endLine >= lineStart;
  });

  return matchingLineMatches.length === 1 ? matchingLineMatches[0] : undefined;
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, text.length));

  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }

  return line;
}
