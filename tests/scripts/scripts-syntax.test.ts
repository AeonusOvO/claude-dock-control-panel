import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ESLint and Prettier both cover `scripts/`, but neither resolves these files the way Node does:
 * `.cjs` and `.mjs` differ in module semantics, and a file that lints clean can still fail to parse
 * under the loader Electron actually uses — surfacing as a raw "A JavaScript error occurred in the
 * main process" dialog. `node --check` runs the real parser, which is the cheapest thing that closes
 * that gap.
 */
const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
const collectScripts = (directory: string): string[] =>
  readdirSync(path.join(scriptsDir, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectScripts(relativePath);
      return /\.(c?js|mjs)$/.test(entry.name) ? [relativePath] : [];
    })
    .sort();
const scriptDirectories = ['build', 'smoke', 'tools'];
const scripts = scriptDirectories.flatMap(collectScripts).sort();

describe('smoke and build scripts', () => {
  it('finds scripts in each classified directory', () => {
    for (const directory of scriptDirectories) {
      expect(scripts.some((script) => script.startsWith(`${directory}${path.sep}`))).toBe(true);
    }
  });

  it.each(scripts)('%s parses', (name) => {
    expect(() =>
      execFileSync(process.execPath, ['--check', path.join(scriptsDir, name)], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});
