import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
const missing = [];

for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!packagePath.startsWith('node_modules/') || metadata.dev) {
    continue;
  }

  const packageName = packagePath.slice(packagePath.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const packageVersion = metadata.version;

  if (!packageVersion) {
    continue;
  }

  const noticeKey = `${packageName}@${packageVersion}`;

  if (!notices.includes(noticeKey)) {
    missing.push(noticeKey);
  }
}

if (missing.length > 0) {
  console.error('THIRD_PARTY_NOTICES.md is missing production packages:');
  for (const packageKey of missing) {
    console.error(`- ${packageKey}`);
  }
  process.exit(1);
}

console.log('THIRD_PARTY_NOTICES.md covers production package versions from package-lock.json.');
