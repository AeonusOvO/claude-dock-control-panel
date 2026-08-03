import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertReleaseVersionFloor,
  CHINA_MIRROR_BASE_URL,
  GITHUB_RELEASE_ROOT,
  RELEASE_MANIFEST_FILE_NAME,
  RELEASE_MANIFEST_LIMIT_BYTES,
  RELEASE_MANIFEST_SIGNATURE_FILE_NAME,
  RELEASE_SIGNATURE_LIMIT_BYTES,
  releaseInstallerFile,
  releaseManifestFile,
  type ReleaseManifestFile,
  type TrustedReleaseManifest,
  verifyDownloadedReleaseFile,
  verifyReleaseManifest,
} from './application-update-manifest';

export type ApplicationUpdateFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApplicationUpdateSource {
  allowedHosts: string[];
  baseUrl?: string;
  id: 'github' | 'mirror';
  label: string;
  owner?: string;
  provider: 'generic' | 'github';
  repo?: string;
}

export interface ApplicationUpdateSourceSelection {
  allowedHosts: string[];
  expectedInstaller: ReleaseManifestFile;
  feed: Record<string, unknown>;
  id: ApplicationUpdateSource['id'];
  label: string;
  manifestDigest: string;
  releaseBaseUrl: string;
  releaseVersion: string;
  sourceDiagnostics: string[];
  throughputBps?: number;
}

interface UpdateMetadata {
  artifactPath: string;
  sha512: string;
  version: string;
}

interface StoredSourceConfiguration {
  sources?: unknown;
  version?: unknown;
}

interface TrustedCandidate {
  manifest: TrustedReleaseManifest;
  manifestDigest: string;
  source: ApplicationUpdateSource;
}

interface CandidateResult {
  candidate?: TrustedCandidate;
  diagnostic: string;
  source: ApplicationUpdateSource;
}

interface SelectApplicationUpdateSourceOptions {
  currentVersion: string;
  highestTrustedVersion?: string;
  publicKeyPem: string;
}

const METADATA_LIMIT_BYTES = 64 * 1024;
const SAMPLE_REQUEST_TIMEOUT_MS = 8_000;
const RESOURCE_REQUEST_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const GITHUB_REPOSITORY_PATH = '/AeonusOvO/claude-dock-control-panel/releases/';
const GITHUB_ALLOWED_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

export const DEFAULT_GITHUB_UPDATE_SOURCE: ApplicationUpdateSource = {
  allowedHosts: GITHUB_ALLOWED_HOSTS,
  id: 'github',
  label: 'GitHub 官方发布',
  owner: 'AeonusOvO',
  provider: 'github',
  repo: 'claude-dock-control-panel',
};

export const DEFAULT_CHINA_MIRROR_UPDATE_SOURCE: ApplicationUpdateSource = {
  allowedHosts: ['124.221.158.247'],
  baseUrl: CHINA_MIRROR_BASE_URL,
  id: 'mirror',
  label: '中国大陆 HTTPS 兜底镜像',
  provider: 'generic',
};

const DEFAULT_UPDATE_SOURCES = [DEFAULT_GITHUB_UPDATE_SOURCE, DEFAULT_CHINA_MIRROR_UPDATE_SOURCE];

const normalizedUrl = (value: unknown): URL | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== '443')
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
};

const parseSource = (value: unknown): ApplicationUpdateSource | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.id === 'github' &&
    record.provider === 'github' &&
    record.owner === 'AeonusOvO' &&
    record.repo === 'claude-dock-control-panel'
  ) {
    return DEFAULT_GITHUB_UPDATE_SOURCE;
  }
  const mirrorUrl = normalizedUrl(record.baseUrl);
  if (
    record.id !== 'mirror' ||
    record.provider !== 'generic' ||
    mirrorUrl?.toString() !== CHINA_MIRROR_BASE_URL ||
    mirrorUrl.hostname !== '124.221.158.247' ||
    !Array.isArray(record.allowedHosts) ||
    record.allowedHosts.length !== 1 ||
    record.allowedHosts[0] !== '124.221.158.247'
  ) {
    return undefined;
  }
  return DEFAULT_CHINA_MIRROR_UPDATE_SOURCE;
};

