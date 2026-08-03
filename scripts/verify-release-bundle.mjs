import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MANIFEST_LIMIT = 64 * 1024;
const SIGNATURE_LIMIT = 256;
const KEY_ID = 'f724eb3fcaa7f4c5';
const GITHUB_RELEASE_ROOT =
  'https://github.com/AeonusOvO/claude-dock-control-panel/releases/download/';
const MIRROR_BASE_URL = 'https://124.221.158.247/claudedock/windows/x64/';
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const PUBLISHED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const argumentsList = process.argv.slice(2);
const bundleDirectory = path.resolve(argumentsList[0] ?? 'outputs');
const againstIndex = argumentsList.indexOf('--against');
const comparisonDirectory =
  againstIndex >= 0 && argumentsList[againstIndex + 1]
    ? path.resolve(argumentsList[againstIndex + 1])
    : undefined;
const publicKeyIndex = argumentsList.indexOf('--public-key');
const publicKeyPath =
  publicKeyIndex >= 0 && argumentsList[publicKeyIndex + 1]
    ? path.resolve(argumentsList[publicKeyIndex + 1])
    : path.resolve('assets/runtime/release-manifest-public-key.pem');
const expectedVersionIndex = argumentsList.indexOf('--expected-version');
const expectedVersion =
  expectedVersionIndex >= 0 ? argumentsList[expectedVersionIndex + 1] : undefined;

const sha512File = async (filePath) => {
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('base64');
};

const canonicalSha512 = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9+/]{86}==$/.test(value) &&
  Buffer.from(value, 'base64').toString('base64') === value;

const manifestPath = path.join(bundleDirectory, 'release-manifest.json');
const signaturePath = path.join(bundleDirectory, 'release-manifest.sig');
const manifestBytes = readFileSync(manifestPath);
const signatureText = readFileSync(signaturePath, 'ascii');
if (
  manifestBytes.byteLength === 0 ||
  manifestBytes.byteLength > MANIFEST_LIMIT ||
  Buffer.byteLength(signatureText, 'ascii') > SIGNATURE_LIMIT ||
  !/^[A-Za-z0-9+/]{86}==\s?$/.test(signatureText)
) {
  throw new Error('Release manifest or detached signature exceeds its strict format limit.');
}
const publicKey = createPublicKey(readFileSync(publicKeyPath, 'utf8'));
if (publicKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('Release manifest public key must be Ed25519.');
}
if (!verify(null, manifestBytes, publicKey, Buffer.from(signatureText.trim(), 'base64'))) {
  throw new Error('Release manifest Ed25519 signature is invalid.');
}

const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (
  manifest.schemaVersion !== 1 ||
  manifest.channel !== 'stable' ||
  manifest.keyId !== KEY_ID ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version) ||
  typeof manifest.publishedAt !== 'string' ||
  !PUBLISHED_AT_PATTERN.test(manifest.publishedAt) ||
  Number.isNaN(Date.parse(manifest.publishedAt)) ||
  manifest.sources?.github !== GITHUB_RELEASE_ROOT + 'v' + manifest.version + '/' ||
  manifest.sources?.mirror !== MIRROR_BASE_URL ||
  Object.keys(manifest.sources ?? {})
    .sort()
    .join(',') !== 'github,mirror' ||
  !Array.isArray(manifest.files) ||
  manifest.files.length !== 3
) {
  throw new Error('Release manifest schema or pinned channel URLs are invalid.');
}
if (expectedVersion && manifest.version !== expectedVersion) {
  throw new Error('Release manifest version does not match the promotion request.');
}

const installerName = 'ClaudeDock-Setup-' + manifest.version + '-x64.exe';
const requiredNames = [
  installerName,
  installerName + '.blockmap',
  'latest.yml',
  'release-manifest.json',
  'release-manifest.sig',
];
const expectedArtifactNames = new Set(requiredNames.slice(0, 3));
const entries = new Map();
for (const entry of manifest.files) {
  if (
    !entry ||
    typeof entry.name !== 'string' ||
    !FILE_NAME_PATTERN.test(entry.name) ||
    !expectedArtifactNames.has(entry.name) ||
    entries.has(entry.name) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size <= 0 ||
    entry.size > 2 * 1024 * 1024 * 1024 ||
    !canonicalSha512(entry.sha512)
  ) {
    throw new Error('Release manifest contains an invalid or duplicate file entry.');
  }
  entries.set(entry.name, entry);
}

