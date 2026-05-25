import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const vsixName = `${packageJson.name}-${packageJson.version}.vsix`;

if (!existsSync(vsixName)) {
  console.error(`Missing ${vsixName}. Run npm run package first.`);
  process.exit(1);
}

const listing = execFileSync('unzip', ['-l', vsixName], { encoding: 'utf8' });
const forbiddenPatterns = [
  /\.agent\//,
  /\.ai-markdown-review\//,
  /\.ai-review\.json\b/,
  /docs\/PRD\.md\b/,
  /docs\/AI-CONTEXT-BRIEF\.md\b/,
  /docs\/mermaid-sample\.md\b/,
  /\.gitignore\b/,
  /\.nvmrc\b/,
  /\.DS_Store\b/,
  /node_modules\//,
  /extension\/src\//,
  /extension\/test\//,
  /extension\/scripts\//,
  /\.map\b/
];

const matches = listing
  .split('\n')
  .filter((line) => forbiddenPatterns.some((pattern) => pattern.test(line)));

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
  'extension/out/extension.js',
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
