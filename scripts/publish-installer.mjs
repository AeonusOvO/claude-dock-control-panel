import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), { encoding: 'utf8' }),
);
const installerName = `ClaudeDock-Setup-${packageJson.version}-x64.exe`;
const releaseDirectory = path.resolve(projectRoot, 'release');
const source = path.resolve(releaseDirectory, installerName);
const destination = path.resolve(projectRoot, installerName);

if (path.dirname(source) !== releaseDirectory) {
  throw new Error(`Refusing to publish from unexpected path: ${source}`);
}

if (path.dirname(destination) !== projectRoot) {
  throw new Error(`Refusing to publish to unexpected path: ${destination}`);
}

await copyFile(source, destination);
console.log(`Published installer: ${destination}`);
