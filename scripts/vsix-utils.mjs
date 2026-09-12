import { createRequire } from 'node:module';

// Reuse the ZIP reader already required by our packaging tool on every OS.
const requireFromVsce = createRequire(import.meta.resolve('@vscode/vsce/package.json'));
const yauzl = requireFromVsce('yauzl');

export async function readVsix(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map();
      let bytes = 0;
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        bytes += entry.uncompressedSize;
        if (bytes > 64 * 1024 * 1024) {
          zip.close();
          reject(new Error('VSIX exceeds the 64 MB uncompressed inspection limit.'));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
