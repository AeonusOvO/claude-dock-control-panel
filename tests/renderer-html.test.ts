import { readFileSync } from 'node:fs';
import { format } from 'prettier';
import { describe, expect, it } from 'vitest';

const rendererHtml = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');

describe('renderer HTML contract', () => {
  it('is valid enough for the strict HTML formatter to parse', async () => {
    await expect(format(rendererHtml, { parser: 'html' })).resolves.toBeTypeOf('string');
  });

  it('has unique straight-quoted element IDs', () => {
    expect(rendererHtml).not.toContain('=”');
    const ids = [...rendererHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

    expect(duplicates).toEqual([]);
  });

  it('contains every ID required during renderer initialization', () => {
    const requiredIds = [
      ...rendererSource.matchAll(/requiredElement(?:<[^>]+>)?\('#([^']+)'\)/g),
    ].map((match) => match[1]);
    const htmlIds = new Set([...rendererHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));

    expect(requiredIds.length).toBeGreaterThan(0);
    expect(requiredIds.filter((id) => !htmlIds.has(id))).toEqual([]);
  });
});
