import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputArgument = process.argv.indexOf('--output-dir');
if (outputArgument >= 0 && !process.argv[outputArgument + 1]) throw new Error('--output-dir requires a directory.');
const outputRoot = outputArgument >= 0 ? path.resolve(process.argv[outputArgument + 1]) : path.join(root, 'out');
const watching = process.argv.includes('--watch');
// One owner per output directory prevents a live watcher from replacing files
// between the release build and its manifest. Different isolated outputs coexist.
const lockDirectory = path.join(root, '.agent/build-locks');
mkdirSync(lockDirectory, { recursive: true });
const lockFile = path.join(lockDirectory, createHash('sha256').update(outputRoot).digest('hex').slice(0, 20) + '.json');
function acquireOutput() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, watch: watching }), { flag: 'wx' });
      process.once('exit', () => {
        try { if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === process.pid) unlinkSync(lockFile); } catch { /* Already released. */ }
      });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(readFileSync(lockFile, 'utf8'));
      try { process.kill(previous.pid, 0); }
      catch (probeError) {
        if (probeError.code === 'ESRCH') { unlinkSync(lockFile); continue; }
        throw probeError;
      }
      throw new Error(`Build output is owned by process ${previous.pid}. Stop the existing watch/build before packaging, or use a separate --output-dir.`);
    }
  }
  throw new Error('Could not acquire build output; retry after the other build exits.');
}
acquireOutput();
const results = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = value => path.relative(root, value).split(path.sep).join('/');
let sequence = 0;
let manifestQueue = Promise.resolve();

async function writeAtomic(destination, bytes) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${sequence++}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
}

function dependencyRoot(input) {
  const normalized = input.replaceAll('\\', '/');
  const marker = normalized.lastIndexOf('node_modules/');
  if (marker < 0) return undefined;
  const start = marker + 'node_modules/'.length;
  const parts = normalized.slice(start).split('/');
  return normalized.slice(0, start) + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
}

function readDependency(packageRoot) {
  const directory = path.resolve(root, packageRoot);
  const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const licenseFiles = readdirSync(directory).filter(name => /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(name))
    .sort().map(name => ({ path: `${packageRoot}/${name}`, sha256: hash(readFileSync(path.join(directory, name))) }));
  if (!licenseFiles.length) {
    const readme = readdirSync(directory).find(name => /^readme(?:\.md)?$/i.test(name));
    if (readme) {
      const bytes = readFileSync(path.join(directory, readme));
      const lines = bytes.toString('utf8').split('\n');
      const start = lines.findIndex(line => /^#{1,6}\s+licen[sc]e\s*$/i.test(line));
      if (start >= 0) {
        const next = lines.findIndex((line, index) => index > start && /^#{1,6}\s/.test(line));
        licenseFiles.push({ path: `${packageRoot}/${readme}`, sha256: hash(bytes), lineStart: start + 2, lineEnd: next < 0 ? lines.length : next });
      }
    }
  }
  if (!licenseFiles.length) throw new Error(`No license file found for bundled ${metadata.name}@${metadata.version}.`);
  const license = (typeof metadata.license === 'string' ? metadata.license : metadata.license?.type) ?? 'SEE LICENSE FILE';
  const repository = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url;
  return { name: metadata.name, version: metadata.version, license, repository: repository ?? '', root: packageRoot, licenseFiles };
}

async function writeManifest() {
  if (results.size !== definitions.length) return;
  const dependencies = new Map();
  const artifacts = [];
  for (const [name, result] of [...results].sort(([a], [b]) => a.localeCompare(b))) {
    const includedInputs = Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs)
      .filter(([, details]) => details.bytesInOutput > 0).map(([input]) => input));
    const packageRoots = [...new Set(includedInputs.map(dependencyRoot).filter(Boolean))].sort();
    const packages = packageRoots.map(packageRoot => {
      const metadata = dependencies.get(packageRoot) ?? readDependency(packageRoot);
      dependencies.set(packageRoot, metadata);
      return `${metadata.name}@${metadata.version}`;
    });
    for (const file of result.outputFiles) {
      artifacts.push({ file: relative(file.path), sha256: hash(file.contents), bytes: file.contents.length, entry: name, packages });
    }
  }
  const cssPath = path.join(outputRoot, 'review.css');
  const css = readFileSync(cssPath);
  artifacts.push({ file: relative(cssPath), sha256: hash(css), bytes: css.length, entry: 'styles', packages: [] });
  const manifest = {
    schemaVersion: 1,
    bundler: { name: 'esbuild', version: esbuild.version },
    artifacts: artifacts.sort((a, b) => a.file.localeCompare(b.file)),
    packages: [...dependencies.values()].sort((a, b) => a.root.localeCompare(b.root))
  };
  await writeAtomic(path.join(outputRoot, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function recordBuild(name) {
  return {
    name: 'record-artifact-inventory',
    setup(build) {
      build.onEnd(async result => {
        if (result.errors.length) return;
        for (const file of result.outputFiles) await writeAtomic(file.path, file.contents);
        results.set(name, result);
        manifestQueue = manifestQueue.then(writeManifest);
        await manifestQueue;
      });
    }
  };
}

const common = { absWorkingDir: root, bundle: true, write: false, metafile: true, legalComments: 'linked', logLevel: 'info' };
const definitions = [
  { name: 'extension', entryPoints: ['src/extension.ts'], platform: 'node', format: 'cjs', external: ['vscode'], target: 'node18', outfile: path.join(outputRoot, 'extension.js') },
  { name: 'webview', entryPoints: ['src/webview/client.ts'], platform: 'browser', format: 'iife', target: 'chrome108', outfile: path.join(outputRoot, 'webview.js') },
  { name: 'errorWebview', entryPoints: ['src/webview/errorClient.ts'], platform: 'browser', format: 'iife', target: 'chrome108', outfile: path.join(outputRoot, 'errorWebview.js') },
  {
    name: 'mermaid',
    stdin: { contents: 'import mermaid from "mermaid"; window.mermaid = mermaid;', resolveDir: root, sourcefile: 'mermaid-entry.js' },
    platform: 'browser', format: 'iife', target: 'chrome108', minify: true, outfile: path.join(outputRoot, 'vendor/mermaid.min.js')
  }
];

async function copyStyles() {
  await writeAtomic(path.join(outputRoot, 'review.css'), readFileSync(path.join(root, 'src/webview/review.css')));
}

await copyStyles();
const options = definitions.map(({ name, ...options }) => ({ ...common, ...options, plugins: [recordBuild(name)] }));
if (!watching) {
  // A final manifest is published only after every runtime artifact succeeds.
  await Promise.all(options.map(options => esbuild.build(options)));
} else {
  const contexts = await Promise.all(options.map(options => esbuild.context(options)));
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
  const checkers = ['tsconfig.json', 'tsconfig.webview.json'].map(project => spawn(process.execPath,
    [tsc, '--project', project, '--noEmit', '--watch', '--preserveWatchOutput'], { cwd: root, stdio: 'inherit' }));
  for (const context of contexts) await context.watch();
  const cssPath = path.join(root, 'src/webview/review.css');
  watchFile(cssPath, { interval: 500 }, () => {
    manifestQueue = manifestQueue.then(copyStyles).then(writeManifest);
    void manifestQueue.catch(error => console.error(error));
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    unwatchFile(cssPath);
    for (const checker of checkers) checker.kill();
    await Promise.all(contexts.map(context => context.dispose()));
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}
