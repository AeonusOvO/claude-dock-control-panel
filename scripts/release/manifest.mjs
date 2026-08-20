// Produces the release manifest for the single canonical artifact directory and fails on drift:
// missing artifact, version mismatch, broken electron-updater digest chain, or stale installers.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const releaseDirectory = path.join(projectRoot, 'outputs');
const manifestPath = path.join(releaseDirectory, 'release-manifest.json');

const packageManifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const version = packageManifest.version;
const installerName = `ClaudeDock-Setup-${version}-x64.exe`;
const shippedNames = [installerName, `${installerName}.blockmap`, 'latest.yml'];
// electron-builder writes these next to the shipped files; they are inputs to debugging, not releases.
const byproductNames = new Set([
  '.gitkeep',
  'builder-debug.yml',
  'release-manifest.json',
  'win-unpacked',
]);

const digest = (algorithm, encoding, filePath) =>
  createHash(algorithm).update(readFileSync(filePath)).digest(encoding);

const readUpdateManifest = (filePath) => {
  const text = readFileSync(filePath, 'utf8');
  const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim();
  return {
    path: field('path'),
    sha512: field('sha512'),
    // `size` only appears inside the indented `files:` entry electron-updater downloads.
    size: Number(/^\s+size:\s*(\d+)$/m.exec(text)?.[1]),
    version: field('version'),
  };
};

const authenticodeStatus = (filePath) => {
  if (process.platform !== 'win32') return 'unavailable';
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-AuthenticodeSignature '${filePath}').Status`],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return 'unknown';
  }
};

const problems = [];
if (!existsSync(releaseDirectory)) {
  problems.push(`missing release directory: ${releaseDirectory}`);
}

const artifacts = [];
for (const name of shippedNames) {
  const filePath = path.join(releaseDirectory, name);
  if (!existsSync(filePath)) {
    problems.push(`missing artifact: ${name}`);
    continue;
  }
  artifacts.push({
    bytes: statSync(filePath).size,
    name,
    sha256: digest('sha256', 'hex', filePath),
    sha512: digest('sha512', 'base64', filePath),
  });
}

const installer = artifacts.find((artifact) => artifact.name === installerName);
const updateManifestPath = path.join(releaseDirectory, 'latest.yml');
let updateManifest;
if (installer && existsSync(updateManifestPath)) {
  updateManifest = readUpdateManifest(updateManifestPath);
  if (updateManifest.version !== version) {
    problems.push(`latest.yml version ${updateManifest.version} != package version ${version}`);
  }
  if (updateManifest.path !== installerName) {
    problems.push(`latest.yml path ${updateManifest.path} != ${installerName}`);
  }
  if (updateManifest.sha512 !== installer.sha512) {
    problems.push('latest.yml sha512 does not match the installer; the update chain is broken');
  }
  if (updateManifest.size !== installer.bytes) {
    problems.push(`latest.yml size ${updateManifest.size} != installer size ${installer.bytes}`);
  }
}

const stale = existsSync(releaseDirectory)
  ? readdirSync(releaseDirectory).filter(
      (name) => !shippedNames.includes(name) && !byproductNames.has(name),
    )
  : [];
if (stale.length > 0) {
  problems.push(`stale files in ${releaseDirectory}: ${stale.join(', ')}`);
}

const manifest = {
  artifacts,
  directory: releaseDirectory,
  generatedAt: new Date().toISOString(),
  problems,
  product: packageManifest.build.productName,
  signature: installer
    ? authenticodeStatus(path.join(releaseDirectory, installerName))
    : 'unavailable',
  version,
};

if (existsSync(releaseDirectory)) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`release ${manifest.product} ${version}`);
console.log(`directory ${releaseDirectory}`);
for (const artifact of artifacts) {
  const megabytes = (artifact.bytes / 1024 / 1024).toFixed(2);
  console.log(`  ${artifact.name}  ${artifact.bytes} bytes (${megabytes} MB)`);
  console.log(`    sha256 ${artifact.sha256}`);
}
console.log(`signature ${manifest.signature}`);
console.log(
  updateManifest
    ? `update chain ok: latest.yml -> ${updateManifest.path} (${updateManifest.size} bytes)`
    : 'update chain unverified',
);

if (problems.length > 0) {
  for (const problem of problems) console.error(`RELEASE PROBLEM ${problem}`);
  process.exitCode = 1;
}
