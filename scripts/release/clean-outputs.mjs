import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const releaseDirectory = path.resolve(projectRoot, 'outputs');

if (path.dirname(releaseDirectory) !== projectRoot) {
  throw new Error(`Refusing to clean unexpected release path: ${releaseDirectory}`);
}

let releaseDirectoryStat;
try {
  releaseDirectoryStat = await lstat(releaseDirectory);
} catch (error) {
  if (error?.code === 'ENOENT') process.exit(0);
  throw error;
}

if (!releaseDirectoryStat.isDirectory() || releaseDirectoryStat.isSymbolicLink()) {
  throw new Error(`Release path must be a real directory: ${releaseDirectory}`);
}

for (const entry of await readdir(releaseDirectory)) {
  if (entry === '.gitkeep') continue;
  const target = path.resolve(releaseDirectory, entry);
  if (path.dirname(target) !== releaseDirectory) {
    throw new Error(`Refusing to clean unexpected release entry: ${target}`);
  }
  await rm(target, { force: true, recursive: true });
}
