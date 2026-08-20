import { opendirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const RUNTIME_ARTIFACT_DIRECTORY_PREFIX = 'launch-';
const RUNTIME_ARTIFACT_CLEANUP_SCAN_LIMIT = 16;
const RUNTIME_ARTIFACT_CLEANUP_REMOVE_LIMIT = 4;
const LEGACY_RUNTIME_ARTIFACT_NAMES = [
  'metrics.json',
  'settings.json',
  'signal.json',
  'turn-stop.json',
] as const;

/** Removes only a bounded sample of artifacts that no live launch can read anymore. */
export const cleanupObsoleteLaunchArtifacts = (
  sessionDirectory: string,
  currentArtifactDirectory: string,
  previousArtifactDirectory?: string,
): void => {
  for (const legacyName of LEGACY_RUNTIME_ARTIFACT_NAMES) {
    try {
      unlinkSync(path.join(sessionDirectory, legacyName));
    } catch {
      // A missing or locked legacy artifact is harmless because no launch reads shared paths now.
    }
  }

  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    directory = opendirSync(sessionDirectory);
    let examined = 0;
    let removed = 0;
    while (
      examined < RUNTIME_ARTIFACT_CLEANUP_SCAN_LIMIT &&
      removed < RUNTIME_ARTIFACT_CLEANUP_REMOVE_LIMIT
    ) {
      const entry = directory.readSync();
      if (!entry) {
        break;
      }
      examined += 1;
      if (!entry.isDirectory() || !entry.name.startsWith(RUNTIME_ARTIFACT_DIRECTORY_PREFIX)) {
        continue;
      }
      const candidate = path.join(sessionDirectory, entry.name);
      if (candidate === currentArtifactDirectory || candidate === previousArtifactDirectory) {
        continue;
      }
      try {
        rmSync(candidate, { force: true, recursive: true });
        removed += 1;
      } catch {
        // A delayed hook may still hold or recreate an old directory; a later launch retries.
      }
    }
  } catch {
    // Cleanup never makes a successfully prepared launch fail.
  } finally {
    try {
      directory?.closeSync();
    } catch {
      // Closing a best-effort cleanup iterator cannot affect the launch.
    }
  }
};
