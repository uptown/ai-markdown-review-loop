import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(path.join(root, 'media/asset-manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.generator.file !== 'scripts/render-marketplace-assets.mjs') {
  throw new Error('Unsupported marketplace asset manifest. Regenerate with npm run assets:marketplace.');
}
if (hash(readFileSync(path.join(root, manifest.generator.file))) !== manifest.generator.sha256) {
  throw new Error('Artwork generator changed. Run npm run assets:marketplace, inspect the output and commit the manifest.');
}
for (const artifact of manifest.artifacts) {
  if (path.basename(artifact.file) !== artifact.file) throw new Error(`Invalid asset path ${artifact.file}.`);
  const bytes = readFileSync(path.join(root, 'media', artifact.file));
  if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) {
    throw new Error(`Stale marketplace asset ${artifact.file}. Run npm run assets:marketplace and inspect the output.`);
  }
}
console.log(`${manifest.artifacts.length} marketplace assets match their generator and recorded hashes; no files changed.`);
