import { failureDisplayMessage, isFailure } from '../../shared/diagnostics/failure';

export const resultFailureMessage = (result: unknown, fallback: string): string => {
  if (isFailure(result)) {
    return failureDisplayMessage(result);
  }
  if (result && typeof result === 'object') {
    const candidate = result as {
      error?: unknown;
      message?: unknown;
    };
    if (typeof candidate.error === 'string') {
      return candidate.error;
    }
    if (typeof candidate.message === 'string') {
      return candidate.message;
    }
  }
  return fallback;
};

export const projectNameFromPath = (directoryPath: string): string => {
  const parts = directoryPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? directoryPath ?? '项目终端';
};

export const formatAttachmentSize = (sizeBytes: number): string => {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(sizeBytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const formatTokenCount = (value: number | undefined): string => {
  if (value === undefined) {
    return '—';
  }
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: value >= 1000 ? 'compact' : 'standard',
  }).format(value);
};

export const formatDuration = (milliseconds: number | undefined): string => {
  if (milliseconds === undefined) {
    return '—';
  }
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes} 分`;
  }
  return `${Math.floor(totalMinutes / 60)} 时 ${totalMinutes % 60} 分`;
};

export const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) {
    return '刚刚';
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  if (days < 30) {
    return `${days} 天前`;
  }

  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    year: timestamp < now - 365 * 86_400_000 ? 'numeric' : undefined,
  });
};
