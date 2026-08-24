import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const packagedSourceIdentityArchivePath = 'dist/build-source-identity.json';

const digestFile = (filePath) => createHash('sha256').update(readFileSync(filePath)).digest('hex');

export const readSourceIdentity = ({ executeGit, projectRoot = defaultProjectRoot } = {}) => {
  const runGit =
    executeGit ??
    ((arguments_) =>
      execFileSync('git', ['-C', projectRoot, ...arguments_], {
        encoding: 'utf8',
      }));
  const gitHead = runGit(['rev-parse', '--verify', 'HEAD']).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(gitHead)) {
    throw new Error(`Git HEAD is not a full object ID: ${gitHead}`);
  }
  const packageLockPath = path.join(projectRoot, 'package-lock.json');
  if (!existsSync(packageLockPath)) throw new Error('missing source file: package-lock.json');
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
  return {
    gitHead,
    packageLockSha256: digestFile(packageLockPath),
    treeClean: status.trim().length === 0,
  };
};

export const packagedSourceIdentityDocument = (sourceIdentity) => ({
  schemaVersion: 1,
  gitHead: sourceIdentity.gitHead,
  packageLockSha256: sourceIdentity.packageLockSha256,
  treeClean: sourceIdentity.treeClean,
});

export const writePackagedSourceIdentity = ({ projectRoot = defaultProjectRoot } = {}) => {
  const identity = packagedSourceIdentityDocument(readSourceIdentity({ projectRoot }));
  const outputPath = path.join(projectRoot, ...packagedSourceIdentityArchivePath.split('/'));
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
  return { identity, outputPath };
};

export const runSourceIdentityCli = () => {
  const { identity, outputPath } = writePackagedSourceIdentity();
  console.log(
    `source identity ${identity.gitHead} -> ${path.relative(defaultProjectRoot, outputPath)}`,
  );
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runSourceIdentityCli();
}
