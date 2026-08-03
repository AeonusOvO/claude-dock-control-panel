import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { directoryDialogDefaultPath, directoryDialogError } from '../src/main/directory-picker';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-picker-'));
const fallbackDirectory = path.join(fixtureRoot, 'fallback');
const regularFile = path.join(fixtureRoot, 'file.txt');
mkdirSync(fallbackDirectory);
writeFileSync(regularFile, 'not a directory', 'utf8');

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
});

describe('directory picker helpers', () => {
  it('uses the active directory when it still exists', () => {
    expect(directoryDialogDefaultPath(fixtureRoot, fallbackDirectory)).toBe(fixtureRoot);
  });

  it('falls back when the active path is missing or is a file', () => {
    expect(directoryDialogDefaultPath(path.join(fixtureRoot, 'missing'), fallbackDirectory)).toBe(
      fallbackDirectory,
    );
    expect(directoryDialogDefaultPath(regularFile, fallbackDirectory)).toBe(fallbackDirectory);
  });

  it('returns no default when neither candidate is a directory', () => {
    expect(
      directoryDialogDefaultPath(regularFile, path.join(fixtureRoot, 'missing')),
    ).toBeUndefined();
  });

  it('keeps the native dialog failure reason visible', () => {
    expect(directoryDialogError(new Error('owner window is invalid'))).toContain(
      'owner window is invalid',
    );
    expect(directoryDialogError(undefined)).toContain('请重试');
  });
});
