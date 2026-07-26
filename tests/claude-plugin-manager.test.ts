import { describe, expect, it } from 'vitest';
import {
  isValidMarketplaceSource,
  isValidPluginId,
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

  it('rejects option-like identifiers and non-https remote marketplaces', () => {
    expect(isValidPluginId('formatter@official')).toBe(true);
    expect(isValidPluginId('--help')).toBe(false);
    expect(isValidMarketplaceSource('owner/repository')).toBe(true);
    expect(isValidMarketplaceSource('https://example.com/plugins.git')).toBe(true);
    expect(isValidMarketplaceSource('http://example.com/plugins.git')).toBe(false);
  });
});
