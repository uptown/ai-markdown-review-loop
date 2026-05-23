import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { createRestoredReviewThread } from './reviewHistory';
import { AnchorConfidence, ReviewDocument, ReviewReply, ReviewThread } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

interface AddThreadsResult {
  reviewDocument: ReviewDocument;
  addedThreads: ReviewThread[];
}

interface ReviewSidecarLocations {
  reviewUri: vscode.Uri;
  resolvedUri: vscode.Uri;
}

export interface AnchorLocationUpdate {
  threadId: string;
  lineStart: number;
  lineEnd: number;
  confidence: Extract<AnchorConfidence, 'exact' | 'recovered'>;
  locatedAt: string;
}

export class ReviewStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async load(documentUri: vscode.Uri): Promise<ReviewDocument> {
    const { reviewUri } = await this.getSidecarLocations(documentUri);
    return this.readReviewDocument(reviewUri, documentUri, 'review sidecar');
  }

  async save(documentUri: vscode.Uri, reviewDocument: ReviewDocument): Promise<void> {
    const { reviewUri } = await this.getSidecarLocations(documentUri);
    await this.writeReviewDocument(reviewUri, documentUri, reviewDocument);
  }

  async saveBoth(
    documentUri: vscode.Uri,
    reviewDocument: ReviewDocument,
    resolvedReviewDocument: ReviewDocument
  ): Promise<void> {
    const { reviewUri, resolvedUri } = await this.getSidecarLocations(documentUri);
    const before = await this.captureSidecarBytes(reviewUri, resolvedUri);

    try {
      await this.writeReviewDocument(reviewUri, documentUri, reviewDocument);
      await this.writeReviewDocument(resolvedUri, documentUri, resolvedReviewDocument);
    } catch (error) {
      await this.restoreSidecarBytes(reviewUri, resolvedUri, before);
      throw error;
    }
  }

  async addThread(documentUri: vscode.Uri, thread: ReviewThread): Promise<ReviewDocument> {
    const reviewDocument = await this.load(documentUri);
    reviewDocument.threads.push(thread);
    await this.save(documentUri, reviewDocument);
    return reviewDocument;
  }

  async addThreads(documentUri: vscode.Uri, threads: ReviewThread[]): Promise<AddThreadsResult> {
    const reviewDocument = await this.load(documentUri);
    const addedThreads: ReviewThread[] = [];

    for (const thread of threads) {
      const duplicate = reviewDocument.threads.some(existing => {
        return existing.status === 'open'
          && existing.anchor.lineStart === thread.anchor.lineStart
          && existing.comment === thread.comment;
      });

      if (!duplicate) {
        reviewDocument.threads.push(thread);
        addedThreads.push(thread);
      }
    }

    if (addedThreads.length > 0) {
      await this.save(documentUri, reviewDocument);
    }

    return { reviewDocument, addedThreads };
  }

  async updateThread(
    documentUri: vscode.Uri,
    threadId: string,
    update: Partial<ReviewThread>
  ): Promise<ReviewDocument> {
    const reviewDocument = await this.load(documentUri);
    const thread = reviewDocument.threads.find(candidate => candidate.id === threadId);

    if (!thread) {
      throw new Error(`Review thread not found: ${threadId}`);
    }

    Object.assign(thread, update, { updatedAt: new Date().toISOString() });

    if (thread.status !== 'open') {
      reviewDocument.threads = reviewDocument.threads.filter(candidate => candidate.id !== thread.id);
      const resolvedDocument = await this.loadResolved(documentUri);
      upsertThread(resolvedDocument.threads, thread);
      await this.saveBoth(documentUri, reviewDocument, resolvedDocument);
      return reviewDocument;
    }

    await this.save(documentUri, reviewDocument);
    return reviewDocument;
  }

  async updateThreadAnchors(
    documentUri: vscode.Uri,
    updates: AnchorLocationUpdate[]
  ): Promise<boolean> {
    if (updates.length === 0) {
      return false;
    }

    const reviewDocument = await this.load(documentUri);
    const updatesById = new Map(updates.map(update => [update.threadId, update]));
    let changed = false;

    for (const thread of reviewDocument.threads) {
      if (thread.status !== 'open') {
        continue;
      }

      const update = updatesById.get(thread.id);

      if (!update) {
        continue;
      }

      const nextAnchor = {
        ...thread.anchor,
        lineStart: update.lineStart,
        lineEnd: update.lineEnd,
        confidence: update.confidence,
        lastLocatedLine: update.lineStart,
        lastLocatedAt: update.locatedAt
      };

      if (sameAnchorLocation(thread.anchor, nextAnchor)) {
        continue;
      }

      thread.anchor = nextAnchor;
      changed = true;
    }

    if (!changed) {
      return false;
    }

    await this.save(documentUri, reviewDocument);
    return true;
  }

  async addReply(
    documentUri: vscode.Uri,
    threadId: string,
    text: string
  ): Promise<ReviewDocument> {
    const reviewDocument = await this.load(documentUri);
    const thread = reviewDocument.threads.find(candidate => candidate.id === threadId);

    if (!thread) {
      throw new Error(`Review thread not found: ${threadId}`);
    }

    const now = new Date().toISOString();
    thread.thread.push({
      role: 'user',
      text,
      createdAt: now
    });
    thread.updatedAt = now;
    await this.save(documentUri, reviewDocument);
    return reviewDocument;
  }

  async loadResolved(documentUri: vscode.Uri): Promise<ReviewDocument> {
    const { resolvedUri } = await this.getSidecarLocations(documentUri);
    return this.readReviewDocument(resolvedUri, documentUri, 'resolved review sidecar');
  }

  async restoreThread(
    documentUri: vscode.Uri,
    threadId: string
  ): Promise<ReviewThread> {
    const reviewDocument = await this.load(documentUri);
    const existingOpenThread = reviewDocument.threads.find(candidate => candidate.id === threadId);

    if (existingOpenThread) {
      return existingOpenThread;
    }

    const resolvedDocument = await this.loadResolved(documentUri);
    const resolvedIndex = resolvedDocument.threads.findIndex(candidate => candidate.id === threadId);

    if (resolvedIndex < 0) {
      throw new Error(`Resolved review thread not found: ${threadId}`);
    }

    const restoredThread = createRestoredReviewThread(
      resolvedDocument.threads[resolvedIndex],
      new Date().toISOString()
    );

    resolvedDocument.threads.splice(resolvedIndex, 1);
    reviewDocument.threads.push(restoredThread);
    await this.saveBoth(documentUri, reviewDocument, resolvedDocument);
    return restoredThread;
  }

  async getReviewFileUri(documentUri: vscode.Uri): Promise<vscode.Uri> {
    const { reviewUri } = await this.getSidecarLocations(documentUri);
    return reviewUri;
  }

  async getResolvedReviewFileUri(documentUri: vscode.Uri): Promise<vscode.Uri> {
    const { resolvedUri } = await this.getSidecarLocations(documentUri);
    return resolvedUri;
  }

  async migrateDocument(oldDocumentUri: vscode.Uri, newDocumentUri: vscode.Uri): Promise<{
    reviewMoved: boolean;
    resolvedMoved: boolean;
  }> {
    const oldLocations = await this.getSidecarLocations(oldDocumentUri);
    const newLocations = await this.getSidecarLocations(newDocumentUri);
    const beforeNewSidecars = await this.captureSidecarBytes(newLocations.reviewUri, newLocations.resolvedUri);
    let reviewMoved = false;
    let resolvedMoved = false;

    try {
      reviewMoved = await this.migrateSidecarFile(
        oldLocations.reviewUri,
        newLocations.reviewUri,
        newDocumentUri
      );
      resolvedMoved = await this.migrateSidecarFile(
        oldLocations.resolvedUri,
        newLocations.resolvedUri,
        newDocumentUri
      );
    } catch (error) {
      await this.restoreSidecarBytes(newLocations.reviewUri, newLocations.resolvedUri, beforeNewSidecars);
      throw error;
    }

    return { reviewMoved, resolvedMoved };
  }

  async deleteDocumentSidecars(documentUri: vscode.Uri): Promise<void> {
    const { reviewUri, resolvedUri } = await this.getSidecarLocations(documentUri);
    await Promise.all([
      restoreFile(reviewUri, undefined),
      restoreFile(resolvedUri, undefined)
    ]);
  }

  async saveResolved(documentUri: vscode.Uri, reviewDocument: ReviewDocument): Promise<void> {
    const { resolvedUri } = await this.getSidecarLocations(documentUri);
    await this.writeReviewDocument(resolvedUri, documentUri, reviewDocument);
  }

  private async getSidecarLocations(documentUri: vscode.Uri): Promise<ReviewSidecarLocations> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    const root = workspaceFolder?.uri ?? this.context.globalStorageUri;
    const documentsRoot = vscode.Uri.joinPath(root, '.ai-markdown-review', 'documents');
    const resolvedRoot = vscode.Uri.joinPath(root, '.ai-markdown-review', 'resolved');
    await Promise.all([
      vscode.workspace.fs.createDirectory(documentsRoot),
      vscode.workspace.fs.createDirectory(resolvedRoot)
    ]);

    return {
      reviewUri: vscode.Uri.joinPath(documentsRoot, `${hashText(documentUri.toString())}.json`),
      resolvedUri: vscode.Uri.joinPath(resolvedRoot, `${hashText(documentUri.toString())}.json`)
    };
  }

  private async readReviewDocument(
    uri: vscode.Uri,
    documentUri: vscode.Uri,
    label: string
  ): Promise<ReviewDocument> {
    let bytes: Uint8Array;

    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw new Error(`Could not read ${label}: ${formatError(error)}`);
      }

      return createEmptyReviewDocument(documentUri);
    }

    try {
      return parseReviewDocument(documentUri, JSON.parse(decoder.decode(bytes)));
    } catch (error) {
      throw new Error(`${capitalize(label)} is invalid: ${formatError(error)}`);
    }
  }

  private async writeReviewDocument(
    uri: vscode.Uri,
    documentUri: vscode.Uri,
    reviewDocument: ReviewDocument
  ): Promise<void> {
    const payload: ReviewDocument = {
      documentUri: documentUri.toString(),
      threads: reviewDocument.threads,
      updatedAt: new Date().toISOString()
    };

    await vscode.workspace.fs.writeFile(
      uri,
      encoder.encode(`${JSON.stringify(payload, null, 2)}\n`)
    );
  }

  private async captureSidecarBytes(
    reviewUri: vscode.Uri,
    resolvedUri: vscode.Uri
  ): Promise<{
    reviewBytes: Uint8Array | undefined;
    resolvedBytes: Uint8Array | undefined;
  }> {
    return {
      reviewBytes: await readFileIfExists(reviewUri),
      resolvedBytes: await readFileIfExists(resolvedUri)
    };
  }

  private async restoreSidecarBytes(
    reviewUri: vscode.Uri,
    resolvedUri: vscode.Uri,
    snapshot: {
      reviewBytes: Uint8Array | undefined;
      resolvedBytes: Uint8Array | undefined;
    }
  ): Promise<void> {
    await Promise.all([
      restoreFile(reviewUri, snapshot.reviewBytes),
      restoreFile(resolvedUri, snapshot.resolvedBytes)
    ]);
  }

  private async migrateSidecarFile(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    newDocumentUri: vscode.Uri
  ): Promise<boolean> {
    const sourceBytes = await readFileIfExists(oldUri);

    if (!sourceBytes) {
      return false;
    }

    const sourceDocument = parseReviewDocument(
      newDocumentUri,
      JSON.parse(decoder.decode(sourceBytes))
    );
    const targetBytes = await readFileIfExists(newUri);
    const targetDocument = targetBytes
      ? parseReviewDocument(newDocumentUri, JSON.parse(decoder.decode(targetBytes)))
      : createEmptyReviewDocument(newDocumentUri);
    const mergedDocument = mergeReviewDocuments(targetDocument, sourceDocument, newDocumentUri);

    await this.writeReviewDocument(newUri, newDocumentUri, mergedDocument);
    return true;
  }
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function createEmptyReviewDocument(documentUri: vscode.Uri): ReviewDocument {
  return {
    documentUri: documentUri.toString(),
    threads: [],
    updatedAt: new Date().toISOString()
  };
}

