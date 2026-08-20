export const RELEASE_API = 'https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest';
export const MAX_RELEASE_BYTES = 2 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

interface CliProxyApiReleaseAsset {
  browser_download_url?: unknown;
  digest?: unknown;
  name?: unknown;
  size?: unknown;
}

interface CliProxyApiReleasePayload {
  assets?: unknown;
  tag_name?: unknown;
}

export interface CliProxyApiRelease {
  digest: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  version: string;
}

export const limitedResponseBody = async (
  response: Response,
  maximumBytes: number,
): Promise<Buffer> => {
  if (!response.ok) {
    throw new Error(`无法读取 CLIProxyAPI 发布信息：HTTP ${response.status}。`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error('CLIProxyAPI 发布信息超过安全大小上限。');
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maximumBytes) {
    throw new Error('CLIProxyAPI 发布信息超过安全大小上限。');
  }
  return body;
};

export const parseCliProxyApiRelease = (value: unknown): CliProxyApiRelease => {
  if (!value || typeof value !== 'object') {
    throw new Error('CLIProxyAPI 发布信息格式无效。');
  }
  const release = value as CliProxyApiReleasePayload;
  if (typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('CLIProxyAPI 发布版本格式无效。');
  }
  const version = release.tag_name.slice(1);
  const expectedName = `CLIProxyAPI_${version}_windows_amd64.zip`;
  const asset = Array.isArray(release.assets)
    ? release.assets.find(
        (candidate): candidate is CliProxyApiReleaseAsset =>
          Boolean(candidate) &&
          typeof candidate === 'object' &&
          (candidate as CliProxyApiReleaseAsset).name === expectedName,
      )
    : undefined;
  if (
    !asset ||
    typeof asset.browser_download_url !== 'string' ||
    typeof asset.digest !== 'string' ||
    typeof asset.size !== 'number'
  ) {
    throw new Error('CLIProxyAPI 最新发布缺少可验证的 Windows x64 压缩包。');
  }
  const url = new URL(asset.browser_download_url);
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1]?.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.pathname !==
      `/router-for-me/CLIProxyAPI/releases/download/${release.tag_name}/${expectedName}` ||
    !digest ||
    !Number.isInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > MAX_ARCHIVE_BYTES
  ) {
    throw new Error('CLIProxyAPI 压缩包未通过来源、版本、大小或 SHA-256 元数据检查。');
  }
  return {
    digest,
    downloadUrl: asset.browser_download_url,
    fileName: expectedName,
    size: asset.size,
    version,
  };
};

export const archiveEntriesAreSafe = (entries: string[]): boolean =>
  entries.length > 0 &&
  entries.length <= 500 &&
  entries.every((entry) => {
    const normalized = entry.trim().replaceAll('\\', '/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      return false;
    }
    const segments = normalized.split('/').filter(Boolean);
    return segments.length > 0 && !segments.includes('..');
  });
