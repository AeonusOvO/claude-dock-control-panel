// Publishes a locally validated Electron update feed to Tencent COS.
// Versioned assets are immutable; channel manifests are the only mutable release pointers and go last.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import COS from 'cos-nodejs-sdk-v5';
import {
  compareSemanticVersions,
  defaultProjectRoot,
  parseSemanticVersion,
  parseUpdateManifest,
  sanitizeManifestText,
  validateRelease,
} from './manifest.mjs';
import { loadReleaseOrchestration } from './release.mjs';

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const CHANNEL_CACHE_CONTROL = 'no-cache, max-age=0, must-revalidate';

const messageOf = (value) => (value instanceof Error ? value.message : String(value));

export const redactSensitiveText = (value, secrets = []) => {
  let text = sanitizeManifestText(value);
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)) {
    text = text.replaceAll(secret, '<redacted>');
  }
  return text
    .replace(
      /((?:authorization|secret(?:id|key)|securitytoken|x-cos-security-token)\s*["']?\s*[:=]\s*["']?)[^\s,"';}\]]+/giu,
      '$1<redacted>',
    )
    .replace(
      /((?:q-sign-algorithm|q-ak|q-sign-time|q-key-time|q-header-list|q-url-param-list|q-signature|x-cos-security-token)=)[^&\s]+/giu,
      '$1<redacted>',
    );
};

const safeError = (error, secrets) => new Error(redactSensitiveText(messageOf(error), secrets));

const requiredEnvironment = (environment, name) => {
  const value = environment[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
};

const normalizePrefix = (value) => {
  const prefix = value.replace(/^\/+|\/+$/g, '');
  if (
    !prefix ||
    prefix.includes('\\') ||
    prefix
      .split('/')
      .some((part) => !/^[0-9A-Za-z._-]+$/.test(part) || part === '.' || part === '..')
  ) {
    throw new Error('TENCENT_COS_PREFIX must be a non-empty object-key prefix');
  }
  return `${prefix}/`;
};

export const readCosEnvironment = (feedUrl, environment = process.env) => {
  const bucket = requiredEnvironment(environment, 'TENCENT_COS_BUCKET');
  const region = requiredEnvironment(environment, 'TENCENT_COS_REGION');
  const prefix = normalizePrefix(requiredEnvironment(environment, 'TENCENT_COS_PREFIX'));
  const secretId = requiredEnvironment(environment, 'TENCENT_COS_SECRET_ID');
  const secretKey = requiredEnvironment(environment, 'TENCENT_COS_SECRET_KEY');
  const securityToken = environment.TENCENT_COS_SECURITY_TOKEN;

  if (!/^[a-z0-9-]+-\d+$/.test(bucket)) {
    throw new Error('TENCENT_COS_BUCKET must include the COS app ID suffix');
  }
  if (!/^[a-z0-9-]+$/.test(region)) {
    throw new Error('TENCENT_COS_REGION is invalid');
  }
  const configuredFeed = new URL(feedUrl);
  const expectedFeed = `https://${bucket}.cos.${region}.myqcloud.com/${prefix}`;
  if (configuredFeed.toString() !== expectedFeed) {
    throw new Error(`COS environment does not match the packaged update feed: ${expectedFeed}`);
  }
  return {
    bucket,
    prefix,
    region,
    secretId,
    secretKey,
    securityToken,
  };
};

const headerValue = (headers, name) => {
  if (!headers) return undefined;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && value !== undefined) return String(value);
  }
  return undefined;
};

const absentObjectError = (error) => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error;
  return (
    candidate.statusCode === 404 ||
    candidate.code === 'NoSuchKey' ||
    candidate.error?.Code === 'NoSuchKey'
  );
};

const existingObjectError = (error) => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error;
  return (
    candidate.statusCode === 409 &&
    (candidate.code === 'FileAlreadyExists' || candidate.error?.Code === 'FileAlreadyExists')
  );
};

