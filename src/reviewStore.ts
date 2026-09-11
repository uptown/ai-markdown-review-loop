import * as vscode from 'vscode';
import { createHash, randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { stat } from 'fs/promises';
import path from 'path';
import { createRestoredReviewThread } from './reviewHistory';
import {
  createEmptyReviewDocument,
  createPortableReviewSidecarPayload,
  createLegacyReviewSidecarPayload,
  createReviewTaskItem,
  migrateLegacyReviewDocuments,
  mergeReviewDocuments,
  parseLegacyReviewDocument,
  parsePortableReviewSidecar,
  upsertThread
} from './reviewSidecarCodec';
import { compareReviewTaskCheckpoint, createReviewTaskCheckpoint, createReviewTaskFingerprint, getReviewTaskStatus, parseReviewTaskSidecar, type ReviewTaskCheckpoint } from './reviewTaskProtocol';
import {
  LEGACY_CLOSED_REVIEW_FOLDER,
  LEGACY_OPEN_REVIEW_FOLDER,
  LEGACY_REVIEW_STORAGE_ROOT,
  createColocatedReviewSidecarFileName
} from './reviewSidecarPaths';
import { isDuplicateReviewThread } from './reviewThreadDedup';
import { createReviewAnchorIdentityKey } from './reviewAnchorIdentity';
import { AnchorConfidence, ReviewDocument, ReviewThread } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

interface AddThreadsResult {
  reviewDocument: ReviewDocument;
  addedThreads: ReviewThread[];
}

interface AddLocalReviewThreadsResult extends AddThreadsResult {
  existingOpenCount: number;
  previouslyClosedCount: number;
}

interface ReviewSidecarLocations {
  reviewUri: vscode.Uri;
  resolvedUri: vscode.Uri;
  legacyReviewUri: vscode.Uri;
  legacyResolvedUri: vscode.Uri;
}

export interface AnchorLocationUpdate {
  threadId: string;
  lineStart: number;
  lineEnd: number;
  confidence: Extract<AnchorConfidence, 'exact' | 'recovered'>;
  locatedAt: string;
}

export class ReviewStorageConflictError extends Error {
  constructor() {
    super('Review state changed during this operation. Reload the review and try again.');
    this.name = 'ReviewStorageConflictError';
  }
}

interface DocumentTransaction {
  active: boolean;
  writableAtEnqueue: boolean;
  internalWrite?: boolean;
  rebaseTaskRevision?: boolean;
  allowTaskRemoval?: boolean;
  reads: Map<string, { uri: vscode.Uri; bytes: Uint8Array | undefined }>;
}

interface StoredReviewState {
  phase?: 'preparing' | 'handedOff';
  checkpoint?: ReviewTaskCheckpoint;
  checkpointPath?: string;
  knownCanonical?: boolean;
  lastValidPath?: string;
  lastHash?: string;
  pendingWrite?: { hash: string; path: string };
  historyPaths?: string[];
  legacyPaths?: string[];
}

export class ReviewHandoffError extends Error {
  constructor(message = 'Review writes are paused while the agent edits the files. When it finishes, return to Review Changes. Drafts are kept.') {
    super(message);
    this.name = 'ReviewHandoffError';
  }
}

export class ReviewStore {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly transactionContext = new AsyncLocalStorage<Map<string, DocumentTransaction>>();
  private readonly states = new Map<string, StoredReviewState>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  getHandoffPhase(uri: vscode.Uri): StoredReviewState['phase'] { return this.state(uri).phase; }
  isHandoffActive(uri: vscode.Uri): boolean { return Boolean(this.getHandoffPhase(uri)); }
  getDocumentEpoch(uri: vscode.Uri): number { return this.epochs.get(uri.toString()) ?? 0; }

  assertWritable(uri: vscode.Uri): void {
    const phase = this.getHandoffPhase(uri);
    const tx = this.transactionContext.getStore()?.get(uri.toString());
    if (phase && !(tx?.active && (tx.internalWrite || (phase === 'preparing' && tx.writableAtEnqueue)))) {
      throw new ReviewHandoffError();
    }
  }

  /** Freeze ingress before draining operations already queued by the editor. */
  async prepareHandoff(uri: vscode.Uri, saveDocument: () => Promise<boolean>, deliver: (sidecar: vscode.Uri, contents: string) => Promise<void>): Promise<void> {
    if (this.isHandoffActive(uri)) throw new ReviewHandoffError();
    this.states.set(uri.toString(), { ...this.state(uri), phase: 'preparing' });
    try {
      await this.withDocumentTransaction(uri, async () => {
        await this.internalWrite(uri, async () => {
          await this.persistState(uri, { phase: 'preparing' });
          if (!await saveDocument()) throw new Error('The document save was cancelled, so the handoff was not sent.');
          const sidecar = await this.getReviewFileUri(uri);
          this.assertSidecarEditorClean(sidecar);
          let pair = await this.readReviewDocuments(uri);
          if (pair.reviewDocument.taskSchemaVersion === 2 || pair.resolvedReviewDocument.taskSchemaVersion === 2) {
            await this.backupLegacy(uri);
            pair = migrateLegacyReviewDocuments(pair);
          }
          // Archive completed records before removing them from the next agent input.
          if (pair.resolvedReviewDocument.threads.length) {
            const archive = createPortableReviewSidecarPayload(uri.toString(), createEmptyReviewDocument(uri.toString()), pair.resolvedReviewDocument, new Date().toISOString());
            const archivePath = await this.backup(uri, 'completed', encoder.encode(JSON.stringify(archive, null, 2)));
            await this.persistState(uri, { historyPaths: [...(this.state(uri).historyPaths ?? []), archivePath] });
            pair.resolvedReviewDocument = { ...createEmptyReviewDocument(uri.toString()), taskSchemaVersion: 3 };
          }
          pair.reviewDocument.taskSchemaVersion = 3;
          pair.resolvedReviewDocument.taskSchemaVersion = 3;
          if (!pair.reviewDocument.threads.length) throw new Error('There are no pending comments to send. Review the document and add a comment first.');
          await this.writePortableReviewDocuments(sidecar, uri, pair.reviewDocument, pair.resolvedReviewDocument);
          const bytes = await readFileIfExists(sidecar);
          if (!bytes) throw new Error('The review file could not be read for handoff.');
          const payload = parseReviewTaskSidecar(JSON.parse(decoder.decode(bytes)));
          const checkpointPath = await this.backup(uri, 'handoff', bytes);
          await this.persistState(uri, { checkpoint: createReviewTaskCheckpoint(payload), checkpointPath, phase: 'handedOff' });
          this.advanceEpoch(uri);
          await deliver(sidecar, decoder.decode(bytes));
        });
      });
    } catch (error) {
      // A failed save/copy does not leave a hidden permanent editing lock.
      await this.persistState(uri, { phase: undefined, checkpoint: undefined, checkpointPath: undefined });
      throw error;
    }
  }

  async resumeReview(uri: vscode.Uri): Promise<void> {
    await this.withDocumentTransaction(uri, async () => {
      const sidecar = await this.getReviewFileUri(uri);
      this.assertSidecarEditorClean(sidecar);
      // Parsing also checks missing/changed immutable requests against the checkpoint.
      await this.readReviewDocuments(uri);
      await this.persistState(uri, { phase: undefined, checkpoint: undefined, checkpointPath: undefined });
      this.advanceEpoch(uri);
    });
  }

  async updateComment(uri: vscode.Uri, id: string, comment: string, expectedRevision?: number): Promise<void> {
    this.assertWritable(uri);
    await this.withDocumentTransaction(uri, async () => {
      const open = await this.load(uri);
      const thread = open.threads.find(item => item.id === id);
      if (!thread) throw new Error('The comment could not be found. Refresh and try again.');
      this.checkTaskRevision(thread, expectedRevision);
      if (!comment.trim()) throw new Error('Enter a change request.');
      Object.assign(thread, { comment: comment.trim(), taskRevision: (thread.taskRevision ?? 1) + 1, taskStatus: 'pending', taskResult: undefined, taskResultFor: undefined, legacyContext: undefined, updatedAt: new Date().toISOString() });
      await this.save(uri, open);
    });
  }

  async removeThread(uri: vscode.Uri, id: string, expectedRevision?: number): Promise<void> {
    this.assertWritable(uri);
    await this.withDocumentTransaction(uri, async () => {
      const pair = await this.readReviewDocuments(uri);
      const thread = [...pair.reviewDocument.threads, ...pair.resolvedReviewDocument.threads].find(item => item.id === id);
      if (!thread) throw new Error('The comment could not be found.');
      this.checkTaskRevision(thread, expectedRevision);
      const sidecar = await this.getReviewFileUri(uri);
      const bytes = await readFileIfExists(sidecar);
      if (bytes) await this.backup(uri, 'removed', bytes);
      pair.reviewDocument.threads = pair.reviewDocument.threads.filter(item => item.id !== id);
      pair.resolvedReviewDocument.threads = pair.resolvedReviewDocument.threads.filter(item => item.id !== id);
      const tx = this.transactionContext.getStore()!.get(uri.toString())!;
      tx.allowTaskRemoval = true;
      try { await this.saveBoth(uri, pair.reviewDocument, pair.resolvedReviewDocument); } finally { tx.allowTaskRemoval = false; }
    });
  }

  async loadArchived(uri: vscode.Uri): Promise<ReviewThread[]> {
    const records = new Map<string, ReviewThread>();
    for (const file of this.state(uri).historyPaths ?? []) {
      const bytes = await readFileIfExists(vscode.Uri.file(file));
      if (!bytes) continue;
      const payload = JSON.parse(decoder.decode(bytes));
      if (payload.schemaVersion === 3) payload.document = path.posix.basename(uri.path);
      const pair = parsePortableReviewSidecar(uri.toString(), payload);
      for (const thread of pair.resolvedReviewDocument.threads) records.set(thread.id, thread);
    }
    return [...records.values()];
  }

  getLegacyBackupPaths(uri: vscode.Uri): string[] { return [...(this.state(uri).legacyPaths ?? [])]; }

  async restoreArchivedThread(uri: vscode.Uri, id: string): Promise<void> {
    this.assertWritable(uri);
    await this.withDocumentTransaction(uri, async () => {
      const pair = await this.readReviewDocuments(uri);
      if ([...pair.reviewDocument.threads, ...pair.resolvedReviewDocument.threads].some(item => item.id === id)) throw new Error('A current comment already uses this ID. Reopen it from the current list.');
      const thread = (await this.loadArchived(uri)).find(item => item.id === id);
      if (!thread) throw new Error('The archived comment could not be found.');
      pair.reviewDocument.threads.push(this.reopenTask(thread));
      await this.saveBoth(uri, pair.reviewDocument, pair.resolvedReviewDocument);
    });
  }

  /** Explicit recovery only; never resurrect a missing sidecar during ordinary reads. */
  async restoreReviewBackup(uri: vscode.Uri): Promise<void> {
    await this.withDocumentTransaction(uri, async () => this.internalWrite(uri, async () => {
      const state = this.state(uri);
      const backupPath = state.checkpointPath ?? state.lastValidPath;
      if (!backupPath) throw new Error('There is no review backup to restore.');
      const bytes = await readFileIfExists(vscode.Uri.file(backupPath));
      if (!bytes) throw new Error('The review backup could not be read.');
      parsePortableReviewSidecar(uri.toString(), JSON.parse(decoder.decode(bytes)));
      const sidecar = await this.getReviewFileUri(uri);
      this.assertSidecarEditorClean(sidecar);
      const current = await readFileIfExists(sidecar);
      if (current) await this.backup(uri, 'before-restore', current);
      await this.commitCanonicalWrite(uri, sidecar, bytes, async () => {
        if (!bytesEqual(current, await readFileIfExists(sidecar))) throw new ReviewStorageConflictError();
      });
      await this.persistState(uri, { phase: undefined, checkpoint: undefined, checkpointPath: undefined });
      this.advanceEpoch(uri);
    }));
  }

  /** Keep the complete read/modify/write operation inside this callback. Nested calls are reentrant. */
  async withDocumentTransaction<T>(documentUri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
    const key = documentUri.toString();
    const inherited = this.transactionContext.getStore();

    if (inherited?.get(key)?.active) {
      return operation();
    }

    const previous = this.queues.get(key) ?? Promise.resolve();
    const writableAtEnqueue = !this.isHandoffActive(documentUri);
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(key, tail);
    await previous;
    const transaction: DocumentTransaction = { active: true, writableAtEnqueue, reads: new Map() };
    const context = new Map(inherited);
    context.set(key, transaction);

    try {
      return await this.transactionContext.run(context, operation);
    } finally {
      transaction.active = false;
      release();
      if (this.queues.get(key) === tail) {
        this.queues.delete(key);
      }
    }
  }

  async save(documentUri: vscode.Uri, reviewDocument: ReviewDocument): Promise<void> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, () => this.saveUnlocked(documentUri, reviewDocument));
  }

  async saveBoth(documentUri: vscode.Uri, open: ReviewDocument, closed: ReviewDocument): Promise<void> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, () => this.saveBothUnlocked(documentUri, open, closed));
  }

  /** Undo replays request deltas while keeping revisions monotonically increasing. */
  async saveBothForUndo(documentUri: vscode.Uri, open: ReviewDocument, closed: ReviewDocument): Promise<void> {
    this.assertWritable(documentUri);
    await this.withDocumentTransaction(documentUri, async () => {
      const tx = this.transactionContext.getStore()!.get(documentUri.toString())!;
      const previous = tx.rebaseTaskRevision;
      tx.rebaseTaskRevision = true;
      try { await this.saveBothUnlocked(documentUri, open, closed); } finally { tx.rebaseTaskRevision = previous; }
    });
  }

  async addThread(documentUri: vscode.Uri, thread: ReviewThread): Promise<ReviewDocument> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, () => this.addThreadUnlocked(documentUri, thread));
  }

  async addThreads(documentUri: vscode.Uri, threads: ReviewThread[]): Promise<AddThreadsResult> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, () => this.addThreadsUnlocked(documentUri, threads));
  }

  async addLocalReviewThreads(documentUri: vscode.Uri, threads: ReviewThread[]): Promise<AddLocalReviewThreadsResult> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, async () => {
      if (threads.some(thread => thread.source !== 'local')) {
        throw new Error('Local checks can only create local review threads.');
      }
      const reviewDocument = await this.load(documentUri);
      const closedDocument = await this.loadResolved(documentUri);
      const addedThreads: ReviewThread[] = [];
      let existingOpenCount = 0;
      let previouslyClosedCount = 0;

      for (const thread of threads) {
        const sameFinding = (existing: ReviewThread) => existing.source === 'local'
          && existing.type === thread.type
          && existing.comment === thread.comment
          && createReviewAnchorIdentityKey(existing) === createReviewAnchorIdentityKey(thread);
        if (reviewDocument.threads.some(sameFinding)) {
          existingOpenCount++;
        } else if (closedDocument.threads.some(sameFinding)) {
          previouslyClosedCount++;
        } else {
          reviewDocument.threads.push(thread);
          addedThreads.push(thread);
        }
      }
      if (addedThreads.length > 0) {
        await this.save(documentUri, reviewDocument);
      }
      return { reviewDocument, addedThreads, existingOpenCount, previouslyClosedCount };
    });
  }

  async updateThread(documentUri: vscode.Uri, threadId: string, update: Partial<ReviewThread>): Promise<ReviewDocument> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, () => this.updateThreadUnlocked(documentUri, threadId, update));
  }

  async updateThreadAnchors(documentUri: vscode.Uri, updates: AnchorLocationUpdate[]): Promise<boolean> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, () => this.updateThreadAnchorsUnlocked(documentUri, updates));
  }

  async addReply(documentUri: vscode.Uri, threadId: string, text: string): Promise<ReviewDocument> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, () => this.addReplyUnlocked(documentUri, threadId, text));
  }

  async restoreThread(documentUri: vscode.Uri, threadId: string): Promise<ReviewThread> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, () => this.restoreThreadUnlocked(documentUri, threadId));
  }

  async migrateDocument(oldDocumentUri: vscode.Uri, newDocumentUri: vscode.Uri): Promise<{
    reviewMoved: boolean;
    resolvedMoved: boolean;
  }> {
    this.assertWritable(oldDocumentUri);
    this.assertWritable(newDocumentUri);
    const ordered = [oldDocumentUri, newDocumentUri].sort((left, right) => left.toString().localeCompare(right.toString()));
    return this.withDocumentTransaction(ordered[0], () => this.withDocumentTransaction(ordered[1],
      () => this.migrateDocumentUnlocked(oldDocumentUri, newDocumentUri)));
  }

  async deleteDocumentSidecars(documentUri: vscode.Uri, preservedDocumentUri?: vscode.Uri): Promise<void> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, () => this.deleteDocumentSidecarsUnlocked(documentUri, preservedDocumentUri));
  }

  async saveResolved(documentUri: vscode.Uri, reviewDocument: ReviewDocument): Promise<void> {
    this.assertWritable(documentUri);
    return this.withDocumentTransaction(documentUri, () => this.saveResolvedUnlocked(documentUri, reviewDocument));
  }

  async load(documentUri: vscode.Uri): Promise<ReviewDocument> {
    return this.withDocumentTransaction(documentUri, async () => (await this.readReviewDocuments(documentUri)).reviewDocument);
  }

  private async saveUnlocked(documentUri: vscode.Uri, reviewDocument: ReviewDocument): Promise<void> {
    const { reviewUri } = await this.getSidecarLocations(documentUri);
    const { resolvedReviewDocument } = await this.readReviewDocuments(documentUri);
    await this.writePortableReviewDocuments(
      reviewUri,
      documentUri,
      reviewDocument,
      resolvedReviewDocument
    );
  }

  private async saveBothUnlocked(
    documentUri: vscode.Uri,
    reviewDocument: ReviewDocument,
    resolvedReviewDocument: ReviewDocument
  ): Promise<void> {
    const { reviewUri } = await this.getSidecarLocations(documentUri);
    await this.writePortableReviewDocuments(reviewUri, documentUri, reviewDocument, resolvedReviewDocument);
  }

  private async addThreadUnlocked(documentUri: vscode.Uri, thread: ReviewThread): Promise<ReviewDocument> {
    const reviewDocument = await this.load(documentUri);
    reviewDocument.threads.push(thread);
    await this.save(documentUri, reviewDocument);
    return reviewDocument;
  }

  private async addThreadsUnlocked(documentUri: vscode.Uri, threads: ReviewThread[]): Promise<AddThreadsResult> {
    const reviewDocument = await this.load(documentUri);
    const addedThreads: ReviewThread[] = [];

    for (const thread of threads) {
      const duplicate = reviewDocument.threads.some(existing => isDuplicateReviewThread(existing, thread));

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

  private async updateThreadUnlocked(
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

  private async updateThreadAnchorsUnlocked(
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

  private async addReplyUnlocked(
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
    return this.withDocumentTransaction(documentUri, async () => (await this.readReviewDocuments(documentUri)).resolvedReviewDocument);
  }

  private async restoreThreadUnlocked(
    documentUri: vscode.Uri,
    threadId: string
  ): Promise<ReviewThread> {
    const reviewDocument = await this.load(documentUri);
    const existingOpenThread = reviewDocument.threads.find(candidate => candidate.id === threadId);

    if (existingOpenThread) {
      if (existingOpenThread.taskStatus === 'blocked' || existingOpenThread.taskResultFor !== undefined) {
        Object.assign(existingOpenThread, this.reopenTask(existingOpenThread));
        await this.save(documentUri, reviewDocument);
      }
      return existingOpenThread;
    }

    const resolvedDocument = await this.loadResolved(documentUri);
    const resolvedIndex = resolvedDocument.threads.findIndex(candidate => candidate.id === threadId);

    if (resolvedIndex < 0) {
      throw new Error(`Resolved review thread not found: ${threadId}`);
    }

    const restoredThread = reviewDocument.taskSchemaVersion === 3
      ? this.reopenTask(resolvedDocument.threads[resolvedIndex])
      : createRestoredReviewThread(resolvedDocument.threads[resolvedIndex], new Date().toISOString());

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

  async getSidecarPathRewrites(
    oldDocumentUri: vscode.Uri,
    newDocumentUri: vscode.Uri
  ): Promise<Record<string, string>> {
    const oldLocations = await this.getSidecarLocations(oldDocumentUri);
    const newLocations = await this.getSidecarLocations(newDocumentUri);

    return {
      [vscode.workspace.asRelativePath(oldLocations.reviewUri, false)]: vscode.workspace.asRelativePath(newLocations.reviewUri, false),
      [vscode.workspace.asRelativePath(oldLocations.resolvedUri, false)]: vscode.workspace.asRelativePath(newLocations.resolvedUri, false),
      [vscode.workspace.asRelativePath(oldLocations.legacyReviewUri, false)]: vscode.workspace.asRelativePath(newLocations.reviewUri, false),
      [vscode.workspace.asRelativePath(oldLocations.legacyResolvedUri, false)]: vscode.workspace.asRelativePath(newLocations.resolvedUri, false)
    };
  }

  async getReviewStateFileUris(documentUri: vscode.Uri): Promise<vscode.Uri[]> {
    const locations = await this.getSidecarLocations(documentUri);
    const uris = [
      locations.reviewUri,
      locations.resolvedUri,
      locations.legacyReviewUri,
      locations.legacyResolvedUri
    ];
    const seen = new Set<string>();

    return uris.filter(uri => {
      const key = uri.toString();

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  private async migrateDocumentUnlocked(oldDocumentUri: vscode.Uri, newDocumentUri: vscode.Uri): Promise<{
    reviewMoved: boolean;
    resolvedMoved: boolean;
  }> {
    const newLocations = await this.getSidecarLocations(newDocumentUri);
    this.assertWritable(oldDocumentUri);
    this.assertWritable(newDocumentUri);
      const sourceDocuments = await this.readReviewDocuments(oldDocumentUri);
      const sourceUri = await this.getReviewFileUri(oldDocumentUri);
      const aliasesSource = await sameFile(sourceUri, newLocations.reviewUri);
      const targetDocuments = aliasesSource ? {
        reviewDocument: createEmptyReviewDocument(newDocumentUri.toString()),
        resolvedReviewDocument: createEmptyReviewDocument(newDocumentUri.toString())
      } : await this.readReviewDocuments(newDocumentUri);
      const reviewMoved = sourceDocuments.reviewDocument.threads.length > 0;
      const resolvedMoved = sourceDocuments.resolvedReviewDocument.threads.length > 0;

      if (reviewMoved || resolvedMoved || this.state(oldDocumentUri).knownCanonical) {
        const open = mergeReviewDocuments(targetDocuments.reviewDocument, sourceDocuments.reviewDocument, newDocumentUri.toString());
        const closed = mergeReviewDocuments(targetDocuments.resolvedReviewDocument, sourceDocuments.resolvedReviewDocument, newDocumentUri.toString());
        open.taskSchemaVersion = sourceDocuments.reviewDocument.taskSchemaVersion;
        closed.taskSchemaVersion = sourceDocuments.resolvedReviewDocument.taskSchemaVersion;
        open.guidance = sourceDocuments.reviewDocument.guidance;
        await this.writePortableReviewDocuments(
          newLocations.reviewUri, newDocumentUri, open, closed, targetDocuments
        );
      }
      this.advanceEpoch(oldDocumentUri);
      this.advanceEpoch(newDocumentUri);
      const previousState = this.state(oldDocumentUri);
      await this.persistState(newDocumentUri, {
        historyPaths: [...(this.state(newDocumentUri).historyPaths ?? []), ...(previousState.historyPaths ?? [])],
        legacyPaths: [...(this.state(newDocumentUri).legacyPaths ?? []), ...(previousState.legacyPaths ?? [])]
      });
      return { reviewMoved, resolvedMoved };
  }

  private async deleteDocumentSidecarsUnlocked(documentUri: vscode.Uri, preservedDocumentUri?: vscode.Uri): Promise<void> {
    this.assertWritable(documentUri);
    const { reviewUri, legacyReviewUri, legacyResolvedUri } = await this.getSidecarLocations(documentUri);
    const preservedUri = preservedDocumentUri ? (await this.getSidecarLocations(preservedDocumentUri)).reviewUri : undefined;
    const samePortableFile = preservedUri ? await sameFile(reviewUri, preservedUri) : false;
    await Promise.all([
      samePortableFile ? Promise.resolve() : restoreFile(reviewUri, undefined),
      restoreFile(legacyReviewUri, undefined),
      restoreFile(legacyResolvedUri, undefined)
    ]);
  }

  private async saveResolvedUnlocked(documentUri: vscode.Uri, reviewDocument: ReviewDocument): Promise<void> {
    const { reviewUri } = await this.getSidecarLocations(documentUri);
    const { reviewDocument: openReviewDocument } = await this.readReviewDocuments(documentUri);
    await this.writePortableReviewDocuments(
      reviewUri,
      documentUri,
      openReviewDocument,
      reviewDocument
    );
  }

  private async getSidecarLocations(documentUri: vscode.Uri): Promise<ReviewSidecarLocations> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    const root = workspaceFolder?.uri ?? this.context.globalStorageUri;
    const documentsRoot = vscode.Uri.joinPath(root, LEGACY_REVIEW_STORAGE_ROOT, LEGACY_OPEN_REVIEW_FOLDER);
    const resolvedRoot = vscode.Uri.joinPath(root, LEGACY_REVIEW_STORAGE_ROOT, LEGACY_CLOSED_REVIEW_FOLDER);
    const portableUri = createColocatedSidecarUri(documentUri);

    return {
      reviewUri: portableUri,
      resolvedUri: portableUri,
      legacyReviewUri: vscode.Uri.joinPath(documentsRoot, `${hashText(documentUri.toString())}.json`),
      legacyResolvedUri: vscode.Uri.joinPath(resolvedRoot, `${hashText(documentUri.toString())}.json`)
    };
  }

  private async readReviewDocuments(documentUri: vscode.Uri): Promise<{
    reviewDocument: ReviewDocument;
    resolvedReviewDocument: ReviewDocument;
  }> {
    const { reviewUri, legacyReviewUri, legacyResolvedUri } = await this.getSidecarLocations(documentUri);
    const portableBytes = await readFileIfExists(reviewUri);
    this.observeRead(documentUri, reviewUri, portableBytes);
    await this.settlePendingWrite(documentUri, portableBytes);

    if (portableBytes !== undefined) {
      try {
        const value = JSON.parse(decoder.decode(portableBytes));
        const pair = parsePortableReviewSidecar(documentUri.toString(), value);
        const state = this.state(documentUri);
        if (state.checkpoint) {
          const compared = compareReviewTaskCheckpoint(state.checkpoint, parseReviewTaskSidecar(value));
          if (!compared.valid) throw new Error('A handed-off request, location, or ID changed or is missing. Inspect the review file or restore the pre-handoff backup.');
        } else if (state.lastValidPath && state.lastHash !== hashText(decoder.decode(portableBytes)) && value.schemaVersion === 3) {
          const previous = await readFileIfExists(vscode.Uri.file(state.lastValidPath));
          if (previous) {
            const old = JSON.parse(decoder.decode(previous));
            if (old.schemaVersion === 3) {
              const compared = compareReviewTaskCheckpoint(createReviewTaskCheckpoint(parseReviewTaskSidecar(old)), value);
              if (compared.missingIds.length) throw new Error('Review items disappeared from the file. Deletion is not treated as completion. Inspect the review file or restore the backup.');
            }
          }
        }
        await this.rememberValid(documentUri, portableBytes, true);
        return pair;
      } catch (error) {
        throw new Error(`Review sidecar is invalid: ${formatError(error)} Saved comments were left untouched. Inspect the review file or restore the backup.`);
      }
    }

    if (this.state(documentUri).knownCanonical || this.getHandoffPhase(documentUri) === 'handedOff') {
      throw new Error('The review file is missing. File deletion is not treated as completion. Check whether it moved or restore the backup.');
    }

    return {
      reviewDocument: await this.readLegacyReviewDocument(
        legacyReviewUri,
        documentUri,
        'legacy review sidecar'
      ),
      resolvedReviewDocument: await this.readLegacyReviewDocument(
        legacyResolvedUri,
        documentUri,
        'legacy resolved review sidecar'
      )
    };
  }

  private async readLegacyReviewDocument(
    uri: vscode.Uri,
    documentUri: vscode.Uri,
    label: string
  ): Promise<ReviewDocument> {
    const bytes = await readFileIfExists(uri);
    this.observeRead(documentUri, uri, bytes);

    if (!bytes) {
      return createEmptyReviewDocument(documentUri.toString());
    }

    try {
      return parseLegacyReviewDocument(documentUri.toString(), JSON.parse(decoder.decode(bytes)));
    } catch (error) {
      throw new Error(`${capitalize(label)} is invalid: ${formatError(error)}`);
    }
  }

  private async writePortableReviewDocuments(
    uri: vscode.Uri,
    documentUri: vscode.Uri,
    reviewDocument: ReviewDocument,
    resolvedReviewDocument: ReviewDocument,
    baseline?: { reviewDocument: ReviewDocument; resolvedReviewDocument: ReviewDocument }
  ): Promise<void> {
    this.assertWritable(documentUri);
    this.assertSidecarEditorClean(uri);
    const current = baseline ?? await this.readReviewDocuments(documentUri);
    this.normalizeTaskWrite(documentUri, current, reviewDocument, resolvedReviewDocument);
    const updatedAt = new Date().toISOString();
    const serialize = reviewDocument.taskSchemaVersion === 2 || resolvedReviewDocument.taskSchemaVersion === 2
      ? createLegacyReviewSidecarPayload : createPortableReviewSidecarPayload;
    const payload = serialize(
      documentUri.toString(),
      reviewDocument,
      resolvedReviewDocument,
      updatedAt
    );

    await vscode.workspace.fs.createDirectory(dirnameUri(uri));
    await this.assertUnchangedReads(documentUri);
    const bytes = encoder.encode(`${JSON.stringify(payload, null, 2)}\n`);
    await this.commitCanonicalWrite(documentUri, uri, bytes, () => this.assertUnchangedReads(documentUri));
    const transaction = this.transactionContext.getStore()?.get(documentUri.toString());
    transaction?.reads.set(uri.toString(), { uri, bytes });
  }

  private normalizeTaskWrite(
    uri: vscode.Uri,
    current: { reviewDocument: ReviewDocument; resolvedReviewDocument: ReviewDocument },
    open: ReviewDocument,
    closed: ReviewDocument
  ): void {
    if (open.taskSchemaVersion !== 3 || closed.taskSchemaVersion !== 3
      || current.reviewDocument.taskSchemaVersion !== 3 || current.resolvedReviewDocument.taskSchemaVersion !== 3) return;
    const previous = new Map([...current.reviewDocument.threads, ...current.resolvedReviewDocument.threads].map(thread => [thread.id, thread]));
    const tx = this.transactionContext.getStore()?.get(uri.toString());
    const outgoing = [...open.threads, ...closed.threads];
    const ids = new Set(outgoing.map(thread => thread.id));
    if (!tx?.internalWrite && !tx?.allowTaskRemoval && !tx?.rebaseTaskRevision && [...previous.keys()].some(id => !ids.has(id))) {
      throw new ReviewStorageConflictError();
    }
    for (const thread of outgoing) {
      const before = previous.get(thread.id);
      if (!before) continue;
      const revision = before.taskRevision ?? 1;
      const proposed = thread.taskRevision ?? 1;
      if (!tx?.rebaseTaskRevision && (proposed < revision || proposed > revision + 1)) throw new ReviewStorageConflictError();
      const changed = createReviewTaskFingerprint({ ...createReviewTaskItem(before), rev: 1 })
        !== createReviewTaskFingerprint({ ...createReviewTaskItem(thread), rev: 1 });
      if (changed || (!tx?.rebaseTaskRevision && proposed === revision + 1)) {
        Object.assign(thread, { taskRevision: revision + 1, taskStatus: 'pending', taskResult: undefined, taskResultFor: undefined,
          status: 'open', closedAt: undefined, closedBy: undefined });
      } else {
        Object.assign(thread, { taskRevision: revision, taskStatus: before.taskStatus, taskResult: before.taskResult, taskResultFor: before.taskResultFor });
        thread.status = getReviewTaskStatus(thread) === 'done' ? 'resolved' : 'open';
      }
    }
    open.threads = outgoing.filter(thread => getReviewTaskStatus(thread) !== 'done');
    closed.threads = outgoing.filter(thread => getReviewTaskStatus(thread) === 'done');
  }

  private async commitCanonicalWrite(documentUri: vscode.Uri, sidecar: vscode.Uri, bytes: Uint8Array, check?: () => Promise<void>): Promise<void> {
    const pendingWrite = { hash: hashText(decoder.decode(bytes)), path: await this.backup(documentUri, 'valid', bytes) };
    // The durable journal describes intent; last-valid continues to describe the committed file.
    await this.persistState(documentUri, { pendingWrite });
    try {
      await this.atomicWrite(sidecar, bytes, check);
    } catch (error) {
      try { await this.persistState(documentUri, { pendingWrite: undefined }); } catch { /* A later read reconciles the uncommitted intent. */ }
      throw error;
    }
    await this.finishCommittedWrite(documentUri, pendingWrite);
  }

  private async finishCommittedWrite(uri: vscode.Uri, committed: { hash: string; path: string }): Promise<void> {
    const update = { lastHash: committed.hash, lastValidPath: committed.path, knownCanonical: true, pendingWrite: undefined };
    try { await this.persistState(uri, update); } catch {
      // Canonical bytes committed successfully. Do not trigger a source rollback: the durable
      // pending record lets a restarted store finish this bookkeeping from the actual bytes.
      this.states.set(uri.toString(), { ...this.state(uri), ...update, pendingWrite: committed });
    }
  }

  private async settlePendingWrite(uri: vscode.Uri, bytes: Uint8Array | undefined): Promise<void> {
    const pending = this.state(uri).pendingWrite;
    if (!pending) return;
    if (bytes && hashText(decoder.decode(bytes)) === pending.hash) {
      await this.finishCommittedWrite(uri, pending);
    } else {
      await this.persistState(uri, { pendingWrite: undefined });
    }
  }

  private state(uri: vscode.Uri): StoredReviewState {
    const key = uri.toString();
    if (!this.states.has(key)) this.states.set(key, this.context.workspaceState?.get<StoredReviewState>('reviewState.' + hashText(key)) ?? {});
    return this.states.get(key)!;
  }

  private async persistState(uri: vscode.Uri, update: Partial<StoredReviewState>): Promise<void> {
    const next = { ...this.state(uri), ...update };
    await this.context.workspaceState?.update('reviewState.' + hashText(uri.toString()), next);
    this.states.set(uri.toString(), next);
  }

  private advanceEpoch(uri: vscode.Uri): void {
    this.epochs.set(uri.toString(), this.getDocumentEpoch(uri) + 1);
  }

  private async internalWrite<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
    const tx = this.transactionContext.getStore()?.get(uri.toString());
    if (!tx) throw new Error('Internal review write requires a transaction.');
    const previous = tx.internalWrite;
    tx.internalWrite = true;
    try { return await operation(); } finally { tx.internalWrite = previous; }
  }

  private assertSidecarEditorClean(uri: vscode.Uri): void {
    if (vscode.workspace.textDocuments?.some(document => document.uri.toString() === uri.toString() && document.isDirty)) {
      throw new Error('The open review JSON has unsaved changes. Save that file or review the changes first.');
    }
  }

  private checkTaskRevision(thread: ReviewThread, expected?: number): void {
    if (expected !== undefined && expected !== (thread.taskRevision ?? 1)) throw new ReviewStorageConflictError();
  }

  private reopenTask(thread: ReviewThread): ReviewThread {
    return { ...thread, status: 'open', taskStatus: 'pending', taskRevision: (thread.taskRevision ?? 1) + 1,
      taskResult: undefined, taskResultFor: undefined, closedAt: undefined, closedBy: undefined,
      thread: [], updatedAt: new Date().toISOString() };
  }

  private async backup(uri: vscode.Uri, kind: string, bytes: Uint8Array): Promise<string> {
    const directory = vscode.Uri.joinPath(this.context.storageUri ?? this.context.globalStorageUri, 'review-recovery', hashText(uri.toString()));
    await vscode.workspace.fs.createDirectory(directory);
    const file = vscode.Uri.joinPath(directory, kind === 'valid' ? `valid-${this.state(uri).lastValidPath?.endsWith('valid-0.json') ? '1' : '0'}.json` : `${kind}-${hashText(decoder.decode(bytes))}.json`);
    const previous = await readFileIfExists(file);
    if (!bytesEqual(previous, bytes)) await this.atomicWrite(file, bytes);
    if (!bytesEqual(bytes, await readFileIfExists(file))) throw new Error('The review backup could not be verified after saving.');
    return file.fsPath;
  }

  private async backupLegacy(uri: vscode.Uri): Promise<void> {
    const locations = await this.getSidecarLocations(uri);
    const paths = [...(this.state(uri).legacyPaths ?? [])];
    for (const [kind, file] of [['legacy', locations.reviewUri], ['legacy-open', locations.legacyReviewUri], ['legacy-closed', locations.legacyResolvedUri]] as const) {
      const bytes = await readFileIfExists(file);
      if (bytes) paths.push(await this.backup(uri, kind, bytes));
    }
    await this.persistState(uri, { legacyPaths: [...new Set(paths)] });
  }

  private async rememberValid(uri: vscode.Uri, bytes: Uint8Array, externalRead: boolean): Promise<void> {
    const state = this.state(uri);
    const hash = hashText(decoder.decode(bytes));
    if (state.lastHash === hash) return;
    if (externalRead && state.lastHash) this.advanceEpoch(uri);
    const lastValidPath = await this.backup(uri, 'valid', bytes);
    await this.persistState(uri, { lastValidPath, lastHash: hash, knownCanonical: true });
  }

  private async atomicWrite(uri: vscode.Uri, bytes: Uint8Array, check?: () => Promise<void>): Promise<void> {
    // Replacement prevents partial JSON reads. It is not a cross-process CAS.
    const temporary = uri.with({ path: uri.path + '.tmp-' + randomUUID() });
    try {
      await vscode.workspace.fs.writeFile(temporary, bytes);
      await check?.();
      await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
    } finally {
      try { await vscode.workspace.fs.delete(temporary); } catch { /* Best-effort cleanup; canonical commit determines success. */ }
    }
  }

  private observeRead(documentUri: vscode.Uri, uri: vscode.Uri, bytes: Uint8Array | undefined): void {
    const transaction = this.transactionContext.getStore()?.get(documentUri.toString());
    if (!transaction?.active) {
      return;
    }
    const previous = transaction.reads.get(uri.toString());
    if (previous && !bytesEqual(previous.bytes, bytes)) {
      throw new ReviewStorageConflictError();
    }
    transaction.reads.set(uri.toString(), { uri, bytes });
  }

  private async assertUnchangedReads(documentUri: vscode.Uri): Promise<void> {
    const context = this.transactionContext.getStore();
    if (!context?.get(documentUri.toString())?.active) return;
    // Rename depends on both source and destination reads in its nested transactions.
    for (const transaction of context.values()) {
      if (!transaction.active) continue;
      for (const { uri, bytes } of transaction.reads.values()) {
        if (!bytesEqual(bytes, await readFileIfExists(uri))) throw new ReviewStorageConflictError();
      }
    }
  }


}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
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

function createColocatedSidecarUri(documentUri: vscode.Uri): vscode.Uri {
  const directoryPath = path.posix.dirname(documentUri.path);
  const markdownFileName = path.posix.basename(documentUri.path);

  return documentUri.with({
    path: path.posix.join(
      directoryPath,
      createColocatedReviewSidecarFileName(markdownFileName)
    ),
    query: '',
    fragment: ''
  });
}

function dirnameUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({
    path: path.posix.dirname(uri.path),
    query: '',
    fragment: ''
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.length === right.length && left.every((value, index) => value === right[index]);
}

async function sameFile(left: vscode.Uri, right: vscode.Uri): Promise<boolean> {
  if (left.toString() === right.toString()) {
    return true;
  }
  if (left.scheme !== 'file' || right.scheme !== 'file') {
    return false;
  }
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left.fsPath, { bigint: true }), stat(right.fsPath, { bigint: true })]);
    return leftStat.ino !== 0n && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}
