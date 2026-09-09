import { hashAnchor, normalizeAnchorText } from './anchorText';
import { findTableAnchorReplacementCandidate, type MarkdownTableSourceMapping } from './tableEdits';
import type { ReviewAnchor, ReviewStatus, ReviewThread } from './types';

const contextRadius = 180;

export type ReviewAwareEditActor = 'user' | 'assistant';
export type ReviewAwareEditIntent =
  | 'apply_suggestion'
  | 'delete_block'
  | 'insert_block'
  | 'manual_block_edit'
  | 'manual_table_edit'
  | 'manual_mermaid_edit'
  | 'rewrite_section';
export type ClosingReviewStatus = Extract<ReviewStatus, 'accepted' | 'resolved' | 'rejected'>;

export interface ReviewAwareEditPlan {
  start: number;
  end: number;
  replacement: string;
  lineStart: number;
  lineEnd: number;
  actor: ReviewAwareEditActor;
  intent: ReviewAwareEditIntent;
  targetThreadId?: string;
  closeTargetAs?: ClosingReviewStatus;
  affectsExistingThreads?: boolean;
  tableSourceMapping?: MarkdownTableSourceMapping;
}

export interface CreateOffsetEditPlanInput {
  start: number;
  end: number;
  replacement: string;
  actor: ReviewAwareEditActor;
  intent: ReviewAwareEditIntent;
  targetThreadId?: string;
  closeTargetAs?: ClosingReviewStatus;
}

export interface CreateLineRangeEditPlanInput {
  lineStart: number;
  lineEnd: number;
  replacement: string;
  actor: ReviewAwareEditActor;
  intent: ReviewAwareEditIntent;
  targetThreadId?: string;
  closeTargetAs?: ClosingReviewStatus;
  tableSourceMapping?: MarkdownTableSourceMapping;
}

export interface CreateLineRangeDeletePlanInput {
  lineStart: number;
  lineEnd: number;
  actor: ReviewAwareEditActor;
  intent: Extract<ReviewAwareEditIntent, 'delete_block'>;
}

export interface CreateLineInsertionEditPlanInput {
  afterLine: number;
  replacement: string;
  actor: ReviewAwareEditActor;
  intent: Extract<ReviewAwareEditIntent, 'insert_block'>;
}

export interface ReviewAwareThreadUpdate {
  threadId: string;
  update: Partial<ReviewThread>;
}

interface ReplacementAnchorCandidate {
  text: string;
  start: number;
  length: number;
}

export function createOffsetEditPlan(
  markdown: string,
  input: CreateOffsetEditPlanInput
): ReviewAwareEditPlan {
  const start = clampOffset(markdown, input.start);
  const end = Math.max(start, clampOffset(markdown, input.end));

  return {
    start,
    end,
    replacement: input.replacement,
    lineStart: lineNumberAtOffset(markdown, start),
    lineEnd: lineNumberAtOffset(markdown, end),
    actor: input.actor,
    intent: input.intent,
    targetThreadId: input.targetThreadId,
    closeTargetAs: input.closeTargetAs
  };
}

export function createLineRangeEditPlan(
  markdown: string,
  input: CreateLineRangeEditPlanInput
): ReviewAwareEditPlan {
  const lineStart = normalizeLineNumber(input.lineStart);
  const lineEnd = Math.max(lineStart, normalizeLineNumber(input.lineEnd));
  const start = lineStartOffset(markdown, lineStart);
  const end = lineEndOffset(markdown, lineEnd);

  return {
    start,
    end,
    replacement: input.replacement,
    lineStart,
    lineEnd,
    actor: input.actor,
    intent: input.intent,
    targetThreadId: input.targetThreadId,
    closeTargetAs: input.closeTargetAs,
    tableSourceMapping: input.tableSourceMapping
  };
}

export function createLineRangeDeletePlan(
  markdown: string,
  input: CreateLineRangeDeletePlanInput
): ReviewAwareEditPlan {
  const lineStart = normalizeLineNumber(input.lineStart);
  const lineEnd = Math.max(lineStart, normalizeLineNumber(input.lineEnd));
  const start = lineStartOffset(markdown, lineStart);
  const end = lineEndOffsetIncludingFollowingNewline(markdown, lineEnd);
  const deletionStart = end === markdown.length
    ? lineStartOffsetIncludingPreviousNewline(markdown, start)
    : start;

  return {
    start: deletionStart,
    end,
    replacement: '',
    lineStart,
    lineEnd,
    actor: input.actor,
    intent: input.intent
  };
}