for (const name of requiredNames.slice(0, 3)) {
  const entry = entries.get(name);
  if (!entry) throw new Error('Release manifest is missing ' + name + '.');
  const filePath = path.join(bundleDirectory, name);
  const fileStatus = lstatSync(filePath);
  if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
    throw new Error('Release artifact must be a regular file: ' + name + '.');
  }
  if (statSync(filePath).size !== entry.size) {
    throw new Error('Size mismatch for ' + name + '.');
  }
  if ((await sha512File(filePath)) !== entry.sha512) {
    throw new Error('SHA-512 mismatch for ' + name + '.');
  }
}

const installer = entries.get(installerName);
if (
  !Number.isSafeInteger(installer.sampleSize) ||
  installer.sampleSize !== Math.min(256 * 1024, installer.size) ||
  !canonicalSha512(installer.sampleSha512)
) {
  throw new Error('Installer sample metadata is invalid.');
}
const blockmap = entries.get(installerName + '.blockmap');
const metadata = entries.get('latest.yml');
if (
  blockmap.size > 32 * 1024 * 1024 ||
  metadata.size > MANIFEST_LIMIT ||
  blockmap.sampleSize !== undefined ||
  blockmap.sampleSha512 !== undefined ||
  metadata.sampleSize !== undefined ||
  metadata.sampleSha512 !== undefined
) {
  throw new Error('Blockmap or latest.yml limits are invalid.');
}
const installerHandle = openSync(path.join(bundleDirectory, installerName), 'r');
const sample = Buffer.alloc(installer.sampleSize);
try {
  if (readSync(installerHandle, sample, 0, sample.byteLength, 0) !== sample.byteLength) {
    throw new Error('Installer sample could not be read.');
  }
} finally {
  closeSync(installerHandle);
}
if (createHash('sha512').update(sample).digest('base64') !== installer.sampleSha512) {
  throw new Error('Installer sample SHA-512 mismatch.');
}

const latestText = readFileSync(path.join(bundleDirectory, 'latest.yml'), 'utf8');
const metadataVersion = /^version:\s*['"]?([^\s'"]+)['"]?\s*$/m.exec(latestText)?.[1];
const metadataPath = /^path:\s*['"]?([^\r\n'"]+)['"]?\s*$/m.exec(latestText)?.[1]?.trim();
const metadataSha512 = /^sha512:\s*([A-Za-z0-9+/=]{40,})\s*$/m.exec(latestText)?.[1];
if (
  metadataVersion !== manifest.version ||
  metadataPath !== installerName ||
  metadataSha512 !== installer.sha512
) {
  throw new Error('latest.yml does not match the signed release manifest.');
}

if (comparisonDirectory) {
  for (const name of requiredNames) {
    const leftPath = path.join(bundleDirectory, name);
    const rightPath = path.join(comparisonDirectory, name);
    if (
      !lstatSync(leftPath).isFile() ||
      !lstatSync(rightPath).isFile() ||
      lstatSync(leftPath).isSymbolicLink() ||
      lstatSync(rightPath).isSymbolicLink()
    ) {
      throw new Error('Compared release artifacts must be regular files: ' + name + '.');
    }
    if (
      statSync(leftPath).size !== statSync(rightPath).size ||
      (await sha512File(leftPath)) !== (await sha512File(rightPath))
    ) {
      throw new Error('Channel byte mismatch for ' + name + '.');
    }
  }
}

process.stdout.write(
  JSON.stringify({
    comparedAgainst: comparisonDirectory,
    files: requiredNames,
    keyId: manifest.keyId,
    verified: true,
    version: manifest.version,
  }) + '\n',
);
