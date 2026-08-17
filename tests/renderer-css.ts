import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rendererDirectory = fileURLToPath(new URL('../src/renderer/', import.meta.url));
const importRule = /^\s*@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;\s*$/gmu;

/**
 * Expands the renderer's CSS entrypoint in cascade order for source-level tests.
 *
 * Production lets Vite resolve the `@import` graph. Tests that inspect selectors need the same
 * logical bundle rather than the now intentionally tiny import-only `styles.css` entrypoint.
 */
export const readRendererCssBundle = (): string => {
  const expand = (filePath: string, ancestors: readonly string[]): string => {
    if (ancestors.includes(filePath)) {
      throw new Error(`Circular renderer CSS import: ${[...ancestors, filePath].join(' -> ')}`);
    }

    const source = readFileSync(filePath, 'utf8');
    const nextAncestors = [...ancestors, filePath];
    const expanded = source.replace(importRule, (_rule, importPath: string) =>
      expand(resolve(dirname(filePath), importPath), nextAncestors),
    );
    return `\n/* test bundle: ${relative(rendererDirectory, filePath).replaceAll('\\', '/')} */\n${expanded}`;
  };

  return expand(resolve(rendererDirectory, 'styles.css'), []);
};

export const rendererStyles = readRendererCssBundle();