export function createLineInsertionEditPlan(
  markdown: string,
  input: CreateLineInsertionEditPlanInput
): ReviewAwareEditPlan {
  const afterLine = normalizeLineNumber(input.afterLine);
  const start = lineEndOffset(markdown, afterLine);
  const normalizedReplacement = normalizeInsertionBlock(markdown, input.replacement);
  const replacement = createInsertionReplacement(markdown, start, normalizedReplacement);
  const leadingLineBreaks = countLeadingLineBreaks(replacement);
  const insertedLineCount = Math.max(
    1,
    countLineBreaks(normalizedReplacement) + (normalizedReplacement ? 1 : 0)
  );
  const lineStart = markdown.length === 0 ? 1 : afterLine + Math.max(1, leadingLineBreaks);

  return {
    start,
    end: start,
    replacement,
    lineStart,
    lineEnd: lineStart + insertedLineCount - 1,
    actor: input.actor,
    intent: input.intent,
    affectsExistingThreads: false
  };
}

export function applyReviewAwareEditToMarkdown(
  markdown: string,
  plan: ReviewAwareEditPlan
): string {
  const start = clampOffset(markdown, plan.start);
  const end = Math.max(start, clampOffset(markdown, plan.end));
  return `${markdown.slice(0, start)}${plan.replacement}${markdown.slice(end)}`;
}

export function buildReviewAwareThreadUpdates(
  beforeMarkdown: string,
  threads: ReviewThread[],
  plan: ReviewAwareEditPlan,
  now: string
): ReviewAwareThreadUpdate[] {
  const afterMarkdown = applyReviewAwareEditToMarkdown(beforeMarkdown, plan);
  const editedRangeText = beforeMarkdown.slice(plan.start, plan.end);
  const replacementAnchorText = normalizeAnchorText(plan.replacement);
  const updates: ReviewAwareThreadUpdate[] = [];

  for (const thread of threads) {
    if (!isAffectedThread(thread, plan, beforeMarkdown)) {
      continue;
    }

    const nextAnchor = createNextAnchor(
      thread,
      plan,
      beforeMarkdown,
      afterMarkdown,
      editedRangeText,
      replacementAnchorText,
      now
    );
    const update: Partial<ReviewThread> = {
      anchor: nextAnchor,
      thread: [
        ...thread.thread,
        {
          role: plan.actor === 'assistant' ? 'assistant' : 'user',
          text: createOutcomeReplyText(thread, plan, nextAnchor.confidence === 'missing'),
          createdAt: now
        }
      ]
    };

    if (thread.id === plan.targetThreadId && plan.closeTargetAs) {
      update.status = plan.closeTargetAs;
      update.closedBy = plan.actor;
      update.closedAt = now;
    }

    updates.push({
      threadId: thread.id,
      update
    });
  }

  return updates;
}

export function lineNumberAtOffset(text: string, offset: number): number {
  const end = clampOffset(text, offset);
  let line = 1;

  for (let index = 0; index < end; index += 1) {
    const char = text.charCodeAt(index);

    if (char === 10) {
      line += 1;
    } else if (char === 13 && text.charCodeAt(index + 1) !== 10) {
      line += 1;
    }
  }

  return line;
}

function createNextAnchor(
  thread: ReviewThread,
  plan: ReviewAwareEditPlan,
  beforeMarkdown: string,
  afterMarkdown: string,
  editedRangeText: string,
  replacementAnchorText: string,
  now: string
): ReviewThread['anchor'] {
  const existingAnchorText = normalizeAnchorText(thread.anchor.text);
  const anchorCoveredWholeEditedRange = Boolean(existingAnchorText)
    && existingAnchorText === normalizeAnchorText(editedRangeText);

  if ((thread.id === plan.targetThreadId || anchorCoveredWholeEditedRange) && replacementAnchorText) {
    return createExactReplacementAnchor(
      thread,
      afterMarkdown,
      plan.start,
      {
        text: plan.replacement,
        start: 0,
        length: plan.replacement.length
      },
      now
    );
  }

  if (plan.intent === 'manual_table_edit') {
    const preferredTableLineIndex = tableLineIndexForThread(thread, plan);
    const tableCandidate = findTableAnchorReplacementCandidate(
      editedRangeText,
      plan.replacement,
      thread.anchor.text,
      preferredTableLineIndex,
      plan.tableSourceMapping
    );

    if (tableCandidate) {
      return createExactReplacementAnchor(
        thread,
        afterMarkdown,
        plan.start,
        tableCandidate,
        now
      );
    }
  }

  // A missing table cell must not fall back to a matching value in another cell.
  const candidate = plan.intent === 'manual_table_edit' ? undefined : findReplacementAnchorCandidate(
    beforeMarkdown,
    editedRangeText,
    plan,
    thread.anchor
  );

  if (candidate) {
    return createExactReplacementAnchor(
      thread,
      afterMarkdown,
      plan.start,
      candidate,
      now
    );
  }

  const missingLine = lineNumberAtOffset(afterMarkdown, plan.start);
  const context = plan.intent === 'delete_block'
    ? {}
    : createOffsetContext(afterMarkdown, plan.start, plan.replacement.length);
  const nextAnchorText = thread.anchor.text;
  return {
    ...thread.anchor,
    text: nextAnchorText,
    lineStart: missingLine,
    lineEnd: missingLine,
    hash: hashAnchor(nextAnchorText),
    occurrence: undefined,
    contextBefore: context.contextBefore,
    contextAfter: context.contextAfter,
    confidence: 'missing',
    lastLocatedLine: missingLine,
    lastLocatedAt: now
  };
}

