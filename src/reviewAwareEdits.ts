import { hashAnchor, normalizeAnchorText } from './anchorText';
import type { ReviewStatus, ReviewThread } from './types';

const contextRadius = 180;

export type ReviewAwareEditActor = 'user' | 'assistant';
export type ReviewAwareEditIntent = 'apply_suggestion' | 'manual_block_edit' | 'rewrite_section';
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
  const editedRangeText = normalizeAnchorText(beforeMarkdown.slice(plan.start, plan.end));
  const replacementAnchorText = normalizeAnchorText(plan.replacement);
  const replacementStartLine = lineNumberAtOffset(afterMarkdown, plan.start);
  const replacementEndLine = plan.replacement.length > 0
    ? lineNumberAtOffset(afterMarkdown, plan.start + plan.replacement.length)
    : replacementStartLine;
  const context = createOffsetContext(
    afterMarkdown,
    plan.start,
    plan.replacement.length
  );
  const updates: ReviewAwareThreadUpdate[] = [];

  for (const thread of threads) {
    if (!isAffectedThread(thread, plan)) {
      continue;
    }

    const nextAnchor = createNextAnchor(
      thread,
      plan,
      editedRangeText,
      replacementAnchorText,
      replacementStartLine,
      replacementEndLine,
      context,
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
  editedRangeText: string,
  replacementAnchorText: string,
  replacementStartLine: number,
  replacementEndLine: number,
  context: Pick<ReviewThread['anchor'], 'contextBefore' | 'contextAfter'>,
  now: string
): ReviewThread['anchor'] {
  const existingAnchorText = normalizeAnchorText(thread.anchor.text);
  const anchorCoveredWholeEditedRange = Boolean(existingAnchorText)
    && existingAnchorText === editedRangeText;

  if ((thread.id === plan.targetThreadId || anchorCoveredWholeEditedRange) && replacementAnchorText) {
    return {
      ...thread.anchor,
      text: replacementAnchorText,
      lineStart: replacementStartLine,
      lineEnd: replacementEndLine,
      hash: hashAnchor(replacementAnchorText),
      occurrence: undefined,
      contextBefore: context.contextBefore,
      contextAfter: context.contextAfter,
      confidence: 'exact',
      lastLocatedLine: replacementStartLine,
      lastLocatedAt: now
    };
  }

  const normalizedReplacement = normalizeAnchorText(plan.replacement);
  const stillExistsInEditedRange = Boolean(existingAnchorText)
    && normalizedReplacement.includes(existingAnchorText);
  const nextAnchorText = thread.anchor.text;

  return {
    ...thread.anchor,
    text: nextAnchorText,
    lineStart: replacementStartLine,
    lineEnd: stillExistsInEditedRange ? replacementEndLine : replacementStartLine,
    hash: hashAnchor(nextAnchorText),
    occurrence: undefined,
    contextBefore: context.contextBefore,
    contextAfter: context.contextAfter,
    confidence: stillExistsInEditedRange ? 'exact' : 'missing',
    lastLocatedLine: replacementStartLine,
    lastLocatedAt: now
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
    return 'Edit outcome: applied the suggested Markdown edit and refreshed this thread anchor.';
  }

  if (plan.intent === 'rewrite_section') {
    return 'Edit outcome: rewrote overlapping Markdown through the review-aware edit pipeline and refreshed this thread anchor.';
  }

  return 'Edit outcome: edited overlapping Markdown through the review-aware edit pipeline and refreshed this thread anchor.';
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
