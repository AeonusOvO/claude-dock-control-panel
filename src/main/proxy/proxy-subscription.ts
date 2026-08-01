import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyImportPreview } from '../../shared/contracts';
import type { DownloadEngine } from '../download-engine';
import { parseProxyImportText } from './proxy-parser';

const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;

export const downloadProxySubscription = async (
  engine: DownloadEngine,
  userDataPath: string,
  urlValue: string,
): Promise<ProxyImportPreview> => {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('订阅地址必须是无内嵌凭据的 HTTPS URL。');
  }
  const id = `proxy-subscription-${randomUUID()}`;
  const finalPath = path.join(userDataPath, 'proxy', 'subscriptions', `${id}.txt`);
  await engine.start({
    allowedHosts: [url.hostname],
    allowedPathPrefixes: [url.pathname],
    finalPath,
    id,
    label: '下载代理订阅',
    maxBytes: MAX_SUBSCRIPTION_BYTES,
    url: url.toString(),
  });
  try {
    return parseProxyImportText(readFileSync(finalPath, 'utf8'));
  } finally {
    try {
      unlinkSync(finalPath);
    } catch {
      // A failed cleanup leaves only the encrypted-user-data-scoped subscription cache.
    }
  }
};
