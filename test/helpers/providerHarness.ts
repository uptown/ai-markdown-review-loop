import { build } from 'esbuild';
import Module from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

let bundledProvider: Promise<string>;

// Runs the real provider with controlled asynchronous VS Code boundaries.
// This is an integration seam test, not an Extension Host or browser test.
export async function createProviderHarness(initialText = 'First.\n\nSecond.\n') {
  bundledProvider ??= build({
    absWorkingDir: process.cwd(), stdin: { contents: "export { ReviewEditorProvider } from './src/reviewEditorProvider'; export { ReviewStore, ReviewStorageConflictError } from './src/reviewStore'; export { ReviewUndoController } from './src/reviewUndo';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'silent'
  }).then(result => result.outputFiles[0].text);
  let text = initialText;
  let version = 1;
  let receiveMessage: (message: any) => Promise<void> = async () => {};
  const warnings: string[] = [];
  const edits: any[] = [];
  const registrations: any[] = [];
  const postedMessages: any[] = [];
  const copiedTexts: string[] = [];
  const executedCommands: any[] = [];
  let handoffPhase: 'preparing' | 'handedOff' | undefined;
  const files = new Map<string, Uint8Array>();
  class Uri {
    scheme = 'file';
    path: string;
    constructor(readonly fsPath: string) { this.path = fsPath; }
    toString() { return 'file://' + this.fsPath; }
    with(value: { path?: string }) { return new Uri(value.path ?? this.path); }
    static file(value: string) { return new Uri(value); }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri(path.join(base.fsPath, ...parts)); }
  }
  class FileSystemError extends Error { code = 'FileNotFound'; }
  const disposable = { dispose() {} };
  const positionAt = (offset: number) => {
    const bounded = Math.max(0, Math.min(offset, text.length));
    const lines = text.split(/\r\n|\r|\n/);
    const separators = [...text.matchAll(/\r\n|\r|\n/g)];
    let start = 0;
    for (let line = 0; line < lines.length; line++) {
      const end = start + lines[line].length;
      const next = end + (separators[line]?.[0].length ?? 0);
      if (bounded < next || line === lines.length - 1) return { line, character: Math.min(bounded - start, lines[line].length) };
      start = next;
    }
    throw new Error('Invalid offset');
  };
  const offsetAt = (position: { line: number; character: number }) => {
    const starts = [0, ...[...text.matchAll(/\r\n|\r|\n/g)].map(match => match.index! + match[0].length)];
    return starts[position.line] + position.character;
  };
  const vscode: any = {
    Uri, FileSystemError,
    TextDocumentChangeReason: { Undo: 1, Redo: 2 },
    commands: { executeCommand: async (...args: any[]) => { executedCommands.push(args); } },
    env: { clipboard: { writeText: async (value: string) => { copiedTexts.push(value); } } },
    Disposable: class { constructor(readonly dispose: () => void) {} },
    WorkspaceEdit: class { change: any; replace(uri: any, range: any, replacement: string) { this.change = { uri, range, replacement }; } },
    Range: class { constructor(readonly start: any, readonly end: any) {} },
    workspace: {
      textDocuments: [],
      getWorkspaceFolder: () => ({ uri: Uri.file('/project') }),
      onDidChangeTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
      applyEdit: async (edit: any) => {
        const startOffset = offsetAt(edit.change.range.start);
        const endOffset = offsetAt(edit.change.range.end);
        const replacement = edit.change.replacement.replace(/\r\n|\r|\n/g, text.includes('\r\n') ? '\r\n' : '\n');
        edits.push({ ...edit.change, startOffset, endOffset });
        text = text.slice(0, startOffset) + replacement + text.slice(endOffset);
        version++;
        return true;
      },
      fs: {
        createDirectory: async () => {},
        readFile: async (uri: Uri) => { const bytes = files.get(uri.toString()); if (!bytes) throw new FileSystemError(); return bytes; },
        writeFile: async (uri: Uri, bytes: Uint8Array) => { files.set(uri.toString(), bytes); },
        rename: async (from: Uri, to: Uri) => {
          const bytes = files.get(from.toString()); if (!bytes) throw new FileSystemError();
          files.set(to.toString(), bytes); files.delete(from.toString());
        },
        delete: async (uri: Uri) => { files.delete(uri.toString()); }
      }
    },
    window: {
      showWarningMessage: async (message: string) => { warnings.push(message); return undefined; },
      showInformationMessage: async () => undefined,
      showErrorMessage: async (message: string) => { warnings.push(message); }
    }
  };
  const loaded = new Module(path.join(process.cwd(), 'test/provider-memory-module'));
  loaded.require = (id: string) => id === 'vscode' ? vscode : require(id);
  (loaded as any)._compile(await bundledProvider, 'provider-memory-module');
  const uri = Uri.file('/project/spec.md');
  const document = {
    uri, fileName: uri.fsPath, getText: () => text, get version() { return version; },
    positionAt, offsetAt,
    get lineCount() { return text.split('\n').length; }
  };
  const empty = () => ({ documentUri: uri.toString(), threads: [], updatedAt: '' });
  let saveCount = 0;
  const store: any = {
    getHandoffPhase: () => handoffPhase,
    isHandoffActive: () => Boolean(handoffPhase),
    assertWritable: () => { if (handoffPhase) throw new Error('저장 보류'); },
    withDocumentTransaction: async (_uri: Uri, operation: () => Promise<unknown>) => operation(),
    load: async () => empty(), loadResolved: async () => empty(),
    saveBoth: async () => { saveCount++; },
    getReviewStateFileUris: async () => [],
    getReviewFileUri: async () => Uri.file('/project/.spec.md.ai-review.json'),
    getResolvedReviewFileUri: async () => Uri.file('/project/.spec.md.ai-review.json')
  };
  const provider: any = new loaded.exports.ReviewEditorProvider({ extensionUri: Uri.file('/extension') }, store);
  const snapshot = { reviewUri: Uri.file('/project/.spec.md.ai-review.json'), resolvedUri: Uri.file('/project/.spec.md.ai-review.json'), reviewBytes: undefined, resolvedBytes: undefined };
  provider.reviewUndo = {
    reset: () => {},
    capture: async () => snapshot,
    register: (...args: any[]) => registrations.push(args),
    handleTextDocumentChange: async () => false
  };
  const webview: any = {
    html: '', cspSource: 'https://test.invalid',
    asWebviewUri: (value: Uri) => ({ toString: () => 'https://file+.vscode-resource.vscode-cdn.net' + value.fsPath }),
    onDidReceiveMessage: (handler: typeof receiveMessage) => { receiveMessage = handler; },
    postMessage: async (message: any) => { postedMessages.push(message); return true; }
  };
  return {
    provider, document, store, vscode, webview, files, edits, warnings, registrations, postedMessages, copiedTexts,
    executedCommands, setHandoffPhase(value: typeof handoffPhase) { handoffPhase = value; },
    snapshot, ReviewStorageConflictError: loaded.exports.ReviewStorageConflictError, get saveCount() { return saveCount; },
    useRealStore() {
      const state = new Map<string, unknown>();
      const realStore = new loaded.exports.ReviewStore({
        globalStorageUri: Uri.file('/private'),
        workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); } }
      });
      const undo = new loaded.exports.ReviewUndoController(realStore);
      const register = undo.register.bind(undo);
      undo.register = (...args: any[]) => { registrations.push(args); register(...args); };
      provider.store = realStore;
      provider.reviewUndo = undo;
      return { store: realStore, undo };
    },
    changeText(value: string) { text = value; version++; },
    render() { return provider.renderHtml(webview, document, empty(), empty()); },
    async open() {
      await provider.resolveCustomTextEditor(document, { webview, onDidDispose: () => disposable, onDidChangeViewState: () => disposable }, {});
    },
    async message(value: any) { await receiveMessage(value); }
  };
}

