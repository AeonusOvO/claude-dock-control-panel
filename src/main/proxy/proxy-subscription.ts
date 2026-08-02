import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
  const downloadId = `proxy-subscription-${randomUUID()}`;
  const subscriptionId = `subscription-${createHash('sha256').update(url.toString()).digest('hex').slice(0, 24)}`;
  const finalPath = path.join(userDataPath, 'proxy', 'subscriptions', `${downloadId}.txt`);
  await engine.start({
    allowedHosts: [url.hostname],
    allowedPathPrefixes: [url.pathname],
    finalPath,
    id: downloadId,
    label: '下载代理订阅',
    maxBytes: MAX_SUBSCRIPTION_BYTES,
    url: url.toString(),
  });
  try {
    return {
      ...parseProxyImportText(readFileSync(finalPath, 'utf8')),
      subscription: {
        id: subscriptionId,
        label: url.hostname,
        url: url.toString(),
      },
    };
  } finally {
    try {
      unlinkSync(finalPath);
    } catch {
      // A failed cleanup leaves only the encrypted-user-data-scoped subscription cache.
    }
  }
};
