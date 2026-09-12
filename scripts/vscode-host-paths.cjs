const fs = require('node:fs');
const path = require('node:path');

function hasApplication(directory) {
  return fs.existsSync(path.join(directory, 'out/cli.js')) && fs.existsSync(path.join(directory, 'package.json'));
}

function windowsApplication(directory) {
  const launcher = path.join(directory, 'bin/code.cmd');
  if (fs.existsSync(launcher)) {
    // Current official Windows archives keep resources under a commit prefix.
    // Select the version referenced by the launcher, never an arbitrary sibling.
    const match = fs.readFileSync(launcher, 'utf8').match(/%~dp0\.\.[\\/](?:([a-f0-9]{8,40})[\\/])?resources[\\/]app[\\/]out[\\/]cli\.js/i);
    if (match) {
      const application = path.join(directory, match[1] || '', 'resources/app');
      if (!hasApplication(application)) throw new Error('The Windows VS Code launcher references an incomplete application directory.');
      return application;
    }
  }
  const legacy = path.join(directory, 'resources/app');
  if (hasApplication(legacy)) return legacy;
  const candidates = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{8,40}$/i.test(entry.name))
    .map(entry => path.join(directory, entry.name, 'resources/app'))
    .filter(hasApplication);
  if (candidates.length !== 1) throw new Error('Cannot identify one complete Windows VS Code application directory; check its bin/code.cmd launcher.');
  return candidates[0];
}

function resolveVscodeExecutablePaths(binary, platform = process.platform) {
  const directory = path.dirname(binary);
  const application = platform === 'darwin' ? path.resolve(directory, '../Resources/app')
    : platform === 'win32' ? windowsApplication(directory) : path.join(directory, 'resources/app');
  if (!fs.existsSync(binary) || !hasApplication(application)) throw new Error('VS Code executable, CLI or application metadata is missing.');
  const launchers = platform === 'darwin' ? [path.join(application, 'bin/code')]
    : [path.join(directory, 'bin/code'), path.join(directory, 'bin/code.cmd')];
  return {
    binary,
    cli: path.join(application, 'out/cli.js'),
    metadata: path.join(application, 'package.json'),
    requiresRunAsNodeFlag: launchers.some(file => fs.existsSync(file)
      && fs.readFileSync(file, 'utf8').includes('--ms-enable-electron-run-as-node'))
  };
}

function resolveVscodeArchivePaths(directory, platform = process.platform) {
  const macDirectory = path.join(directory, 'Visual Studio Code.app/Contents/MacOS');
  const binary = platform === 'darwin'
    ? path.join(macDirectory, fs.existsSync(path.join(macDirectory, 'Code')) ? 'Code' : 'Electron')
    : path.join(directory, platform === 'win32' ? 'Code.exe' : 'code');
  return resolveVscodeExecutablePaths(binary, platform);
}

exports.resolveVscodeExecutablePaths = resolveVscodeExecutablePaths;
exports.resolveVscodeArchivePaths = resolveVscodeArchivePaths;
