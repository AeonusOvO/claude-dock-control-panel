// Produces the release manifest for the single canonical artifact directory and fails on drift:
// missing artifacts, invalid feed configuration, version mismatch, or a broken updater digest chain.
import asar from '@electron/asar';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  packagedSourceIdentityArchivePath,
  readSourceIdentity,
} from '../build/source-identity.mjs';
import { inspectBlockmap, inspectInstallerPayload } from './artifact-integrity.mjs';

export { readSourceIdentity };

export const defaultProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const byproductNames = new Set([
  '.gitkeep',
  'builder-debug.yml',
  'builder-effective-config.yaml',
  'production-smoke-appdata',
  'release-manifest.json',
  'release-orchestration.json',
  'win-unpacked',
]);

export const expectedBrandAssetNames = [
  'claude-spark-clay.svg',
  'openai-blossom-black.svg',
  'openai-blossom-white.svg',
];

const defaultArchiveReader = {
  extractFile: asar.extractFile,
  listPackage: asar.listPackage,
};

const messageOf = (value) => (value instanceof Error ? value.message : String(value));

export const sanitizeManifestText = (value) =>
  String(value)
    .replace(/(https?:\/\/[^\s#"'<>]+)#[^\s"'<>]*/giu, '$1#<redacted>')
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/giu, '$1?<redacted>')
    .replace(/(https?:\/\/)[^/\s?#"'<>]*@/giu, '$1<redacted>@');

const digestBytes = (algorithm, encoding, bytes) =>
  createHash(algorithm).update(bytes).digest(encoding);

export const digestFile = (algorithm, encoding, filePath) =>
  digestBytes(algorithm, encoding, readFileSync(filePath));

const objectRecord = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

const stringValue = (value) => (typeof value === 'string' ? value : undefined);

const normalizeArchivePath = (value) => value.replaceAll('\\', '/').replace(/^\/+/, '');

const findNamedFiles = (directory, expectedName) => {
  if (!existsSync(directory)) return [];
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findNamedFiles(entryPath, expectedName));
    } else if (entry.isFile() && entry.name.toLowerCase() === expectedName.toLowerCase()) {
      matches.push(entryPath);
    }
  }
  return matches;
};

const archiveEntries = (archive, appAsarPath) =>
  archive.listPackage(appAsarPath).map((rawPath) => ({
    normalizedPath: normalizeArchivePath(rawPath),
    rawPath: rawPath.replace(/^[\\/]+/u, ''),
  }));

const archiveFilesMatching = (entries, predicate) =>
  entries.filter(({ normalizedPath }) => predicate(normalizedPath));

const validSourceIdentity = (value) =>
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value?.gitHead) &&
  /^[0-9a-f]{64}$/u.test(value?.packageLockSha256) &&
  typeof value?.treeClean === 'boolean';

const parsePackagedSourceIdentity = (bytes) => {
  const document = objectRecord(JSON.parse(bytes.toString('utf8')));
  if (!document) throw new Error('document root must be an object');
  const expectedKeys = ['gitHead', 'packageLockSha256', 'schemaVersion', 'treeClean'];
  const actualKeys = Object.keys(document).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`document must contain only ${expectedKeys.join(', ')}`);
  }
  if (document.schemaVersion !== 1) throw new Error('schemaVersion must equal 1');
  if (!validSourceIdentity(document)) {
    throw new Error('Git HEAD, package-lock.json SHA-256, or clean-tree fact is invalid');
  }
  return {
    gitHead: document.gitHead,
    packageLockSha256: document.packageLockSha256,
    treeClean: document.treeClean,
  };
};

const inspectPackagedUpdater = ({ appUpdatePath, packageManifest, problems }) => {
  if (!existsSync(appUpdatePath)) {
    problems.push('missing packaged updater configuration: win-unpacked/resources/app-update.yml');
    return;
  }
  try {
    const packagedUpdater = objectRecord(parseYaml(readFileSync(appUpdatePath, 'utf8')));
    if (!packagedUpdater) throw new Error('document root must be an object');
    let packagedFeed;
    try {
      packagedFeed = validateGenericFeed({ build: { publish: packagedUpdater } });
    } catch (error) {
      problems.push(`packaged app-update.yml is invalid: ${messageOf(error)}`);
    }
    let intendedFeed;
    try {
      intendedFeed = validateGenericFeed(packageManifest);
    } catch {
      intendedFeed = undefined;
    }
    let observedFeedUrl;
    if (typeof packagedUpdater.url === 'string') {
      try {
        observedFeedUrl = new URL(packagedUpdater.url).toString();
      } catch {
        observedFeedUrl = undefined;
      }
    }
    if (observedFeedUrl && intendedFeed && observedFeedUrl !== intendedFeed.feedUrl) {
      problems.push(
        `packaged app-update.yml feed ${observedFeedUrl} != intended feed ${intendedFeed.feedUrl}`,
      );
    } else if (packagedFeed && intendedFeed && packagedFeed.feedUrl !== intendedFeed.feedUrl) {
      problems.push(
        `packaged app-update.yml feed ${packagedFeed.feedUrl} != intended feed ${intendedFeed.feedUrl}`,
      );
    }
    try {
      const intendedChannel = resolveReleaseChannel(packageManifest);
      if (packagedUpdater.channel !== intendedChannel) {
        problems.push(
          `packaged app-update.yml channel ${String(packagedUpdater.channel)} != intended channel ${intendedChannel}`,
        );
      }
    } catch {
      // The top-level release validation reports an invalid intended channel separately.
    }
  } catch (error) {
    problems.push(`packaged app-update.yml cannot be parsed: ${messageOf(error)}`);
  }
};

