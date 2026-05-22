import { hashAnchor, normalizeAnchorText } from './anchorText';
import type { ReviewStatus, ReviewThread } from './types';

const contextRadius = 180;

export type ReviewAwareEditActor = 'user' | 'assistant';
export type ReviewAwareEditIntent =
  | 'apply_suggestion'
  | 'manual_block_edit'
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
    closeTargetAs: input.closeTargetAs
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
    if (!isAffectedThread(thread, plan)) {
      continue;
    }

    const nextAnchor = createNextAnchor(
      thread,
      plan,
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
          text: createOutcomeReplyText(thread, plan),
          createdAt: now
        }
      ]
    };

    if (thread.id === plan.targetThreadId && plan.closeTargetAs) {
      update.status = plan.closeTargetAs;
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

  const candidate = findReplacementAnchorCandidate(
    editedRangeText,
    plan.replacement,
    thread.anchor.text
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
  const context = createOffsetContext(afterMarkdown, plan.start, plan.replacement.length);
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
    occurrence: undefined,
    contextBefore: context.contextBefore,
    contextAfter: context.contextAfter,
    confidence: 'exact',
    lastLocatedLine: lineStart,
    lastLocatedAt: now
  };
}

function findReplacementAnchorCandidate(
  editedRangeText: string,
  replacementText: string,
  anchorText: string
): ReplacementAnchorCandidate | undefined {
  const exactStart = replacementText.indexOf(anchorText);

  if (exactStart >= 0) {
    return {
      text: replacementText.slice(exactStart, exactStart + anchorText.length),
      start: exactStart,
      length: anchorText.length
    };
  }

  const editedAnchorStart = editedRangeText.indexOf(anchorText);

  if (editedAnchorStart < 0) {
    return undefined;
  }

  const prefix = editedRangeText.slice(0, editedAnchorStart);
  const suffix = editedRangeText.slice(editedAnchorStart + anchorText.length);

  if (!replacementText.startsWith(prefix) || !replacementText.endsWith(suffix)) {
    return undefined;
  }

  const start = prefix.length;
  const end = replacementText.length - suffix.length;

  if (end <= start) {
    return undefined;
  }

  return {
    text: replacementText.slice(start, end),
    start,
    length: end - start
  };
}

function isAffectedThread(thread: ReviewThread, plan: ReviewAwareEditPlan): boolean {
  if (thread.status !== 'open' && thread.id !== plan.targetThreadId) {
    return false;
  }

  if (thread.id === plan.targetThreadId) {
    return true;
  }

  const threadLineStart = thread.anchor.lastLocatedLine ?? thread.anchor.lineStart;

  if (!threadLineStart) {
    return false;
  }

  const threadLineEnd = Math.max(threadLineStart, thread.anchor.lineEnd ?? threadLineStart);
  return threadLineStart <= plan.lineEnd && threadLineEnd >= plan.lineStart;
}

function createOutcomeReplyText(thread: ReviewThread, plan: ReviewAwareEditPlan): string {
  if (thread.id === plan.targetThreadId && plan.intent === 'apply_suggestion') {
    return 'Review update: applied the suggested edit and kept this thread attached.';
  }

  if (plan.intent === 'rewrite_section') {
    return 'Review update: rewrote the reviewed text and kept this comment attached.';
  }

  if (plan.intent === 'manual_mermaid_edit') {
    return 'Review update: edited the Mermaid source and kept this comment attached.';
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
