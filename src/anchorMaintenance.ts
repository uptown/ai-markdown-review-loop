import * as vscode from 'vscode';
import { AnchorConfidence } from './types';
import { AnchorLocationUpdate, ReviewStore } from './reviewStore';

const debounceMs = 1500;
const writableConfidence = new Set<AnchorConfidence>(['exact', 'recovered']);

export interface AnchorObservation {
  threadId: string;
  sourceLine: number;
  confidence: AnchorConfidence;
  documentVersion: number;
}

interface PendingDocument {
  document: vscode.TextDocument;
  observations: Map<string, AnchorObservation>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class AnchorMaintenanceController implements vscode.Disposable {
  private readonly pending = new Map<string, PendingDocument>();

  constructor(private readonly store: ReviewStore) {}

  observe(document: vscode.TextDocument, observation: AnchorObservation): void {
    if (!shouldPersistObservation(document, observation)) {
      return;
    }

    const key = document.uri.toString();
    let pendingDocument = this.pending.get(key);

    if (!pendingDocument) {
      pendingDocument = {
        document,
        observations: new Map(),
        timer: undefined
      };
      this.pending.set(key, pendingDocument);
    }

    pendingDocument.document = document;
    pendingDocument.observations.set(observation.threadId, observation);
    this.schedule(key, pendingDocument);
  }

  async flush(document?: vscode.TextDocument | vscode.Uri): Promise<void> {
    if (!document) {
      await Promise.all([...this.pending.keys()].map(key => this.flushKey(key)));
      return;
    }

    const uri = document instanceof vscode.Uri ? document : document.uri;
    await this.flushKey(uri.toString());
  }

  dispose(): void {
    for (const pendingDocument of this.pending.values()) {
      if (pendingDocument.timer) {
        clearTimeout(pendingDocument.timer);
      }
    }

    this.pending.clear();
  }

  private schedule(key: string, pendingDocument: PendingDocument): void {
    if (pendingDocument.timer) {
      clearTimeout(pendingDocument.timer);
    }

    pendingDocument.timer = setTimeout(() => {
      pendingDocument.timer = undefined;
      void this.flushKey(key);
    }, debounceMs);
  }

  private async flushKey(key: string): Promise<void> {
    const pendingDocument = this.pending.get(key);

    if (!pendingDocument) {
      return;
    }

    if (pendingDocument.timer) {
      clearTimeout(pendingDocument.timer);
      pendingDocument.timer = undefined;
    }

    const observations = [...pendingDocument.observations.values()]
      .filter(observation => shouldPersistObservation(pendingDocument.document, observation));
    pendingDocument.observations.clear();

    if (observations.length === 0) {
      this.pending.delete(key);
      return;
    }

    try {
      const locatedAt = new Date().toISOString();
      const updates: AnchorLocationUpdate[] = observations.map(observation => ({
        threadId: observation.threadId,
        lineStart: observation.sourceLine,
        lineEnd: observation.sourceLine,
        confidence: observation.confidence,
        locatedAt
      }));

      await this.store.updateThreadAnchors(pendingDocument.document.uri, updates);
    } catch (error) {
      console.warn('AI Markdown Review anchor maintenance failed:', error);
    } finally {
      if (pendingDocument.observations.size === 0) {
        this.pending.delete(key);
      } else {
        this.schedule(key, pendingDocument);
      }
    }
  }
}

function shouldPersistObservation(
  document: vscode.TextDocument,
  observation: AnchorObservation
): observation is AnchorObservation & {
  confidence: Extract<AnchorConfidence, 'exact' | 'recovered'>;
} {
  return Boolean(observation.threadId)
    && Number.isFinite(observation.sourceLine)
    && observation.sourceLine >= 1
    && observation.documentVersion === document.version
    && writableConfidence.has(observation.confidence);
}
