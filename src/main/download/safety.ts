import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DownloadJournalEntry } from './journal';
import type { DownloadRequest } from './request';

export const isPathWithinUserData = (userDataPath: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(userDataPath), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export const isAllowedUrl = (request: DownloadRequest, candidate: string | URL): boolean => {
  try {
    const url = candidate instanceof URL ? candidate : new URL(candidate);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      request.allowedHosts.some(
        (host, index) =>
          host === url.hostname &&
          url.pathname.startsWith(request.allowedPathPrefixes[index] ?? ''),
      )
    );
  } catch {
    return false;
  }
};

export const isSafePartialPath = (userDataPath: string, candidate: string): boolean =>
  isPathWithinUserData(userDataPath, candidate) && candidate.endsWith('.partial');

export const isRecoverableEntry = (userDataPath: string, entry: DownloadJournalEntry): boolean => {
  if (
    !isPathWithinUserData(userDataPath, entry.finalPath) ||
    !isSafePartialPath(userDataPath, entry.savePath) ||
    !existsSync(entry.savePath)
  ) {
    return false;
  }
  try {
    /*
     * The partial is normally AHEAD of the journal, never behind: `persistTask` is throttled to
     * one write per JOURNAL_WRITE_INTERVAL_MS and `flushJournal` only re-serializes the cached
     * entries without re-reading `getReceivedBytes()`, so even a graceful quit records a byte
     * count up to a second stale. Demanding exact equality therefore threw away a valid partial
     * on essentially every restart.
     *
     * Since downloads only ever append (see `rebindFromDisk`), the recorded offset stays a valid
     * prefix of a longer partial and `createInterruptedDownload` overwrites the surplus tail. A
     * partial SHORTER than the journal is still unrecoverable: those bytes were never written, so
     * resuming at the recorded offset would leave a hole.
     */
    return statSync(entry.savePath).size >= entry.receivedBytes;
  } catch {
    return false;
  }
};

export const verifyPartial = async (request: DownloadRequest): Promise<void> => {
  const partialPath = `${request.finalPath}.partial`;
  const actualBytes = statSync(partialPath).size;
  if (actualBytes > request.maxBytes) {
    throw new Error('下载内容超过安全上限。');
  }
  if (request.expectedBytes !== undefined && actualBytes !== request.expectedBytes) {
    throw new Error('文件字节数与发布信息不一致。');
  }
  if (request.expectedSha256) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(partialPath)) {
      hash.update(chunk);
    }
    if (hash.digest('hex') !== request.expectedSha256.toLowerCase()) {
      throw new Error('SHA-256 与发布信息不一致。');
    }
  }
};
