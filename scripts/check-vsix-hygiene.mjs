import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readVsix } from './vsix-utils.mjs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const candidateArgument = process.argv.indexOf('--vsix');
if (candidateArgument >= 0 && !process.argv[candidateArgument + 1]) throw new Error('--vsix requires a file.');
const vsixName = candidateArgument >= 0 ? process.argv[candidateArgument + 1] : `${packageJson.name}-${packageJson.version}.vsix`;

if (!existsSync(vsixName)) {
  console.error(`Missing ${vsixName}. Run npm run package first.`);
  process.exit(1);
}

const files = await readVsix(vsixName);
const listing = [...files.keys()];
const forbiddenPatterns = [
  /\.agent\//,
  /\.ai-markdown-review\//,
  /\.ai-review\.json\b/,
  /docs\/PRD\.md\b/,
  /docs\/AI-CONTEXT-BRIEF\.md\b/,
  /docs\/mermaid-sample\.md\b/,
  /\.gitignore\b/,
  /\.nvmrc\b/,
  /(?:^|\/)AGENTS\.md$/,
  /\.DS_Store\b/,
  /node_modules\//,
  /extension\/src\//,
  /extension\/test\//,
  /extension\/scripts\//,
  /\.map\b/,
  /\.tmp\b/,
  /extension\/tsconfig(?:\.[^/]+)?\.json$/
];

const matches = listing.filter(line => forbiddenPatterns.some(pattern => pattern.test(line)));

if (matches.length > 0) {
  console.error(`${vsixName} includes files that should stay out of the Marketplace package:`);
  for (const match of matches) {
    console.error(match);
  }
  process.exit(1);
}

const requiredFiles = [
  'extension/LICENSE.txt',
  'extension/SUPPORT.md',
  'extension/THIRD_PARTY_NOTICES.md',
  'extension/changelog.md',
  'extension/package.json',
  'extension/readme.md',
  'extension/media/marketplace-icon.png',
  'extension/media/marketplace-hero.png',
  'extension/media/review-loop-demo.gif',
  'extension/media/review-loop-demo.mp4',
  'extension/media/asset-manifest.json',
  'extension/out/extension.js',
  'extension/out/webview.js',
  'extension/out/errorWebview.js',
  'extension/out/review.css',
  'extension/out/build-manifest.json',
  'extension/out/vendor/mermaid.min.js'
];

const missing = requiredFiles.filter((file) => !listing.includes(file));

if (missing.length > 0) {
  console.error(`${vsixName} is missing expected Marketplace/runtime files:`);
  for (const file of missing) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const buildManifest = JSON.parse(files.get('extension/out/build-manifest.json').toString('utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const notices = files.get('extension/THIRD_PARTY_NOTICES.md').toString('utf8');
if (buildManifest.schemaVersion !== 1) throw new Error('Unsupported runtime artifact inventory.');
for (const artifact of buildManifest.artifacts) {
  const bytes = files.get(`extension/${artifact.file}`);
  if (!bytes || sha256(bytes) !== artifact.sha256 || bytes.length !== artifact.bytes) {
    throw new Error(`VSIX runtime hash mismatch: ${artifact.file}.`);
  }
}
for (const dependency of buildManifest.packages) {
  const key = `${dependency.name}@${dependency.version}`;
  if (lock.packages[dependency.root]?.version !== dependency.version || !notices.includes(`| ${key} |`)) {
    throw new Error(`VSIX dependency inventory is stale or missing notices: ${key}.`);
  }
}
const runtimeEntries = ['extension', 'webview', 'errorWebview', 'mermaid', 'styles'];
for (const entry of runtimeEntries) {
  if (!buildManifest.artifacts.some(artifact => artifact.entry === entry)) throw new Error(`Missing runtime inventory: ${entry}.`);
}
const inventoryFiles = new Set(buildManifest.artifacts.map(artifact => `extension/${artifact.file}`));
for (const file of listing.filter(file => file.startsWith('extension/out/') && !file.endsWith('/build-manifest.json'))) {
  if (!inventoryFiles.has(file)) throw new Error(`Uninventoried runtime file in VSIX: ${file}.`);
}
const assetManifest = JSON.parse(files.get('extension/media/asset-manifest.json').toString('utf8'));
for (const artifact of assetManifest.artifacts) {
  const bytes = files.get(`extension/media/${artifact.file}`);
  if (!bytes || sha256(bytes) !== artifact.sha256) throw new Error(`VSIX artwork hash mismatch: ${artifact.file}.`);
}

const oldVsixes = readdirSync('.')
  .filter((fileName) => fileName.endsWith('.vsix') && fileName !== vsixName)
  .map((fileName) => path.resolve(fileName));

if (oldVsixes.length > 0) {
  console.warn('Old local VSIX files are ignored by packaging but should not be uploaded:');
  for (const fileName of oldVsixes) {
    console.warn(`- ${fileName}`);
  }
}

console.log(`${vsixName} package hygiene passed.`);
