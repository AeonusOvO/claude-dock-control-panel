import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  createReadStream,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const KEY_ID = 'f724eb3fcaa7f4c5';
const SAMPLE_BYTES = 256 * 1024;
const GITHUB_RELEASE_ROOT =
  'https://github.com/AeonusOvO/claude-dock-control-panel/releases/download/';
const MIRROR_BASE_URL = 'https://124.221.158.247/claudedock/windows/x64/';

const outputDirectory = path.resolve(process.argv[2] ?? 'outputs');
const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
const version = String(packageJson.version ?? '');
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error('A stable release manifest requires an exact major.minor.patch package version.');
}

const privateKeyText = process.env.RELEASE_MANIFEST_PRIVATE_KEY?.replace(/\\n/g, '\n');
if (!privateKeyText) {
  throw new Error('RELEASE_MANIFEST_PRIVATE_KEY is required.');
}
const privateKey = createPrivateKey(privateKeyText);
if (privateKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('RELEASE_MANIFEST_PRIVATE_KEY must be an Ed25519 PKCS#8 key.');
}
const publicKey = createPublicKey(privateKey);
const keyId = createHash('sha256')
  .update(publicKey.export({ format: 'der', type: 'spki' }))
  .digest('hex')
  .slice(0, 16);
if (keyId !== KEY_ID) {
  throw new Error(
    'The release manifest private key does not match the public key pinned by clients.',
  );
}

const publishedAt = process.env.RELEASE_PUBLISHED_AT ?? new Date().toISOString();
if (new Date(publishedAt).toISOString() !== publishedAt) {
  throw new Error('RELEASE_PUBLISHED_AT must be a canonical UTC ISO timestamp.');
}

const installerName = 'ClaudeDock-Setup-' + version + '-x64.exe';
const fileNames = [installerName, installerName + '.blockmap', 'latest.yml'];

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

const sha512Sample = (filePath, sampleSize) => {
  const handle = openSync(filePath, 'r');
  try {
    const bytes = Buffer.alloc(sampleSize);
    const read = readSync(handle, bytes, 0, sampleSize, 0);
    if (read !== sampleSize) {
      throw new Error('Unable to read the signed installer sample.');
    }
    return createHash('sha512').update(bytes).digest('base64');
  } finally {
    closeSync(handle);
  }
};

const files = [];
for (const name of fileNames) {
  const filePath = path.join(outputDirectory, name);
  const size = statSync(filePath).size;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error('Release artifact is empty: ' + name);
  }
  const entry = {
    name,
    sha512: await sha512File(filePath),
    size,
  };
  if (name === installerName) {
    const sampleSize = Math.min(SAMPLE_BYTES, size);
    entry.sampleSha512 = sha512Sample(filePath, sampleSize);
    entry.sampleSize = sampleSize;
  }
  files.push(entry);
}

const latestText = readFileSync(path.join(outputDirectory, 'latest.yml'), 'utf8');
const metadataVersion = /^version:\s*['"]?([^\s'"]+)['"]?\s*$/m.exec(latestText)?.[1];
const metadataPath = /^path:\s*['"]?([^\r\n'"]+)['"]?\s*$/m.exec(latestText)?.[1]?.trim();
const metadataSha512 = /^sha512:\s*([A-Za-z0-9+/=]{40,})\s*$/m.exec(latestText)?.[1];
if (
  metadataVersion !== version ||
  metadataPath !== installerName ||
  metadataSha512 !== files[0].sha512
) {
  throw new Error('latest.yml does not describe the final signed installer bytes.');
}

const manifest = {
  channel: 'stable',
  files,
  keyId: KEY_ID,
  publishedAt,
  schemaVersion: 1,
  sources: {
    github: GITHUB_RELEASE_ROOT + 'v' + version + '/',
    mirror: MIRROR_BASE_URL,
  },
  version,
};
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const signature = sign(null, manifestBytes, privateKey).toString('base64') + '\n';
writeFileSync(path.join(outputDirectory, 'release-manifest.json'), manifestBytes, {
  mode: 0o644,
});
writeFileSync(path.join(outputDirectory, 'release-manifest.sig'), signature, {
  encoding: 'ascii',
  mode: 0o644,
});
process.stdout.write(
  JSON.stringify({
    files: [...fileNames, 'release-manifest.json', 'release-manifest.sig'],
    keyId,
    version,
  }) + '\n',
);