export const inspectPackagedApplication = ({
  archive = defaultArchiveReader,
  expectedSourceIdentity,
  extractInstaller,
  installerPath,
  packageManifest,
  projectRoot = defaultProjectRoot,
  releaseDirectory = path.join(projectRoot, 'outputs'),
  temporaryRoot,
} = {}) => {
  const problems = [];
  const winUnpackedPath = path.join(releaseDirectory, 'win-unpacked');
  const resourcesPath = path.join(winUnpackedPath, 'resources');
  const appAsarPath = path.join(resourcesPath, 'app.asar');
  const appUpdatePath = path.join(resourcesPath, 'app-update.yml');
  let entries = [];
  let installerPayloadEvidence;
  let packagedSourceIdentity;

  if (!existsSync(appAsarPath)) {
    problems.push('missing packaged application: win-unpacked/resources/app.asar');
  } else {
    try {
      entries = archiveEntries(archive, appAsarPath);
    } catch (error) {
      problems.push(`packaged app.asar cannot be listed: ${messageOf(error)}`);
    }
  }

  const entriesByPath = new Map();
  for (const entry of entries) {
    const candidates = entriesByPath.get(entry.normalizedPath) ?? [];
    candidates.push(entry);
    entriesByPath.set(entry.normalizedPath, candidates);
  }
  const readPackagedFile = (archivePath) => {
    const candidates = entriesByPath.get(archivePath) ?? [];
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length === 0
          ? `missing root ${archivePath}`
          : `multiple archive entries resolve to ${archivePath}`,
      );
    }
    return archive.extractFile(appAsarPath, candidates[0].rawPath);
  };

  if (entries.length > 0) {
    try {
      packagedSourceIdentity = parsePackagedSourceIdentity(
        readPackagedFile(packagedSourceIdentityArchivePath),
      );
    } catch (error) {
      problems.push(`packaged source identity is invalid: ${messageOf(error)}`);
    }
    if (packagedSourceIdentity) {
      if (!validSourceIdentity(expectedSourceIdentity)) {
        problems.push(
          'packaged source identity cannot be compared because expected source identity is invalid',
        );
      } else {
        const mismatches = [];
        if (packagedSourceIdentity.gitHead !== expectedSourceIdentity.gitHead) {
          mismatches.push('Git HEAD');
        }
        if (packagedSourceIdentity.packageLockSha256 !== expectedSourceIdentity.packageLockSha256) {
          mismatches.push('package-lock.json SHA-256');
        }
        if (packagedSourceIdentity.treeClean !== expectedSourceIdentity.treeClean) {
          mismatches.push('clean-tree fact');
        }
        if (mismatches.length > 0) {
          problems.push(
            `packaged source identity ${mismatches.join(', ')} differs from expected source identity`,
          );
        }
      }
    }

    try {
      const packagedManifest = JSON.parse(readPackagedFile('package.json').toString('utf8'));
      if (packagedManifest.version !== packageManifest.version) {
        problems.push(
          `packaged app version ${String(packagedManifest.version)} != package version ${packageManifest.version}`,
        );
      }
    } catch (error) {
      problems.push(`packaged package.json is invalid: ${messageOf(error)}`);
    }

    for (const legalFileName of ['LICENSE', 'NOTICE']) {
      try {
        if (readPackagedFile(legalFileName).byteLength === 0) {
          problems.push(`packaged root ${legalFileName} is empty`);
        }
      } catch (error) {
        problems.push(`packaged root ${legalFileName} is invalid: ${messageOf(error)}`);
      }
    }

    const emittedSvgEntries = archiveFilesMatching(entries, (archivePath) =>
      /^dist\/renderer\/assets\/[^/]+\.svg$/u.test(archivePath),
    );
    if (emittedSvgEntries.length !== expectedBrandAssetNames.length) {
      problems.push(
        `packaged renderer assets must contain exactly ${expectedBrandAssetNames.length} SVG files; found ${emittedSvgEntries.length}`,
      );
    }
    for (const sourceName of expectedBrandAssetNames) {
      const extension = path.extname(sourceName);
      const stem = path.basename(sourceName, extension);
      const emittedPattern = new RegExp(
        `^dist/renderer/assets/${stem}-[0-9A-Za-z_-]+\\${extension}$`,
        'u',
      );
      const matches = emittedSvgEntries.filter(({ normalizedPath }) =>
        emittedPattern.test(normalizedPath),
      );
      if (matches.length !== 1) {
        problems.push(
          `packaged brand ${sourceName} must have exactly one emitted SVG; found ${matches.length}`,
        );
        continue;
      }
      const sourcePath = path.join(projectRoot, 'src', 'renderer', 'assets', 'brands', sourceName);
      try {
        const sourceBytes = readFileSync(sourcePath);
        const packagedBytes = archive.extractFile(appAsarPath, matches[0].rawPath);
        if (!sourceBytes.equals(packagedBytes)) {
          problems.push(
            `packaged brand ${matches[0].normalizedPath} bytes differ from ${sourceName}`,
          );
        }
      } catch (error) {
        problems.push(`packaged brand ${sourceName} cannot be compared: ${messageOf(error)}`);
      }
    }

    const bundledClaudeEntries = archiveFilesMatching(
      entries,
      (archivePath) => path.posix.basename(archivePath).toLowerCase() === 'claude.exe',
    );
    for (const entry of bundledClaudeEntries) {
      problems.push(`packaged application contains forbidden claude.exe: ${entry.normalizedPath}`);
    }
  }

  try {
    for (const filePath of findNamedFiles(winUnpackedPath, 'claude.exe')) {
      problems.push(
        `packaged application contains forbidden claude.exe: ${path.relative(winUnpackedPath, filePath)}`,
      );
    }
  } catch (error) {
    problems.push(`win-unpacked cannot be scanned for claude.exe: ${messageOf(error)}`);
  }

  inspectPackagedUpdater({ appUpdatePath, packageManifest, problems });

  if (installerPath && existsSync(installerPath)) {
    try {
      installerPayloadEvidence = inspectInstallerPayload({
        extractInstaller,
        installerPath,
        releaseDirectory,
        temporaryRoot,
      });
    } catch (error) {
      problems.push(`installer payload cannot be linked to win-unpacked: ${messageOf(error)}`);
    }
  }

  return {
    installerPayloadEvidence,
    packagedSourceIdentity,
    problems: problems.map(sanitizeManifestText),
  };
};

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
  if (feedUrl.username || feedUrl.password)
    throw new Error('update feed must not contain userinfo');
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
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const powershellExecutable = path.join(
      windowsRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const securityModulePath = path.join(
      windowsRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'Modules',
      'Microsoft.PowerShell.Security',
      'Microsoft.PowerShell.Security.psd1',
    );
    const escapedPath = filePath.replaceAll("'", "''");
    const escapedModulePath = securityModulePath.replaceAll("'", "''");
    return execFileSync(
      powershellExecutable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Import-Module -Name '${escapedModulePath}' -Force; (Get-AuthenticodeSignature -LiteralPath '${escapedPath}').Status.ToString()`,
      ],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return 'unknown';
  }
};

const inspectReleaseSource = ({ projectRoot, sourceIdentity }) => {
  const problems = [];
  const source = {
    gitHead: null,
    packageLockSha256: null,
    treeClean: false,
  };
  try {
    const identity = sourceIdentity({ projectRoot });
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(identity?.gitHead)) {
      problems.push('source identity does not contain a full Git HEAD object ID');
    } else {
      source.gitHead = identity.gitHead;
    }
    if (!/^[0-9a-f]{64}$/u.test(identity?.packageLockSha256)) {
      problems.push('source identity does not contain package-lock.json SHA-256');
    } else {
      source.packageLockSha256 = identity.packageLockSha256;
    }
    if (identity?.treeClean === true) {
      source.treeClean = true;
    } else if (identity?.treeClean === false) {
      problems.push(
        'source tree is dirty; commit or remove tracked and untracked changes before final release manifest generation',
      );
    } else {
      problems.push('source identity does not contain a clean-tree fact');
    }
  } catch (error) {
    problems.push(`source identity cannot be determined: ${messageOf(error)}`);
  }
  return { problems, source };
};

export const validateRelease = ({
  archive = defaultArchiveReader,
  expectedPackagedSourceIdentity,
  extractInstaller,
  now = new Date(),
  projectRoot = defaultProjectRoot,
  releaseDirectory = path.join(projectRoot, 'outputs'),
  signatureStatus = authenticodeStatus,
  sourceIdentity = readSourceIdentity,
  temporaryRoot,
  writeReport = true,
} = {}) => {
  const packageManifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = packageManifest.version;
  const installerName = `ClaudeDock-Setup-${version}-x64.exe`;
  const blockmapName = `${installerName}.blockmap`;
  const installerPath = path.join(releaseDirectory, installerName);
  const blockmapPath = path.join(releaseDirectory, blockmapName);
  const { problems, source } = inspectReleaseSource({ projectRoot, sourceIdentity });
  let channel = 'unknown';
  let channelManifestName = 'unknown.yml';
  let blockmapEvidence;
  let feedUrl;
  let installerPayloadEvidence;
  let packagedSourceIdentity;
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

  try {
    const inspection = inspectPackagedApplication({
      archive,
      expectedSourceIdentity: expectedPackagedSourceIdentity ?? source,
      extractInstaller,
      installerPath,
      packageManifest,
      projectRoot,
      releaseDirectory,
      temporaryRoot,
    });
    installerPayloadEvidence = inspection.installerPayloadEvidence;
    packagedSourceIdentity = inspection.packagedSourceIdentity;
    problems.push(...inspection.problems);
  } catch (error) {
    problems.push(`packaged application inspection failed: ${messageOf(error)}`);
  }

  if (!existsSync(releaseDirectory)) {
    problems.push(`missing release directory: ${releaseDirectory}`);
  }

  const shippedNames = [installerName, blockmapName, channelManifestName];
  const artifacts = [];
  let channelManifestBytes;
  for (const name of shippedNames) {
    const filePath = path.join(releaseDirectory, name);
    if (!existsSync(filePath)) {
      problems.push(`missing artifact: ${name}`);
      continue;
    }
    if (name === channelManifestName) {
      channelManifestBytes = readFileSync(filePath);
      artifacts.push({
        bytes: channelManifestBytes.byteLength,
        name,
        sha256: digestBytes('sha256', 'hex', channelManifestBytes),
        sha512: digestBytes('sha512', 'base64', channelManifestBytes),
      });
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
  if (installer && blockmap) {
    try {
      blockmapEvidence = inspectBlockmap({ blockmapPath, installerPath });
    } catch (error) {
      problems.push(`external blockmap is invalid: ${messageOf(error)}`);
    }
  }
  const updateManifestPath = path.join(releaseDirectory, channelManifestName);
  let updateManifest;
  if (installer && channelManifestBytes) {
    try {
      updateManifest = parseUpdateManifest(channelManifestBytes.toString('utf8'));
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

  let signature = 'unavailable';
  if (installer) {
    try {
      const observedStatus = signatureStatus(installerPath);
      signature = typeof observedStatus === 'string' ? observedStatus.trim() : 'unavailable';
    } catch {
      signature = 'unavailable';
    }
  }
  signature = sanitizeManifestText(signature);
  if (signature !== 'Valid' && signature !== 'NotSigned') {
    problems.push(
      `installer Authenticode status is ${signature.length > 0 ? signature : 'empty'}; expected Valid or NotSigned`,
    );
  }

  const manifest = {
    artifacts,
    channel,
    channelManifest: channelManifestName,
    cohort: {
      blockmap: blockmapEvidence ?? null,
      installerPayload: installerPayloadEvidence ?? null,
    },
    directory: releaseDirectory,
    feedUrl,
    generatedAt: now.toISOString(),
    problems: problems.map(sanitizeManifestText),
    product: packageManifest.build?.productName,
    provider,
    signature,
    source,
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
    channelManifestBytes,
    channelManifestPath: updateManifestPath,
    installer,
    manifest,
    packageManifest,
    packagedSourceIdentity,
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
  console.log(`source HEAD ${manifest.source.gitHead ?? 'unavailable'}`);
  console.log(`source tree ${manifest.source.treeClean ? 'clean' : 'dirty or unavailable'}`);
  console.log(`package-lock.json sha256 ${manifest.source.packageLockSha256 ?? 'unavailable'}`);
  for (const artifact of manifest.artifacts) {
    const megabytes = (artifact.bytes / 1024 / 1024).toFixed(2);
    console.log(`  ${artifact.name}  ${artifact.bytes} bytes (${megabytes} MB)`);
    console.log(`    sha256 ${artifact.sha256}`);
  }
  console.log(`signature ${manifest.signature}`);
  console.log(
    updateManifest
      ? `update chain inspected: ${manifest.channelManifest} -> ${sanitizeManifestText(String(updateManifest.path))} (${String(updateManifest.size)} bytes)`
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
