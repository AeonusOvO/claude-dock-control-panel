import { existsSync, statSync } from 'node:fs';

const existingDirectory = (candidate: string | undefined): string | undefined => {
  if (!candidate || !existsSync(candidate)) {
    return undefined;
  }
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
};

export const directoryDialogDefaultPath = (
  preferredPath: string | undefined,
  fallbackPath: string | undefined,
): string | undefined => existingDirectory(preferredPath) ?? existingDirectory(fallbackPath);

export const directoryDialogError = (error: unknown): string => {
  const detail = error instanceof Error ? error.message.trim() : '';
  return detail ? `系统文件夹选择器未能启动：${detail}` : '系统文件夹选择器未能启动，请重试。';
};
