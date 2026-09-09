import * as vscode from 'vscode';
import { ReviewStore } from './reviewStore';
import { createEmptyReviewDocument, parsePortableReviewSidecar } from './reviewSidecarCodec';
import type { ReviewDocumentPair } from './reviewSidecarCodec';
import { mergeReviewUndoDelta } from './reviewUndoMerge';
import type { ReviewUndoProtection } from './reviewUndoMerge';

export interface ReviewSidecarSnapshot {
  documents?: ReviewDocumentPair;
  reviewUri: vscode.Uri;
  reviewBytes: Uint8Array | undefined;
  resolvedUri: vscode.Uri;
  resolvedBytes: Uint8Array | undefined;
}

interface ReviewUndoEntry {
  protection: ReviewUndoProtection;
  beforeText: string;
  afterText: string;
  beforeSnapshot: ReviewSidecarSnapshot;
  afterSnapshot: ReviewSidecarSnapshot;
}

const maxEntriesPerDocument = 50;

export class ReviewUndoController {
  private readonly done = new Map<string, ReviewUndoEntry[]>();
  private readonly undone = new Map<string, ReviewUndoEntry[]>();

  constructor(private readonly store: ReviewStore) {}

  async capture(documentUri: vscode.Uri): Promise<ReviewSidecarSnapshot> {
    return this.store.withDocumentTransaction(documentUri, async () => {
      const reviewUri = await this.store.getReviewFileUri(documentUri);
      const resolvedUri = await this.store.getResolvedReviewFileUri(documentUri);
      const documents = {
        reviewDocument: await this.store.load(documentUri),
        resolvedReviewDocument: await this.store.loadResolved(documentUri)
      };
      const reviewBytes = await readFileIfExists(reviewUri);
      return {
        documents,
        reviewUri,
        reviewBytes,
        resolvedUri,
        resolvedBytes: reviewUri.toString() === resolvedUri.toString() ? reviewBytes : await readFileIfExists(resolvedUri)
      };
    });
  }

  register(
    documentUri: vscode.Uri,
    beforeText: string,
    afterText: string,
    beforeSnapshot: ReviewSidecarSnapshot,
    afterSnapshot: ReviewSidecarSnapshot
  ): void {
    if (beforeText === afterText && snapshotsEqual(beforeSnapshot, afterSnapshot)) {
      return;
    }

    const key = documentUri.toString();
    const doneEntries = this.done.get(key) ?? [];
    doneEntries.push({
      protection: { fields: new Map(), decisions: new Set() },
      beforeText,
      afterText,
      beforeSnapshot,
      afterSnapshot
    });

    while (doneEntries.length > maxEntriesPerDocument) {
      doneEntries.shift();
    }

    this.done.set(key, doneEntries);
    this.undone.delete(key);
  }

  async handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<boolean> {
    // Capture the event's text before queueing; TextDocument can advance during the wait.
    const text = event.document.getText();
    if (event.reason !== vscode.TextDocumentChangeReason.Undo && event.reason !== vscode.TextDocumentChangeReason.Redo) {
      return false;
    }
    return this.store.withDocumentTransaction(event.document.uri, () =>
      this.restoreForChange(event.document.uri, text, event.reason === vscode.TextDocumentChangeReason.Undo));
  }

  private async restoreForChange(documentUri: vscode.Uri, text: string, undo: boolean): Promise<boolean> {
    const key = documentUri.toString();
    const source = undo ? this.done : this.undone;
    const destination = undo ? this.undone : this.done;
    const entries = source.get(key) ?? [];
    const entry = entries[entries.length - 1];
    if (!entry || (undo ? entry.beforeText : entry.afterText) !== text) {
      return false;
    }

    const current = {
      reviewDocument: await this.store.load(documentUri),
      resolvedReviewDocument: await this.store.loadResolved(documentUri)
    };
    const from = snapshotDocuments(undo ? entry.afterSnapshot : entry.beforeSnapshot, documentUri);
    const to = snapshotDocuments(undo ? entry.beforeSnapshot : entry.afterSnapshot, documentUri);
    const protection = structuredClone(entry.protection);
    const merged = mergeReviewUndoDelta(current, from, to, protection);
    await this.store.saveBoth(documentUri, merged.reviewDocument, merged.resolvedReviewDocument);
    entry.protection = protection;

    // Preserve the entry if persistence fails so the operation remains retryable.
    entries.pop();
    const destinationEntries = destination.get(key) ?? [];
    destinationEntries.push(entry);
    destination.set(key, destinationEntries);
    return true;
  }
}

async function restoreSnapshot(snapshot: ReviewSidecarSnapshot): Promise<void> {
  await restoreFile(snapshot.reviewUri, snapshot.reviewBytes);
  if (snapshot.reviewUri.toString() !== snapshot.resolvedUri.toString()) {
    await restoreFile(snapshot.resolvedUri, snapshot.resolvedBytes);
  }
}

export async function restoreReviewSidecarSnapshot(snapshot: ReviewSidecarSnapshot): Promise<void> {
  await restoreSnapshot(snapshot);
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

function snapshotsEqual(left: ReviewSidecarSnapshot, right: ReviewSidecarSnapshot): boolean {
  return bytesEqual(left.reviewBytes, right.reviewBytes)
    && bytesEqual(left.resolvedBytes, right.resolvedBytes);
}

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  if (left.byteLength !== right.byteLength) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function snapshotDocuments(snapshot: ReviewSidecarSnapshot, documentUri: vscode.Uri): ReviewDocumentPair {
  if (snapshot.documents) {
    return snapshot.documents;
  }
  if (snapshot.reviewBytes) {
    return parsePortableReviewSidecar(documentUri.toString(), JSON.parse(new TextDecoder().decode(snapshot.reviewBytes)));
  }
  return {
    reviewDocument: createEmptyReviewDocument(documentUri.toString()),
    resolvedReviewDocument: createEmptyReviewDocument(documentUri.toString())
  };
}
