import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { resolveVscodeArchivePaths, resolveVscodeExecutablePaths } = require(path.join(process.cwd(), 'scripts/vscode-host-paths.cjs'));

function fixture(run: (directory: string, write: (name: string, text?: string) => void) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amrl-vscode-paths-test-'));
  const write = (name: string, text = '') => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  };
  try { run(directory, write); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

describe('official VS Code host layouts', () => {
  for (const binary of ['Code', 'Electron']) it(`resolves the macOS ${binary} executable and its official launcher flag`, () => fixture((directory, write) => {
    write('Visual Studio Code.app/Contents/MacOS/' + binary);
    write('Visual Studio Code.app/Contents/Resources/app/out/cli.js');
    write('Visual Studio Code.app/Contents/Resources/app/package.json', '{"version":"1.85.0"}');
    write('Visual Studio Code.app/Contents/Resources/app/bin/code', '"$ELECTRON" "$CLI" --ms-enable-electron-run-as-node');
    const resolved = resolveVscodeArchivePaths(directory, 'darwin');
    assert.equal(resolved.binary, path.join(directory, 'Visual Studio Code.app/Contents/MacOS/' + binary));
    assert.equal(resolved.requiresRunAsNodeFlag, true);
    assert.equal(resolveVscodeExecutablePaths(resolved.binary, 'darwin').cli, resolved.cli);
  }));

  it('resolves the Linux root resource layout and root bin launcher', () => fixture((directory, write) => {
    write('code'); write('resources/app/out/cli.js'); write('resources/app/package.json');
    write('bin/code', 'ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" --ms-enable-electron-run-as-node');
    const resolved = resolveVscodeArchivePaths(directory, 'linux');
    assert.equal(resolved.cli, path.join(directory, 'resources/app/out/cli.js'));
    assert.equal(resolved.requiresRunAsNodeFlag, true);
  }));

  it('resolves the legacy Windows root resource layout', () => fixture((directory, write) => {
    write('Code.exe'); write('resources/app/out/cli.js'); write('resources/app/package.json');
    write('bin/code.cmd', '"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*');
    assert.equal(resolveVscodeArchivePaths(directory, 'win32').cli, path.join(directory, 'resources/app/out/cli.js'));
  }));

  it('follows the current Windows launcher commit prefix even when another version exists', () => fixture((directory, write) => {
    write('Code.exe');
    for (const prefix of ['645f29cc31', '1111111111']) {
      write(prefix + '/resources/app/out/cli.js'); write(prefix + '/resources/app/package.json');
    }
    write('bin/code.cmd', '"%~dp0..\\Code.exe" "%~dp0..\\645f29cc31\\resources\\app\\out\\cli.js" %*');
    const resolved = resolveVscodeArchivePaths(directory, 'win32');
    assert.equal(resolved.cli, path.join(directory, '645f29cc31/resources/app/out/cli.js'));
    assert.equal(resolved.requiresRunAsNodeFlag, false);
    assert.equal(resolveVscodeExecutablePaths(path.join(directory, 'Code.exe'), 'win32').metadata, path.join(directory, '645f29cc31/resources/app/package.json'));
  }));

  it('rejects an incomplete launcher target instead of selecting another version', () => fixture((directory, write) => {
    write('Code.exe'); write('1111111111/resources/app/out/cli.js'); write('1111111111/resources/app/package.json');
    write('bin/code.cmd', '"%~dp0..\\645f29cc31\\resources\\app\\out\\cli.js"');
    assert.throws(() => resolveVscodeArchivePaths(directory, 'win32'), /incomplete/);
  }));

  it('rejects ambiguous version directories without a usable official launcher', () => fixture((directory, write) => {
    write('Code.exe');
    for (const prefix of ['645f29cc31', '1111111111']) {
      write(prefix + '/resources/app/out/cli.js'); write(prefix + '/resources/app/package.json');
    }
    assert.throws(() => resolveVscodeArchivePaths(directory, 'win32'), /Cannot identify one/);
  }));
});
