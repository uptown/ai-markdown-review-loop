import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const vendorFiles = [
  {
    from: 'node_modules/mermaid/dist/mermaid.min.js',
    to: 'out/vendor/mermaid.min.js'
  }
];

for (const file of vendorFiles) {
  const source = resolve(file.from);
  const destination = resolve(file.to);

  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
