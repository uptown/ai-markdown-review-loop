import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';

// Execute the actual driver startup with platform path semantics. These are
// harness regressions; the separate installed-host CI uses the real VS Code API.
async function activateDriver(paths: typeof path.win32, root: string, actualWorkspace: string): Promise<{ ready?: boolean; error?: string }> {
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts/extension-host-smoke.cjs'), 'utf8');
  let evidence: { ready?: boolean; error?: string } = {};
  const driver: { activate?: (context: { subscriptions: unknown[] }) => Promise<void> } = {};
  const vscode = {
    version: '1.137.0',
    workspace: {
      workspaceFolders: [{ uri: { fsPath: actualWorkspace } }],
      onDidChangeTextDocument: () => ({ dispose() {} }),
      isTrusted: true,
      openTextDocument: async (uri: unknown) => ({ uri })
    },
    extensions: { getExtension: () => ({
      activate: async () => {}, packageJSON: { version: '0.4.0' },
      extensionPath: paths.join(root, 'extensions', 'uptown.ai-markdown-review-loop-0.4.0')
    }) },
    env: { clipboard: { readText: async () => '', writeText: async () => {} } },
    commands: { getCommands: async () => [], executeCommand: async () => {} },
    window: { showTextDocument: async () => {} },
    Uri: { file: (fsPath: string) => ({ fsPath }) }
  };
  const modules: Record<string, unknown> = {
    'node:path': paths, 'node:os': { tmpdir: () => paths.dirname(root) }, vscode,
    'node:fs': {
      // Windows realpath preserves the input drive-letter case seen in CI.
      realpathSync: (file: string) => file,
      readFileSync: (file: string) => file.endsWith('.isolated-smoke') ? 'ai-markdown-review-loop' : 'fixture bundle',
      writeFileSync: (_file: string, contents: string) => { evidence = JSON.parse(contents); }
    }
  };
  new Script(source, { filename: 'extension-host-smoke.cjs' }).runInNewContext({
    exports: driver, require: (name: string) => modules[name] ?? require(name),
    process: { env: { AI_REVIEW_HOST_SMOKE_DIR: root, AI_REVIEW_HOST_SMOKE_PHASE: 'round' } },
    setInterval: () => 1, clearInterval: () => {}
  });
  await driver.activate!({ subscriptions: [] });
  return evidence;
}

describe('installed-host driver workspace isolation', () => {
  const windowsRoot = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\amrl-host-test';
  it('accepts VS Code normalizing the Windows drive letter', async () => {
    const evidence = await activateDriver(path.win32, windowsRoot, windowsRoot.replace(/^C:/, 'c:') + '\\workspace');
    assert.equal(evidence.ready, true, evidence.error);
  });
  it('rejects a different Windows workspace', async () => {
    const evidence = await activateDriver(path.win32, windowsRoot, windowsRoot + '\\workspace-other');
    assert.equal(evidence.ready, undefined);
    assert.match(evidence.error!, /isolated workspace/);
  });
  it('rejects the same Windows path on a different drive', async () => {
    const evidence = await activateDriver(path.win32, windowsRoot, windowsRoot.replace(/^C:/, 'D:') + '\\workspace');
    assert.equal(evidence.ready, undefined);
    assert.match(evidence.error!, /isolated workspace/);
  });
  it('accepts the same POSIX workspace', async () => {
    const evidence = await activateDriver(path.posix, '/tmp/amrl-host-test', '/tmp/amrl-host-test/workspace');
    assert.equal(evidence.ready, true, evidence.error);
  });
  it('preserves POSIX case-sensitive workspace isolation', async () => {
    const evidence = await activateDriver(path.posix, '/tmp/amrl-host-test', '/tmp/amrl-host-test/Workspace');
    assert.equal(evidence.ready, undefined);
    assert.match(evidence.error!, /isolated workspace/);
  });
});