export function runWebview(html: string, initialState?: any) {
  // Domino is already Turndown's DOM implementation. Supply layout-only stubs;
  // event handlers, source metadata and serialization remain the shipped script.
  const window = require('@mixmark-io/domino').createWindow(html);
  const messages: any[] = [];
  let savedState = initialState;
  Object.defineProperty(window.Element.prototype, 'dataset', {
    configurable: true,
    get() {
      const element = this;
      const attribute = (key: string) => 'data-' + key.replace(/[A-Z]/g, match => '-' + match.toLowerCase());
      return new Proxy({}, {
        get: (_target, key) => element.getAttribute(attribute(String(key))) ?? undefined,
        set: (_target, key, value) => { element.setAttribute(attribute(String(key)), String(value)); return true; }
      });
    }
  });
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40 });
  window.Element.prototype.scrollIntoView = () => {};
  window.Element.prototype.replaceChildren = function (...children: any[]) {
    while (this.firstChild) this.removeChild(this.firstChild);
    for (const child of children) this.appendChild(typeof child === 'string' ? window.document.createTextNode(child) : child);
  };
  window.Element.prototype.append = function (...children: any[]) {
    for (const child of children) this.appendChild(typeof child === 'string' ? window.document.createTextNode(child) : child);
  };
  window.innerWidth = 1200;
  window.innerHeight = 800;
  window.getSelection = () => ({ removeAllRanges() {}, rangeCount: 0, isCollapsed: true });
  window.acquireVsCodeApi = () => ({
    postMessage: (message: any) => messages.push(message),
    getState: () => savedState,
    setState: (value: any) => { savedState = JSON.parse(JSON.stringify(value)); }
  });
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  const context = vm.createContext(window);
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
  vm.runInContext(script, context);
  return {
    window, document: window.document, messages,
    get savedState() { return savedState; },
    receive(message: any) {
      const event = new window.Event('message');
      Object.defineProperty(event, 'data', { value: message });
      window.dispatchEvent(event);
    },
    evaluate: (source: string) => vm.runInContext(source, context),
    dispatch(element: any, type: string) {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
    }
  };
}