export const createCosStorage = ({ bucket, client, region, secrets = [] }) => {
  const putObject = async (
    { body, bytes, cacheControl, contentType, key, localPath, sha256, sha512 },
    forbidOverwrite,
  ) => {
    try {
      await client.putObject({
        Body: body ?? createReadStream(localPath),
        Bucket: bucket,
        CacheControl: cacheControl,
        ContentLength: bytes,
        ContentType: contentType,
        Key: key,
        Region: region,
        'x-cos-forbid-overwrite': forbidOverwrite ? 'true' : undefined,
        'x-cos-meta-sha256': sha256,
        'x-cos-meta-sha512': sha512,
      });
      return true;
    } catch (error) {
      if (forbidOverwrite && existingObjectError(error)) return false;
      throw safeError(error, secrets);
    }
  };

  return {
    async assertAtomicCreateSupported() {
      try {
        const result = await client.getBucketVersioning({ Bucket: bucket, Region: region });
        const status = result.VersioningConfiguration?.Status;
        if (status) {
          throw new Error(
            `COS bucket versioning is ${status}; x-cos-forbid-overwrite cannot guarantee immutable releases`,
          );
        }
      } catch (error) {
        throw safeError(error, secrets);
      }
    },

    async create(descriptor) {
      return putObject(descriptor, true);
    },

    async delete(key) {
      try {
        await client.deleteObject({ Bucket: bucket, Key: key, Region: region });
      } catch (error) {
        throw safeError(error, secrets);
      }
    },

    async head(key) {
      try {
        const result = await client.headObject({ Bucket: bucket, Key: key, Region: region });
        const length = headerValue(result.headers, 'content-length');
        return {
          bytes: length === undefined ? undefined : Number(length),
          cacheControl: headerValue(result.headers, 'cache-control'),
          exists: true,
          sha256: headerValue(result.headers, 'x-cos-meta-sha256'),
          sha512: headerValue(result.headers, 'x-cos-meta-sha512'),
        };
      } catch (error) {
        if (absentObjectError(error)) return { exists: false };
        throw safeError(error, secrets);
      }
    },

    async put(descriptor) {
      await putObject(descriptor, false);
    },

    async read(key) {
      try {
        const result = await client.getObject({ Bucket: bucket, Key: key, Region: region });
        return Buffer.from(result.Body);
      } catch (error) {
        if (absentObjectError(error)) return undefined;
        throw safeError(error, secrets);
      }
    },
  };
};

const objectKey = (prefix, name) => `${prefix}${name}`;

const publicObjectUrl = (feedUrl, name) =>
  new URL(name.split('/').map(encodeURIComponent).join('/'), feedUrl).toString();

