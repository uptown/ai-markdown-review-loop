import * as vscode from 'vscode';
import { ReviewStore } from './reviewStore';

export interface ReviewSidecarSnapshot {
  reviewUri: vscode.Uri;
  reviewBytes: Uint8Array | undefined;
  resolvedUri: vscode.Uri;
  resolvedBytes: Uint8Array | undefined;
}

interface ReviewUndoEntry {
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
    const reviewUri = await this.store.getReviewFileUri(documentUri);
    const resolvedUri = await this.store.getResolvedReviewFileUri(documentUri);

    return {
      reviewUri,
      reviewBytes: await readFileIfExists(reviewUri),
      resolvedUri,
      resolvedBytes: await readFileIfExists(resolvedUri)
    };
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
    if (event.reason === vscode.TextDocumentChangeReason.Undo) {
      return this.restoreForUndo(event.document);
    }

    if (event.reason === vscode.TextDocumentChangeReason.Redo) {
      return this.restoreForRedo(event.document);
    }

    return false;
  }

  private async restoreForUndo(document: vscode.TextDocument): Promise<boolean> {
    const key = document.uri.toString();
    const doneEntries = this.done.get(key) ?? [];
    const entry = doneEntries[doneEntries.length - 1];

    if (!entry || entry.beforeText !== document.getText()) {
      return false;
    }

    doneEntries.pop();
    await restoreSnapshot(entry.beforeSnapshot);

    const undoneEntries = this.undone.get(key) ?? [];
    undoneEntries.push(entry);
    this.undone.set(key, undoneEntries);
    return true;
  }

  private async restoreForRedo(document: vscode.TextDocument): Promise<boolean> {
    const key = document.uri.toString();
    const undoneEntries = this.undone.get(key) ?? [];
    const entry = undoneEntries[undoneEntries.length - 1];

    if (!entry || entry.afterText !== document.getText()) {
      return false;
    }

    undoneEntries.pop();
    await restoreSnapshot(entry.afterSnapshot);

    const doneEntries = this.done.get(key) ?? [];
    doneEntries.push(entry);
    this.done.set(key, doneEntries);
    return true;
  }
}

async function restoreSnapshot(snapshot: ReviewSidecarSnapshot): Promise<void> {
  await Promise.all([
    restoreFile(snapshot.reviewUri, snapshot.reviewBytes),
    restoreFile(snapshot.resolvedUri, snapshot.resolvedBytes)
  ]);
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
