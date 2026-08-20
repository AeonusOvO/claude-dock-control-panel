import { format } from 'prettier';
import { describe, expect, it } from 'vitest';
import { createRendererHarness, rendererMarkup } from '../helpers/renderer-harness';

describe('renderer HTML contract', () => {
  it('is valid enough for the strict HTML formatter to parse', async () => {
    await expect(format(rendererMarkup, { parser: 'html' })).resolves.toBeTypeOf('string');
  });

  it('has unique straight-quoted element IDs', () => {
    expect(rendererMarkup).not.toContain('=”');
    const ids = [...rendererMarkup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

    expect(duplicates).toEqual([]);
  });

  it('initializes the real renderer against the shipped markup', async () => {
    const harness = await createRendererHarness();
    try {
      expect(harness.method('getWorkspace')).toHaveBeenCalled();
      expect(harness.query('#terminal-stage')).toBeInstanceOf(HTMLElement);
    } finally {
      await harness.cleanup();
    }
  });
});
