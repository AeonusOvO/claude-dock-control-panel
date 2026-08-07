const { existsSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const root = path.join(__dirname, '..');
const unpackedRoot = path.join(root, 'outputs', 'win-unpacked');
const resourcesRoot = path.join(unpackedRoot, 'resources');
const appAsar = path.join(resourcesRoot, 'app.asar');

if (!existsSync(unpackedRoot)) {
  throw new Error(`Packaged application is missing: ${unpackedRoot}`);
}

const matches = [];
const visit = (directory) => {
  for (const name of readdirSync(directory)) {
    const absolute = path.join(directory, name);
    const relative = path.relative(unpackedRoot, absolute).replaceAll('\\', '/');
    if (statSync(absolute).isDirectory()) visit(absolute);
    else if (name.toLowerCase() === 'claude.exe') matches.push(relative);
  }
};

visit(unpackedRoot);

if (existsSync(appAsar)) {
  for (const entry of asar.listPackage(appAsar)) {
    if (path.posix.basename(entry.toLowerCase()) === 'claude.exe') {
      matches.push(`resources/app.asar:${entry}`);
    }
  }
}

if (matches.length > 0) {
  throw new Error(
    `The package contains a second Claude Code executable:\n${matches.map((entry) => `- ${entry}`).join('\n')}`,
  );
}

console.log('Package assertion passed: no bundled claude.exe was found.');
