export interface AnchorMatch {
  index: number;
  length: number;
}

export interface AnchorMatchOptions {
  occurrence?: number;
  lineStartHint?: number;
  lineEndHint?: number;
}

export function selectAnchorMatch(
  text: string,
  needle: string,
  options: AnchorMatchOptions = {}
): AnchorMatch | undefined {
  if (!needle) {
    return undefined;
  }

  const matches = findAllMatches(text, needle);

  if (matches.length === 0) {
    return undefined;
  }

  const occurrence = normalizeOccurrence(options.occurrence);
  const requestedMatch = matches[Math.min(occurrence, matches.length - 1)];
  const lineStartHint = normalizeLineHint(options.lineStartHint);

  if (lineStartHint === undefined) {
    return requestedMatch;
  }

  const lineEndHint = Math.max(lineStartHint, normalizeLineHint(options.lineEndHint) ?? lineStartHint);

  if (isMatchInLineRange(text, requestedMatch, lineStartHint, lineEndHint)) {
    return requestedMatch;
  }

  const rangeStartOffset = lineStartOffset(text, lineStartHint);
  const rangeEndOffset = lineEndOffset(text, lineEndHint);
  const rangeMatches = matches.filter(match => {
    return match.index >= rangeStartOffset && match.index < rangeEndOffset;
  });

  if (rangeMatches.length > 0) {
    const matchesBeforeRange = matches.filter(match => match.index < rangeStartOffset).length;
    const localOccurrence = occurrence - matchesBeforeRange;

    if (localOccurrence >= 0 && localOccurrence < rangeMatches.length) {
      return rangeMatches[localOccurrence];
    }

    return rangeMatches[Math.min(Math.max(localOccurrence, 0), rangeMatches.length - 1)];
  }

  const laterMatch = matches.find(match => match.index >= rangeStartOffset);
  return laterMatch ?? requestedMatch;
}

function findAllMatches(text: string, needle: string): AnchorMatch[] {
  const matches: AnchorMatch[] = [];
  let index = text.indexOf(needle);

  while (index >= 0) {
    matches.push({ index, length: needle.length });
    index = text.indexOf(needle, index + Math.max(1, needle.length));
  }

  return matches;
}

function normalizeOccurrence(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function normalizeLineHint(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(1, Math.floor(value));
}

function isMatchInLineRange(
  text: string,
  match: AnchorMatch,
  lineStart: number,
  lineEnd: number
): boolean {
  const matchLineStart = lineNumberAtOffset(text, match.index);
  const matchLineEnd = lineNumberAtOffset(text, match.index + match.length);
  return matchLineStart <= lineEnd && matchLineEnd >= lineStart;
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, text.length));

  for (let index = 0; index < end; index += 1) {
    if (text[index] === '\n') {
      line += 1;
    }
  }

  return line;
}

function lineStartOffset(text: string, oneBasedLine: number): number {
  if (oneBasedLine <= 1) {
    return 0;
  }

  let line = 1;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      line += 1;

      if (line === oneBasedLine) {
        return index + 1;
      }
    }
  }

  return text.length;
}

function lineEndOffset(text: string, oneBasedLine: number): number {
  const start = lineStartOffset(text, oneBasedLine);
  const nextLineStart = lineStartOffset(text, oneBasedLine + 1);
  return nextLineStart > start ? nextLineStart : text.length;
}