function createExactReplacementAnchor(
  thread: ReviewThread,
  afterMarkdown: string,
  replacementOffset: number,
  candidate: ReplacementAnchorCandidate,
  now: string
): ReviewThread['anchor'] {
  const nextAnchorText = normalizeAnchorText(candidate.text);
  const candidateOffset = replacementOffset + candidate.start;
  const lineStart = lineNumberAtOffset(afterMarkdown, candidateOffset);
  const lineEnd = candidate.length > 0
    ? lineNumberAtOffset(afterMarkdown, candidateOffset + candidate.length)
    : lineStart;
  const context = createOffsetContext(afterMarkdown, candidateOffset, candidate.length);

  return {
    ...thread.anchor,
    text: nextAnchorText,
    lineStart,
    lineEnd,
    hash: hashAnchor(nextAnchorText),
    occurrence: occurrenceAtOffset(afterMarkdown, nextAnchorText, candidateOffset),
    contextBefore: context.contextBefore,
    contextAfter: context.contextAfter,
    confidence: 'exact',
    lastLocatedLine: lineStart,
    lastLocatedAt: now
  };
}

function occurrenceAtOffset(markdown: string, anchorText: string, offset: number): number | undefined {
  if (!anchorText || !markdown.startsWith(anchorText, offset)) {
    return undefined;
  }

  let occurrence = 0;
  let index = markdown.indexOf(anchorText);
  while (index >= 0 && index < offset) {
    occurrence += 1;
    index = markdown.indexOf(anchorText, index + anchorText.length);
  }

  return index === offset ? occurrence : undefined;
}

