import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('out/build-manifest.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const artifact of manifest.artifacts) {
  if (hash(readFileSync(artifact.file)) !== artifact.sha256) throw new Error(`Built artifact changed: ${artifact.file}. Run npm run compile.`);
}
const licenses = new Map();
const rows = [];
for (const dependency of manifest.packages) {
  const key = `${dependency.name}@${dependency.version}`;
  if (lock.packages[dependency.root]?.version !== dependency.version) throw new Error(`Stale bundled dependency ${key}. Run npm run compile.`);
  const sections = [];
  for (const file of dependency.licenseFiles) {
    const bytes = readFileSync(file.path);
    if (hash(bytes) !== file.sha256) throw new Error(`License changed: ${file.path}. Run npm run compile.`);
    let section = licenses.get(file.sha256);
    if (!section) {
      const text = file.lineStart ? bytes.toString('utf8').split('\n').slice(file.lineStart - 1, file.lineEnd).join('\n') : bytes.toString('utf8');
      section = { number: licenses.size + 1, text: text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim(), packages: new Set() };
      licenses.set(file.sha256, section);
    }
    section.packages.add(key);
    sections.push(`[${section.number}](#license-${section.number})`);
  }
  rows.push(`| ${key} | ${dependency.license} | ${sections.join(', ')} |`);
}
const contents = [
  '# Third-Party Notices', '',
  'AI Markdown Review Loop is licensed under the MIT License. This inventory describes dependencies actually bundled into the extension and browser runtimes. Mermaid is rebuilt from resolved npm modules; no separately prebundled renderer is copied.', '',
  'Generated with `npm run compile && npm run notices:generate` from esbuild input graphs and the installed license files. `out/build-manifest.json` records package versions and SHA-256 hashes of every runtime artifact. Development-only tooling and tree-shaken modules are not part of this shipped-code inventory.', '',
  '## Bundled packages', '', '| Package | Declared license | License text |', '| --- | --- | --- |',
  ...rows, '', '## License texts', '',
  ...[...licenses.values()].flatMap(section => [
    `<a id="license-${section.number}"></a>`, '', `### License ${section.number}`, '',
    `Packages: ${[...section.packages].sort().join(', ')}`, '', '```text', section.text, '```', ''
  ])
].join('\n');
if (process.argv.includes('--write')) {
  writeFileSync('THIRD_PARTY_NOTICES.md', contents);
  console.log(`Generated notices for ${manifest.packages.length} bundled package entries.`);
} else if (readFileSync('THIRD_PARTY_NOTICES.md', 'utf8') !== contents) {
  throw new Error('THIRD_PARTY_NOTICES.md does not match the built package inventory. Run npm run notices:generate and review the changes.');
} else {
  console.log(`Notices and runtime hashes cover ${manifest.packages.length} bundled package entries.`);
}
