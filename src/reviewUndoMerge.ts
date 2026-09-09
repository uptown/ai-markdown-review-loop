import { isDeepStrictEqual } from 'util';
import type { ReviewDocumentPair } from './reviewSidecarCodec';
import type { ReviewReply, ReviewThread } from './types';

export interface ReviewUndoProtection {
  fields: Map<string, Set<string>>;
  decisions: Set<string>;
}

interface LocatedThread {
  thread: ReviewThread;
  closed: boolean;
}

/** Apply only the delta between two edit snapshots to today's discussion state. */
export function mergeReviewUndoDelta(
  current: ReviewDocumentPair,
  from: ReviewDocumentPair,
  to: ReviewDocumentPair,
  protection: ReviewUndoProtection = { fields: new Map(), decisions: new Set() }
): ReviewDocumentPair {
  const currentThreads = indexThreads(current);
  const fromThreads = indexThreads(from);
  const toThreads = indexThreads(to);

  for (const id of new Set([...fromThreads.keys(), ...toThreads.keys()])) {
    const previous = fromThreads.get(id);
    const target = toThreads.get(id);
    const present = currentThreads.get(id);

    if (isDeepStrictEqual(previous, target)) {
      continue;
    }
    if (!previous) {
      if (!present && target) {
        currentThreads.set(id, structuredClone(target));
      }
      continue;
    }
    if (!target) {
      // A thread with later replies/decisions belongs to the user and must survive Undo.
      if (isDeepStrictEqual(present, previous)) {
        currentThreads.delete(id);
      }
      continue;
    }
    if (!present) {
      continue;
    }

    const protectedFields = protection.fields.get(id) ?? new Set<string>();
    protection.fields.set(id, protectedFields);
    const thread = mergeObjectDelta(present.thread, previous.thread, target.thread, protectedFields) as ReviewThread;
    thread.thread = mergeReplyDelta(present.thread.thread, previous.thread.thread, target.thread.thread);
    if (!isDeepStrictEqual(decision(present), decision(previous))) {
      protection.decisions.add(id);
    }
    const decisionUnchanged = !protection.decisions.has(id);
    const sourceDecision = decisionUnchanged ? target.thread : present.thread;
    thread.status = sourceDecision.status;
    setOptional(thread, 'closedBy', sourceDecision.closedBy);
    setOptional(thread, 'closedAt', sourceDecision.closedAt);
    currentThreads.set(id, { thread, closed: decisionUnchanged ? target.closed : present.closed });
  }

  return {
    reviewDocument: {
      ...current.reviewDocument,
      threads: [...currentThreads.values()].filter(value => !value.closed).map(value => value.thread)
    },
    resolvedReviewDocument: {
      ...current.resolvedReviewDocument,
      threads: [...currentThreads.values()].filter(value => value.closed).map(value => value.thread)
    }
  };
}

function indexThreads(pair: ReviewDocumentPair): Map<string, LocatedThread> {
  return new Map<string, LocatedThread>([
    ...pair.reviewDocument.threads.map(thread => [thread.id, { thread: structuredClone(thread), closed: false }] as const),
    ...pair.resolvedReviewDocument.threads.map(thread => [thread.id, { thread: structuredClone(thread), closed: true }] as const)
  ]);
}

function decision(value: LocatedThread): unknown {
  return { closed: value.closed, status: value.thread.status, closedBy: value.thread.closedBy, closedAt: value.thread.closedAt };
}

function mergeObjectDelta(current: unknown, from: unknown, to: unknown, protectedFields: Set<string>, field = ''): unknown {
  if (protectedFields.has(field) || isDeepStrictEqual(from, to)) {
    return structuredClone(current);
  }
  if (isObject(current) && isObject(from) && isObject(to)) {
    const result = structuredClone(current);
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      if (!isDeepStrictEqual(from[key], to[key])) {
        const value = mergeObjectDelta(current[key], from[key], to[key], protectedFields, `${field}/${key}`);
        if (value === undefined) {
          delete result[key];
        } else {
          result[key] = value;
        }
      }
    }
    return result;
  }
  if (isDeepStrictEqual(current, from)) {
    return structuredClone(to);
  }
  // Keep a conflicting user change protected across subsequent Undo/Redo cycles,
  // even if its value happens to equal one of the original edit snapshots.
  protectedFields.add(field);
  return structuredClone(current);
}

function mergeReplyDelta(current: ReviewReply[], from: ReviewReply[], to: ReviewReply[]): ReviewReply[] {
  const result = structuredClone(current);
  const removals = difference(from, to);
  for (const reply of removals) {
    const index = result.findIndex(candidate => isDeepStrictEqual(candidate, reply));
    if (index >= 0) {
      result.splice(index, 1);
    }
  }

  const additions = difference(to, from);
  for (const reply of additions) {
    const targetIndex = to.findIndex(candidate => isDeepStrictEqual(candidate, reply));
    let insertionIndex = 0;
    for (let index = targetIndex - 1; index >= 0; index--) {
      let previousIndex = result.length - 1;
      while (previousIndex >= 0 && !isDeepStrictEqual(result[previousIndex], to[index])) {
        previousIndex--;
      }
      if (previousIndex >= 0) {
        insertionIndex = previousIndex + 1;
        break;
      }
    }
    result.splice(insertionIndex, 0, structuredClone(reply));
  }
  return result;
}

function difference(left: ReviewReply[], right: ReviewReply[]): ReviewReply[] {
  const remaining = [...right];
  return left.filter(reply => {
    const index = remaining.findIndex(candidate => isDeepStrictEqual(candidate, reply));
    if (index < 0) {
      return true;
    }
    remaining.splice(index, 1);
    return false;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function setOptional<K extends 'closedBy' | 'closedAt'>(thread: ReviewThread, key: K, value: ReviewThread[K]): void {
  if (value === undefined) {
    delete thread[key];
  } else {
    thread[key] = value;
  }
}
