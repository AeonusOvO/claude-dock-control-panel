// Produces the release manifest for the single canonical artifact directory and fails on drift:
// missing artifacts, invalid feed configuration, version mismatch, or a broken updater digest chain.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const defaultProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const byproductNames = new Set([
  '.gitkeep',
  'builder-debug.yml',
  'production-smoke-appdata',
  'release-manifest.json',
  'win-unpacked',
]);

const messageOf = (value) => (value instanceof Error ? value.message : String(value));

export const digestFile = (algorithm, encoding, filePath) =>
  createHash(algorithm).update(readFileSync(filePath)).digest(encoding);

const objectRecord = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

const stringValue = (value) => (typeof value === 'string' ? value : undefined);

export const parseUpdateManifest = (text) => {
  const document = objectRecord(parseYaml(text));
  const files = Array.isArray(document?.files) ? document.files : [];
  const file = files.length === 1 ? objectRecord(files[0]) : undefined;
  return {
    fileCount: files.length,
    fileSha512: stringValue(file?.sha512),
    fileUrl: stringValue(file?.url),
    path: stringValue(document?.path),
    releaseDate: stringValue(document?.releaseDate),
    sha512: stringValue(document?.sha512),
    size: typeof file?.size === 'number' ? file.size : undefined,
    version: stringValue(document?.version),
  };
};

const compareNumericIdentifiers = (left, right) => {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
};

export const parseSemanticVersion = (value) => {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) throw new Error(`invalid semantic version: ${value}`);
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((identifier) => /^0\d+$/.test(identifier))) {
    throw new Error(`invalid semantic version: ${value}`);
  }
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
  };
};

export const compareSemanticVersions = (leftValue, rightValue) => {
  const left = parseSemanticVersion(leftValue);
  const right = parseSemanticVersion(rightValue);
  for (const key of ['major', 'minor', 'patch']) {
    const comparison = compareNumericIdentifiers(left[key], right[key]);
    if (comparison !== 0) return comparison;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === rightIdentifier) continue;
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
};

const publishConfigOf = (packageManifest) => {
  const configured = packageManifest.build?.publish;
  if (Array.isArray(configured) && configured.length !== 1) {
    throw new Error('build.publish must contain exactly one provider');
  }
  const publish = Array.isArray(configured) ? configured[0] : configured;
  if (!publish || typeof publish !== 'object') {
    throw new Error('build.publish must contain one generic provider');
  }
  return publish;
};

export const validateGenericFeed = (packageManifest) => {
  const publish = publishConfigOf(packageManifest);
  if (publish.provider !== 'generic') {
    throw new Error(`build.publish.provider ${String(publish.provider)} != generic`);
  }
  if (typeof publish.url !== 'string') {
    throw new Error('build.publish.url is missing');
  }
  const feedUrl = new URL(publish.url);
  if (feedUrl.protocol !== 'https:') throw new Error('update feed must use HTTPS');
  if (feedUrl.username || feedUrl.password) throw new Error('update feed must not contain userinfo');
  if (feedUrl.search) throw new Error('update feed must not contain a query string');
  if (feedUrl.hash) throw new Error('update feed must not contain a fragment');
  if (!feedUrl.pathname.endsWith('/')) throw new Error('update feed URL must end with /');
  if (publish.useMultipleRangeRequest !== false) {
    throw new Error('Tencent COS feed requires useMultipleRangeRequest=false');
  }
  return { feedUrl: feedUrl.toString(), publish };
};

export const resolveReleaseChannel = (packageManifest) => {
  const publish = publishConfigOf(packageManifest);
  const explicitChannel = publish.channel;
  let channel;
  if (explicitChannel !== undefined) {
    if (typeof explicitChannel !== 'string' || explicitChannel.length === 0) {
      throw new Error('build.publish.channel must be a non-empty string');
    }
    channel = explicitChannel;
  } else {
    const version = parseSemanticVersion(packageManifest.version);
    channel =
      packageManifest.build?.detectUpdateChannel !== false && version.prerelease.length > 0
        ? version.prerelease[0]
        : 'latest';
  }
  if (!/^[0-9A-Za-z-]+$/.test(channel)) {
    throw new Error(`invalid update channel: ${channel}`);
  }
  return channel;
};

const authenticodeStatus = (filePath) => {
  if (process.platform !== 'win32') return 'unavailable';
  try {
    const escapedPath = filePath.replaceAll("'", "''");
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${escapedPath}').Status`],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return 'unknown';
  }
};

