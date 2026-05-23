import type { ReviewAwareThreadUpdate } from './reviewAwareEdits';
import type { ReviewActor, ReviewDocument, ReviewStatus, ReviewThread } from './types';

export interface ClosedReviewThreadUpdate {
  threadId: string;
  status: Exclude<ReviewStatus, 'open'>;
  closedBy?: ReviewActor;
  closedAt: string;
}

export interface ApplyReviewThreadUpdatesResult {
  reviewDocument: ReviewDocument;
  resolvedReviewDocument: ReviewDocument;
  closedThreads: ClosedReviewThreadUpdate[];
}

export function applyReviewThreadUpdatesToDocuments(
  reviewDocument: ReviewDocument,
  resolvedReviewDocument: ReviewDocument,
  updates: ReviewAwareThreadUpdate[],
  now: string
): ApplyReviewThreadUpdatesResult {
  const activeThreads = reviewDocument.threads.map(cloneReviewThread);
  const resolvedThreads = resolvedReviewDocument.threads.map(cloneReviewThread);
  const closedThreads: ClosedReviewThreadUpdate[] = [];

  for (const threadUpdate of updates) {
    const activeIndex = activeThreads.findIndex(thread => thread.id === threadUpdate.threadId);

    if (activeIndex < 0) {
      continue;
    }

    const thread = mergeThreadUpdate(activeThreads[activeIndex], threadUpdate.update, now);

    if (thread.status !== 'open') {
      const closedStatus = thread.status;
      const closedThread = {
        ...thread,
        closedAt: thread.closedAt ?? now
      };
      activeThreads.splice(activeIndex, 1);
      upsertResolvedThread(resolvedThreads, closedThread);
      closedThreads.push({
        threadId: closedThread.id,
        status: closedStatus,
        closedBy: closedThread.closedBy,
        closedAt: closedThread.closedAt
      });
      continue;
    }

    activeThreads[activeIndex] = thread;
  }

  return {
    reviewDocument: {
      documentUri: reviewDocument.documentUri,
      threads: activeThreads,
      updatedAt: now
    },
    resolvedReviewDocument: {
      documentUri: resolvedReviewDocument.documentUri,
      threads: resolvedThreads,
      updatedAt: closedThreads.length > 0 ? now : resolvedReviewDocument.updatedAt
    },
    closedThreads
  };
}

function mergeThreadUpdate(
  thread: ReviewThread,
  update: Partial<ReviewThread>,
  now: string
): ReviewThread {
  return {
    ...thread,
    ...update,
    anchor: update.anchor ? { ...update.anchor } : { ...thread.anchor },
    thread: update.thread ? update.thread.map(reply => ({ ...reply })) : thread.thread.map(reply => ({ ...reply })),
    suggestedPatch: update.suggestedPatch
      ? { ...update.suggestedPatch }
      : thread.suggestedPatch
        ? { ...thread.suggestedPatch }
        : undefined,
    updatedAt: now
  };
}

function upsertResolvedThread(
  resolvedThreads: ReviewThread[],
  thread: ReviewThread
): void {
  const existingIndex = resolvedThreads.findIndex(candidate => candidate.id === thread.id);

  if (existingIndex >= 0) {
    resolvedThreads[existingIndex] = thread;
    return;
  }

  resolvedThreads.push(thread);
}

function cloneReviewThread(thread: ReviewThread): ReviewThread {
  return {
    ...thread,
    anchor: { ...thread.anchor },
    suggestedPatch: thread.suggestedPatch ? { ...thread.suggestedPatch } : undefined,
    thread: thread.thread.map(reply => ({ ...reply }))
  };
}
