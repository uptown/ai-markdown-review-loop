import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Pass test files explicitly so support modules are not counted as empty tests.
const directory = new URL('../.test-out/test/', import.meta.url);
const tests = readdirSync(directory)
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => fileURLToPath(new URL(name, directory)));

if (tests.length === 0) {
  throw new Error('No compiled unit tests found. Compile tsconfig.test.json first.');
}

const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
process.exit(result.status ?? 1);