export const validateRelease = ({
  now = new Date(),
  projectRoot = defaultProjectRoot,
  releaseDirectory = path.join(projectRoot, 'outputs'),
  signatureStatus = authenticodeStatus,
  writeReport = true,
} = {}) => {
  const packageManifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = packageManifest.version;
  const installerName = `ClaudeDock-Setup-${version}-x64.exe`;
  const blockmapName = `${installerName}.blockmap`;
  const problems = [];
  let channel = 'unknown';
  let channelManifestName = 'unknown.yml';
  let feedUrl;
  let provider;

  try {
    channel = resolveReleaseChannel(packageManifest);
    channelManifestName = `${channel}.yml`;
  } catch (error) {
    problems.push(messageOf(error));
  }
  try {
    const feed = validateGenericFeed(packageManifest);
    feedUrl = feed.feedUrl;
    provider = feed.publish.provider;
  } catch (error) {
    problems.push(messageOf(error));
  }

  if (!existsSync(releaseDirectory)) {
    problems.push(`missing release directory: ${releaseDirectory}`);
  }

  const shippedNames = [installerName, blockmapName, channelManifestName];
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
      sha256: digestFile('sha256', 'hex', filePath),
      sha512: digestFile('sha512', 'base64', filePath),
    });
  }

  const installer = artifacts.find((artifact) => artifact.name === installerName);
  const blockmap = artifacts.find((artifact) => artifact.name === blockmapName);
  const updateManifestPath = path.join(releaseDirectory, channelManifestName);
  let updateManifest;
  if (installer && existsSync(updateManifestPath)) {
    try {
      updateManifest = parseUpdateManifest(readFileSync(updateManifestPath, 'utf8'));
    } catch (error) {
      problems.push(`${channelManifestName} cannot be parsed: ${messageOf(error)}`);
    }
    if (updateManifest) {
      if (updateManifest.version !== version) {
        problems.push(
          `${channelManifestName} version ${String(updateManifest.version)} != package version ${version}`,
        );
      }
      if (updateManifest.fileCount !== 1) {
        problems.push(`${channelManifestName} must contain exactly one update file`);
      }
      if (updateManifest.fileUrl !== installerName) {
        problems.push(
          `${channelManifestName} file URL ${String(updateManifest.fileUrl)} != ${installerName}`,
        );
      }
      if (updateManifest.path !== installerName) {
        problems.push(
          `${channelManifestName} path ${String(updateManifest.path)} != ${installerName}`,
        );
      }
      if (
        updateManifest.fileSha512 !== installer.sha512 ||
        updateManifest.sha512 !== installer.sha512
      ) {
        problems.push(
          `${channelManifestName} sha512 does not match the installer; the update chain is broken`,
        );
      }
      if (updateManifest.size !== installer.bytes) {
        problems.push(
          `${channelManifestName} size ${String(updateManifest.size)} != installer size ${installer.bytes}`,
        );
      }
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
    channel,
    channelManifest: channelManifestName,
    directory: releaseDirectory,
    feedUrl,
    generatedAt: now.toISOString(),
    problems,
    product: packageManifest.build?.productName,
    provider,
    signature: installer
      ? signatureStatus(path.join(releaseDirectory, installerName))
      : 'unavailable',
    version,
  };

  if (writeReport && existsSync(releaseDirectory)) {
    writeFileSync(
      path.join(releaseDirectory, 'release-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  return {
    blockmap,
    channelManifestPath: updateManifestPath,
    installer,
    manifest,
    packageManifest,
    updateManifest,
  };
};

export const runManifestCli = () => {
  const result = validateRelease();
  const { manifest, updateManifest } = result;
  console.log(`release ${manifest.product} ${manifest.version}`);
  console.log(`channel ${manifest.channel} (${manifest.channelManifest})`);
  console.log(`feed ${manifest.feedUrl ?? 'invalid'}`);
  console.log(`directory ${manifest.directory}`);
  for (const artifact of manifest.artifacts) {
    const megabytes = (artifact.bytes / 1024 / 1024).toFixed(2);
    console.log(`  ${artifact.name}  ${artifact.bytes} bytes (${megabytes} MB)`);
    console.log(`    sha256 ${artifact.sha256}`);
  }
  console.log(`signature ${manifest.signature}`);
  console.log(
    updateManifest
      ? `update chain ok: ${manifest.channelManifest} -> ${String(updateManifest.path)} (${String(updateManifest.size)} bytes)`
      : 'update chain unverified',
  );
  if (manifest.problems.length > 0) {
    for (const problem of manifest.problems) console.error(`RELEASE PROBLEM ${problem}`);
    process.exitCode = 1;
  }
  return result;
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runManifestCli();
}
