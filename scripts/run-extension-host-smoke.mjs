import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { runScenarios } from './host-smoke-scenarios.mjs';
import { resolveVscodeArchivePaths, resolveVscodeExecutablePaths } from './vscode-host-paths.cjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const version = option('--version') || process.env.CODE_VERSION || 'stable';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amrl-host-'));
const report = { result: 'running', root, platform: process.platform, arch: process.arch, checks: [], boundaries: ['File edits simulate an agent; no model is invoked.', 'Keyboard automation is not a human screen-reader evaluation.'] };
const output = path.resolve(option('--output') || '.agent/reviews/2026-09-12-remediation/host-' + process.platform + '-' + version + '.json');
const record = (check, details = {}) => { report.checks.push({ check, ...details }); console.log('[host] ' + check); save(); };
function save() { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
function run(command, parameters, env = {}) {
  const result = spawnSync(command, parameters, { encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } });
  if (result.error || result.status !== 0) throw new Error(String(result.error || result.stderr || result.stdout || 'Child exited with status ' + result.status + ' and signal ' + result.signal));
  return result.stdout;
}
async function waitFor(predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } }
async function executable() {
  const explicit = option('--vscode') || process.env.AI_REVIEW_VSCODE_EXECUTABLE;
  if (explicit) return path.resolve(explicit);
  if (version !== 'stable' && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use stable or an exact VS Code version such as 1.85.0.');
  const platform = process.platform === 'darwin' ? 'darwin-' + process.arch
    : process.platform === 'win32' ? 'win32-' + process.arch + '-archive' : 'linux-' + process.arch;
  let resolvedVersion = version;
  let downloadUrl = 'https://update.code.visualstudio.com/' + version + '/' + platform + '/stable';
  let expectedHash;
  if (version === 'stable') {
    const metadataResponse = await fetch('https://update.code.visualstudio.com/api/update/' + platform + '/stable/latest', { signal: AbortSignal.timeout(30000) });
    if (!metadataResponse.ok) throw new Error('VS Code release lookup failed: ' + metadataResponse.status);
    const metadata = await metadataResponse.json();
    resolvedVersion = metadata.productVersion || metadata.name;
    if (!/^\d+\.\d+\.\d+$/.test(resolvedVersion) || !/^https:\/\//.test(metadata.url)) throw new Error('Invalid VS Code release metadata.');
    if (!/^[a-f0-9]{64}$/i.test(metadata.sha256hash)) throw new Error('VS Code release metadata has no valid SHA-256.');
    downloadUrl = metadata.url;
    expectedHash = metadata.sha256hash.toLowerCase();
  }
  report.resolvedVscodeVersion = resolvedVersion;
  const cache = path.join(os.tmpdir(), 'amrl-vscode-' + platform + '-' + resolvedVersion);
  const paths = directory => resolveVscodeArchivePaths(directory);
  const complete = directory => {
    const marker = readJson(path.join(directory, '.amrl-download-complete.json'));
    let files;
    try { files = paths(directory); } catch { return false; }
    return marker?.platform === platform && marker.version === resolvedVersion
      && (!expectedHash || marker.archiveSha256 === expectedHash)
      && fs.existsSync(files.binary) && fs.existsSync(files.cli)
      && readJson(files.metadata)?.version === resolvedVersion;
  };
  if (complete(cache)) return paths(cache).binary;
  console.log('[host] Downloading VS Code ' + resolvedVersion + ' for ' + platform);
  const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('VS Code download failed: ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  const archiveSha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash && archiveSha256 !== expectedHash) throw new Error('VS Code archive SHA-256 does not match release metadata.');
  const archive = path.join(root, process.platform === 'linux' ? 'vscode.tar.gz' : 'vscode.zip');
  fs.writeFileSync(archive, bytes);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'amrl-vscode-stage-'));
  try {
    if (process.platform === 'darwin') run('ditto', ['-x', '-k', archive, staging]);
    else if (process.platform === 'win32') run('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:AMRL_ARCHIVE -DestinationPath $env:AMRL_DEST'], { AMRL_ARCHIVE: archive, AMRL_DEST: staging });
    else run('tar', ['-xzf', archive, '--strip-components=1', '-C', staging]);
    const files = paths(staging);
    assert.ok(fs.existsSync(files.binary) && fs.existsSync(files.cli), 'Downloaded VS Code executable and CLI exist');
    assert.equal(readJson(files.metadata)?.version, resolvedVersion, 'Downloaded VS Code matches the requested version');
    fs.writeFileSync(path.join(staging, '.amrl-download-complete.json'), JSON.stringify({ platform, version: resolvedVersion, archiveSha256 }));
    // Another concurrent run may have completed the same immutable version.
    if (complete(cache)) return paths(cache).binary;
    if (fs.existsSync(cache)) fs.renameSync(cache, cache + '.incomplete-' + process.pid + '-' + Date.now());
    fs.renameSync(staging, cache);
    return paths(cache).binary;
  } finally {
    // This directory was created by this invocation and contains only the download.
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}
let browser;
let child;
const workspace = path.join(root, 'workspace');
const documentFile = path.join(workspace, 'docs/spec.md');
const sidecar = path.join(workspace, 'docs/.spec.md.ai-review.json');
const prefix = ['--user-data-dir=' + path.join(root, 'user-data'), '--extensions-dir=' + path.join(root, 'extensions')];
async function rpc(action, extra = {}) {
  const id = Date.now() + '-' + Math.random();
  fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ id, action, ...extra }));
  const result = await waitFor(() => { const value = readJson(path.join(root, 'control-result.json')); return value?.id === id && value; }, 'driver ' + action);
  assert.equal(result.ok, true, result.error);
  return result;
}
async function reviewFrame() {
  return waitFor(async () => {
    for (const context of browser.contexts()) for (const page of context.pages()) for (const frame of page.frames()) {
      try { if (await frame.locator('#markdown-body').count()) return frame; } catch { /* Navigating */ }
    }
  }, 'rendered Markdown webview');
}
async function untilFrame(predicate, label) {
  return waitFor(async () => { try { const frame = await reviewFrame(); return await predicate(frame); } catch { return false; } }, label);
}
async function confirmCommand(command, button) {
  const pending = rpc('command', { command });
  // Observe rejection while the confirmation is being found to avoid an unhandled promise.
  pending.catch(() => {});
  await waitFor(async () => {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      const target = page.getByRole('button', { name: button, exact: true });
      if (await target.count()) { await target.last().click(); return true; }
    }
  }, command + ' confirmation');
  return pending;
}
try {
  fs.writeFileSync(path.join(root, '.isolated-smoke'), 'ai-markdown-review-loop');
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user-data/User'), { recursive: true });
  fs.mkdirSync(path.join(root, 'driver'), { recursive: true });
  fs.writeFileSync(path.join(root, 'user-data/User/settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'extensions.autoUpdate': false, 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
    'window.dialogStyle': 'custom',
    'workbench.enableExperiments': false, 'workbench.tips.enabled': false
  }));
  fs.writeFileSync(path.join(workspace, 'docs/local.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>');
  fs.writeFileSync(documentFile, '# Policy\n\nRetry failed requests.\n\n![Local diagram](local.svg)\n\n```mermaid\nflowchart LR\n A[Read] --> B[Review]\n```\n\n| Feature | Decision |\n| --- | --- |\n| Retry | Required |\n');
  fs.copyFileSync(path.join(repo, 'scripts/extension-host-smoke.cjs'), path.join(root, 'driver/extension.cjs'));
  fs.writeFileSync(path.join(root, 'driver/package.json'), JSON.stringify({ name: 'isolated-review-smoke', publisher: 'localtest', version: '0.0.1', engines: { vscode: '^1.85.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'] }));
  const binary = await executable();
  if (args.includes('--download-only')) { record('vscode-downloaded', { binary }); report.result = 'passed'; save(); process.exit(0); }
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const vsix = path.resolve(option('--vsix') || path.join(repo, pkg.name + '-' + pkg.version + '.vsix'));
  assert.ok(fs.existsSync(vsix), 'Package the candidate VSIX before host testing.');
  report.vsixSha256 = createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
  const { cli, requiresRunAsNodeFlag } = resolveVscodeExecutablePaths(binary);
  // Current VS Code shares additional storage outside --user-data-dir. Older
  // hosts have no such CLI option; do not forward an unknown Electron switch.
  if (fs.readFileSync(cli, 'utf8').includes('"shared-data-dir"')) {
    const sharedData = path.join(root, 'shared-data');
    prefix.push('--shared-data-dir=' + sharedData);
    report.sharedDataDirectory = sharedData;
  }
  // Older signed VS Code binaries require this flag in addition to the env var;
  // its official bin/code launcher supplies it before handing control to cli.js.
  const nodeFlag = requiresRunAsNodeFlag ? ['--ms-enable-electron-run-as-node'] : [];
  run(binary, [cli, ...nodeFlag, ...prefix, '--install-extension', vsix, '--force'], { ELECTRON_RUN_AS_NODE: '1' });
  record('candidate-vsix-installed-in-isolated-profile');
  for (const phase of ['round', 'restart', 'restricted']) {
    // A normal restart must not replay the previous process's quit command.
    for (const file of ['control.json', 'control-result.json']) fs.rmSync(path.join(root, file), { force: true });
    const launchPrefix = [...prefix];
    if (phase === 'restricted') {
      const restrictedProfile = path.join(root, 'restricted-user-data');
      fs.mkdirSync(path.join(restrictedProfile, 'User'), { recursive: true });
      const settings = JSON.parse(fs.readFileSync(path.join(root, 'user-data/User/settings.json'), 'utf8'));
      Object.assign(settings, { 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.untrustedFiles': 'open' });
      fs.writeFileSync(path.join(restrictedProfile, 'User/settings.json'), JSON.stringify(settings));
      launchPrefix[0] = '--user-data-dir=' + restrictedProfile;
      fs.writeFileSync(sidecar, JSON.stringify({ schemaVersion: 3, document: 'spec.md', guidance: 'Review only.',
        items: [{ id: 'rv_readonly', rev: 1, target: { quote: 'Apply a maximum of three attempts.' }, comment: 'Read-only fixture comment.' }] }));
    }
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const log = fs.openSync(path.join(root, phase + '.log'), 'w');
    const env = { ...process.env, AI_REVIEW_HOST_SMOKE_DIR: root, AI_REVIEW_HOST_SMOKE_PHASE: phase };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(binary, [...launchPrefix, '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-updates',
      '--remote-debugging-port=' + port, '--extensionDevelopmentPath=' + path.join(root, 'driver'), workspace,
      ...(args.includes('--trace') ? ['--log', 'trace'] : []),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { stdio: ['ignore', log, log], env });
    fs.closeSync(log);
    await waitFor(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'VS Code CDP', 90000);
    // Preserve Electron's native context; older supported hosts do not implement
    // Browser.setDownloadBehavior, and these tests never download via the webview.
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { noDefaults: true });
    const driver = await waitFor(() => readJson(path.join(root, 'driver-' + phase + '.json')), 'driver activation');
    assert.equal(driver.ready, true, driver.error);
    assert.equal(driver.trusted, phase !== 'restricted', 'Workspace trust matches the scenario');
    Object.assign(report, { vscode: driver.vscode, extensionVersion: driver.extensionVersion, bundleSha256: driver.bundleSha256 });
    await runScenarios({ phase, record, rpc, reviewFrame, untilFrame, waitFor, confirmCommand, readJson, documentFile, sidecar, browser, root });
    if (phase === 'restricted') {
      const directories = fs.readdirSync(path.join(root, 'restricted-user-data'), { recursive: true });
      assert.equal(directories.some(file => String(file).includes('review-recovery')), false, 'Restricted preview must not create recovery storage');
      record('restricted-preview-creates-no-review-recovery-storage');
    }
    await rpc('quit');
    await browser.close(); browser = undefined;
    await waitFor(() => child.exitCode !== null, 'VS Code process exit');
    child = undefined;
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error.stack || error); process.exitCode = 1;
  if (browser) {
    let screenshotIndex = 0;
    for (const context of browser.contexts()) for (const page of context.pages()) {
      await page.screenshot({ path: path.join(root, 'failure-' + screenshotIndex++ + '.png') }).catch(() => {});
    }
  }
} finally {
  if (child && child.exitCode === null) await rpc('quit').catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) child.kill('SIGTERM');
  save();
  console.log(JSON.stringify({ result: report.result, evidence: output, root, error: report.error }));
}
