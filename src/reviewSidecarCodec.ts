import type { ReviewDocument, ReviewReply, ReviewThread } from './types';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import {
  parseReviewTaskSidecar,
  REVIEW_TASK_GUIDANCE,
  REVIEW_TASK_SCHEMA_VERSION,
  type ReviewTaskItem,
  type ReviewTaskSidecar,
  type ReviewTaskTarget
} from './reviewTaskProtocol';

export const REVIEW_SIDECAR_SCHEMA_VERSION = REVIEW_TASK_SCHEMA_VERSION;
export type PortableReviewSidecar = ReviewTaskSidecar;

export interface LegacyPortableReviewSidecar {
  schemaVersion: 2;
  documentUri: string;
  updatedAt: string;
  openThreads: ReviewThread[];
  closedThreads: ReviewThread[];
}

export interface ReviewDocumentPair {
  reviewDocument: ReviewDocument;
  resolvedReviewDocument: ReviewDocument;
}

export function createEmptyReviewDocument(documentUri: string): ReviewDocument {
  return {
    documentUri,
    threads: [],
    updatedAt: new Date().toISOString(),
    taskSchemaVersion: 3,
    guidance: REVIEW_TASK_GUIDANCE
  };
}

export function createPortableReviewSidecarPayload(
  documentUri: string,
  reviewDocument: ReviewDocument,
  _resolvedReviewDocument: ReviewDocument,
  _updatedAt: string
): PortableReviewSidecar {
  // Schema v3 is a current comment list. Completed agent outcomes stay on the
  // item until the user edits or deletes the comment; they are never moved to a
  // second history collection.
  const threads = [...reviewDocument.threads];
  threads.sort((left, right) => (left.taskOrder ?? Number.MAX_SAFE_INTEGER) - (right.taskOrder ?? Number.MAX_SAFE_INTEGER));
  return parseReviewTaskSidecar({
    schemaVersion: REVIEW_SIDECAR_SCHEMA_VERSION,
    document: reviewTaskDocumentName(documentUri),
    guidance: reviewDocument.guidance ?? REVIEW_TASK_GUIDANCE,
    items: threads.map(createReviewTaskItem)
  });
}

/** Explicit writer for legacy documents until the user exports the JSON flow. */
export function createLegacyReviewSidecarPayload(
  documentUri: string,
  reviewDocument: ReviewDocument,
  resolvedReviewDocument: ReviewDocument,
  updatedAt: string
): LegacyPortableReviewSidecar {
  return {
    schemaVersion: 2,
    documentUri,
    updatedAt,
    openThreads: normalizeThreads(reviewDocument.threads, documentUri),
    closedThreads: normalizeThreads(resolvedReviewDocument.threads, documentUri)
  };
}

export function parsePortableReviewSidecar(
  documentUri: string,
  value: unknown
): ReviewDocumentPair {
  if (!isRecord(value)) {
    throw new Error('Expected a JSON object.');
  }
  if (value.schemaVersion === REVIEW_TASK_SCHEMA_VERSION) {
    const sidecar = parseReviewTaskSidecar(value);
    if (sidecar.document !== reviewTaskDocumentName(documentUri)) {
      throw new Error('Review file document does not match this Markdown filename.');
    }
    return taskSidecarToDocuments(documentUri, sidecar);
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error('Unsupported review schemaVersion. This file has not been changed.');
  }

  if (Array.isArray(value.threads)) {
    return {
      reviewDocument: parseLegacyReviewDocument(documentUri, value),
      resolvedReviewDocument: { ...createEmptyReviewDocument(documentUri), taskSchemaVersion: 2 }
    };
  }

  if (!Array.isArray(value.openThreads)) {
    throw new Error('Expected "openThreads" to be an array.');
  }

  if (!Array.isArray(value.closedThreads)) {
    throw new Error('Expected "closedThreads" to be an array.');
  }

  assertReviewThreads(value.openThreads);
  assertReviewThreads(value.closedThreads);
  assertUniqueThreadIds([...value.openThreads, ...value.closedThreads]);

  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString();

  return {
    reviewDocument: {
      documentUri,
      threads: normalizeThreads(value.openThreads, documentUri),
      updatedAt,
      taskSchemaVersion: 2
    },
    resolvedReviewDocument: {
      documentUri,
      threads: normalizeThreads(value.closedThreads, documentUri),
      updatedAt,
      taskSchemaVersion: 2
    }
  };
}

export function parseLegacyReviewDocument(
  documentUri: string,
  value: unknown
): ReviewDocument {
  if (!isRecord(value)) {
    throw new Error('Expected a JSON object.');
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error('Unsupported legacy review schemaVersion. This file has not been changed.');
  }

  if (!Array.isArray(value.threads)) {
    throw new Error('Expected "threads" to be an array.');
  }

  assertReviewThreads(value.threads);
  assertUniqueThreadIds(value.threads);

  return {
    documentUri,
    threads: normalizeThreads(value.threads, documentUri),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    taskSchemaVersion: 2
  };
}