function mergeReviewDocuments(
  target: ReviewDocument,
  source: ReviewDocument,
  documentUri: vscode.Uri
): ReviewDocument {
  const merged = new Map<string, ReviewThread>();

  for (const thread of [...target.threads, ...source.threads]) {
    const normalizedThread = {
      ...thread,
      documentUri: documentUri.toString()
    };
    const existing = merged.get(thread.id);

    if (!existing || timestamp(normalizedThread.updatedAt) >= timestamp(existing.updatedAt)) {
      merged.set(thread.id, normalizedThread);
    }
  }

  return {
    documentUri: documentUri.toString(),
    threads: [...merged.values()],
    updatedAt: new Date().toISOString()
  };
}

function upsertThread(threads: ReviewThread[], thread: ReviewThread): void {
  const existingIndex = threads.findIndex(candidate => candidate.id === thread.id);

  if (existingIndex >= 0) {
    threads[existingIndex] = thread;
  } else {
    threads.push(thread);
  }
}

function parseReviewDocument(documentUri: vscode.Uri, value: unknown): ReviewDocument {
  if (!isRecord(value)) {
    throw new Error('Expected a JSON object.');
  }

  if (!Array.isArray(value.threads)) {
    throw new Error('Expected "threads" to be an array.');
  }

  const invalidThread = value.threads.find(thread => !isReviewThread(thread));

  if (invalidThread) {
    throw new Error('Expected every thread to match the review thread schema.');
  }

  return {
    documentUri: documentUri.toString(),
    threads: value.threads,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
  };
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

function sameAnchorLocation(
  left: ReviewThread['anchor'],
  right: ReviewThread['anchor']
): boolean {
  return left.lineStart === right.lineStart
    && left.lineEnd === right.lineEnd
    && left.confidence === right.confidence
    && left.lastLocatedLine === right.lastLocatedLine;
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

function isFileNotFoundError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const message = formatError(error);

  return code === 'FileNotFound'
    || message.includes('FileNotFound')
    || message.includes('ENOENT')
    || message.includes('no such file');
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function restoreFile(uri: vscode.Uri, bytes: Uint8Array | undefined): Promise<void> {
  if (bytes === undefined) {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }
    return;
  }

  await vscode.workspace.fs.writeFile(uri, bytes);
}

async function readFileIfExists(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}
