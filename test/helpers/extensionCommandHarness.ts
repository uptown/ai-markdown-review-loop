import { build } from 'esbuild';
import Module from 'module';
import path from 'path';

let bundledExtension: Promise<string>;

/** Exercise the registered commands and real store/prompt code through a small VS Code boundary. */
export async function createExtensionCommandHarness() {
  bundledExtension ??= build({
    absWorkingDir: process.cwd(), entryPoints: ['src/extension.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['vscode'], supported: { 'dynamic-import': false }, logLevel: 'silent'
  }).then(result => result.outputFiles[0].text);
  const commands = new Map<string, (...args: any[]) => Promise<unknown>>();
  const documents = new Map<string, any>();
  const contentProviders = new Map<string, any>();
  const files = new Map<string, Uint8Array>();
  const information: string[] = [];
  const warnings: string[] = [];
  const errors: Array<{ message: string; actions: string[] }> = [];
  const choices: Array<{ choice?: string; action?: () => void }> = [];
  const openFailures = new Map<string, Error[]>();
  const openAttempts: string[] = [];
  const shownDocuments: any[] = [];
  const executed: Array<{ id: string; args: any[] }> = [];
  const disposable = { dispose() {} };
  let provider: any;

  class Uri {
    readonly fsPath: string;
    constructor(readonly path: string, readonly scheme = 'file') { this.fsPath = path; }
    toString(): string { return `${this.scheme}://${this.path}`; }
    with(value: { path?: string }): Uri { return new Uri(value.path ?? this.path, this.scheme); }
    static file(value: string): Uri { return new Uri(value); }
    static from(value: { path: string; scheme: string }): Uri { return new Uri(value.path, value.scheme); }
    static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(path.posix.join(base.path, ...parts), base.scheme); }
  }
  class FileSystemError extends Error {
    readonly code = 'FileNotFound';
    constructor() { super('FileNotFound'); }
  }
  function textDocument(uri: Uri, text: string, languageId = 'markdown') {
    return {
      uri, fileName: uri.path, languageId, version: 1,
      getText: () => text, lineCount: text.split(/\r?\n/).length,
      lineAt: (line: number) => ({ text: text.split(/\r?\n/)[line] })
    };
  }
  const vscode: any = {
    Uri, FileSystemError,
    Disposable: class { constructor(readonly dispose: () => void) {} },
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    ViewColumn: { Active: -1, Beside: -2 },
    workspace: {
      getWorkspaceFolder: (uri: Uri) => uri.scheme === 'file' && uri.path.startsWith('/workspace/')
        ? { uri: Uri.file('/workspace') } : undefined,
      asRelativePath: (uri: Uri) => path.relative('/workspace', uri.path),
      onDidRenameFiles: () => disposable,
      registerTextDocumentContentProvider: (scheme: string, value: any) => { contentProviders.set(scheme, value); return disposable; },
      openTextDocument: async (uri: Uri) => {
        openAttempts.push(uri.toString());
        const error = openFailures.get(uri.toString())?.shift();
        if (error) { throw error; }
        if (contentProviders.has(uri.scheme)) {
          const document = textDocument(uri, contentProviders.get(uri.scheme).provideTextDocumentContent(uri));
          documents.set(uri.toString(), document);
          return document;
        }
        const document = documents.get(uri.toString());
        if (!document) { throw new Error('The file is unavailable.'); }
        return document;
      },
      fs: {
        createDirectory: async () => {},
        readFile: async (uri: Uri) => { const bytes = files.get(uri.toString()); if (!bytes) { throw new FileSystemError(); } return Uint8Array.from(bytes); },
        writeFile: async (uri: Uri, bytes: Uint8Array) => { files.set(uri.toString(), Uint8Array.from(bytes)); },
        delete: async (uri: Uri) => { if (!files.delete(uri.toString())) { throw new FileSystemError(); } }
      }
    },
    window: {
      activeTextEditor: undefined,
      registerCustomEditorProvider: (_viewType: string, value: any) => { provider = value; return disposable; },
      showTextDocument: async (document: any) => { shownDocuments.push(document); vscode.window.activeTextEditor = { document }; },
      showInformationMessage: async (message: string) => { information.push(message); },
      showWarningMessage: async (message: string) => { warnings.push(message); },
      showErrorMessage: async (message: string, ...actions: string[]) => {
        errors.push({ message, actions });
        const next = choices.shift();
        next?.action?.();
        return next?.choice;
      }
    },
    commands: {
      registerCommand: (id: string, handler: (...args: any[]) => Promise<unknown>) => { commands.set(id, handler); return disposable; },
      executeCommand: async (id: string, ...args: any[]) => { executed.push({ id, args }); }
    },
    languages: { setTextDocumentLanguage: async (document: any, languageId: string) => { document.languageId = languageId; return document; } }
  };
  const loaded = new Module(path.join(process.cwd(), 'test/extension-command-memory-module'));
  loaded.require = (name: string) => name === 'vscode' ? vscode : require(name);
  (loaded as any)._compile(await bundledExtension, 'extension-command-memory-module');
  const context = { extensionUri: Uri.file('/extension'), globalStorageUri: Uri.file('/global'), subscriptions: [] as any[] };
  loaded.exports.activate(context);
  return {
    files, information, warnings, errors, executed, shownDocuments, openAttempts,
    get store(): any { return provider.store; },
    addDocument(filePath: string, text = '# Spec\n\nTODO: choose a limit.\n\n## Acceptance Criteria\n\n- Checks pass.', languageId = 'markdown') {
      const document = textDocument(Uri.file(filePath), text, languageId);
      documents.set(document.uri.toString(), document);
      return document;
    },
    setActivePreview(document: any) { provider.currentDocumentUri = document.uri; vscode.window.activeTextEditor = undefined; },
    setActiveSource(document: any) { vscode.window.activeTextEditor = { document }; },
    failNextOpen(document: any, message = 'The file is temporarily unavailable.') {
      const pending = openFailures.get(document.uri.toString()) ?? [];
      pending.push(new Error(message)); openFailures.set(document.uri.toString(), pending);
    },
    chooseOnError(choice?: string, action?: () => void) { choices.push({ choice, action }); },
    async run(id: string, ...args: any[]) {
      const handler = commands.get(`aiMarkdownReviewLoop.${id}`);
      if (!handler) { throw new Error(`Unregistered command: ${id}`); }
      return handler(...args);
    },
    dispose() { for (const subscription of context.subscriptions) { subscription.dispose(); } }
  };
}
