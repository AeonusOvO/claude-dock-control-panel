import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudePluginManager } from '../../src/main/claude/plugin-manager';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import type { runWindowsCommand } from '../../src/main/infra/windows-command';
import type { ClaudePluginCatalog } from '../../src/shared/contracts';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';
import {
  createTestMainServiceRegistry,
  registerTestService,
} from '../helpers/main-service-registry';

const catalog: ClaudePluginCatalog = {
  available: [],
  checkedAt: 1,
  cliAvailable: true,
  installed: [],
  marketplaces: [],
  message: 'ready',
  updatesAvailable: 0,
};

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const pluginList = (pluginId: string): string =>
  JSON.stringify({
    available: [],
    installed: [{ enabled: true, id: pluginId, version: '1.0.0' }],
  });

const commandIs = (argumentsList: string[], ...expected: string[]): boolean =>
  expected.every((value, index) => argumentsList[index] === value);

const createPluginManager = () => ({
  getCatalog: vi.fn(async () => catalog),
  hasActiveMutation: vi.fn(() => false),
  mutate: vi.fn(async (request: { type: string }) => ({
    catalog,
    message: request.type === 'marketplace-add' ? '插件市场已添加。' : '插件操作已完成。',
  })),
});

const registerHarness = async (
  busyRegistry: BusyRegistry,
  pluginManager = createPluginManager(),
) => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
  const [{ registerClaudePluginIpc }, { BUSY_REGISTRY }] = await Promise.all([
    import('../../src/main/ipc/claude-plugin'),
    import('../../src/main/infra/service-tokens'),
  ]);
  const services = await createTestMainServiceRegistry();
  registerTestService(services, BUSY_REGISTRY, busyRegistry);
  const assertPluginMutationsAllowed = vi.fn();
  const validateSender = vi.fn();
  registerClaudePluginIpc({
    guards: { assertPluginMutationsAllowed, validateSender },
    pluginManager: pluginManager as never,
    services,
  });
  return { assertPluginMutationsAllowed, ipc, pluginManager, validateSender };
};

