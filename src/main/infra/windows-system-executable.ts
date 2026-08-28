import { existsSync } from 'node:fs';
import path from 'node:path';

type SystemExecutable = 'curl.exe' | 'powershell.exe';

/** Prefer the current Windows installation, without assuming a drive or depending on GUI PATH. */
export const resolveWindowsSystemExecutable = (
  executable: SystemExecutable,
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (candidate: string) => boolean = existsSync,
): string => {
  const entries = Object.entries(environment);
  for (const name of ['SYSTEMROOT', 'WINDIR']) {
    const root = entries.find(([key]) => key.toUpperCase() === name)?.[1];
    if (!root || !path.win32.isAbsolute(root) || ['/', '\\'].includes(path.win32.parse(root).root))
      continue;
    const candidate = path.win32.join(
      root,
      'System32',
      ...(executable === 'powershell.exe' ? ['WindowsPowerShell', 'v1.0'] : []),
      executable,
    );
    if (fileExists(candidate)) return candidate;
  }
  // Windows/Node still perform their normal executable lookup if system metadata is unavailable.
  return executable;
};
