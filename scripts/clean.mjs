import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(projectRoot, 'dist');

if (path.dirname(target) !== projectRoot) {
  throw new Error(`Refusing to clean unexpected path: ${target}`);
}

await rm(target, { force: true, recursive: true });