describe('Claude plugin IPC hardening', () => {
  it('records an exact disable busy lease from the validated false boolean', async () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const busyRegistry = { acquire } as unknown as BusyRegistry;
    const { ipc, pluginManager } = await registerHarness(busyRegistry);

    await expect(
      ipc.invoke(CHANNELS.CLAUDE_PLUGINS_SET_ENABLED, 'formatter@official', false),
    ).resolves.toMatchObject({ ok: true });

    const identity = createHash('sha256')
      .update('set-enabled:formatter@official:false')
      .digest('hex')
      .slice(0, 16);
    expect(acquire).toHaveBeenCalledExactlyOnceWith({
      action: 'disable',
      cancellable: false,
      domain: 'plugin',
      id: `plugin:${CHANNELS.CLAUDE_PLUGINS_SET_ENABLED}:${identity}:1`,
      kind: 'configure',
      label: '禁用 formatter@official',
      severity: 'blocking',
      stage: '禁用 Claude Code 插件',
      target: 'formatter@official',
    });
    expect(pluginManager.mutate).toHaveBeenCalledExactlyOnceWith({
      enabled: false,
      pluginId: 'formatter@official',
      type: 'set-enabled',
    });
    expect(pluginManager.getCatalog).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps local marketplace paths out of busy metadata and operation messages', async () => {
    const observedLeases: unknown[] = [];
    const busyRegistry = new BusyRegistry((leases) => {
      observedLeases.push(...leases);
    });
    const pluginManager = createPluginManager();
    const { ipc } = await registerHarness(busyRegistry, pluginManager);
    const privatePath = 'C:\\private\\team\\marketplace';

    const result = await ipc.invoke(CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_ADD, privatePath);

    expect(result).toMatchObject({ message: '插件市场已添加。', ok: true });
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(observedLeases).toContainEqual(
      expect.objectContaining({
        label: '安装 插件市场',
        target: '插件市场',
      }),
    );
    expect(JSON.stringify(observedLeases)).not.toContain(privatePath);
    expect(pluginManager.mutate).toHaveBeenCalledExactlyOnceWith({
      source: privatePath,
      type: 'marketplace-add',
    });
  });

  it('rejects credentialed marketplace URLs without echoing credentials in errors or busy status', async () => {
    const acquire = vi.fn(() => vi.fn());
    const busyRegistry = { acquire } as unknown as BusyRegistry;
    const pluginManager = createPluginManager();
    const { ipc } = await registerHarness(busyRegistry, pluginManager);
    const credentialedSources = [
      'https://private-user:private-secret@example.com/plugins.git',
      'https://example.com/plugins.git?access_token=private-token#credential',
    ];

    for (const credentialed of credentialedSources) {
      const result = await ipc.invoke(CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_ADD, credentialed);
      expect(result).toMatchObject({
        error: '插件市场地址无效，请填写仓库所有者/仓库名、HTTPS 地址或本机绝对路径。',
        ok: false,
      });
      expect(JSON.stringify(result)).not.toMatch(
        /private-user|private-secret|private-token|credential/,
      );
    }
    expect(acquire).not.toHaveBeenCalled();
    expect(pluginManager.mutate).not.toHaveBeenCalled();
    expect(pluginManager.getCatalog).toHaveBeenCalledTimes(credentialedSources.length);
    expect(pluginManager.getCatalog).toHaveBeenCalledWith(false);
  });

  it('rejects a competing mutation without adding a lease or queueing its side effect', async () => {
    const firstRefresh = deferred<string>();
    const calls: string[][] = [];
    const leaseSnapshots: string[][] = [];
    let listCalls = 0;
    const commandRunner = vi.fn(async (_command: string, argumentsList: string[]) => {
      calls.push(argumentsList);
      if (commandIs(argumentsList, 'plugin', 'list')) {
        listCalls += 1;
        return listCalls === 1 ? firstRefresh.promise : pluginList('after-second@official');
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
    const busyRegistry = new BusyRegistry((leases) => {
      leaseSnapshots.push(leases.map((lease) => lease.id));
    });
    const { ipc } = await registerHarness(busyRegistry, manager as never);

    const first = ipc.invoke(CHANNELS.CLAUDE_PLUGINS_INSTALL, 'first@official');
    await vi.waitFor(() =>
      expect(calls).toContainEqual(['plugin', 'list', '--json', '--available']),
    );
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_REMOVE, 'official'),
    ).resolves.toMatchObject({
      catalog: {
        activeOperation: {
          kind: 'install',
          phase: 'refreshing',
          target: 'first@official',
        },
      },
      ok: false,
    });
    expect(Math.max(...leaseSnapshots.map((snapshot) => snapshot.length))).toBe(1);
    expect(calls).not.toContainEqual(['plugin', 'marketplace', 'remove', 'official']);

    firstRefresh.resolve(pluginList('after-first@official'));
    await expect(first).resolves.toMatchObject({
      catalog: { installed: [expect.objectContaining({ pluginId: 'after-first@official' })] },
      ok: true,
    });
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_REMOVE, 'official'),
    ).resolves.toMatchObject({ ok: true });
    expect(
      calls.filter((argumentsList) => commandIs(argumentsList, 'plugin', 'marketplace', 'remove')),
    ).toEqual([['plugin', 'marketplace', 'remove', 'official']]);
  });

  it('joins identical toggle requests under one busy lease and one CLI side effect', async () => {
    const firstDisable = deferred<string>();
    const calls: string[][] = [];
    const leaseSnapshots: string[][] = [];
    let disableCalls = 0;
    const commandRunner = vi.fn(async (_command: string, argumentsList: string[]) => {
      calls.push(argumentsList);
      if (commandIs(argumentsList, 'plugin', 'disable')) {
        disableCalls += 1;
        return firstDisable.promise;
      }
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
    const busyRegistry = new BusyRegistry((leases) => {
      leaseSnapshots.push(leases.map((lease) => lease.id));
    });
    const { ipc } = await registerHarness(busyRegistry, manager as never);

    const first = ipc.invoke(CHANNELS.CLAUDE_PLUGINS_SET_ENABLED, 'same@official', false);
    await vi.waitFor(() => expect(disableCalls).toBe(1));
    const second = ipc.invoke(CHANNELS.CLAUDE_PLUGINS_SET_ENABLED, 'same@official', false);
    await vi.waitFor(() => expect(leaseSnapshots.length).toBeGreaterThan(0));
    expect(Math.max(...leaseSnapshots.map((snapshot) => snapshot.length))).toBe(1);
    expect(disableCalls).toBe(1);

    firstDisable.resolve('');
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(calls.filter((argumentsList) => commandIs(argumentsList, 'plugin', 'disable'))).toEqual([
      ['plugin', 'disable', 'same@official', '--scope', 'user'],
    ]);
  });
});