export function reviewTaskDocumentName(documentUri: string): string {
  try {
    return path.posix.basename(decodeURIComponent(new URL(documentUri).pathname));
  } catch {
    return path.posix.basename(documentUri.replace(/\\/g, '/'));
  }
}

/** Preserve every role and patch candidate as request context, without summarizing away requirements. */
export function buildLegacyReviewTaskComment(thread: ReviewThread): string {
  if (thread.taskRevision !== undefined) return thread.comment;
  const context = buildLegacyReviewContext(thread);
  return context ? thread.comment + '\n\nPrevious review context (preserved verbatim):\n' + context : thread.comment;
}

/** Caller must durably back up the original bytes before writing this converted pair. */
export function migrateLegacyReviewDocuments(pair: ReviewDocumentPair): ReviewDocumentPair {
  if (pair.reviewDocument.taskSchemaVersion === 3 && pair.resolvedReviewDocument.taskSchemaVersion === 3) return structuredClone(pair);
  const documentUri = pair.reviewDocument.documentUri;
  return {
    reviewDocument: {
      ...pair.reviewDocument,
      taskSchemaVersion: 3,
      guidance: REVIEW_TASK_GUIDANCE,
      threads: pair.reviewDocument.taskSchemaVersion === 3 ? structuredClone(pair.reviewDocument.threads) : pair.reviewDocument.threads.map((thread, index) => ({
        ...structuredClone(thread),
        // Legacy request editing can carry a revision before format conversion. It
        // must not make the original discussion look already flattened.
        comment: buildLegacyReviewTaskComment({ ...thread, taskRevision: undefined }),
        legacyContext: buildLegacyReviewContext(thread) || undefined,
        thread: [],
        suggestedPatch: undefined,
        status: 'open',
        closedBy: undefined,
        closedAt: undefined,
        taskRevision: 1,
        taskStatus: 'pending',
        taskResult: undefined,
        taskResultFor: undefined,
        taskOrder: index
      }))
    },
    resolvedReviewDocument: pair.resolvedReviewDocument.taskSchemaVersion === 3
      ? structuredClone(pair.resolvedReviewDocument) : createEmptyReviewDocument(documentUri)
  };
}

function buildLegacyReviewContext(thread: ReviewThread): string {
  const parts: string[] = [];
  if (thread.legacyContext) parts.push(thread.legacyContext);
  if (thread.suggestedPatch) {
    parts.push('Previously suggested replacement:\nOriginal:\n' + thread.suggestedPatch.original
      + '\nReplacement:\n' + thread.suggestedPatch.replacement);
  }
  for (const reply of thread.thread) {
    parts.push((reply.role === 'user' ? 'User' : 'Assistant') + ' (' + reply.createdAt + '):\n' + reply.text);
  }
  return parts.join('\n\n');
}

export function createReviewTaskItem(thread: ReviewThread): ReviewTaskItem {
  const anchor = thread.anchor;
  const target: ReviewTaskTarget = { quote: anchor.text };
  if (anchor.lineStart !== undefined) target.line = anchor.lineStart;
  if (anchor.lineEnd !== undefined) target.lineEnd = anchor.lineEnd;
  if (anchor.occurrence !== undefined) target.occurrence = anchor.occurrence;
  if (anchor.contextBefore !== undefined) target.contextBefore = anchor.contextBefore;
  if (anchor.contextAfter !== undefined) target.contextAfter = anchor.contextAfter;
  if (anchor.confidence === 'missing' || anchor.confidence === 'ambiguous') target.state = anchor.confidence;
  return {
    id: thread.id,
    rev: thread.taskRevision ?? 1,
    target,
    comment: thread.taskRevision === undefined ? buildLegacyReviewTaskComment(thread) : thread.comment,
    status: thread.taskStatus ?? 'pending',
    ...(thread.taskResult !== undefined ? { result: thread.taskResult } : {}),
    ...(thread.taskResultFor !== undefined ? { resultFor: thread.taskResultFor } : {})
  };
}

