import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/` is outside both the ESLint glob (`src`/`tests`/`vite.config.ts`) and the Prettier glob,
 * so nothing else in CI ever parses these files. A syntax error therefore stays invisible until
 * Electron loads the script and shows the user a raw "A JavaScript error occurred in the main
 * process" dialog. `node --check` is the cheapest thing that closes that gap.
 */
const scriptsDir = path.join(__dirname, '..', 'scripts');
const scripts = readdirSync(scriptsDir).filter((name) => /\.(c?js|mjs)$/.test(name));

describe('smoke and build scripts', () => {
  it('finds the script directory', () => {
    // Guards the loop below against silently passing if the directory is ever renamed.
    expect(scripts.length).toBeGreaterThan(5);
  });

  it.each(scripts)('%s parses', (name) => {
    expect(() =>
      execFileSync(process.execPath, ['--check', path.join(scriptsDir, name)], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});
