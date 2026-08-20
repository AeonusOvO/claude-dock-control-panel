import type { DownloadTaskState, DownloadTaskView } from '../../shared/contracts';

const SPEED_EMA_ALPHA = 0.3;

export const exponentialMovingAverage = (
  previous: number,
  deltaBytes: number,
  deltaMs: number,
  alpha = SPEED_EMA_ALPHA,
): number => {
  if (deltaBytes < 0 || deltaMs <= 0 || alpha <= 0 || alpha > 1) {
    return Math.max(0, previous);
  }
  const instantaneous = (deltaBytes * 1000) / deltaMs;
  return previous > 0 ? alpha * instantaneous + (1 - alpha) * previous : instantaneous;
};

export const calculateDownloadProgress = (
  receivedBytes: number,
  totalBytes: number,
  bytesPerSecond: number,
): Pick<DownloadTaskView, 'percent' | 'remainingMs'> => {
  if (totalBytes <= 0) {
    return { percent: -1, remainingMs: -1 };
  }
  const percent = Math.min(100, Math.max(0, (receivedBytes / totalBytes) * 100));
  const remainingMs =
    bytesPerSecond > 0 ? Math.max(0, ((totalBytes - receivedBytes) / bytesPerSecond) * 1000) : -1;
  return { percent, remainingMs };
};

export const mapDownloadItemState = (
  state: 'interrupted' | 'progressing',
  paused: boolean,
  canResume: boolean,
): DownloadTaskState => {
  if (state === 'progressing') {
    return paused ? 'paused' : 'progressing';
  }
  return canResume ? 'paused' : 'failed';
};
