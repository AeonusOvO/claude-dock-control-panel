import { describe, expect, it, vi } from 'vitest';
import {
  PluginCatalogService,
  buildPluginCatalogSnapshot,
  projectPluginCatalogPresentation,
} from '../../src/main/claude/plugins/catalog-service';
import { adaptClaudeCliMarketplaceSource } from '../../src/main/claude/plugins/claude-cli-record-adapter';
import { createAnthropicOfficialCatalogSource } from '../../src/main/claude/plugins/official-source';
import type { PluginCatalogSource } from '../../src/main/claude/plugins/source-types';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const officialSource = (pluginId = 'frontend-design', description = 'Known official entry') =>
  createAnthropicOfficialCatalogSource(
    'https://github.com/anthropics/claude-plugins-official.git',
    [
      {
        canonicalPluginId: pluginId,
        description,
        name: pluginId,
        sourceRevision: 'revision-2',
        version: '2.0.0',
      },
    ],
    'marketplace-revision-2',
  );

describe('plugin catalog service', () => {
  it('merges install and update state only by exact source plus plugin identity', () => {
    const snapshot = buildPluginCatalogSnapshot(
      [officialSource()],
      [
        {
          canonicalPluginId: 'frontend-design',
          canonicalSourceId: 'github:anthropics/claude-plugins-official',
          enabled: true,
          name: 'frontend-design',
          scope: 'user',
          sourceRevision: 'revision-1',
          version: '1.0.0',
        },
        {
          canonicalPluginId: 'frontend-design',
          canonicalSourceId: 'github:example/claude-plugins-official',
          description: 'Official verified marketplace plugin',
          display: { label: 'Anthropic Official Marketplace' },
          enabled: true,
          name: 'frontend-design',
          scope: 'user',
          version: '1.0.0',
        },
      ],
      123,
    );

    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]).toMatchObject({
      canonicalSourceId: 'github:anthropics/claude-plugins-official',
      installed: true,
      installedVersion: '1.0.0',
      latestVersion: '2.0.0',
      sourceKind: 'official',
      updateAvailable: true,
    });
    expect(snapshot.entries[1]).toMatchObject({
      canonicalSourceId: 'github:example/claude-plugins-official',
      installed: true,
      publisherId: 'unknown',
      recommendationTier: 'none',
      sourceKind: 'unknown',
      updateAvailable: false,
    });
    expect(snapshot.installedCount).toBe(2);
    expect(snapshot.updatesAvailable).toBe(1);
  });

  it('retains last-known-good presentation with a stale-degraded status on refresh failure', async () => {
    const privateFailure = 'https://private-user:private-secret@example.com/catalog';
    let shouldFail = false;
    const loadRecommendationSources = vi.fn(async () => {
      if (shouldFail) {
        throw new Error(privateFailure);
      }
      return [officialSource()];
    });
    const service = new PluginCatalogService(
      {
        loadInstalledPlugins: async () => [],
        loadRecommendationSources,
      },
      { ttlMs: 60_000 },
    );

    const fresh = await service.getCatalog(true);
    shouldFail = true;
    const degraded = await service.getCatalog(true);

    expect(fresh.status).toBe('fresh');
    expect(degraded.status).toBe('stale-degraded');
    expect(degraded.value).toBe(fresh.value);
    expect(degraded.message).not.toMatch(/private-user|private-secret/);
    expect(loadRecommendationSources).toHaveBeenCalledTimes(2);
  });

  it('fences an in-flight pre-invalidation generation from newer presentation state', async () => {
    const staleLoad = deferred<readonly PluginCatalogSource[]>();
    const freshLoad = deferred<readonly PluginCatalogSource[]>();
    let calls = 0;
    const loadRecommendationSources = vi.fn(() => {
      calls += 1;
      return calls === 1 ? staleLoad.promise : freshLoad.promise;
    });
    const service = new PluginCatalogService(
      {
        loadInstalledPlugins: async () => [],
        loadRecommendationSources,
      },
      { ttlMs: 60_000 },
    );

    const staleRequest = service.getCatalog(true);
    await vi.waitFor(() => expect(calls).toBe(1));
    service.invalidate();
    const freshRequest = service.getCatalog(true);
    await vi.waitFor(() => expect(calls).toBe(2));

    freshLoad.resolve([officialSource('fresh-plugin', 'fresh generation')]);
    const fresh = await freshRequest;
    staleLoad.resolve([officialSource('stale-plugin', 'stale generation')]);
    const fenced = await staleRequest;

    expect(fresh.value.entries.map((entry) => entry.canonicalPluginId)).toEqual(['fresh-plugin']);
    expect(fenced.value).toBe(fresh.value);
    await expect(service.getCatalog()).resolves.toMatchObject({ value: fresh.value });
    expect(loadRecommendationSources).toHaveBeenCalledTimes(2);
  });

  it('projects only sanitized source display values and drops exact main-only source IDs', () => {
    const source = adaptClaudeCliMarketplaceSource(
      [
        {
          description: 'User entry',
          name: 'user-plugin',
          pluginId: 'user-plugin@user-marketplace',
        },
      ],
      {
        canonicalSourceId: 'url:example.com/user-marketplace',
        display: {
          label:
            'https://example.com/catalog?proxy=proxy-secret&token=token-secret&url=url-secret#fragment-secret',
          uri: 'https://example.com/catalog?token=uri-secret&url=uri-url-secret#uri-fragment-secret',
        },
        sourceKind: 'user-marketplace',
      },
    );
    const presentation = projectPluginCatalogPresentation(
      buildPluginCatalogSnapshot([source], [], 456),
    );
    const [entry] = presentation.entries;

    expect(entry).not.toHaveProperty('canonicalSourceId');
    expect(entry?.displaySource).toEqual({
      label: 'https://example.com/catalog',
      uri: 'https://example.com/catalog',
    });
    expect(entry?.catalogEntryId).toMatch(/^plugin:[0-9a-f]{64}$/);
    expect(entry?.catalogEntryId).not.toContain('example.com');
    expect(JSON.stringify(presentation)).not.toMatch(
      /proxy-secret|token-secret|url-secret|fragment-secret|uri-secret/,
    );
  });

  it('rejects bare authority credentials before catalog data can be projected to the renderer', () => {
    const credentialedLabels = [
      'proxy-user:proxy-token@127.0.0.1/catalog',
      'oauth-token@localhost/catalog',
      'user%3Aprivate-secret@127.0.0.1/catalog',
      'user%3aprivate-secret@[2001:db8::1]:8443/catalog',
      'proxy-token@catalog.internal:8443',
      'malformed%3Gsecret@localhost/catalog',
    ];

    for (const label of credentialedLabels) {
      let failure: unknown;
      try {
        projectPluginCatalogPresentation(
          buildPluginCatalogSnapshot(
            [],
            [
              {
                canonicalPluginId: 'credential-test',
                canonicalSourceId: 'unknown:credential-test',
                display: { label },
                name: 'credential-test',
              },
            ],
            457,
          ),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toMatch(
        /proxy-user|proxy-token|oauth-token|private-secret|malformed%3gsecret/i,
      );
    }
  });

  it('rejects Codex-shaped installed records from the Claude plugin domain', () => {
    expect(() =>
      buildPluginCatalogSnapshot(
        [],
        [
          {
            canonicalPluginId: 'not-a-claude-plugin',
            canonicalSourceId: 'unknown:codex',
            client: 'codex',
            name: 'not-a-claude-plugin',
          } as never,
        ],
      ),
    ).toThrow('unsupported fields');
  });
});
