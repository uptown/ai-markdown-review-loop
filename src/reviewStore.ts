import * as vscode from 'vscode';
import { createHash } from 'crypto';
import path from 'path';
import { createRestoredReviewThread } from './reviewHistory';
import {
  createEmptyReviewDocument,
  createPortableReviewSidecarPayload,
  mergeReviewDocuments,
  parseLegacyReviewDocument,
  parsePortableReviewSidecar,
  upsertThread
} from './reviewSidecarCodec';
import {
  LEGACY_CLOSED_REVIEW_FOLDER,
  LEGACY_OPEN_REVIEW_FOLDER,
  LEGACY_REVIEW_STORAGE_ROOT,
  createColocatedReviewSidecarFileName
} from './reviewSidecarPaths';
import { AnchorConfidence, ReviewDocument, ReviewThread } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

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

export class ReviewStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async load(documentUri: vscode.Uri): Promise<ReviewDocument> {
    return (await this.readReviewDocuments(documentUri)).reviewDocument;
  }

  async save(documentUri: vscode.Uri, reviewDocument: ReviewDocument): Promise<void> {
    const { reviewUri } = await this.getSidecarLocations(documentUri);
    const { resolvedReviewDocument } = await this.readReviewDocuments(documentUri);
    await this.writePortableReviewDocuments(
      reviewUri,
      documentUri,
      reviewDocument,
      resolvedReviewDocument
    );
  }

  async saveBoth(
    documentUri: vscode.Uri,
    reviewDocument: ReviewDocument,
    resolvedReviewDocument: ReviewDocument
  ): Promise<void> {
    const { reviewUri, resolvedUri } = await this.getSidecarLocations(documentUri);
    const before = await this.captureSidecarBytes(reviewUri, resolvedUri);

    try {
      await this.writePortableReviewDocuments(
        reviewUri,
        documentUri,
        reviewDocument,
        resolvedReviewDocument
      );
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
    return (await this.readReviewDocuments(documentUri)).resolvedReviewDocument;
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

  async migrateDocument(oldDocumentUri: vscode.Uri, newDocumentUri: vscode.Uri): Promise<{
    reviewMoved: boolean;
    resolvedMoved: boolean;
  }> {
    const newLocations = await this.getSidecarLocations(newDocumentUri);
    const beforeNewSidecars = await this.captureSidecarBytes(newLocations.reviewUri, newLocations.resolvedUri);

    try {
      const sourceDocuments = await this.readReviewDocuments(oldDocumentUri);
      const targetDocuments = await this.readReviewDocuments(newDocumentUri);
      const reviewMoved = sourceDocuments.reviewDocument.threads.length > 0;
      const resolvedMoved = sourceDocuments.resolvedReviewDocument.threads.length > 0;

      if (reviewMoved || resolvedMoved) {
        await this.writePortableReviewDocuments(
          newLocations.reviewUri,
          newDocumentUri,
          mergeReviewDocuments(
            targetDocuments.reviewDocument,
            sourceDocuments.reviewDocument,
            newDocumentUri.toString()
          ),
          mergeReviewDocuments(
            targetDocuments.resolvedReviewDocument,
            sourceDocuments.resolvedReviewDocument,
            newDocumentUri.toString()
          )
        );
      }

      return { reviewMoved, resolvedMoved };
    } catch (error) {
      await this.restoreSidecarBytes(newLocations.reviewUri, newLocations.resolvedUri, beforeNewSidecars);
      throw error;
    }
  }

  async deleteDocumentSidecars(documentUri: vscode.Uri): Promise<void> {
    const { reviewUri, legacyReviewUri, legacyResolvedUri } = await this.getSidecarLocations(documentUri);
    await Promise.all([
      restoreFile(reviewUri, undefined),
      restoreFile(legacyReviewUri, undefined),
      restoreFile(legacyResolvedUri, undefined)
    ]);
  }

  async saveResolved(documentUri: vscode.Uri, reviewDocument: ReviewDocument): Promise<void> {
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

    if (portableBytes) {
      try {
        return parsePortableReviewSidecar(
          documentUri.toString(),
          JSON.parse(decoder.decode(portableBytes))
        );
      } catch (error) {
        throw new Error(`Review sidecar is invalid: ${formatError(error)}`);
      }
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
    resolvedReviewDocument: ReviewDocument
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    const payload = createPortableReviewSidecarPayload(
      documentUri.toString(),
      reviewDocument,
      resolvedReviewDocument,
      updatedAt
    );

    await vscode.workspace.fs.createDirectory(dirnameUri(uri));
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
