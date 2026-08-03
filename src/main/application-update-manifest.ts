import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const RELEASE_MANIFEST_FILE_NAME = 'release-manifest.json';
export const RELEASE_MANIFEST_SIGNATURE_FILE_NAME = 'release-manifest.sig';
export const RELEASE_MANIFEST_KEY_ID = 'f724eb3fcaa7f4c5';
export const RELEASE_MANIFEST_LIMIT_BYTES = 64 * 1024;
export const RELEASE_SIGNATURE_LIMIT_BYTES = 256;
export const RELEASE_SAMPLE_BYTES = 256 * 1024;
export const GITHUB_RELEASE_ROOT =
  'https://github.com/AeonusOvO/claude-dock-control-panel/releases/download/';
export const CHINA_MIRROR_BASE_URL = 'https://124.221.158.247/claudedock/windows/x64/';

export interface ReleaseManifestFile {
  name: string;
  sampleSha512?: string;
  sampleSize?: number;
  sha512: string;
  size: number;
}

export interface TrustedReleaseManifest {
  channel: 'stable';
  files: ReleaseManifestFile[];
  keyId: string;
  publishedAt: string;
  schemaVersion: 1;
  sources: {
    github: string;
    mirror: string;
  };
  version: string;
}

interface StoredUpdateFloor {
  highestTrustedVersion?: unknown;
  schemaVersion?: unknown;
}

interface ParsedSemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const PUBLISHED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isCanonicalSha512 = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength === 64 && decoded.toString('base64') === value;
};

const parseSemanticVersion = (value: string): ParsedSemanticVersion | undefined => {
  const match = SEMANTIC_VERSION_PATTERN.exec(value);
  if (!match) return undefined;
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part) || part < 0)) return undefined;
  if (match[4]?.split('.').some((part) => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))) {
    return undefined;
  }
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  if (
    prerelease.some((part) => typeof part === 'number' && (!Number.isSafeInteger(part) || part < 0))
  ) {
    return undefined;
  }
  return {
    major: core[0]!,
    minor: core[1]!,
    patch: core[2]!,
    prerelease,
  };
};

export const compareApplicationVersions = (left: string, right: string): number => {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);
  if (!leftVersion || !rightVersion) {
    throw new Error('更新版本号不是有效的 SemVer。');
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    const difference = leftVersion[key] - rightVersion[key];
    if (difference !== 0) return difference;
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) return 0;
  if (leftVersion.prerelease.length === 0) return 1;
  if (rightVersion.prerelease.length === 0) return -1;
  const count = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === 'number' && typeof rightPart === 'number') {
      return leftPart - rightPart;
    }
    if (typeof leftPart === 'number') return -1;
    if (typeof rightPart === 'number') return 1;
    return leftPart.localeCompare(rightPart, 'en');
  }
  return 0;
};

const parseManifestFile = (value: unknown): ReleaseManifestFile | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.name !== 'string' ||
    !FILE_NAME_PATTERN.test(value.name) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) <= 0 ||
    (value.size as number) > 2 * 1024 * 1024 * 1024 ||
    !isCanonicalSha512(value.sha512)
  ) {
    return undefined;
  }
  const hasSampleSize = value.sampleSize !== undefined;
  const hasSampleSha512 = value.sampleSha512 !== undefined;
  if (hasSampleSize !== hasSampleSha512) return undefined;
  if (
    hasSampleSize &&
    (!Number.isSafeInteger(value.sampleSize) ||
      (value.sampleSize as number) <= 0 ||
      (value.sampleSize as number) > RELEASE_SAMPLE_BYTES ||
      (value.sampleSize as number) > (value.size as number) ||
      !isCanonicalSha512(value.sampleSha512))
  ) {
    return undefined;
  }
  return {
    name: value.name,
    sampleSha512: hasSampleSha512 ? (value.sampleSha512 as string) : undefined,
    sampleSize: hasSampleSize ? (value.sampleSize as number) : undefined,
    sha512: value.sha512,
    size: value.size as number,
  };
};