export const loadApplicationUpdateSources = (filePath: string): ApplicationUpdateSource[] => {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as StoredSourceConfiguration;
    if (parsed.version !== 2 || !Array.isArray(parsed.sources)) {
      return DEFAULT_UPDATE_SOURCES;
    }
    const sources = parsed.sources
      .map(parseSource)
      .filter((source): source is ApplicationUpdateSource => Boolean(source));
    if (sources.length !== 2 || sources[0]?.id !== 'github' || sources[1]?.id !== 'mirror') {
      return DEFAULT_UPDATE_SOURCES;
    }
    return sources;
  } catch {
    return DEFAULT_UPDATE_SOURCES;
  }
};

const sourceStableUrl = (source: ApplicationUpdateSource, fileName: string): string =>
  source.provider === 'github'
    ? 'https://github.com/AeonusOvO/claude-dock-control-panel/releases/latest/download/' +
      encodeURIComponent(fileName)
    : new URL(fileName, source.baseUrl).toString();

const sourceReleaseBaseUrl = (
  source: ApplicationUpdateSource,
  manifest: TrustedReleaseManifest,
): string => (source.id === 'github' ? manifest.sources.github : manifest.sources.mirror);

const sourceReleaseUrl = (
  source: ApplicationUpdateSource,
  manifest: TrustedReleaseManifest,
  fileName: string,
): string =>
  new URL(encodeURIComponent(fileName), sourceReleaseBaseUrl(source, manifest)).toString();

const urlAllowedForSource = (source: ApplicationUpdateSource, value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !source.allowedHosts.includes(url.hostname)
  ) {
    return false;
  }
  if (source.id === 'mirror') {
    return (
      url.hostname === '124.221.158.247' &&
      !url.search &&
      url.pathname.startsWith('/claudedock/windows/x64/')
    );
  }
  if (url.hostname === 'github.com') {
    return !url.search && url.pathname.startsWith(GITHUB_REPOSITORY_PATH);
  }
  return (
    (url.hostname === 'objects.githubusercontent.com' ||
      url.hostname === 'release-assets.githubusercontent.com') &&
    url.pathname.length > 1
  );
};

export const isApplicationUpdateRequestAllowed = (
  selection: ApplicationUpdateSourceSelection,
  value: string,
): boolean => {
  const source =
    selection.id === 'github' ? DEFAULT_GITHUB_UPDATE_SOURCE : DEFAULT_CHINA_MIRROR_UPDATE_SOURCE;
  if (
    selection.releaseBaseUrl !==
    (source.id === 'github'
      ? GITHUB_RELEASE_ROOT + 'v' + selection.releaseVersion + '/'
      : CHINA_MIRROR_BASE_URL)
  ) {
    return false;
  }
  return urlAllowedForSource(source, value);
};

const strictFetch = async (
  source: ApplicationUpdateSource,
  initialUrl: string,
  fetchImpl: ApplicationUpdateFetch,
  init: RequestInit,
): Promise<Response> => {
  let requestUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (!urlAllowedForSource(source, requestUrl)) {
      throw new Error('请求 URL 超出固定更新主机范围。');
    }
    const response = await fetchImpl(requestUrl, {
      ...init,
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(RESOURCE_REQUEST_TIMEOUT_MS),
    });
    if (!REDIRECT_STATUS.has(response.status)) {
      const responseUrl = response.url || requestUrl;
      if (!urlAllowedForSource(source, responseUrl)) {
        throw new Error('更新响应跳转到了未授权主机。');
      }
      return response;
    }
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error('更新响应重定向次数超过安全上限。');
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('更新响应缺少重定向目标。');
    requestUrl = new URL(location, requestUrl).toString();
  }
  throw new Error('更新响应重定向次数超过安全上限。');
};