function findReplacementAnchorCandidate(
  beforeMarkdown: string,
  editedRangeText: string,
  plan: ReviewAwareEditPlan,
  anchor: ReviewAnchor
): ReplacementAnchorCandidate | undefined {
  const sourceMatch = findSourceAnchorMatch(beforeMarkdown, anchor);

  if (!sourceMatch) {
    return undefined;
  }

  const start = sourceMatch.start - plan.start;
  const end = start + sourceMatch.length;
  const replacementText = plan.replacement;

  if (start < 0 || end > editedRangeText.length) {
    return undefined;
  }

  let prefixLength = 0;
  while (prefixLength < Math.min(editedRangeText.length, replacementText.length)
    && editedRangeText[prefixLength] === replacementText[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (suffixLength < Math.min(editedRangeText.length, replacementText.length)
    && editedRangeText[editedRangeText.length - suffixLength - 1]
      === replacementText[replacementText.length - suffixLength - 1]) {
    suffixLength += 1;
  }

  if (editedRangeText === replacementText) {
    return { text: replacementText.slice(start, end), start, length: end - start };
  }

  // Repeated adjacent text can make two different deletions/insertions equally valid.
  // Only retain the prefix/suffix that is common to both interpretations.
  const stablePrefix = Math.min(prefixLength, editedRangeText.length - suffixLength, replacementText.length - suffixLength);
  const stableSuffix = Math.min(suffixLength, editedRangeText.length - prefixLength, replacementText.length - prefixLength);
  const lengthDelta = replacementText.length - editedRangeText.length;
  let replacementStart: number;
  let replacementEnd: number;

  if (end <= stablePrefix) {
    replacementStart = start;
    replacementEnd = end;
  } else if (start >= editedRangeText.length - stableSuffix) {
    replacementStart = start + lengthDelta;
    replacementEnd = end + lengthDelta;
  } else if (start <= stablePrefix && end >= editedRangeText.length - stableSuffix) {
    replacementStart = start;
    replacementEnd = end + lengthDelta;
  } else {
    return undefined;
  }

  return replacementEnd > replacementStart ? {
    text: replacementText.slice(replacementStart, replacementEnd),
    start: replacementStart,
    length: replacementEnd - replacementStart
  } : undefined;
}

function findSourceAnchorMatch(markdown: string, anchor: ReviewAnchor): ReplacementAnchorCandidate | undefined {
  if (!anchor.text) {
    return undefined;
  }

  const matches: ReplacementAnchorCandidate[] = [];
  let start = markdown.indexOf(anchor.text);
  while (start >= 0) {
    matches.push({ text: anchor.text, start, length: anchor.text.length });
    start = markdown.indexOf(anchor.text, start + anchor.text.length);
  }

  const lineStart = anchor.lastLocatedLine ?? anchor.lineStart;
  const lineEnd = Math.max(lineStart ?? 1, anchor.lineEnd ?? lineStart ?? 1);
  const inLineRange = (candidate: ReplacementAnchorCandidate) => !lineStart
    || (lineNumberAtOffset(markdown, candidate.start) >= lineStart
      && lineNumberAtOffset(markdown, candidate.start) <= lineEnd);
  const candidates = matches.filter(inLineRange);
  const occurrenceMatch = Number.isSafeInteger(anchor.occurrence) && (anchor.occurrence ?? -1) >= 0
    ? matches[anchor.occurrence!]
    : undefined;
  const withContext = candidates.filter(candidate => {
    const context = createOffsetContext(markdown, candidate.start, candidate.length);
    return Boolean(anchor.contextBefore || anchor.contextAfter)
      && (!anchor.contextBefore || context.contextBefore?.endsWith(anchor.contextBefore))
      && (!anchor.contextAfter || context.contextAfter?.startsWith(anchor.contextAfter));
  });

  if (withContext.length === 1) {
    return withContext[0];
  }

  if (occurrenceMatch && inLineRange(occurrenceMatch)) {
    return occurrenceMatch;
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

function isAffectedThread(thread: ReviewThread, plan: ReviewAwareEditPlan, beforeMarkdown: string): boolean {
  if (thread.status !== 'open' && thread.id !== plan.targetThreadId) {
    return false;
  }

  if (thread.id === plan.targetThreadId) {
    return true;
  }

  if (plan.affectsExistingThreads === false) {
    return false;
  }

  const sourceMatch = findSourceAnchorMatch(beforeMarkdown, thread.anchor);
  if (sourceMatch && (sourceMatch.start >= plan.end || sourceMatch.start + sourceMatch.length <= plan.start)) {
    return false;
  }

  const threadLineStart = thread.anchor.lastLocatedLine ?? thread.anchor.lineStart;

  if (!threadLineStart) {
    return false;
  }

  const threadLineEnd = Math.max(threadLineStart, thread.anchor.lineEnd ?? threadLineStart);
  return threadLineStart <= plan.lineEnd && threadLineEnd >= plan.lineStart;
}

function tableLineIndexForThread(
  thread: ReviewThread,
  plan: ReviewAwareEditPlan
): number | undefined {
  const locatedLine = thread.anchor.lastLocatedLine ?? thread.anchor.lineStart;

  if (!locatedLine) {
    return undefined;
  }

  return Math.max(0, locatedLine - plan.lineStart);
}

function createOutcomeReplyText(thread: ReviewThread, plan: ReviewAwareEditPlan, anchorMissing: boolean): string {
  if (anchorMissing && plan.intent !== 'delete_block') {
    const action = plan.intent === 'manual_table_edit' ? 'edited the table'
      : plan.intent === 'manual_mermaid_edit' ? 'edited the Mermaid source'
        : plan.intent === 'apply_suggestion' ? 'applied the suggested edit'
          : 'edited the reviewed text';
    return `Review update: ${action}; this comment now needs re-anchor or closure.`;
  }

  if (thread.id === plan.targetThreadId && plan.intent === 'apply_suggestion') {
    return 'Review update: applied the suggested edit and kept this thread attached.';
  }

  if (plan.intent === 'rewrite_section') {
    return 'Review update: rewrote the reviewed text and kept this comment attached.';
  }

  if (plan.intent === 'manual_mermaid_edit') {
    return 'Review update: edited the Mermaid source and kept this comment attached.';
  }

  if (plan.intent === 'delete_block') {
    return 'Review update: deleted the reviewed block; this comment now needs re-anchor or closure.';
  }

  if (plan.intent === 'insert_block') {
    return 'Review update: inserted a new Markdown block near this comment.';
  }

  if (plan.intent === 'manual_table_edit') {
    return 'Review update: edited the table and kept this comment attached.';
  }

  return 'Review update: edited the reviewed text and kept this comment attached.';
}

function createOffsetContext(
  fullText: string,
  matchIndex: number,
  matchLength: number
): Pick<ReviewThread['anchor'], 'contextBefore' | 'contextAfter'> {
  const start = clampOffset(fullText, matchIndex);
  const end = Math.max(start, clampOffset(fullText, matchIndex + matchLength));
  const before = fullText.slice(Math.max(0, start - contextRadius), start);
  const after = fullText.slice(end, end + contextRadius);

  return {
    contextBefore: normalizeAnchorText(before) || undefined,
    contextAfter: normalizeAnchorText(after) || undefined
  };
}

function lineStartOffset(text: string, oneBasedLine: number): number {
  if (oneBasedLine <= 1) {
    return 0;
  }

  let line = 1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);

    if (char === 10 || char === 13) {
      if (char === 13 && text.charCodeAt(index + 1) === 10) {
        index += 1;
      }

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

  for (let index = start; index < text.length; index += 1) {
    const char = text.charCodeAt(index);

    if (char === 10 || char === 13) {
      return index;
    }
  }

  return text.length;
}

function createInsertionReplacement(markdown: string, offset: number, normalizedReplacement: string): string {
  const eol = detectLineEnding(markdown);

  if (!normalizedReplacement) {
    return '';
  }

  if (markdown.length === 0) {
    return normalizedReplacement;
  }

  const prefix = offset <= 0
    ? ''
    : needsInsertionBlankLineBefore(markdown, offset) ? `${eol}${eol}` : eol;
  const suffix = needsInsertionBlankLineAfter(markdown, offset) ? eol : '';
  return `${prefix}${normalizedReplacement}${suffix}`;
}

function needsInsertionBlankLineBefore(markdown: string, offset: number): boolean {
  if (offset <= 0) {
    return false;
  }

  return !/(?:\r\n|\r|\n){2}$/.test(markdown.slice(0, offset));
}

function needsInsertionBlankLineAfter(markdown: string, offset: number): boolean {
  const after = markdown.slice(offset);

  if (!after) {
    return false;
  }

  return !/^(?:\r\n|\r|\n){2}/.test(after);
}

function normalizeInsertionBlock(markdown: string, replacement: string): string {
  const eol = detectLineEnding(markdown);
  return stripOuterLineBreaks(replacement).replace(/\r\n|\r|\n/g, eol);
}

function detectLineEnding(text: string): string {
  const match = text.match(/\r\n|\r|\n/);
  return match?.[0] ?? '\n';
}

function stripOuterLineBreaks(value: string): string {
  return value.replace(/^(?:\r\n|\r|\n)+|(?:\r\n|\r|\n)+$/g, '');
}

function countLineBreaks(value: string): number {
  return (value.match(/\r\n|\r|\n/g) ?? []).length;
}

function countLeadingLineBreaks(value: string): number {
  return countLineBreaks(value.match(/^(?:\r\n|\r|\n)+/)?.[0] ?? '');
}

function lineEndOffsetIncludingFollowingNewline(text: string, lineEnd: number): number {
  const end = lineEndOffset(text, lineEnd);

  if (end < text.length) {
    const char = text.charCodeAt(end);

    if (char === 13 && text.charCodeAt(end + 1) === 10) {
      return end + 2;
    }

    if (char === 10 || char === 13) {
      return end + 1;
    }
  }

  return end;
}

function lineStartOffsetIncludingPreviousNewline(text: string, start: number): number {
  if (start <= 0) {
    return 0;
  }

  const previous = text.charCodeAt(start - 1);

  if (previous === 10) {
    return start >= 2 && text.charCodeAt(start - 2) === 13
      ? start - 2
      : start - 1;
  }

  if (previous === 13) {
    return start - 1;
  }

  return start;
}

function normalizeLineNumber(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

function clampOffset(text: string, offset: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }

  return Math.max(0, Math.min(text.length, Math.floor(offset)));
}
