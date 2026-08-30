import { describe, expect, it, vi } from 'vitest';
import type { ClaudePluginView } from '../../src/shared/contracts';
import {
  comparePluginsByGithubStars,
  sortPluginsByGithubStars,
} from '../../src/renderer/features/plugins/view';
import {
  change,
  input,
  plugin,
  pluginCatalog,
  settle,
  withRenderer,
} from '../helpers/renderer-interaction-fixture';
import type { RendererHarness } from '../helpers/renderer-harness';

const github = (
  stars: number | null,
  provenance: 'live' | 'cached' | 'built-in' = 'live',
  repositoryUri = 'https://github.com/owner/repository',
): NonNullable<ClaudePluginView['github']> => ({
  provenance,
  repositoryUri,
  stars,
});

const availableNames = (harness: RendererHarness): Array<string | null> =>
  Array.from(
    harness.document.querySelectorAll<HTMLElement>('#plugin-available-list .plugin-card strong'),
    (element) => element.textContent,
  );

describe('plugin GitHub stars presentation', () => {
  it('sorts known stars first, puts unknown stars last, and never mutates source arrays', () => {
    const unknown = plugin('unknown', {
      github: github(null, 'built-in', 'https://github.com/owner/unknown'),
    });
    const low = plugin('low', {
      github: github(4, 'cached', 'https://github.com/owner/low'),
    });
    const high = plugin('high', {
      github: github(40, 'live', 'https://github.com/owner/high'),
    });
    const original = [unknown, low, high] as const;

    const sorted = sortPluginsByGithubStars(original);

    expect(sorted.map((entry) => entry.name)).toEqual(['high', 'low', 'unknown']);
    expect(original.map((entry) => entry.name)).toEqual(['unknown', 'low', 'high']);
    expect(comparePluginsByGithubStars(low, high)).toBeGreaterThan(0);
    expect(
      comparePluginsByGithubStars(
        plugin('alpha', { github: github(10) }),
        plugin('beta', { github: github(10) }),
      ),
    ).toBeLessThan(0);
  });

  it('filters by search and category before sorting each resulting list', async () => {
    const available = [
      plugin('security-high', {
        description: 'security audit tools',
        github: github(900, 'live', 'https://github.com/owner/security-high'),
      }),
      plugin('frontend-low', {
        description: 'frontend design tools',
        github: github(3, 'cached', 'https://github.com/owner/frontend-low'),
      }),
      plugin('frontend-high', {
        description: 'frontend design tools',
        github: github(30, 'live', 'https://github.com/owner/frontend-high'),
      }),
    ];
    const originalOrder = available.map((entry) => entry.pluginId);

    await withRenderer(
      { getClaudePlugins: async () => pluginCatalog(available) },
      async (harness) => {
        harness.click('[data-rail-tab="extensions"]');
        await settle(harness);

        input(harness.query('#plugin-search'), 'frontend');
        expect(availableNames(harness)).toEqual(['frontend-high', 'frontend-low']);

        input(harness.query('#plugin-search'), '');
        change(harness.query('#plugin-category-filter'), '设计与前端');
        expect(availableNames(harness)).toEqual(['frontend-high', 'frontend-low']);
        expect(available.map((entry) => entry.pluginId)).toEqual(originalOrder);
      },
    );
  });

  it('renders star count, provenance, and a guarded canonical repository link', async () => {
    const openExternal = vi.fn(async () => true);
    const catalog = pluginCatalog([
      plugin('live', {
        github: github(42, 'live', 'https://github.com/Owner/Repository'),
      }),
      plugin('built-in', {
        github: github(null, 'built-in', 'https://github.com/owner/built-in'),
      }),
    ]);

    await withRenderer({ getClaudePlugins: async () => catalog, openExternal }, async (harness) => {
      harness.click('[data-rail-tab="extensions"]');
      await settle(harness);

      const cards = harness.document.querySelectorAll<HTMLElement>(
        '#plugin-available-list .plugin-card',
      );
      expect(cards[0]?.textContent).toContain('★ 42（实时）');
      expect(cards[0]?.querySelector<HTMLElement>('[data-provenance="live"]')).not.toBeNull();
      const link = cards[0]?.querySelector<HTMLAnchorElement>('a');
      expect(link?.href).toBe('https://github.com/owner/repository');
      expect(link?.textContent).toBe('owner/repository');

      link?.dispatchEvent(
        new harness.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await harness.flush();
      expect(openExternal).toHaveBeenCalledWith('https://github.com/owner/repository');

      expect(cards[1]?.textContent).toContain('★ 暂无（内置）');
      expect(cards[1]?.querySelector<HTMLElement>('[data-provenance="built-in"]')).not.toBeNull();
    });
  });

  it('does not render a link for a credential-bearing or non-GitHub repository URI', async () => {
    const catalog = pluginCatalog([
      plugin('unsafe', {
        github: github(99, 'live', 'https://user:secret@github.com/owner/repository'),
      }),
      plugin('wrong-host', {
        github: github(98, 'live', 'https://example.com/owner/repository'),
      }),
    ]);

    await withRenderer({ getClaudePlugins: async () => catalog }, async (harness) => {
      harness.click('[data-rail-tab="extensions"]');
      await settle(harness);

      expect(harness.document.querySelectorAll('#plugin-available-list a')).toHaveLength(0);
      expect(harness.query('#plugin-available-list').textContent).not.toContain('secret');
    });
  });
});
