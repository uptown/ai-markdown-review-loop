import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { ReviewDocument, ReviewThread } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export class ReviewStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async load(documentUri: vscode.Uri): Promise<ReviewDocument> {
    const reviewUri = await this.getReviewFileUri(documentUri);

    try {
      const bytes = await vscode.workspace.fs.readFile(reviewUri);
      const parsed = JSON.parse(decoder.decode(bytes)) as ReviewDocument;
      return {
        documentUri: documentUri.toString(),
        threads: Array.isArray(parsed.threads) ? parsed.threads : [],
        updatedAt: parsed.updatedAt ?? new Date().toISOString()
      };
    } catch {
      return {
        documentUri: documentUri.toString(),
        threads: [],
        updatedAt: new Date().toISOString()
      };
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

  async addThreads(documentUri: vscode.Uri, threads: ReviewThread[]): Promise<ReviewDocument> {
    const reviewDocument = await this.load(documentUri);

    for (const thread of threads) {
      const duplicate = reviewDocument.threads.some(existing => {
        return existing.status === 'open'
          && existing.anchor.lineStart === thread.anchor.lineStart
          && existing.comment === thread.comment;
      });

      if (!duplicate) {
        reviewDocument.threads.push(thread);
      }
    }

    await this.save(documentUri, reviewDocument);
    return reviewDocument;
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