const readBoundedBody = async (response: Response, limit: number): Promise<Uint8Array> => {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) <= 0 || Number(declaredLength) > limit)
  ) {
    throw new Error('更新响应 Content-Length 无效或超过安全上限。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('更新响应没有可读取的正文。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length <= limit) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value) {
        chunks.push(chunk.value);
        length += chunk.value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (length === 0 || length > limit || (declaredLength && Number(declaredLength) !== length)) {
    throw new Error('更新响应长度与 Content-Length 不一致。');
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const fetchBytes = async (
  source: ApplicationUpdateSource,
  url: string,
  fetchImpl: ApplicationUpdateFetch,
  limit: number,
): Promise<Uint8Array> => {
  const response = await strictFetch(source, url, fetchImpl, {
    cache: 'no-store',
    headers: { accept: 'application/octet-stream' },
  });
  if (!response.ok) throw new Error('更新端点返回 HTTP ' + response.status.toString() + '。');
  return readBoundedBody(response, limit);
};

const sha512Bytes = (bytes: Uint8Array): string =>
  createHash('sha512').update(bytes).digest('base64');

const parseMetadata = (text: string): UpdateMetadata | undefined => {
  const version = /^version:\s*['"]?([^\s'"]+)['"]?\s*$/m.exec(text)?.[1];
  const artifactPath = /^path:\s*['"]?([^\r\n'"]+)['"]?\s*$/m.exec(text)?.[1]?.trim();
  const sha512 = /^sha512:\s*([A-Za-z0-9+/=]{40,})\s*$/m.exec(text)?.[1];
  if (
    !version ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    !artifactPath ||
    artifactPath.startsWith('/') ||
    artifactPath.includes('..') ||
    artifactPath.includes('\\') ||
    !sha512
  ) {
    return undefined;
  }
  return { artifactPath, sha512, version };
};

const loadTrustedCandidate = async (
  source: ApplicationUpdateSource,
  fetchImpl: ApplicationUpdateFetch,
  options: SelectApplicationUpdateSourceOptions,
): Promise<CandidateResult> => {
  try {
    const [manifestBytes, signatureBytes] = await Promise.all([
      fetchBytes(
        source,
        sourceStableUrl(source, RELEASE_MANIFEST_FILE_NAME),
        fetchImpl,
        RELEASE_MANIFEST_LIMIT_BYTES,
      ),
      fetchBytes(
        source,
        sourceStableUrl(source, RELEASE_MANIFEST_SIGNATURE_FILE_NAME),
        fetchImpl,
        RELEASE_SIGNATURE_LIMIT_BYTES,
      ),
    ]);
    const signatureText = new TextDecoder('utf-8', { fatal: true }).decode(signatureBytes);
    const manifest = verifyReleaseManifest(manifestBytes, signatureText, options.publicKeyPem);
    assertReleaseVersionFloor(
      manifest.version,
      options.currentVersion,
      options.highestTrustedVersion,
    );
    const metadataFile = releaseManifestFile(manifest, 'latest.yml');
    const metadataBytes = await fetchBytes(
      source,
      sourceReleaseUrl(source, manifest, metadataFile.name),
      fetchImpl,
      METADATA_LIMIT_BYTES,
    );
    if (
      metadataBytes.byteLength !== metadataFile.size ||
      sha512Bytes(metadataBytes) !== metadataFile.sha512
    ) {
      throw new Error('latest.yml 与签名发布清单不一致。');
    }
    const metadata = parseMetadata(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes));
    const installer = releaseInstallerFile(manifest);
    if (
      !metadata ||
      metadata.version !== manifest.version ||
      metadata.artifactPath !== installer.name ||
      metadata.sha512 !== installer.sha512
    ) {
      throw new Error('latest.yml 声明的版本或安装包摘要无效。');
    }
    return {
      candidate: {
        manifest,
        manifestDigest: sha512Bytes(manifestBytes),
        source,
      },
      diagnostic: source.label + '：签名清单和 latest.yml 已验证。',
      source,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知验证错误。';
    return {
      diagnostic: source.label + '：' + message,
      source,
    };
  }
};

const sampleArtifact = async (
  candidate: TrustedCandidate,
  fetchImpl: ApplicationUpdateFetch,
): Promise<number | undefined> => {
  const installer = releaseInstallerFile(candidate.manifest);
  const sampleSize = installer.sampleSize;
  if (!sampleSize || !installer.sampleSha512) return undefined;
  const url = sourceReleaseUrl(candidate.source, candidate.manifest, installer.name);
  const startedAt = Date.now();
  try {
    const response = await strictFetch(candidate.source, url, fetchImpl, {
      cache: 'no-store',
      headers: { range: 'bytes=0-' + (sampleSize - 1).toString() },
      signal: AbortSignal.timeout(SAMPLE_REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 206) return undefined;
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    if (
      contentLength !== sampleSize.toString() ||
      contentRange !== 'bytes 0-' + (sampleSize - 1).toString() + '/' + installer.size.toString()
    ) {
      return undefined;
    }
    const bytes = await readBoundedBody(response, sampleSize);
    if (bytes.byteLength !== sampleSize || sha512Bytes(bytes) !== installer.sampleSha512) {
      return undefined;
    }
    return Math.round((sampleSize * 1_000) / Math.max(Date.now() - startedAt, 1));
  } catch {
    return undefined;
  }
};

export const selectApplicationUpdateSource = async (
  sources: ApplicationUpdateSource[],
  fetchImpl: ApplicationUpdateFetch,
  options: SelectApplicationUpdateSourceOptions,
): Promise<ApplicationUpdateSourceSelection> => {
  const results = await Promise.all(
    sources.map((source) => loadTrustedCandidate(source, fetchImpl, options)),
  );
  const candidates = results.flatMap((result) => (result.candidate ? [result.candidate] : []));
  const diagnostics = results.map((result) => result.diagnostic);
  if (candidates.length === 0) {
    throw new Error('所有更新源验证失败：' + diagnostics.join('；'));
  }
  if (new Set(candidates.map((candidate) => candidate.manifestDigest)).size !== 1) {
    throw new Error('GitHub 与镜像的签名发布清单不一致，已阻止更新。');
  }
  const defaultCandidate = candidates[0];
  if (!defaultCandidate) {
    throw new Error('所有更新源均未返回可用的签名发布清单。');
  }
  const measurements = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      throughputBps: await sampleArtifact(candidate, fetchImpl),
    })),
  );
  const selectedMeasurement = measurements
    .filter(
      (
        item,
      ): item is {
        candidate: TrustedCandidate;
        throughputBps: number;
      } => typeof item.throughputBps === 'number',
    )
    .sort((left, right) => right.throughputBps - left.throughputBps)[0];
  const selectedCandidate = selectedMeasurement?.candidate ?? defaultCandidate;
  const releaseBaseUrl = sourceReleaseBaseUrl(selectedCandidate.source, selectedCandidate.manifest);
  return {
    allowedHosts: selectedCandidate.source.allowedHosts,
    expectedInstaller: releaseInstallerFile(selectedCandidate.manifest),
    feed: { provider: 'generic', url: releaseBaseUrl },
    id: selectedCandidate.source.id,
    label: selectedCandidate.source.label,
    manifestDigest: selectedCandidate.manifestDigest,
    releaseBaseUrl,
    releaseVersion: selectedCandidate.manifest.version,
    sourceDiagnostics: diagnostics,
    throughputBps: selectedMeasurement?.throughputBps,
  };
};

export const verifyDownloadedApplicationUpdate = async (
  downloadedPaths: string[],
  selection: ApplicationUpdateSourceSelection,
): Promise<void> => {
  const installerPath = downloadedPaths.find(
    (candidate) => path.basename(candidate) === selection.expectedInstaller.name,
  );
  if (!installerPath) {
    throw new Error('下载器未返回签名发布清单指定的安装包。');
  }
  await verifyDownloadedReleaseFile(installerPath, selection.expectedInstaller);
};
