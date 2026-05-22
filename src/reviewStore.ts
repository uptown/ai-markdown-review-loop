import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { ReviewDocument, ReviewReply, ReviewThread } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

interface AddThreadsResult {
  reviewDocument: ReviewDocument;
  addedThreads: ReviewThread[];
}

export class ReviewStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async load(documentUri: vscode.Uri): Promise<ReviewDocument> {
    const reviewUri = await this.getReviewFileUri(documentUri);

    let bytes: Uint8Array;

    try {
      bytes = await vscode.workspace.fs.readFile(reviewUri);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw new Error(`Could not read review sidecar: ${formatError(error)}`);
      }

      return {
        documentUri: documentUri.toString(),
        threads: [],
        updatedAt: new Date().toISOString()
      };
    }

    try {
      return parseReviewDocument(documentUri, JSON.parse(decoder.decode(bytes)));
    } catch (error) {
      throw new Error(`Review sidecar is invalid: ${formatError(error)}`);
    }
  }

  async save(documentUri: vscode.Uri, reviewDocument: ReviewDocument): Promise<void> {
    const reviewUri = await this.getReviewFileUri(documentUri);
    const payload: ReviewDocument = {
      documentUri: documentUri.toString(),
      threads: reviewDocument.threads,
      updatedAt: new Date().toISOString()
    };

    await vscode.workspace.fs.writeFile(
      reviewUri,
      encoder.encode(`${JSON.stringify(payload, null, 2)}\n`)
    );
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
    await this.save(documentUri, reviewDocument);
    return reviewDocument;
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

  async getReviewFileUri(documentUri: vscode.Uri): Promise<vscode.Uri> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    const root = workspaceFolder?.uri ?? this.context.globalStorageUri;
    const reviewRoot = vscode.Uri.joinPath(root, '.ai-markdown-review', 'documents');
    await vscode.workspace.fs.createDirectory(reviewRoot);

    return vscode.Uri.joinPath(reviewRoot, `${hashText(documentUri.toString())}.json`);
  }
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
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
