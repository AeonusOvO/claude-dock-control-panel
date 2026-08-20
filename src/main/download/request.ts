import type { DownloadItem, Event } from 'electron';
import type { DownloadTaskView } from '../../shared/contracts';

export interface DownloadRequest {
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  expectedBytes?: number;
  expectedSha256?: string;
  finalPath: string;
  id: string;
  label: string;
  maxBytes: number;
  url: string;
}

export interface DownloadResult {
  filePath: string;
  id: string;
}

export type DownloadsListener = (tasks: DownloadTaskView[]) => void;

export interface DownloadSession {
  createInterruptedDownload: (options: {
    eTag?: string;
    lastModified?: string;
    length: number;
    offset: number;
    path: string;
    startTime?: number;
    urlChain: string[];
  }) => void;
  downloadURL: (url: string) => void;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  on: (event: 'will-download', listener: (event: Event, item: DownloadItem) => void) => unknown;
}
