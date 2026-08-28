import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveWindowsSystemExecutable } from '../../src/main/infra/windows-system-executable';

describe('portable Windows system executable lookup', () => {
  it.each(['D:\\系统目录', 'E:\\Windows with spaces', 'Z:\\Portable Windows'])(
    'uses the detected Windows installation at %s',
    (root) => {
      const fileExists = vi.fn(() => true);
      expect(
        resolveWindowsSystemExecutable('powershell.exe', { SystemRoot: root }, fileExists),
      ).toBe(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
      expect(resolveWindowsSystemExecutable('curl.exe', { SystemRoot: root }, fileExists)).toBe(
        path.win32.join(root, 'System32', 'curl.exe'),
      );
    },
  );

  it('accepts case-insensitive system metadata and falls back from missing SystemRoot to WINDIR', () => {
    const fallback = 'F:\\Windows';
    const expected = path.win32.join(fallback, 'System32', 'curl.exe');
    const fileExists = vi.fn((candidate: string) => candidate === expected);
    expect(
      resolveWindowsSystemExecutable(
        'curl.exe',
        { systemroot: 'Q:\\Missing', windir: fallback },
        fileExists,
      ),
    ).toBe(expected);
    expect(resolveWindowsSystemExecutable('curl.exe', { WINDIR: fallback }, fileExists)).toBe(
      expected,
    );
  });

  it.each([
    {},
    { SystemRoot: '' },
    { SystemRoot: 'relative-windows' },
    { SystemRoot: 'C:' },
    { SystemRoot: '\\Windows' },
    { SystemRoot: '/Windows' },
  ])(
    'uses normal command discovery instead of inventing a drive when metadata is absent: %j',
    (environment) => {
      const fileExists = vi.fn(() => true);
      expect(resolveWindowsSystemExecutable('powershell.exe', environment, fileExists)).toBe(
        'powershell.exe',
      );
      expect(resolveWindowsSystemExecutable('curl.exe', environment, fileExists)).toBe('curl.exe');
      expect(fileExists).not.toHaveBeenCalled();
    },
  );

  it('falls back to command discovery when the detected system executable is absent', () => {
    expect(
      resolveWindowsSystemExecutable('curl.exe', { SystemRoot: 'R:\\Windows' }, () => false),
    ).toBe('curl.exe');
  });
});
