import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeTerminalSize, resolveDirectory } from '../../src/main/infra/directory';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-test-'));
const projectDirectory = path.join(fixtureRoot, 'demo project');
const filePath = path.join(fixtureRoot, 'not-a-directory.txt');
mkdirSync(projectDirectory);
writeFileSync(filePath, 'fixture');

afterAll(() => {
  const safePrefix = path.join(tmpdir(), 'claudedock-test-');
  if (!fixtureRoot.startsWith(safePrefix)) {
    throw new Error(`Refusing to remove unexpected test fixture: ${fixtureRoot}`);
  }
  rmSync(fixtureRoot, { force: true, recursive: true });
});

describe('resolveDirectory', () => {
  it('returns an absolute path for an existing directory', () => {
    expect(resolveDirectory(projectDirectory)).toBe(path.resolve(projectDirectory));
  });

  it('rejects files', () => {
    expect(() => resolveDirectory(filePath)).toThrow('不是文件夹');
  });

  it('rejects missing paths', () => {
    expect(() => resolveDirectory(path.join(fixtureRoot, 'missing'))).toThrow('不存在');
  });

  it('rejects blank input', () => {
    expect(() => resolveDirectory('  ')).toThrow('有效的文件夹');
  });
});

describe('normalizeTerminalSize', () => {
  it('floors valid values', () => {
    expect(normalizeTerminalSize(92.8, 31.9)).toEqual({ cols: 92, rows: 31 });
  });

  it('clamps out-of-range and non-finite values', () => {
    expect(normalizeTerminalSize(2, Number.NaN)).toEqual({ cols: 20, rows: 24 });
    expect(normalizeTerminalSize(900, 400)).toEqual({ cols: 500, rows: 200 });
  });
});
