import { statSync } from 'node:fs';
import path from 'node:path';

const MAX_PATH_INPUT_LENGTH = 32_768;

export const resolveDirectory = (candidate: string): string => {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new Error('请选择一个有效的文件夹。');
  }

  if (candidate.length > MAX_PATH_INPUT_LENGTH) {
    throw new Error('文件夹路径过长。');
  }

  const resolved = path.resolve(candidate);

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error('文件夹不存在或当前用户无权访问。');
  }

  if (!stat.isDirectory()) {
    throw new Error('拖入的项目不是文件夹。');
  }

  return resolved;
};

export const normalizeTerminalSize = (
  cols: number,
  rows: number,
): { cols: number; rows: number } => ({
  cols: Math.min(500, Math.max(20, Math.floor(Number.isFinite(cols) ? cols : 80))),
  rows: Math.min(200, Math.max(5, Math.floor(Number.isFinite(rows) ? rows : 24))),
});
