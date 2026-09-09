import { findSourceAnchorMatches } from './anchorSourceMatches';
import { normalizeAnchorText } from './anchorText';

export interface ReanchorSelection {
  anchorText: string;
  sourceLine: number;
  sourceLineEnd: number;
  contextBefore?: string;
  contextAfter?: string;
}

/** Explicit reattachment requires an identifiable current source range, never a nearby fallback. */
export function resolveReanchorSelection(markdown: string, selection: ReanchorSelection) {
  const lineCount = markdown.split(/\r\n|\r|\n/).length;
  if (!selection.anchorText.trim() || !Number.isSafeInteger(selection.sourceLine)
    || !Number.isSafeInteger(selection.sourceLineEnd) || selection.sourceLine < 1
    || selection.sourceLineEnd < selection.sourceLine || selection.sourceLineEnd > lineCount) {
    throw new Error('Select text in the current Markdown preview before reattaching this thread.');
  }

  const matches = findSourceAnchorMatches(markdown, selection.anchorText).filter(match =>
    match.lineStart >= selection.sourceLine && match.lineEnd <= selection.sourceLineEnd);
  const before = normalizeAnchorText(selection.contextBefore ?? '');
  const after = normalizeAnchorText(selection.contextAfter ?? '');
  const contextMatches = matches.filter(match => (before || after)
    && (!before || normalizeAnchorText(markdown.slice(0, match.start)).endsWith(before))
    && (!after || normalizeAnchorText(markdown.slice(match.start + match.length)).startsWith(after)));
  const match = matches.length === 1 ? matches[0] : contextMatches.length === 1 ? contextMatches[0] : undefined;
  if (!match) {
    throw new Error(matches.length === 0
      ? 'The selection does not match the current Markdown source. Select a shorter plain-text phrase and retry.'
      : 'This selection matches more than one source location. Select a narrower phrase or include more surrounding text.');
  }

  const text = markdown.slice(match.start, match.start + match.length);
  let occurrence = 0;
  let index = markdown.indexOf(text);
  while (index >= 0 && index < match.start) {
    occurrence += 1;
    index = markdown.indexOf(text, index + text.length);
  }
  return { ...match, text, occurrence };
}
