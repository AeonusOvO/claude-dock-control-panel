import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudePluginManager,
  collectMarketplaceManifests,
  describePluginSource,
  enrichInstalledPlugins,
  isValidMarketplaceSource,
  isValidPluginId,
  parseMarketplaces,
  parsePluginCatalog,
  readBoundedMarketplaceManifest,
  readMarketplaceManifest,
} from '../../src/main/claude/plugin-manager';
import type { runWindowsCommand } from '../../src/main/infra/windows-command';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const temporaryDirectory = (name: string): string => {
  const directory = mkdtempSync(path.join(tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const pluginList = (pluginId: string, description = pluginId): string =>
  JSON.stringify({
    available: [],
    installed: [
      {
        description,
        enabled: true,
        id: pluginId,
        version: '1.0.0',
      },
    ],
  });

const commandIs = (argumentsList: string[], ...expected: string[]): boolean =>
  expected.every((value, index) => argumentsList[index] === value);

describe('Claude plugin manager parsing', () => {
  it('rejects structurally invalid plugin output while preserving legitimate empty arrays', () => {
    expect(() => parsePluginCatalog('null')).toThrow('Unexpected plugin catalog shape');
    expect(() => parsePluginCatalog('{}')).toThrow('Unexpected plugin catalog shape');
    expect(() => parsePluginCatalog('[null]')).toThrow('Unexpected plugin catalog entries');
    expect(() => parsePluginCatalog('{"available":[],"installed":{}}')).toThrow(
      'Unexpected plugin catalog shape',
    );
    expect(() => parsePluginCatalog('{"available":{},"installed":[]}')).toThrow(
      'Unexpected plugin catalog shape',
    );
    expect(parsePluginCatalog('[]')).toEqual({ available: [], installed: [] });
    expect(parsePluginCatalog('{"available":[],"installed":[]}')).toEqual({
      available: [],
      installed: [],
    });
  });

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

  it('describes an installed plugin using the checked-out marketplace manifest', async () => {
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
    const manifests = await collectMarketplaceManifests(marketplaces, () =>
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

  it('keeps the plugin list intact when a marketplace manifest cannot be read', async () => {
    const marketplaces = parseMarketplaces(
      JSON.stringify([{ installLocation: 'C:\\missing', name: 'official', source: 'github' }]),
    );
    const manifests = await collectMarketplaceManifests(marketplaces, () => {
      throw new Error('ENOENT');
    });

    expect(manifests.size).toBe(0);
    const { installed } = parsePluginCatalog(
      JSON.stringify({ installed: [{ enabled: true, id: 'example@official' }] }),
    );
    expect(enrichInstalledPlugins(installed, manifests)).toHaveLength(1);
  });

  it('rejects credentialed and ambiguous sources while preserving supported source forms', () => {
    expect(isValidPluginId('formatter@official')).toBe(true);
    expect(isValidPluginId('--help')).toBe(false);
    expect(isValidMarketplaceSource('owner/repository')).toBe(true);
    expect(isValidMarketplaceSource('https://example.com/plugins.git')).toBe(true);
    expect(isValidMarketplaceSource('C:\\marketplaces\\plugins')).toBe(true);
    expect(isValidMarketplaceSource('\\\\server\\share\\plugins')).toBe(true);

    expect(isValidMarketplaceSource('https://user:secret@example.com/plugins.git')).toBe(false);
    expect(isValidMarketplaceSource('https://example.com/plugins.git?token=secret')).toBe(false);
    expect(isValidMarketplaceSource('https://example.com/plugins.git#credential')).toBe(false);
    expect(isValidMarketplaceSource('https://@example.com/plugins.git')).toBe(false);
    expect(isValidMarketplaceSource('https:\\example.com\\plugins.git')).toBe(false);
    expect(isValidMarketplaceSource('http://example.com/plugins.git')).toBe(false);
    expect(isValidMarketplaceSource('owner/repo\u0000secret')).toBe(false);
    expect(isValidMarketplaceSource('C:\\marketplaces\\..\\private')).toBe(false);
    expect(isValidMarketplaceSource('\\\\?\\C:\\private')).toBe(false);
    expect(isValidMarketplaceSource('\\\\server')).toBe(false);
  });

  it('strips URL credentials, query and fragment from source display data', () => {
    expect(
      describePluginSource({
        path: 'plugins/example',
        url: 'https://user:secret@example.com/private/repo.git?token=abc#fragment',
      }),
    ).toBe('example.com/private/repo · plugins/example');
    expect(
      describePluginSource({
        path: 'C:\\private\\plugin',
        ref: 'https://user:secret@example.com/ref',
        source: 'C:\\private\\marketplace',
      }),
    ).toBe('未知来源');
    expect(
      describePluginSource('https://user:secret@example.com/repo.git?token=abc#fragment'),
    ).toBe('example.com/repo');
    expect(
      parseMarketplaces(
        JSON.stringify([
          {
            installLocation: 'C:\\private\\official',
            name: 'official',
            repo: 'https://example.com/org/repo.git?token=abc#fragment',
            source: 'https://source-user:source-secret@example.com/source.git?token=abc#fragment',
          },
          {
            installLocation: 'C:\\private\\credentialed',
            name: 'credentialed',
            repo: 'https://user:secret@example.com/org/repo.git',
            source: 'url',
          },
        ]),
      ),
    ).toEqual([
      expect.objectContaining({ repo: 'example.com/org/repo' }),
      expect.not.objectContaining({ repo: expect.anything() }),
    ]);
  });
});

describe('Claude plugin manager catalog fencing', () => {
  it('starts a fresh post-mutation load and never publishes or caches the older in-flight result', async () => {
    const staleList = deferred<string>();
    const freshList = deferred<string>();
    let listCalls = 0;
    const commandRunner = vi.fn(async (_command: string, argumentsList: string[]) => {
      if (commandIs(argumentsList, 'plugin', 'list')) {
        listCalls += 1;
        return listCalls === 1 ? staleList.promise : freshList.promise;
      }
      if (commandIs(argumentsList, 'plugin', 'marketplace', 'list')) {
        return '[]';
      }
      return '';
    });
    const manager = new ClaudePluginManager(
      'C:\\test',
      commandRunner as unknown as typeof runWindowsCommand,
      async () => '{}',
    );

    const staleRequest = manager.getCatalog(true);
    await vi.waitFor(() => expect(listCalls).toBe(1));

    const mutation = manager.mutate({ pluginId: 'fresh@official', type: 'install' });
    await vi.waitFor(() => expect(listCalls).toBe(2));
    freshList.resolve(pluginList('fresh@official', 'fresh catalog'));
    await expect(mutation).resolves.toMatchObject({
      catalog: { installed: [expect.objectContaining({ description: 'fresh catalog' })] },
    });

    staleList.resolve(pluginList('stale@official', 'stale catalog'));
    await expect(staleRequest).resolves.toMatchObject({
      installed: [expect.objectContaining({ description: 'fresh catalog' })],
    });
    await expect(manager.getCatalog()).resolves.toMatchObject({
      installed: [expect.objectContaining({ pluginId: 'fresh@official' })],
    });
    expect(listCalls).toBe(2);
  });

  it('retains the last-known-good process cache while surfacing a refresh failure safely', async () => {
    let listCalls = 0;
    const commandRunner = vi.fn(async (_command: string, argumentsList: string[]) => {
      if (commandIs(argumentsList, 'plugin', 'list')) {
        listCalls += 1;
        if (listCalls === 1) {
          return pluginList('stable@official', 'last good');
        }
        throw new Error('C:\\private\\credentialed-source');
      }
      return '[]';
    });
    const manager = new ClaudePluginManager(
      'C:\\test',
      commandRunner as unknown as typeof runWindowsCommand,
      async () => '{}',
    );

    const good = await manager.getCatalog(true);
    const { catalog: failed } = await manager.mutate({
      pluginId: 'candidate@official',
      type: 'install',
    });

    expect(failed).toMatchObject({
      cliAvailable: false,
      installed: [expect.objectContaining({ description: 'last good' })],
      message: 'Claude 插件命令执行失败；请确认 Claude Code 已登录并支持插件命令。',
    });
    expect(failed.message).not.toContain('C:\\private');
    await expect(manager.getCatalog()).resolves.toBe(good);
    expect(listCalls).toBe(2);
  });

  it('does not replace a last-good catalog with a structurally invalid empty response', async () => {
    let listCalls = 0;
    const commandRunner = vi.fn(async (_command: string, argumentsList: string[]) => {
      if (commandIs(argumentsList, 'plugin', 'list')) {
        listCalls += 1;
        return listCalls === 1 ? pluginList('stable@official', 'last good') : '{}';
      }
      return '[]';
    });
    const manager = new ClaudePluginManager(
      'C:\\test',
      commandRunner as unknown as typeof runWindowsCommand,
      async () => '{}',
    );

    const good = await manager.getCatalog(true);
    await expect(manager.getCatalog(true)).resolves.toMatchObject({
      cliAvailable: true,
      installed: [expect.objectContaining({ pluginId: 'stable@official' })],
      message: 'Claude 命令行返回了无法解析的插件列表。',
    });
    await expect(manager.getCatalog()).resolves.toBe(good);
  });

  it('joins identical mutations, rejects competing side effects and releases ownership after failure', async () => {
    const firstMutation = deferred<string>();
    const firstRefresh = deferred<string>();
    const callArguments: string[][] = [];
    let listCalls = 0;
    const commandRunner = vi.fn(async (_command: string, argumentsList: string[]) => {
      callArguments.push(argumentsList);
      if (commandIs(argumentsList, 'plugin', 'install')) {
        return firstMutation.promise;
      }
      if (commandIs(argumentsList, 'plugin', 'list')) {
        listCalls += 1;
        return listCalls === 1
          ? firstRefresh.promise
          : JSON.stringify({ available: [], installed: [] });
      }
      if (commandIs(argumentsList, 'plugin', 'marketplace', 'list')) {
        return '[]';
      }
      return '';
    });
    const manager = new ClaudePluginManager(
      'C:\\test',
      commandRunner as unknown as typeof runWindowsCommand,
      async () => '{}',
    );

    const install = manager.mutate({ pluginId: 'first@official', type: 'install' });
    const joinedInstall = manager.mutate({ pluginId: 'first@official', type: 'install' });
    expect(joinedInstall).toBe(install);
    await expect(
      manager.mutate({ name: 'second', type: 'marketplace-remove' }),
    ).rejects.toMatchObject({
      catalog: {
        activeOperation: {
          attempt: 1,
          kind: 'install',
          phase: 'mutating',
          target: 'first@official',
        },
      },
      message: '已有插件操作正在进行，请等待完成后再试。',
    });
    await expect(manager.getCatalog(false)).resolves.toMatchObject({
      activeOperation: {
        attempt: 1,
        kind: 'install',
        phase: 'mutating',
        target: 'first@official',
      },
    });

    await vi.waitFor(() =>
      expect(callArguments).toContainEqual([
        'plugin',
        'install',
        'first@official',
        '--scope',
        'user',
      ]),
    );
    firstMutation.reject(new Error('failed'));
    await vi.waitFor(() => expect(listCalls).toBe(1));
    await expect(manager.getCatalog(false)).resolves.toMatchObject({
      activeOperation: { attempt: 1, kind: 'install', phase: 'refreshing' },
    });
    firstRefresh.resolve(JSON.stringify({ available: [], installed: [] }));
    await expect(install).rejects.toThrow('Claude 插件命令执行失败');
    await expect(joinedInstall).rejects.toThrow('Claude 插件命令执行失败');
    expect(manager.hasActiveMutation()).toBe(false);

    await expect(
      manager.mutate({ enabled: false, pluginId: 'third@official', type: 'set-enabled' }),
    ).resolves.toMatchObject({ message: expect.stringContaining('已停用') });
    expect(
      callArguments.filter((argumentsList) => commandIs(argumentsList, 'plugin', 'install')),
    ).toEqual([['plugin', 'install', 'first@official', '--scope', 'user']]);
    expect(callArguments).not.toContainEqual(['plugin', 'marketplace', 'remove', 'second']);
    expect(callArguments).toContainEqual([
      'plugin',
      'disable',
      'third@official',
      '--scope',
      'user',
    ]);
  });

  it('keeps install and update non-interactive consent behavior unchanged for the later preview/apply phase', async () => {
    const calls: string[][] = [];
    const commandRunner = vi.fn(async (_command: string, argumentsList: string[]) => {
      calls.push(argumentsList);
      if (commandIs(argumentsList, 'plugin', 'list')) {
        return JSON.stringify({ available: [], installed: [] });
      }
      if (commandIs(argumentsList, 'plugin', 'marketplace', 'list')) {
        return '[]';
      }
      return '';
    });
    const manager = new ClaudePluginManager(
      'C:\\test',
      commandRunner as unknown as typeof runWindowsCommand,
      async () => '{}',
    );

    await manager.mutate({ pluginId: 'example@official', type: 'install' });
    await manager.mutate({ pluginId: 'example@official', type: 'update' });

    const mutationCalls = calls.filter(
      (argumentsList) =>
        commandIs(argumentsList, 'plugin', 'install') ||
        commandIs(argumentsList, 'plugin', 'update', 'example@official'),
    );
    expect(mutationCalls).toEqual([
      ['plugin', 'install', 'example@official', '--scope', 'user'],
      ['plugin', 'update', 'example@official', '--scope', 'user'],
    ]);
    expect(mutationCalls.flat()).not.toContain('--yes');
  });
});

describe('Claude plugin marketplace manifest reads', () => {
  const createManifestRoot = (): { manifest: string; root: string } => {
    const root = temporaryDirectory('claudedock-plugin-manifest-');
    const manifestDirectory = path.join(root, '.claude-plugin');
    mkdirSync(manifestDirectory, { recursive: true });
    return { manifest: path.join(manifestDirectory, 'marketplace.json'), root };
  };

  it('fails closed instead of crossing the unsafe production manifest filesystem seam', async () => {
    const { manifest, root } = createManifestRoot();
    writeFileSync(manifest, '{"plugins":[]}');

    await expect(readMarketplaceManifest(root)).rejects.toThrow('插件市场清单不可用');
  });

  it('bounds injected manifest text before parsing or enrichment', async () => {
    const marketplaces = parseMarketplaces(
      JSON.stringify([{ installLocation: 'C:\\captured', name: 'official', source: 'github' }]),
    );
    const manifests = await collectMarketplaceManifests(
      marketplaces,
      () => `{"plugins":[],"padding":"${'a'.repeat(256 * 1024)}"}`,
    );

    expect(manifests.size).toBe(0);
  });

  it('rejects oversized manifests without exposing their absolute path', async () => {
    const { manifest, root } = createManifestRoot();
    writeFileSync(manifest, Buffer.alloc(256 * 1024 + 1, 0x61));

    const result = readMarketplaceManifest(root);
    await expect(result).rejects.toThrow('插件市场清单不可用');
    await expect(result).rejects.not.toThrow(root);
  });

  it('rejects non-regular manifest candidates', async () => {
    const { manifest, root } = createManifestRoot();
    mkdirSync(manifest);

    await expect(readMarketplaceManifest(root)).rejects.toThrow('插件市场清单不可用');
  });

  it('never publishes outside content when the installation root is swapped to a junction', async () => {
    const root = temporaryDirectory('claudedock-plugin-manifest-root-swap-');
    const outside = temporaryDirectory('claudedock-plugin-manifest-root-target-');
    mkdirSync(path.join(outside, '.claude-plugin'));
    writeFileSync(
      path.join(outside, '.claude-plugin', 'marketplace.json'),
      '{"plugins":[{"name":"escaped","description":"outside"}]}',
    );

    const pending = readMarketplaceManifest(root);
    rmSync(root, { force: true, recursive: true });
    symlinkSync(outside, root, 'junction');

    await expect(pending).rejects.toThrow('插件市场清单不可用');
    const marketplaces = parseMarketplaces(
      JSON.stringify([{ installLocation: root, name: 'official', source: root }]),
    );
    await expect(collectMarketplaceManifests(marketplaces)).resolves.toEqual(new Map());
  });

  it('never publishes outside content when an intermediate parent is swapped to a junction', async () => {
    const { root } = createManifestRoot();
    const outside = temporaryDirectory('claudedock-plugin-manifest-parent-target-');
    writeFileSync(
      path.join(outside, 'marketplace.json'),
      '{"plugins":[{"name":"escaped","description":"outside"}]}',
    );

    const pending = readMarketplaceManifest(root);
    rmSync(path.join(root, '.claude-plugin'), { force: true, recursive: true });
    symlinkSync(outside, path.join(root, '.claude-plugin'), 'junction');

    await expect(pending).rejects.toThrow('插件市场清单不可用');
    const marketplaces = parseMarketplaces(
      JSON.stringify([{ installLocation: root, name: 'official', source: root }]),
    );
    await expect(collectMarketplaceManifests(marketplaces)).resolves.toEqual(new Map());
  });

  it('rejects a candidate path outside the captured installation root', async () => {
    const root = temporaryDirectory('claudedock-plugin-manifest-root-');
    const outside = temporaryDirectory('claudedock-plugin-manifest-outside-');
    const outsideManifest = path.join(outside, 'marketplace.json');
    writeFileSync(outsideManifest, '{}');

    await expect(readBoundedMarketplaceManifest(root, outsideManifest)).rejects.toThrow(
      '插件市场清单不可用',
    );
  });
});