const checkedFetch = async (fetchImpl, url, init, expectedStatus) => {
  const response = await fetchImpl(url, init);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${init?.method ?? 'GET'} ${new URL(url).pathname} returned HTTP ${response.status}`,
    );
  }
  return response;
};

const verifyHeaders = (response, descriptor) => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== String(descriptor.bytes)) {
    throw new Error(
      `${descriptor.remoteName} public content-length ${String(contentLength)} != ${descriptor.bytes}`,
    );
  }
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl !== descriptor.cacheControl) {
    throw new Error(
      `${descriptor.remoteName} public cache-control ${String(cacheControl)} != ${descriptor.cacheControl}`,
    );
  }
};

export const verifyPublicRange = async ({ descriptor, feedUrl, fetchImpl }) => {
  const url = publicObjectUrl(feedUrl, descriptor.remoteName);
  const response = await checkedFetch(
    fetchImpl,
    url,
    { headers: { Range: 'bytes=0-0' }, method: 'GET' },
    206,
  );
  const contentRange = response.headers.get('content-range');
  if (contentRange !== `bytes 0-0/${descriptor.bytes}`) {
    throw new Error(
      `${descriptor.remoteName} content-range ${String(contentRange)} != bytes 0-0/${descriptor.bytes}`,
    );
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength !== 1) {
    throw new Error(`${descriptor.remoteName} single-byte range returned ${body.byteLength} bytes`);
  }
  if (body[0] !== descriptor.firstByte) {
    throw new Error(`${descriptor.remoteName} single-byte range differs from the local artifact`);
  }
};

export const hashPublicObject = async ({ descriptor, feedUrl, fetchImpl }) => {
  const url = publicObjectUrl(feedUrl, descriptor.remoteName);
  const response = await checkedFetch(fetchImpl, url, { method: 'GET' }, 200);
  verifyHeaders(response, descriptor);
  if (!response.body) throw new Error(`${descriptor.remoteName} public response has no body`);
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > descriptor.bytes) {
      throw new Error(`${descriptor.remoteName} public body exceeds ${descriptor.bytes} bytes`);
    }
    sha256.update(buffer);
    sha512.update(buffer);
  }
  if (bytes !== descriptor.bytes) {
    throw new Error(`${descriptor.remoteName} public body ${bytes} != ${descriptor.bytes} bytes`);
  }
  const actualSha256 = sha256.digest('hex');
  const actualSha512 = sha512.digest('base64');
  if (actualSha256 !== descriptor.sha256 || actualSha512 !== descriptor.sha512) {
    throw new Error(`${descriptor.remoteName} public digest does not match the local artifact`);
  }
};

const verifyPublicHead = async ({ descriptor, feedUrl, fetchImpl }) => {
  const response = await checkedFetch(
    fetchImpl,
    publicObjectUrl(feedUrl, descriptor.remoteName),
    { method: 'HEAD' },
    200,
  );
  verifyHeaders(response, descriptor);
};

const firstByteOf = (filePath) => {
  const descriptor = openSync(filePath, 'r');
  try {
    const byte = Buffer.allocUnsafe(1);
    if (readSync(descriptor, byte, 0, 1, 0) !== 1) {
      throw new Error(`release artifact is empty: ${filePath}`);
    }
    return byte[0];
  } finally {
    closeSync(descriptor);
  }
};

const immutableDescriptor = (artifact, releaseDirectory, prefix) => {
  const localPath = path.join(releaseDirectory, artifact.name);
  return {
    ...artifact,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    contentType: artifact.name.endsWith('.exe')
      ? 'application/vnd.microsoft.portable-executable'
      : 'application/octet-stream',
    firstByte: firstByteOf(localPath),
    key: objectKey(prefix, artifact.name),
    localPath,
    remoteName: artifact.name,
  };
};

const channelDescriptor = ({ artifact, body, prefix, remoteName }) => ({
  ...artifact,
  body,
  cacheControl: CHANNEL_CACHE_CONTROL,
  contentType: 'application/yaml; charset=utf-8',
  key: objectKey(prefix, remoteName),
  remoteName,
});

const freezeChannelManifest = (artifact, bytes) => {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error('validated release did not freeze the channel manifest bytes');
  }
  const body = Buffer.from(bytes);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const sha512 = createHash('sha512').update(body).digest('base64');
  if (
    body.byteLength !== artifact.bytes ||
    sha256 !== artifact.sha256 ||
    sha512 !== artifact.sha512
  ) {
    throw new Error('frozen channel manifest bytes differ from the validated artifact metadata');
  }
  return body;
};

const assertRemoteMetadataCompatible = (remote, descriptor) => {
  if (remote.bytes !== undefined && remote.bytes !== descriptor.bytes) {
    throw new Error(
      `immutable key collision for ${descriptor.remoteName}: remote size ${remote.bytes} != ${descriptor.bytes}`,
    );
  }
  if (remote.sha256 && remote.sha256 !== descriptor.sha256) {
    throw new Error(`immutable key collision for ${descriptor.remoteName}: SHA-256 differs`);
  }
  if (remote.sha512 && remote.sha512 !== descriptor.sha512) {
    throw new Error(`immutable key collision for ${descriptor.remoteName}: SHA-512 differs`);
  }
};

const publishImmutableObject = async ({ descriptor, feedUrl, fetchImpl, log, storage }) => {
  const remote = await storage.head(descriptor.key);
  if (remote.exists) {
    assertRemoteMetadataCompatible(remote, descriptor);
    log(`reuse immutable ${descriptor.remoteName}`);
  } else if (await storage.create(descriptor)) {
    log(`uploaded immutable ${descriptor.remoteName}`);
  } else {
    const racedRemote = await storage.head(descriptor.key);
    if (!racedRemote.exists) {
      throw new Error(
        `immutable create for ${descriptor.remoteName} conflicted but no object exists`,
      );
    }
    assertRemoteMetadataCompatible(racedRemote, descriptor);
    log(`reuse concurrently created immutable ${descriptor.remoteName}`);
  }
  await verifyPublicHead({ descriptor, feedUrl, fetchImpl });
  await verifyPublicRange({ descriptor, feedUrl, fetchImpl });
  await hashPublicObject({ descriptor, feedUrl, fetchImpl });
  log(`verified immutable ${descriptor.remoteName}`);
};

const fetchExistingChannel = async ({ descriptor, feedUrl, fetchImpl, storage }) => {
  const remote = await storage.head(descriptor.key);
  if (!remote.exists) return undefined;
  const response = await checkedFetch(
    fetchImpl,
    publicObjectUrl(feedUrl, descriptor.remoteName),
    { method: 'GET' },
    200,
  );
  return response.text();
};

const assertChannelAdvance = (existingText, localText, localVersion, remoteName) => {
  if (existingText === undefined) return 'upload';
  const existing = parseUpdateManifest(existingText);
  if (!existing.version) throw new Error(`${remoteName} has no readable version`);
  const comparison = compareSemanticVersions(existing.version, localVersion);
  if (comparison > 0) {
    throw new Error(
      `${remoteName} version ${existing.version} is newer than local ${localVersion}`,
    );
  }
  if (comparison === 0) {
    if (existingText !== localText) {
      throw new Error(`${remoteName} already has version ${localVersion} with different metadata`);
    }
    return 'reuse';
  }
  return 'upload';
};

const publicationLockDescriptor = (prefix, channel, ownerToken) => {
  const body = Buffer.from(`ClaudeDock publication lock for ${channel}: ${ownerToken}\n`, 'utf8');
  return {
    body,
    bytes: body.byteLength,
    cacheControl: 'no-store',
    contentType: 'text/plain; charset=utf-8',
    key: objectKey(prefix, `.claudedock-publication-locks/${channel}.lock`),
  };
};

const releaseChannelLocks = async ({ locks, log, storage }) => {
  const errors = [];
  for (const lock of [...locks].reverse()) {
    try {
      const remoteBody = await storage.read(lock.key);
      if (!remoteBody) {
        log(`channel lock ${lock.channel} was already absent`);
        continue;
      }
      if (!remoteBody.equals(lock.body)) {
        throw new Error(
          `COS publication lock ownership changed for ${lock.channel}; refusing to delete it`,
        );
      }
      await storage.delete(lock.key);
      log(`released channel lock ${lock.channel}`);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'failed to release one or more COS publication locks');
  }
};

const acquireChannelLocks = async ({ channels, log, prefix, storage }) => {
  const locks = [];
  try {
    for (const channel of [...channels].sort()) {
      const descriptor = publicationLockDescriptor(prefix, channel, randomUUID());
      let created;
      try {
        created = await storage.create(descriptor);
      } catch (error) {
        let remoteBody;
        try {
          remoteBody = await storage.read(descriptor.key);
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            `COS publication lock result for ${channel} is ambiguous and ownership could not be checked`,
            { cause: recoveryError },
          );
        }
        if (!remoteBody?.equals(descriptor.body)) throw error;
        created = true;
        log(`recovered acknowledged ownership of channel lock ${channel}`);
      }
      if (!created) {
        const remoteBody = await storage.read(descriptor.key);
        if (remoteBody?.equals(descriptor.body)) {
          created = true;
          log(`recovered create-conflict ownership of channel lock ${channel}`);
        } else {
          throw new Error(
            `COS publication lock for ${channel} is already held; do not delete it until the active publisher is known to have stopped`,
          );
        }
      }
      locks.push({ body: descriptor.body, channel, key: descriptor.key });
      log(`acquired channel lock ${channel}`);
    }
    return locks;
  } catch (error) {
    try {
      await releaseChannelLocks({ locks, log, storage });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'channel lock acquisition and cleanup failed',
        {
          cause: cleanupError,
        },
      );
    }
    throw error;
  }
};

const withChannelLocks = async ({ channels, log, operation, prefix, storage }) => {
  const locks = await acquireChannelLocks({ channels, log, prefix, storage });
  let operationError;
  let result;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await releaseChannelLocks({ locks, log, storage });
  } catch (cleanupError) {
    if (operationError) {
      throw new AggregateError(
        [operationError, cleanupError],
        'COS publication and channel lock cleanup failed',
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }
  if (operationError) throw operationError;
  return result;
};

const publishChannelObject = async ({
  action,
  descriptor,
  feedUrl,
  fetchImpl,
  localText,
  localVersion,
  log,
  storage,
}) => {
  if (action === 'upload') {
    await storage.put(descriptor);
    log(`uploaded channel ${descriptor.remoteName}`);
  } else {
    log(`reuse channel ${descriptor.remoteName}`);
  }
  await verifyPublicHead({ descriptor, feedUrl, fetchImpl });
  const response = await checkedFetch(
    fetchImpl,
    publicObjectUrl(feedUrl, descriptor.remoteName),
    { method: 'GET' },
    200,
  );
  const publicText = await response.text();
  if (publicText !== localText) {
    throw new Error(`${descriptor.remoteName} public content differs from the local manifest`);
  }
  if (parseUpdateManifest(publicText).version !== localVersion) {
    throw new Error(`${descriptor.remoteName} public version does not match ${localVersion}`);
  }
  log(`verified channel ${descriptor.remoteName}`);
};

export const publishValidatedRelease = async ({
  fetchImpl = fetch,
  log = () => undefined,
  prefix,
  promoteChannels = [],
  release,
  storage,
}) => {
  const { blockmap, channelManifestBytes, installer, manifest, updateManifest } = release;
  if (manifest.problems.length > 0) {
    throw new Error(
      `local release validation failed: ${manifest.problems.map((problem) => redactSensitiveText(problem)).join('; ')}`,
    );
  }
  if (!installer || !blockmap || !updateManifest) {
    throw new Error('local release validation did not produce the complete update chain');
  }
  const feedUrl = manifest.feedUrl;
  if (!feedUrl) throw new Error('validated release has no feed URL');

  const channels = [manifest.channel, ...promoteChannels];
  if (new Set(channels).size !== channels.length) {
    throw new Error('channel publication list contains duplicates');
  }
  if (promoteChannels.length > 0 && parseSemanticVersion(manifest.version).prerelease.length > 0) {
    throw new Error('prerelease builds cannot promote stable channel manifests');
  }
  for (const channel of channels) {
    if (!/^[0-9A-Za-z-]+$/.test(channel)) throw new Error(`invalid promotion channel: ${channel}`);
  }

  const manifestArtifact = manifest.artifacts.find(
    (artifact) => artifact.name === manifest.channelManifest,
  );
  if (!manifestArtifact)
    throw new Error(`missing local artifact metadata: ${manifest.channelManifest}`);
  const channelBody = freezeChannelManifest(manifestArtifact, channelManifestBytes);
  const localText = channelBody.toString('utf8');
  const publications = channels.map((channel) => {
    const remoteName = `${channel}.yml`;
    return {
      descriptor: channelDescriptor({
        artifact: manifestArtifact,
        body: channelBody,
        prefix,
        remoteName,
      }),
    };
  });

  await storage.assertAtomicCreateSupported();
  for (const artifact of [installer, blockmap]) {
    await publishImmutableObject({
      descriptor: immutableDescriptor(artifact, manifest.directory, prefix),
      feedUrl,
      fetchImpl,
      log,
      storage,
    });
  }
  await withChannelLocks({
    channels,
    log,
    operation: async () => {
      for (const publication of publications) {
        const existingText = await fetchExistingChannel({
          descriptor: publication.descriptor,
          feedUrl,
          fetchImpl,
          storage,
        });
        publication.action = assertChannelAdvance(
          existingText,
          localText,
          manifest.version,
          publication.descriptor.remoteName,
        );
      }
      for (const publication of publications) {
        await publishChannelObject({
          action: publication.action,
          descriptor: publication.descriptor,
          feedUrl,
          fetchImpl,
          localText,
          localVersion: manifest.version,
          log,
          storage,
        });
      }
    },
    prefix,
    storage,
  });

  return {
    assets: [installer.name, blockmap.name],
    channels: channels.map((channel) => `${channel}.yml`),
    feedUrl,
    version: manifest.version,
  };
};

const withoutGeneratedAt = (manifest) =>
  Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'generatedAt'));

export const assertFrozenManifestMatches = ({ currentManifest, frozenManifest }) => {
  if (
    typeof frozenManifest?.generatedAt !== 'string' ||
    Number.isNaN(Date.parse(frozenManifest.generatedAt)) ||
    new Date(frozenManifest.generatedAt).toISOString() !== frozenManifest.generatedAt
  ) {
    throw new Error('frozen release manifest has an invalid generatedAt value');
  }
  if (!Array.isArray(frozenManifest.problems)) {
    throw new Error('frozen release manifest has no problems array');
  }
  if (frozenManifest.problems.length > 0) {
    throw new Error(
      `frozen release manifest contains problems: ${frozenManifest.problems.map((problem) => redactSensitiveText(problem)).join('; ')}`,
    );
  }
  if (frozenManifest.source?.treeClean !== true) {
    throw new Error('frozen release manifest does not record a clean source tree');
  }
  if (currentManifest.source?.treeClean !== true) {
    throw new Error('current source tree is not clean');
  }
  if (!isDeepStrictEqual(currentManifest.source, frozenManifest.source)) {
    throw new Error(
      'current Git HEAD or package-lock.json SHA-256 differs from the frozen manifest',
    );
  }
  if (!isDeepStrictEqual(currentManifest.artifacts, frozenManifest.artifacts)) {
    throw new Error('current release artifacts differ from the frozen manifest');
  }
  if (currentManifest.problems.length > 0) {
    throw new Error(
      `current non-writing release validation failed: ${currentManifest.problems.map((problem) => redactSensitiveText(problem)).join('; ')}`,
    );
  }
  if (!isDeepStrictEqual(withoutGeneratedAt(currentManifest), withoutGeneratedAt(frozenManifest))) {
    throw new Error('current release metadata differs from the frozen manifest');
  }
};

export const loadFrozenValidatedRelease = ({
  archive,
  extractInstaller,
  now = new Date(),
  projectRoot = defaultProjectRoot,
  releaseDirectory = path.join(projectRoot, 'outputs'),
  signatureStatus,
  sourceIdentity,
  temporaryRoot,
  validateReleaseImpl = validateRelease,
} = {}) => {
  const reportPath = path.join(releaseDirectory, 'release-manifest.json');
  let frozenManifestBytes;
  let frozenManifest;
  try {
    frozenManifestBytes = readFileSync(reportPath);
    frozenManifest = JSON.parse(frozenManifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`frozen release manifest cannot be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
  if (!frozenManifest || typeof frozenManifest !== 'object' || Array.isArray(frozenManifest)) {
    throw new Error('frozen release manifest root must be an object');
  }
  loadReleaseOrchestration({
    releaseDirectory,
    reportBytes: frozenManifestBytes,
    source: frozenManifest.source,
  });
  const currentRelease = validateReleaseImpl({
    archive,
    expectedPackagedSourceIdentity: frozenManifest.source,
    extractInstaller,
    now,
    projectRoot,
    releaseDirectory,
    signatureStatus,
    sourceIdentity,
    temporaryRoot,
    writeReport: false,
  });
  assertFrozenManifestMatches({
    currentManifest: currentRelease.manifest,
    frozenManifest,
  });
  return {
    ...currentRelease,
    manifest: frozenManifest,
  };
};