function taskSidecarToDocuments(documentUri: string, sidecar: ReviewTaskSidecar): ReviewDocumentPair {
  // Dates are not part of v3. A deterministic adapter value avoids changing state on every read.
  const updatedAt = '1970-01-01T00:00:00.000Z';
  const threads = sidecar.items.map((item, index): ReviewThread => {
    const thread: ReviewThread = {
      id: item.id, documentUri,
      anchor: {
        text: item.target.quote,
        ...(item.target.line !== undefined ? { lineStart: item.target.line } : {}),
        ...(item.target.lineEnd !== undefined ? { lineEnd: item.target.lineEnd } : {}),
        ...(item.target.occurrence !== undefined ? { occurrence: item.target.occurrence } : {}),
        ...(item.target.contextBefore !== undefined ? { contextBefore: item.target.contextBefore } : {}),
        ...(item.target.contextAfter !== undefined ? { contextAfter: item.target.contextAfter } : {}),
        ...(item.target.state !== undefined ? { confidence: item.target.state } : {})
      },
      type: 'note', source: 'human', severity: 'medium', comment: item.comment,
      status: 'open', thread: [], createdAt: updatedAt, updatedAt,
      taskRevision: item.rev, taskStatus: item.status, taskOrder: index,
      ...(item.result !== undefined ? { taskResult: item.result } : {}),
      ...(item.resultFor !== undefined ? { taskResultFor: item.resultFor } : {})
    };
    return thread;
  });
  const metadata = { documentUri, updatedAt, taskSchemaVersion: 3 as const, guidance: sidecar.guidance };
  return {
    reviewDocument: { ...metadata, threads },
    resolvedReviewDocument: { ...metadata, threads: [] }
  };
}

export function mergeReviewDocuments(
  target: ReviewDocument,
  source: ReviewDocument,
  documentUri: string
): ReviewDocument {
  if (target.threads.length > 0 && source.threads.length > 0) {
    if (target.taskSchemaVersion !== undefined && source.taskSchemaVersion !== undefined
      && target.taskSchemaVersion !== source.taskSchemaVersion) {
      throw new Error('Review files use different schemas. Convert them before merging.');
    }
    if (target.guidance !== undefined && source.guidance !== undefined && target.guidance !== source.guidance) {
      throw new Error('Review files have different guidance. Review it before merging.');
    }
  }
  const merged = new Map<string, ReviewThread>();

  for (const thread of [...target.threads, ...source.threads]) {
    const normalizedThread = {
      ...thread,
      documentUri
    };
    const existing = merged.get(thread.id);

    if (existing && (target.taskSchemaVersion === 3 || source.taskSchemaVersion === 3)
      && !isDeepStrictEqual(createReviewTaskItem(existing), createReviewTaskItem(normalizedThread))) {
      throw new Error('Conflicting review item ID: ' + thread.id + '. Review both files before merging.');
    }
    if (!existing || timestamp(normalizedThread.updatedAt) >= timestamp(existing.updatedAt)) {
      merged.set(thread.id, normalizedThread);
    }
  }

  return {
    ...target,
    documentUri,
    taskSchemaVersion: target.threads.length === 0 ? source.taskSchemaVersion ?? target.taskSchemaVersion : target.taskSchemaVersion,
    guidance: target.threads.length === 0 ? source.guidance ?? target.guidance : target.guidance ?? source.guidance,
    threads: [...merged.values()],
    updatedAt: new Date().toISOString()
  };
}

export function upsertThread(threads: ReviewThread[], thread: ReviewThread): void {
  const existingIndex = threads.findIndex(candidate => candidate.id === thread.id);

  if (existingIndex >= 0) {
    threads[existingIndex] = thread;
  } else {
    threads.push(thread);
  }
}

function assertReviewThreads(value: unknown[]): asserts value is ReviewThread[] {
  if (value.some(thread => !isReviewThread(thread))) {
    throw new Error('Expected every thread to match the review thread schema.');
  }
}

function assertUniqueThreadIds(threads: ReviewThread[]): void {
  const ids = new Set<string>();
  for (const thread of threads) {
    if (ids.has(thread.id)) throw new Error('Duplicate review thread ID: ' + thread.id);
    ids.add(thread.id);
  }
}

function normalizeThreads(threads: ReviewThread[], documentUri: string): ReviewThread[] {
  return threads.map(thread => ({
    ...thread,
    documentUri
  }));
}

function isReviewThread(value: unknown): value is ReviewThread {
  if (!isRecord(value) || !isRecord(value.anchor)) {
    return false;
  }

  return typeof value.id === 'string'
    && typeof value.documentUri === 'string'
    && typeof value.anchor.text === 'string'
    && isOneOf(value.type, ['fix', 'question', 'note', 'risk', 'suggestion'])
    && isOneOf(value.source, ['human', 'ai', 'local'])
    && isOneOf(value.status, ['open', 'accepted', 'rejected', 'resolved'])
    && optionalOneOf(value.closedBy, ['user', 'assistant'])
    && optionalString(value.closedAt)
    && isOneOf(value.severity, ['low', 'medium', 'high'])
    && typeof value.comment === 'string'
    && Array.isArray(value.thread)
    && value.thread.every(isReviewReply)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isReviewReply(value: unknown): value is ReviewReply {
  return isRecord(value)
    && isOneOf(value.role, ['user', 'assistant'])
    && typeof value.text === 'string'
    && typeof value.createdAt === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf(value: unknown, options: readonly string[]): boolean {
  return typeof value === 'string' && options.includes(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalOneOf(value: unknown, options: readonly string[]): boolean {
  return value === undefined || isOneOf(value, options);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
