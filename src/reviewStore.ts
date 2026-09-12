import * as vscode from 'vscode';
import { createHash, randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { stat } from 'fs/promises';
import path from 'path';
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
import { compareReviewTaskCheckpoint, createReviewTaskCheckpoint, createReviewTaskFingerprint, parseReviewTaskSidecar, type ReviewTaskCheckpoint } from './reviewTaskProtocol';
import {
  LEGACY_CLOSED_REVIEW_FOLDER,
  LEGACY_OPEN_REVIEW_FOLDER,
  LEGACY_REVIEW_STORAGE_ROOT,
  createColocatedReviewSidecarFileName
} from './reviewSidecarPaths';
import { isDuplicateReviewThread } from './reviewThreadDedup';
import { AnchorConfidence, ReviewDocument, ReviewThread } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const retainedNamedSnapshots = 4;
const retainedNamedBytes = 8 * 1024 * 1024;
const recoveryFilePattern = /^(?:valid-[01]|(?:removed|before-restore|before-start-over|legacy(?:-open|-closed)?|handoff|completed)-[a-f0-9]{24})\.json$/;

interface AddThreadsResult {
  reviewDocument: ReviewDocument;
  addedThreads: ReviewThread[];
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
  acceptedCopies?: { path: string; hash: string }[];
  pendingWrite?: { hash: string; path: string };
  historyPaths?: string[];
  legacyPaths?: string[];
  renameCheckpoint?: {
    destination: string;
    sourceHash?: string;
    destinationHash?: string;
    files: { path: string; hash?: string }[];
  };
  /** The external agent removed the canonical JSON after processing it. */
  sidecarMissing?: boolean;
}

export class ReviewStore {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly transactionContext = new AsyncLocalStorage<Map<string, DocumentTransaction>>();
  private readonly states = new Map<string, StoredReviewState>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  getReviewFileState(uri: vscode.Uri): 'active' | 'removed' {
    return this.state(uri).sidecarMissing ? 'removed' : 'active';
  }
  getDocumentEpoch(uri: vscode.Uri): number { return this.epochs.get(uri.toString()) ?? 0; }

  /**
   * Prepare the canonical JSON for an external agent without creating a
   * handoff phase or pausing extension writes. The returned text can be pasted
   * into an agent that cannot read the workspace; file based agents can use the
   * returned sidecar path directly.
   */
  async exportReviewJson(uri: vscode.Uri, saveDocument: () => Promise<boolean>): Promise<{ sidecar: vscode.Uri; contents: string }> {

    return this.withDocumentTransaction(uri, async () => {
      if (!await saveDocument()) throw new Error('The document save was cancelled, so the review JSON was not exported.');
      const sidecar = await this.getReviewFileUri(uri);
      this.assertSidecarEditorClean(sidecar);
      let pair = await this.readReviewDocuments(uri);
      if (pair.reviewDocument.taskSchemaVersion === 2 || pair.resolvedReviewDocument.taskSchemaVersion === 2) {
        await this.backupLegacy(uri);
        pair = migrateLegacyReviewDocuments(pair);
      }
      pair.reviewDocument.taskSchemaVersion = 3;
      pair.resolvedReviewDocument.taskSchemaVersion = 3;
      if (pair.reviewDocument.threads.length === 0) {
        throw new Error('There are no comments to export. Select text and add a comment first.');
      }
      await this.writePortableReviewDocuments(sidecar, uri, pair.reviewDocument, pair.resolvedReviewDocument);
      const bytes = await readFileIfExists(sidecar);
      if (!bytes) throw new Error('The review JSON could not be read after export.');
      return { sidecar, contents: decoder.decode(bytes) };
    });
  }

  async updateComment(uri: vscode.Uri, id: string, comment: string, expectedRevision?: number): Promise<void> {

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

  /** Explicit recovery only; never resurrect a missing sidecar during ordinary reads. */
  async restoreReviewBackup(uri: vscode.Uri): Promise<void> {
    await this.withDocumentTransaction(uri, async () => this.internalWrite(uri, async () => {
      await this.migrateStoredState(uri);
      const bytes = await this.findRecoveryBytes(uri);
      if (!bytes) throw new Error('No valid review backup is available. Run Start New Review to begin an empty comment list.');
      const sidecar = await this.getReviewFileUri(uri);
      this.assertSidecarEditorClean(sidecar);
      const current = await readFileIfExists(sidecar);
      if (current) await this.backup(uri, 'before-restore', current);
      await this.preserveUnconfirmedWrite(uri);
      await this.commitCanonicalWrite(uri, sidecar, bytes, async () => {
        if (!bytesEqual(current, await readFileIfExists(sidecar))) throw new ReviewStorageConflictError();
      });
      await this.persistState(uri, { phase: undefined, checkpoint: undefined, checkpointPath: undefined });
      this.advanceEpoch(uri);
    }));
  }

  /** User-confirmed restart only when no accepted comment copy is recoverable. */
  async startNewReview(uri: vscode.Uri): Promise<void> {
    await this.withDocumentTransaction(uri, async () => {
      await this.migrateStoredState(uri);
      const sidecar = await this.getReviewFileUri(uri);
      this.assertSidecarEditorClean(sidecar);
      const current = await readFileIfExists(sidecar);
      if (current) {
        try {
          parsePortableReviewSidecar(uri.toString(), JSON.parse(decoder.decode(current)));
          throw new ReviewStorageConflictError();
        } catch (error) {
          if (error instanceof ReviewStorageConflictError) {
            throw new Error('The current JSON contains valid comments. Edit or delete them in the preview instead.');
          }
        }
      }
      if (await this.findRecoveryBytes(uri)) throw new Error('A valid comment copy is available. Run Restore Review Backup instead.');
      if (current) await this.backup(uri, 'before-start-over', current);
      await this.preserveUnconfirmedWrite(uri);
      const empty = createEmptyReviewDocument(uri.toString());
      const bytes = encoder.encode(JSON.stringify(createPortableReviewSidecarPayload(uri.toString(), empty, empty, ''), null, 2) + '\n');
      await this.commitCanonicalWrite(uri, sidecar, bytes, async () => {
        if (!bytesEqual(current, await readFileIfExists(sidecar))) throw new ReviewStorageConflictError();
      });
      this.advanceEpoch(uri);
    });
  }

  /** Remove private historical copies while retaining the accepted current comments. */
  async purgeRecovery(uri: vscode.Uri): Promise<number> {
    return this.withDocumentTransaction(uri, async () => {
      await this.migrateStoredState(uri);
      // Load first: never purge a recovery baseline while an external conflict is unresolved.
      await this.readReviewDocuments(uri);
      const removed = await this.pruneRecovery(uri, undefined, true);
      const state = this.state(uri);
      await this.persistState(uri, { historyPaths: [], legacyPaths: [],
        acceptedCopies: state.lastValidPath && state.lastHash ? [{ path: state.lastValidPath, hash: state.lastHash }] : [] });
      return removed;
    });
  }

  private async findRecoveryBytes(uri: vscode.Uri): Promise<Uint8Array | undefined> {
    const state = this.state(uri);
    // An alternating slot can contain a prepared write that never committed.
    // Only explicitly accepted hashes are eligible for recovery.
    const candidates = [{ path: state.lastValidPath, hash: state.lastHash }, ...(state.acceptedCopies ?? [])];
    for (const { path: file, hash } of candidates) {
      if (!file || (file === state.pendingWrite?.path && file !== state.lastValidPath)) continue;
      const bytes = await readFileIfExists(vscode.Uri.file(file));
      if (!bytes) continue;
      if (hash && hashText(decoder.decode(bytes)) !== hash) continue;
      try { parsePortableReviewSidecar(uri.toString(), JSON.parse(decoder.decode(bytes))); return bytes; } catch { /* Try the other accepted slot. */ }
    }
    return undefined;
  }

  private recoveryDirectory(uri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(this.context.storageUri ?? this.context.globalStorageUri, 'review-recovery', hashText(uri.toString()));
  }

  private async pruneRecovery(uri: vscode.Uri, keep?: string, purge = false): Promise<number> {
    const directory = this.recoveryDirectory(uri);
    let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(directory); } catch (error) {
      if (isFileNotFoundError(error)) return 0;
      throw error;
    }
    const state = this.state(uri);
    const protectedPaths = new Set([state.lastValidPath, state.pendingWrite?.path, keep].filter(Boolean));
    const candidates: { file: vscode.Uri; size: number; mtime: number; valid: boolean }[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !recoveryFilePattern.test(name)) continue;
      const file = vscode.Uri.joinPath(directory, name);
      if (protectedPaths.has(file.fsPath)) continue;
      const stat = await vscode.workspace.fs.stat(file);
      candidates.push({ file, size: stat.size, mtime: stat.mtime, valid: name.startsWith('valid-') });
    }
    candidates.sort((a, b) => b.mtime - a.mtime || a.file.path.localeCompare(b.file.path));
    const keptNamed = keep && !/valid-[01]\.json$/.test(keep) ? await vscode.workspace.fs.stat(vscode.Uri.file(keep)) : undefined;
    let count = keptNamed ? 1 : 0, bytes = keptNamed?.size ?? 0, removed = 0;
    for (const candidate of candidates) {
      if (!purge && candidate.valid) continue;
      if (!purge && count < retainedNamedSnapshots && bytes + candidate.size <= retainedNamedBytes) {
        count++; bytes += candidate.size; continue;
      }
      await vscode.workspace.fs.delete(candidate.file);
      removed++;
    }
    return removed;
  }

  /** Keep the complete read/modify/write operation inside this callback. Nested calls are reentrant. */
  async withDocumentTransaction<T>(documentUri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
    const key = documentUri.toString();
    const inherited = this.transactionContext.getStore();

    if (inherited?.get(key)?.active) {
      return operation();
    }

    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(key, tail);
    await previous;
    const transaction: DocumentTransaction = { active: true, reads: new Map() };
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

    return this.withDocumentTransaction(documentUri, () => this.saveUnlocked(documentUri, reviewDocument));
  }

  async saveBoth(documentUri: vscode.Uri, open: ReviewDocument, closed: ReviewDocument): Promise<void> {

    return this.withDocumentTransaction(documentUri, () => this.saveBothUnlocked(documentUri, open, closed));
  }

  /** Undo replays request deltas while keeping revisions monotonically increasing. */
  async saveBothForUndo(documentUri: vscode.Uri, open: ReviewDocument, closed: ReviewDocument): Promise<void> {

    await this.withDocumentTransaction(documentUri, async () => {
      const tx = this.transactionContext.getStore()!.get(documentUri.toString())!;
      const previous = tx.rebaseTaskRevision;
      tx.rebaseTaskRevision = true;
      try { await this.saveBothUnlocked(documentUri, open, closed); } finally { tx.rebaseTaskRevision = previous; }
    });
  }

  async addThread(documentUri: vscode.Uri, thread: ReviewThread): Promise<ReviewDocument> {

    return this.withDocumentTransaction(documentUri, () => this.addThreadUnlocked(documentUri, thread));
  }

  async addThreads(documentUri: vscode.Uri, threads: ReviewThread[]): Promise<AddThreadsResult> {

    return this.withDocumentTransaction(documentUri, () => this.addThreadsUnlocked(documentUri, threads));
  }

  async updateThread(documentUri: vscode.Uri, threadId: string, update: Partial<ReviewThread>): Promise<ReviewDocument> {

    return this.withDocumentTransaction(documentUri, () => this.updateThreadUnlocked(documentUri, threadId, update));
  }

  async updateThreadAnchors(documentUri: vscode.Uri, updates: AnchorLocationUpdate[]): Promise<boolean> {

    return this.withDocumentTransaction(documentUri, () => this.updateThreadAnchorsUnlocked(documentUri, updates));
  }

  async migrateDocument(oldDocumentUri: vscode.Uri, newDocumentUri: vscode.Uri): Promise<{
    reviewMoved: boolean;
    resolvedMoved: boolean;
  }> {


    const ordered = [oldDocumentUri, newDocumentUri].sort((left, right) => left.toString().localeCompare(right.toString()));
    return this.withDocumentTransaction(ordered[0], () => this.withDocumentTransaction(ordered[1],
      () => this.migrateDocumentUnlocked(oldDocumentUri, newDocumentUri)));
  }

  /** Keep both document queues locked until the copied review is finalized. */
  async renameDocument(oldDocumentUri: vscode.Uri, newDocumentUri: vscode.Uri): Promise<void> {
    if (oldDocumentUri.toString() === newDocumentUri.toString()) return;
    const ordered = [oldDocumentUri, newDocumentUri].sort((left, right) => left.toString().localeCompare(right.toString()));
    await this.withDocumentTransaction(ordered[0], () => this.withDocumentTransaction(ordered[1], async () => {
      await this.migrateDocumentUnlocked(oldDocumentUri, newDocumentUri);
      await this.deleteDocumentSidecarsUnlocked(oldDocumentUri, newDocumentUri);
    }));
  }

  async deleteDocumentSidecars(documentUri: vscode.Uri, preservedDocumentUri?: vscode.Uri): Promise<void> {
    const ordered = [documentUri, ...(preservedDocumentUri ? [preservedDocumentUri] : [])]
      .sort((left, right) => left.toString().localeCompare(right.toString()));
    return this.withDocumentTransaction(ordered[0], () => this.withDocumentTransaction(ordered[1] ?? ordered[0],
      () => this.deleteDocumentSidecarsUnlocked(documentUri, preservedDocumentUri)));
  }

  async load(documentUri: vscode.Uri): Promise<ReviewDocument> {
    return this.withDocumentTransaction(documentUri, async () => (await this.readReviewDocuments(documentUri)).reviewDocument);
  }

  /** Restricted previews may read comments without accepting or persisting state. */
  async loadReadonly(documentUri: vscode.Uri): Promise<ReviewDocument> {
    return this.withDocumentTransaction(documentUri, async () => (await this.readReviewDocuments(documentUri, true)).reviewDocument);
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

  async loadResolved(documentUri: vscode.Uri): Promise<ReviewDocument> {
    return this.withDocumentTransaction(documentUri, async () => (await this.readReviewDocuments(documentUri)).resolvedReviewDocument);
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


      const sourceDocuments = await this.readReviewDocuments(oldDocumentUri);
      const sourceFiles: { path: string; hash?: string }[] = [];
      for (const uri of await this.getReviewStateFileUris(oldDocumentUri)) {
        const bytes = await readFileIfExists(uri);
        this.observeRead(oldDocumentUri, uri, bytes);
        sourceFiles.push({ path: uri.fsPath, hash: bytes === undefined ? undefined : hashText(decoder.decode(bytes)) });
      }
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
      if (aliasesSource) {
        const canonical = sourceFiles.find(file => file.path === sourceUri.fsPath)!;
        const bytes = await readFileIfExists(sourceUri);
        const hash = bytes === undefined ? undefined : hashText(decoder.decode(bytes));
        if (hash !== canonical.hash && hash !== this.state(newDocumentUri).lastHash) throw new ReviewStorageConflictError();
        canonical.hash = hash;
      }
      await this.persistState(oldDocumentUri, { renameCheckpoint: {
        destination: newDocumentUri.toString(), sourceHash: previousState.lastHash,
        destinationHash: this.state(newDocumentUri).lastHash, files: sourceFiles
      } });
      return { reviewMoved, resolvedMoved };
  }

  private async deleteDocumentSidecarsUnlocked(documentUri: vscode.Uri, preservedDocumentUri?: vscode.Uri): Promise<void> {
    if (documentUri.toString() === preservedDocumentUri?.toString()) return;

    const { reviewUri, legacyReviewUri, legacyResolvedUri } = await this.getSidecarLocations(documentUri);
    const preservedUri = preservedDocumentUri ? (await this.getSidecarLocations(preservedDocumentUri)).reviewUri : undefined;
    const samePortableFile = preservedUri ? await sameFile(reviewUri, preservedUri) : false;
    if (preservedDocumentUri && preservedUri) {
      const checkpoint = this.state(documentUri).renameCheckpoint;
      if (!checkpoint || checkpoint.destination !== preservedDocumentUri.toString()
        || checkpoint.sourceHash !== this.state(documentUri).lastHash) {
        throw new Error('Review comments changed while rename was completing. Original files and recovery copies were retained.');
      }
      for (const file of checkpoint.files) {
        const bytes = await readFileIfExists(vscode.Uri.file(file.path));
        if ((bytes === undefined ? undefined : hashText(decoder.decode(bytes))) !== file.hash) {
          throw new Error('Review comments changed while rename was completing. Original files and recovery copies were retained.');
        }
      }
      const destination = await readFileIfExists(preservedUri);
      if ((destination === undefined ? undefined : hashText(decoder.decode(destination))) !== checkpoint.destinationHash) {
        throw new Error('The destination review changed while rename was completing. Original files and recovery copies were retained.');
      }
      if (!destination) {
        if (this.state(documentUri).knownCanonical || await readFileIfExists(reviewUri)) {
          throw new Error('The renamed review JSON is missing; original recovery copies were retained.');
        }
      } else {
        parsePortableReviewSidecar(preservedDocumentUri.toString(), JSON.parse(decoder.decode(destination)));
        await this.moveRecoveryAfterRename(documentUri, preservedDocumentUri);
      }
    }
    await Promise.all([
      samePortableFile ? Promise.resolve() : restoreFile(reviewUri, undefined),
      restoreFile(legacyReviewUri, undefined),
      restoreFile(legacyResolvedUri, undefined)
    ]);
    if (preservedDocumentUri) {
      await this.context.workspaceState?.update('reviewState.' + hashText(documentUri.toString()), undefined);
      this.states.set(documentUri.toString(), {});
    }
  }

  /** A rename keeps one bounded recovery directory, not a trail of private copies. */
  private async moveRecoveryAfterRename(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    if (from.toString() === to.toString()) return;
    const source = this.recoveryDirectory(from);
    let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(source); } catch (error) {
      if (isFileNotFoundError(error)) return;
      throw error;
    }
    const files: { name: string; uri: vscode.Uri; mtime: number }[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !recoveryFilePattern.test(name)) continue;
      const uri = vscode.Uri.joinPath(source, name);
      files.push({ name, uri, mtime: (await vscode.workspace.fs.stat(uri)).mtime });
    }
    // Copy named recovery records before deleting anything. Current accepted
    // comments already have a verified baseline at the renamed destination.
    files.sort((a, b) => a.mtime - b.mtime);
    for (const file of files) {
      if (file.name.startsWith('valid-')) continue;
      const bytes = await readFileIfExists(file.uri);
      if (bytes) await this.backup(to, file.name.replace(/-[a-f0-9]{24}\.json$/, ''), bytes);
    }
    for (const file of files) await vscode.workspace.fs.delete(file.uri);
    await this.persistState(to, { historyPaths: [], legacyPaths: [] });
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

  private async readReviewDocuments(documentUri: vscode.Uri, readOnly = false): Promise<{
    reviewDocument: ReviewDocument;
    resolvedReviewDocument: ReviewDocument;
  }> {
    if (!readOnly) await this.migrateStoredState(documentUri);
    const { reviewUri, legacyReviewUri, legacyResolvedUri } = await this.getSidecarLocations(documentUri);
    const portableBytes = await readFileIfExists(reviewUri);
    this.observeRead(documentUri, reviewUri, portableBytes);
    if (!readOnly) await this.settlePendingWrite(documentUri, portableBytes);

    if (portableBytes !== undefined) {
      try {
        const value = JSON.parse(decoder.decode(portableBytes));
        const pair = parsePortableReviewSidecar(documentUri.toString(), value);
        const state = this.state(documentUri);
        if ((state.knownCanonical || state.lastValidPath) && state.lastHash !== hashText(decoder.decode(portableBytes))) {
          const previous = state.lastValidPath ? await readFileIfExists(vscode.Uri.file(state.lastValidPath)) : undefined;
          if (!previous || !state.lastHash || hashText(decoder.decode(previous)) !== state.lastHash) {
            throw new Error('The last accepted copy is missing or changed, so this external JSON cannot be verified.');
          }
          const old = JSON.parse(decoder.decode(previous));
          if (old.schemaVersion === 3) {
            if (value.schemaVersion !== 3) throw new Error('An external edit replaced the current comment format.');
            const compared = compareReviewTaskCheckpoint(createReviewTaskCheckpoint(parseReviewTaskSidecar(old)), value);
            if (!compared.valid) throw new Error('An external edit changed user-owned comments, targets, revisions, IDs, or guidance.');
          }
        }
        if (!readOnly) await this.rememberValid(documentUri, portableBytes, true);
        return pair;
      } catch (error) {
        throw new Error(`Review sidecar is invalid: ${formatError(error)} The last accepted comments are preserved. Inspect the JSON or run Restore Review Backup to recover them; the conflicting file will be backed up.`);
      }
    }

    const state = this.state(documentUri);
    if (state.knownCanonical || (readOnly && state.checkpointPath)) {
      const lastValidPath = state.lastValidPath ?? (readOnly ? state.checkpointPath : undefined);
      const previous = lastValidPath ? await readFileIfExists(vscode.Uri.file(lastValidPath)) : undefined;
      if (previous) {
        try {
          if (!state.lastHash || hashText(decoder.decode(previous)) !== state.lastHash) {
            throw new Error('The last accepted copy is missing or changed. Run Restore Review Backup to check other accepted copies.');
          }
          const value = JSON.parse(decoder.decode(previous));
          const pair = parsePortableReviewSidecar(documentUri.toString(), value);
          if (!readOnly && !state.sidecarMissing) {
            await this.persistState(documentUri, { sidecarMissing: true });
            this.advanceEpoch(documentUri);
          }
          return pair;
        } catch (error) {
          throw new Error(`The last valid review JSON could not be restored after deletion: ${formatError(error)}`);
        }
      }
      throw new Error('The review JSON and its last accepted copy are missing. Run Restore Review Backup to check other copies, or Start New Review when no valid comments can be recovered.');
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
        // v3 keeps every user-owned comment in the current list. Agent outcomes
        // are metadata on that comment, never a second resolved/history list.
        thread.status = 'open';
      }
    }
    open.threads = outgoing;
    closed.threads = [];
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
    const update = { lastHash: committed.hash, lastValidPath: committed.path, acceptedCopies: this.acceptedCopies(uri, committed), knownCanonical: true, pendingWrite: undefined, sidecarMissing: false };
    try { await this.persistState(uri, update); } catch {
      // Canonical bytes committed successfully. Do not trigger a source rollback: the durable
      // pending record lets a restarted store finish this bookkeeping from the actual bytes.
      this.states.set(uri.toString(), { ...this.state(uri), ...update, pendingWrite: committed });
    }
  }

  private acceptedCopies(uri: vscode.Uri, latest: { hash: string; path: string }): { hash: string; path: string }[] {
    const state = this.state(uri);
    const previous = state.lastValidPath && state.lastHash ? [{ path: state.lastValidPath, hash: state.lastHash }] : [];
    return [latest, ...previous, ...(state.acceptedCopies ?? [])]
      .filter((copy, index, all) => all.findIndex(candidate => candidate.path === copy.path) === index).slice(0, 2);
  }

  private async settlePendingWrite(uri: vscode.Uri, bytes: Uint8Array | undefined): Promise<void> {
    const pending = this.state(uri).pendingWrite;
    if (!pending) return;
    if (!bytes && this.state(uri).lastHash === pending.hash && this.state(uri).lastValidPath === pending.path) {
      await this.finishCommittedWrite(uri, pending);
      return;
    }
    if (!bytes) {
      throw new Error('The review JSON disappeared before its last save could be confirmed. Run Restore Review Backup; the unconfirmed write will also be preserved for inspection.');
    }
    if (bytes && hashText(decoder.decode(bytes)) === pending.hash) {
      await this.finishCommittedWrite(uri, pending);
    } else {
      await this.persistState(uri, { pendingWrite: undefined });
    }
  }

  private async preserveUnconfirmedWrite(uri: vscode.Uri): Promise<void> {
    const pending = this.state(uri).pendingWrite;
    if (!pending) return;
    const bytes = await readFileIfExists(vscode.Uri.file(pending.path));
    if (bytes && hashText(decoder.decode(bytes)) === pending.hash) await this.backup(uri, 'before-restore', bytes);
  }

  private state(uri: vscode.Uri): StoredReviewState {
    const key = uri.toString();
    if (!this.states.has(key)) this.states.set(key, this.context.workspaceState?.get<StoredReviewState>('reviewState.' + hashText(key)) ?? {});
    return this.states.get(key)!;
  }

  /** Old releases persisted a UI handoff lock. It has no role in current rounds. */
  private async migrateStoredState(uri: vscode.Uri): Promise<void> {
    const state = this.state(uri);
    if (state.phase !== undefined || state.checkpoint !== undefined || state.checkpointPath !== undefined) {
      await this.persistState(uri, {
        lastValidPath: state.lastValidPath ?? state.checkpointPath,
        knownCanonical: state.knownCanonical || Boolean(state.checkpointPath),
        phase: undefined, checkpoint: undefined, checkpointPath: undefined
      });
    }
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

  private async backup(uri: vscode.Uri, kind: string, bytes: Uint8Array): Promise<string> {
    if (kind !== 'valid' && bytes.byteLength > retainedNamedBytes) {
      throw new Error('This recovery snapshot exceeds the 8 MiB retention limit. Save a separate copy of the review JSON before reducing its size and retrying.');
    }
    const directory = this.recoveryDirectory(uri);
    await vscode.workspace.fs.createDirectory(directory);
    const file = vscode.Uri.joinPath(directory, kind === 'valid' ? `valid-${this.state(uri).lastValidPath?.endsWith('valid-0.json') ? '1' : '0'}.json` : `${kind}-${hashText(decoder.decode(bytes))}.json`);
    const previous = await readFileIfExists(file);
    if (!bytesEqual(previous, bytes)) await this.atomicWrite(file, bytes);
    if (!bytesEqual(bytes, await readFileIfExists(file))) throw new Error('The review backup could not be verified after saving.');
    await this.pruneRecovery(uri, file.fsPath);
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
    if (state.lastHash === hash) {
      const acceptedUri = state.lastValidPath ? vscode.Uri.file(state.lastValidPath) : undefined;
      const acceptedBytes = acceptedUri ? await readFileIfExists(acceptedUri) : undefined;
      if (!acceptedUri || !acceptedBytes || hashText(decoder.decode(acceptedBytes)) !== hash) {
        // The unchanged canonical bytes are themselves authenticated by lastHash.
        // Repair the latest slot in place to preserve the previous accepted copy.
        if (acceptedUri) {
          await vscode.workspace.fs.createDirectory(this.recoveryDirectory(uri));
          await this.atomicWrite(acceptedUri, bytes);
        } else {
          const lastValidPath = await this.backup(uri, 'valid', bytes);
          await this.persistState(uri, { lastValidPath, acceptedCopies: this.acceptedCopies(uri, { path: lastValidPath, hash }), knownCanonical: true });
        }
      }
      if (state.sidecarMissing) await this.persistState(uri, { sidecarMissing: false });
      return;
    }
    if (externalRead && state.lastHash) this.advanceEpoch(uri);
    const lastValidPath = await this.backup(uri, 'valid', bytes);
    await this.persistState(uri, { lastValidPath, lastHash: hash, acceptedCopies: this.acceptedCopies(uri, { path: lastValidPath, hash }), knownCanonical: true, sidecarMissing: false });
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
