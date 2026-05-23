import type { ReviewDocument, ReviewReply, ReviewThread } from './types';

export const REVIEW_SIDECAR_SCHEMA_VERSION = 2;

export interface PortableReviewSidecar {
  schemaVersion: typeof REVIEW_SIDECAR_SCHEMA_VERSION;
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
    updatedAt: new Date().toISOString()
  };
}

export function createPortableReviewSidecarPayload(
  documentUri: string,
  reviewDocument: ReviewDocument,
  resolvedReviewDocument: ReviewDocument,
  updatedAt: string
): PortableReviewSidecar {
  return {
    schemaVersion: REVIEW_SIDECAR_SCHEMA_VERSION,
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

  if (Array.isArray(value.threads)) {
    return {
      reviewDocument: parseLegacyReviewDocument(documentUri, value),
      resolvedReviewDocument: createEmptyReviewDocument(documentUri)
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

  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString();

  return {
    reviewDocument: {
      documentUri,
      threads: normalizeThreads(value.openThreads, documentUri),
      updatedAt
    },
    resolvedReviewDocument: {
      documentUri,
      threads: normalizeThreads(value.closedThreads, documentUri),
      updatedAt
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

  if (!Array.isArray(value.threads)) {
    throw new Error('Expected "threads" to be an array.');
  }

  assertReviewThreads(value.threads);

  return {
    documentUri,
    threads: normalizeThreads(value.threads, documentUri),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
  };
}

export function mergeReviewDocuments(
  target: ReviewDocument,
  source: ReviewDocument,
  documentUri: string
): ReviewDocument {
  const merged = new Map<string, ReviewThread>();

  for (const thread of [...target.threads, ...source.threads]) {
    const normalizedThread = {
      ...thread,
      documentUri
    };
    const existing = merged.get(thread.id);

    if (!existing || timestamp(normalizedThread.updatedAt) >= timestamp(existing.updatedAt)) {
      merged.set(thread.id, normalizedThread);
    }
  }

  return {
    documentUri,
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
  const invalidThread = value.find(thread => !isReviewThread(thread));

  if (invalidThread) {
    throw new Error('Expected every thread to match the review thread schema.');
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
  return typeof value === 'object' && value !== null;
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
