import { describe, expect, it } from 'vitest';
import {
  collectMarketplaceManifests,
  enrichInstalledPlugins,
  isValidMarketplaceSource,
  isValidPluginId,
  parseMarketplaces,
  parsePluginCatalog,
} from '../src/main/claude-plugin-manager';

describe('Claude plugin manager parsing', () => {
  it('merges installed plugins with the marketplace version and marks updates', () => {
    const catalog = parsePluginCatalog(
      JSON.stringify({
        available: [
          {
            description: 'Example',
            marketplaceName: 'official',
            name: 'example',
            pluginId: 'example@official',
            version: '2.0.0',
          },
        ],
        installed: [
          {
            enabled: true,
            marketplaceName: 'official',
            name: 'example',
            pluginId: 'example@official',
            version: '1.0.0',
          },
        ],
      }),
    );

    expect(catalog.available).toHaveLength(0);
    expect(catalog.installed[0]).toMatchObject({
      latestVersion: '2.0.0',
      updateAvailable: true,
      version: '1.0.0',
    });
  });

  /*
   * `claude plugin list --json --available` describes an installed plugin only by `id`, with no
   * `name`, `pluginId`, `marketplaceName` or `description`, and reports `"unknown"` as its version.
   * Dropping such entries used to hide every installed plugin from the panel.
   */
  it('keeps an installed plugin that the CLI describes only by its composite id', () => {
    const catalog = parsePluginCatalog(
      JSON.stringify({
        available: [
          {
            description: 'Something else',
            marketplaceName: 'claude-plugins-official',
            name: 'other-plugin',
            pluginId: 'other-plugin@claude-plugins-official',
          },
        ],
        installed: [
          {
            enabled: true,
            id: 'frontend-design@claude-plugins-official',
            installPath: 'C:\\Users\\tester\\.claude\\plugins\\cache\\x\\frontend-design\\unknown',
            installedAt: '2026-07-26T12:29:22.110Z',
            lastUpdated: '2026-07-26T12:29:22.110Z',
            scope: 'user',
            version: 'unknown',
          },
        ],
      }),
    );

    expect(catalog.installed).toHaveLength(1);
    expect(catalog.installed[0]).toMatchObject({
      enabled: true,
      installed: true,
      marketplaceName: 'claude-plugins-official',
      name: 'frontend-design',
      pluginId: 'frontend-design@claude-plugins-official',
      scope: 'user',
      updateAvailable: false,
    });
    expect(catalog.installed[0]?.version).toBeUndefined();
    expect(catalog.available).toHaveLength(1);
  });

  it('describes an installed plugin using the checked-out marketplace manifest', () => {
    const marketplaces = parseMarketplaces(
      JSON.stringify([
        {
          installLocation: 'C:\\Users\\tester\\.claude\\plugins\\marketplaces\\official',
          name: 'claude-plugins-official',
          repo: 'anthropics/claude-plugins-official',
          source: 'github',
        },
      ]),
    );
    const manifests = collectMarketplaceManifests(marketplaces, () =>
      JSON.stringify({
        name: 'claude-plugins-official',
        plugins: [
          {
            category: 'development',
            description: '创建有辨识度的前端界面。',
            name: 'frontend-design',
            source: './plugins/frontend-design',
          },
        ],
      }),
    );

    const { installed } = parsePluginCatalog(
      JSON.stringify({
        installed: [
          { enabled: true, id: 'frontend-design@claude-plugins-official', version: 'unknown' },
        ],
      }),
    );

    expect(enrichInstalledPlugins(installed, manifests)[0]).toMatchObject({
      description: '创建有辨识度的前端界面。',
      sourceLabel: 'anthropics/claude-plugins-official · plugins/frontend-design',
    });
  });

  it('keeps the plugin list intact when a marketplace manifest cannot be read', () => {
    const marketplaces = parseMarketplaces(
      JSON.stringify([{ installLocation: 'C:\\missing', name: 'official', source: 'github' }]),
    );
    const manifests = collectMarketplaceManifests(marketplaces, () => {
      throw new Error('ENOENT');
    });

    expect(manifests.size).toBe(0);
    const { installed } = parsePluginCatalog(
      JSON.stringify({ installed: [{ enabled: true, id: 'example@official' }] }),
    );
    expect(enrichInstalledPlugins(installed, manifests)).toHaveLength(1);
  });

  it('rejects option-like identifiers and non-https remote marketplaces', () => {
    expect(isValidPluginId('formatter@official')).toBe(true);
    expect(isValidPluginId('--help')).toBe(false);
    expect(isValidMarketplaceSource('owner/repository')).toBe(true);
    expect(isValidMarketplaceSource('https://example.com/plugins.git')).toBe(true);
    expect(isValidMarketplaceSource('http://example.com/plugins.git')).toBe(false);
  });
});
