import path from 'path';
import Module from 'module';
import type * as Vscode from 'vscode';
import type * as StoreModule from '../../src/reviewStore';
import type * as UndoModule from '../../src/reviewUndo';
import type { ReviewThread } from '../../src/types';

class TestUri {
  readonly scheme = 'file';
  readonly fsPath: string;
  constructor(readonly path: string) { this.fsPath = path; }
  toString(): string { return `file://${this.path}`; }
  with(value: { path?: string }): TestUri { return new TestUri(value.path ?? this.path); }
  static file(value: string): TestUri { return new TestUri(value); }
  static joinPath(base: TestUri, ...segments: string[]): TestUri { return new TestUri(path.posix.join(base.path, ...segments)); }
}

class TestFileSystemError extends Error {
  readonly code = 'FileNotFound';
  constructor() { super('FileNotFound'); }
}

export function createReviewStorageHarness(root = '/workspace', legacy = false) {
  const files = new Map<string, Uint8Array>();
  let failWrites = 0;
  let failStateWrites = 0;
  const memento = new Map<string, unknown>();
  const vscode = {
    Uri: TestUri,
    FileSystemError: TestFileSystemError,
    FileType: { File: 1, Directory: 2 },
    TextDocumentChangeReason: { Undo: 1, Redo: 2 },
    workspace: {
      textDocuments: [] as Array<{uri: TestUri; isDirty: boolean}>,
      getWorkspaceFolder: () => ({ uri: TestUri.file(root) }),
      asRelativePath: (uri: TestUri) => path.relative(root, uri.path),
      fs: {
        readDirectory: async (uri: TestUri): Promise<[string, number][]> => [...files.keys()]
          .filter(file => path.dirname(file) === uri.path).map(file => [path.basename(file), 1]),
        stat: async (uri: TestUri) => {
          const bytes = files.get(uri.path);
          if (!bytes) throw new TestFileSystemError();
          return { type: 1, ctime: 0, mtime: [...files.keys()].indexOf(uri.path), size: bytes.byteLength };
        },
        createDirectory: async (_uri: TestUri): Promise<void> => {},
        readFile: async (uri: TestUri): Promise<Uint8Array> => {
          const bytes = files.get(uri.path);
          if (bytes === undefined) { throw new TestFileSystemError(); }
          return Uint8Array.from(bytes);
        },
        writeFile: async (uri: TestUri, bytes: Uint8Array): Promise<void> => {
          if (failWrites > 0) { failWrites--; throw new Error('Injected write failure'); }
          files.set(uri.path, Uint8Array.from(bytes));
        },
        rename: async (from: TestUri, to: TestUri): Promise<void> => {
          const bytes = files.get(from.path);
          if (!bytes) throw new TestFileSystemError();
          files.set(to.path, bytes); files.delete(from.path);
        },
        delete: async (uri: TestUri): Promise<void> => {
          if (!files.delete(uri.path)) { throw new TestFileSystemError(); }
        }
      }
    }
  };
  const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  for (const name of ['../../src/reviewStore', '../../src/reviewUndo']) {
    delete require.cache[require.resolve(name)];
  }
  let storeModule: typeof StoreModule;
  let undoModule: typeof UndoModule;
  loader._load = function(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  try {
    storeModule = require('../../src/reviewStore') as typeof StoreModule;
    undoModule = require('../../src/reviewUndo') as typeof UndoModule;
  } finally {
    loader._load = originalLoad;
  }
  const context = { globalStorageUri: TestUri.file(path.join(root, '.test-private')), workspaceState: {
    get: (key: string) => memento.get(key), update: async (key: string, value: unknown) => {
      if (failStateWrites > 0) { failStateWrites--; throw new Error('Injected state write failure'); }
      memento.set(key, structuredClone(value));
    }
  }} as unknown as Vscode.ExtensionContext;
  const store = new storeModule.ReviewStore(context);
  if (legacy) files.set(path.join(root, '.spec.md.ai-review.json'), new TextEncoder().encode(JSON.stringify({schemaVersion: 2, documentUri: 'file://' + path.join(root, 'spec.md'), openThreads: [], closedThreads: [], updatedAt: '2026-09-09T00:00:00Z'})));
  const undo = new undoModule.ReviewUndoController(store);
  const uri = TestUri.file(path.join(root, 'spec.md')) as unknown as Vscode.Uri;
  return {
    files, vscode, store, undo, uri, context, memento,
    restartStore: () => new storeModule.ReviewStore(context),
    uriFor: (value: string) => TestUri.file(value) as unknown as Vscode.Uri,
    failNextWrites: (count = 1) => { failWrites = count; },
    failNextStateWrites: (count = 1) => { failStateWrites = count; },
    ReviewStorageConflictError: storeModule.ReviewStorageConflictError,
    change: (text: string, reason: 'undo' | 'redo') => ({
      document: { uri, getText: () => text },
      reason: reason === 'undo' ? 1 : 2
    } as unknown as Vscode.TextDocumentChangeEvent)
  };
}

export function storageThread(id: string, overrides: Partial<ReviewThread> = {}): ReviewThread {
  const now = '2026-09-09T00:00:00Z';
  return {
    id, documentUri: 'file:///workspace/spec.md',
    anchor: { text: 'Requirement old', lineStart: 1, lineEnd: 1, confidence: 'exact' },
    type: 'note', source: 'human', status: 'open', severity: 'medium', comment: id,
    thread: [], createdAt: now, updatedAt: now, ...overrides
  };
}