export const runPublishCli = async ({
  environment = process.env,
  projectRoot = defaultProjectRoot,
} = {}) => {
  const release = loadFrozenValidatedRelease({ projectRoot });
  const configuration = readCosEnvironment(release.manifest.feedUrl, environment);
  const secrets = [
    configuration.secretId,
    configuration.secretKey,
    configuration.securityToken,
  ].filter(Boolean);
  const client = new COS({
    SecretId: configuration.secretId,
    SecretKey: configuration.secretKey,
    SecurityToken: configuration.securityToken,
  });
  const storage = createCosStorage({
    bucket: configuration.bucket,
    client,
    region: configuration.region,
    secrets,
  });
  const promoteChannels = process.argv.includes('--promote-rc') ? ['rc'] : [];
  const result = await publishValidatedRelease({
    log: (message) => console.log(message),
    prefix: configuration.prefix,
    promoteChannels,
    release,
    storage,
  });
  console.log(`published ${result.version} to ${result.feedUrl}`);
  return result;
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const secrets = [
    process.env.TENCENT_COS_SECRET_ID,
    process.env.TENCENT_COS_SECRET_KEY,
    process.env.TENCENT_COS_SECURITY_TOKEN,
  ].filter(Boolean);
  try {
    await runPublishCli();
  } catch (error) {
    console.error(`COS publication failed: ${redactSensitiveText(messageOf(error), secrets)}`);
    process.exitCode = 1;
  }
}