const parseManifest = (value: unknown): TrustedReleaseManifest | undefined => {
  if (!isRecord(value) || !STABLE_VERSION_PATTERN.test(String(value.version ?? ''))) {
    return undefined;
  }
  const version = value.version as string;
  if (
    value.schemaVersion !== 1 ||
    value.channel !== 'stable' ||
    value.keyId !== RELEASE_MANIFEST_KEY_ID ||
    typeof value.publishedAt !== 'string' ||
    !PUBLISHED_AT_PATTERN.test(value.publishedAt) ||
    Number.isNaN(Date.parse(value.publishedAt)) ||
    !isRecord(value.sources) ||
    value.sources.github !== GITHUB_RELEASE_ROOT + 'v' + version + '/' ||
    value.sources.mirror !== CHINA_MIRROR_BASE_URL ||
    Object.keys(value.sources).sort().join(',') !== 'github,mirror' ||
    !Array.isArray(value.files) ||
    value.files.length < 3 ||
    value.files.length > 16
  ) {
    return undefined;
  }
  const files = value.files
    .map(parseManifestFile)
    .filter((file): file is ReleaseManifestFile => Boolean(file));
  if (
    files.length !== value.files.length ||
    new Set(files.map((file) => file.name)).size !== files.length
  ) {
    return undefined;
  }
  const installerName = 'ClaudeDock-Setup-' + version + '-x64.exe';
  const installer = files.find((file) => file.name === installerName);
  const blockmap = files.find((file) => file.name === installerName + '.blockmap');
  const metadata = files.find((file) => file.name === 'latest.yml');
  if (
    !installer ||
    !blockmap ||
    !metadata ||
    installer.sampleSize !== Math.min(RELEASE_SAMPLE_BYTES, installer.size) ||
    !installer.sampleSha512 ||
    blockmap.sampleSize !== undefined ||
    metadata.sampleSize !== undefined ||
    metadata.size > RELEASE_MANIFEST_LIMIT_BYTES ||
    blockmap.size > 32 * 1024 * 1024
  ) {
    return undefined;
  }
  return {
    channel: 'stable',
    files,
    keyId: RELEASE_MANIFEST_KEY_ID,
    publishedAt: value.publishedAt,
    schemaVersion: 1,
    sources: {
      github: value.sources.github as string,
      mirror: value.sources.mirror as string,
    },
    version,
  };
};

export const verifyReleaseManifest = (
  manifestBytes: Uint8Array,
  signatureText: string,
  publicKeyPem: string,
): TrustedReleaseManifest => {
  if (manifestBytes.byteLength === 0 || manifestBytes.byteLength > RELEASE_MANIFEST_LIMIT_BYTES) {
    throw new Error('发布清单为空或超过 64 KiB 安全上限。');
  }
  if (
    Buffer.byteLength(signatureText, 'utf8') > RELEASE_SIGNATURE_LIMIT_BYTES ||
    !/^[A-Za-z0-9+/]{86}==\s?$/.test(signatureText)
  ) {
    throw new Error('发布清单签名格式无效。');
  }
  const signature = Buffer.from(signatureText.trim(), 'base64');
  let verified: boolean;
  try {
    verified = verifySignature(
      null,
      Buffer.from(manifestBytes),
      createPublicKey(publicKeyPem),
      signature,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new Error('发布清单 Ed25519 签名验证失败。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error('发布清单不是有效的 UTF-8 JSON。');
  }
  const manifest = parseManifest(parsed);
  if (!manifest) {
    throw new Error('发布清单结构、固定来源或文件摘要无效。');
  }
  return manifest;
};

export const releaseManifestFile = (
  manifest: TrustedReleaseManifest,
  name: string,
): ReleaseManifestFile => {
  const file = manifest.files.find((entry) => entry.name === name);
  if (!file) throw new Error('发布清单缺少文件：' + name);
  return file;
};

export const releaseInstallerFile = (manifest: TrustedReleaseManifest): ReleaseManifestFile =>
  releaseManifestFile(manifest, 'ClaudeDock-Setup-' + manifest.version + '-x64.exe');

export const assertReleaseVersionFloor = (
  version: string,
  currentVersion: string,
  highestTrustedVersion?: string,
): void => {
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error('发布清单只能声明稳定 SemVer 版本。');
  }
  if (compareApplicationVersions(version, currentVersion) < 0) {
    throw new Error('拒绝低于当前安装版本 ' + currentVersion + ' 的更新。');
  }
  if (highestTrustedVersion && compareApplicationVersions(version, highestTrustedVersion) < 0) {
    throw new Error('拒绝低于已验证版本 ' + highestTrustedVersion + ' 的更新。');
  }
};

export const updateVersionFloorPath = (userDataPath: string): string =>
  path.join(userDataPath, 'update-security', 'version-floor.json');

export const readHighestTrustedVersion = (filePath: string): string | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as StoredUpdateFloor;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.highestTrustedVersion !== 'string' ||
      !STABLE_VERSION_PATTERN.test(parsed.highestTrustedVersion)
    ) {
      return undefined;
    }
    return parsed.highestTrustedVersion;
  } catch {
    return undefined;
  }
};

export const recordHighestTrustedVersion = (filePath: string, version: string): void => {
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error('不能记录非稳定版更新下限。');
  }
  const existing = readHighestTrustedVersion(filePath);
  if (existing && compareApplicationVersions(version, existing) <= 0) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = filePath + '.tmp-' + process.pid.toString() + '-' + Date.now().toString();
  writeFileSync(
    temporaryPath,
    JSON.stringify({ highestTrustedVersion: version, schemaVersion: 1 }, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  renameSync(temporaryPath, filePath);
};

export const sha512File = async (filePath: string): Promise<string> => {
  const hash = createHash('sha512');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('base64');
};

export const verifyDownloadedReleaseFile = async (
  filePath: string,
  expected: ReleaseManifestFile,
): Promise<void> => {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    throw new Error('下载器没有返回可读取的安装包。');
  }
  if (size !== expected.size) {
    throw new Error(
      '安装包大小不符：期望 ' + expected.size.toString() + '，实际 ' + size.toString() + '。',
    );
  }
  const digest = await sha512File(filePath);
  if (digest !== expected.sha512) {
    throw new Error('安装包 SHA-512 与签名发布清单不一致。');
  }
};
