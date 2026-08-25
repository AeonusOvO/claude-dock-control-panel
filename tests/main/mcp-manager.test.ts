import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import { discoverMcpServers, McpManager, type McpManagerOptions } from '../../src/main/mcp/manager';
import { McpRegistryClient, type McpRegistryFetch } from '../../src/main/mcp/registry-client';
import { McpRegistrySyncService } from '../../src/main/mcp/registry-service';
import { McpRegistrySnapshotStore } from '../../src/main/mcp/registry-snapshot';
import type { McpTogglePreview } from '../../src/shared/contracts';
import { CURATED_MCP_SERVERS } from '../../src/shared/ui/mcp-catalog';
import { createRendererHarness } from '../helpers/renderer-harness';

const childProcessHarness = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: childProcessHarness.spawn }));

const REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io';
const REGISTRY_PATH = '/v0.1/servers';
const temporaryDirectories: string[] = [];

const registryWrapper = (
  name: string,
  options: {
    description?: string;
    remoteUrl?: string;
    status?: 'active' | 'deleted' | 'deprecated';
    updatedAt?: string;
    version?: string;
  } = {},
): unknown => {
  const status = options.status ?? 'active';
  return {
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        isLatest: status !== 'deleted',
        status,
        ...(status === 'active' ? {} : { statusMessage: `${status} record` }),
        updatedAt: options.updatedAt ?? '2026-08-20T00:00:00.000Z',
      },
    },
    server: {
      description: options.description ?? `${name} description`,
      name,
      ...(options.remoteUrl
        ? { remotes: [{ type: 'streamable-http', url: options.remoteUrl }] }
        : {}),
      version: options.version ?? '1.0.0',
    },
  };
};

const registryResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });

const registryFetch = (payload: unknown): Mock<McpRegistryFetch> =>
  vi.fn<McpRegistryFetch>().mockImplementation(async () => registryResponse(payload));

const deferred = <T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

const registryService = (
  userData: string,
  fetchImplementation: McpRegistryFetch,
  now: number = Date.parse('2026-08-20T01:02:03.004Z'),
): McpRegistrySyncService =>
  new McpRegistrySyncService(
    new McpRegistryClient({ fetch: fetchImplementation }),
    new McpRegistrySnapshotStore(userData),
    { now: () => now },
  );

const managerWithRegistry = (
  home: string,
  userData: string,
  fetchImplementation: McpRegistryFetch,
  now?: number,
  options: McpManagerOptions = {},
): { manager: McpManager; service: McpRegistrySyncService } => {
  const service = registryService(userData, fetchImplementation, now);
  return {
    manager: new McpManager(home, userData, new BusyRegistry(), service, options),
    service,
  };
};

const requestedRegistryUrl = (fetchMock: Mock<McpRegistryFetch>): URL => {
  const input = fetchMock.mock.calls.at(-1)?.[0];
  if (!input) throw new Error('Registry fetch was not called.');
  return new URL(String(input));
};

const createCatalogFixture = (prefix: string) => {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const userData = path.join(root, 'user-data');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(userData, { recursive: true });
  return { cwd, home, userData };
};

beforeEach(() => {
  childProcessHarness.spawn.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('MCP discovery', () => {
  it('keeps Claude scopes, Codex origin, source paths and disabled state distinct', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-mcp-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const normalizedCwd = cwd.replaceAll('\\', '/');
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { userServer: { command: 'node' } },
        projects: {
          [normalizedCwd]: {
            disabledMcpjsonServers: ['sharedServer'],
            enabledMcpjsonServers: [],
            mcpServers: { localServer: { type: 'sse', url: 'https://example.com/sse' } },
          },
        },
      }),
    );
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: { sharedServer: { type: 'http', url: 'https://example.com/mcp' } },
      }),
    );
    writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.codex_server]\ncommand = "node"\n',
    );

    const servers = discoverMcpServers(home, cwd);
    expect(
      servers.map(({ client, enabled, name, scope, transport }) => ({
        client,
        enabled,
        name,
        scope,
        transport,
      })),
    ).toEqual([
      { client: 'claude', enabled: true, name: 'userServer', scope: 'user', transport: 'stdio' },
      { client: 'claude', enabled: true, name: 'localServer', scope: 'local', transport: 'sse' },
      {
        client: 'claude',
        enabled: false,
        name: 'sharedServer',
        scope: 'project',
        transport: 'http',
      },
      { client: 'codex', enabled: true, name: 'codex_server', scope: 'user', transport: 'stdio' },
    ]);
    expect(servers.every((server) => path.isAbsolute(server.configPath))).toBe(true);
  });

  it('ships renderer-safe offline curated metadata without secret or config authority', () => {
    expect(CURATED_MCP_SERVERS.length).toBeGreaterThanOrEqual(3);
    expect(CURATED_MCP_SERVERS.every((entry) => entry.featured && entry.installable)).toBe(true);
    expect(CURATED_MCP_SERVERS.every((entry) => !entry.requiresCredential)).toBe(true);
    expect(JSON.stringify(CURATED_MCP_SERVERS)).not.toMatch(/"(?:args|command|config|url)"/u);
  });

  it('keeps startup and forced catalog refresh inert for enabled project stdio commands', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-mcp-inert-stdio-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    const userData = path.join(root, 'user-data');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          malicious: {
            args: ['-NoProfile', '-Command', 'throw "catalog discovery executed me"'],
            command: 'powershell.exe',
            type: 'stdio',
          },
        },
      }),
    );
    const fetchMock = registryFetch({ servers: [] });
    const { manager } = managerWithRegistry(home, userData, fetchMock);

    const catalog = await manager.getCatalog(cwd, true);

    expect(catalog.installed).toEqual([
      expect.objectContaining({
        enabled: true,
        health: 'unknown',
        name: 'malicious',
        scope: 'project',
        transport: 'stdio',
      }),
    ]);
    expect(childProcessHarness.spawn).not.toHaveBeenCalled();
  });

  it('keeps a forced full refresh distinct from an in-flight ordinary catalog projection', async () => {
    const { cwd, home, userData } = createCatalogFixture('claudedock-mcp-force-overlap-');
    const response = deferred<Response>();
    const fetchMock = vi
      .fn<McpRegistryFetch>()
      .mockImplementationOnce(() => response.promise)
      .mockImplementationOnce(async () => registryResponse({ servers: [] }));
    const { manager, service } = managerWithRegistry(home, userData, fetchMock);

    const ordinaryCatalog = manager.getCatalog(cwd);
    const forcedCatalog = manager.getCatalog(cwd, true);
    const duplicateForcedCatalog = manager.getCatalog(cwd, true);

    expect(forcedCatalog).not.toBe(ordinaryCatalog);
    expect(duplicateForcedCatalog).toBe(forcedCatalog);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    response.resolve(
      registryResponse({
        servers: [registryWrapper('example/forced-overlap', { version: '1.0.0' })],
      }),
    );

    const [ordinary, forced] = await Promise.all([ordinaryCatalog, forcedCatalog]);
    expect(ordinary.available.some(({ name }) => name === 'example/forced-overlap')).toBe(false);
    expect(forced.available.some(({ name }) => name === 'example/forced-overlap')).toBe(true);
    expect(service.getState()).toMatchObject({ mode: 'live', syncKind: 'full' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('synchronizes only the trusted Registry without probing project remote endpoints', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-mcp-inert-remote-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    const userData = path.join(root, 'user-data');
    const projectEndpoint = 'https://project-defined.invalid/mcp';
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          remoteMalicious: { type: 'http', url: projectEndpoint },
        },
      }),
    );
    const registryEndpoint = 'https://catalog-defined.invalid/mcp';
    const registryDescription = '<img src=x onerror="throw new Error(\'executed\')">';
    const fetchMock = registryFetch({
      servers: [
        registryWrapper('example/recommendation', {
          description: registryDescription,
          remoteUrl: registryEndpoint,
        }),
      ],
    });
    const { manager, service } = managerWithRegistry(home, userData, fetchMock);

    const catalog = await manager.getCatalog(cwd, true);

    expect(catalog.installed).toEqual([
      expect.objectContaining({
        enabled: true,
        health: 'unknown',
        name: 'remoteMalicious',
        scope: 'project',
        transport: 'http',
      }),
    ]);
    const registryEntry = catalog.available.find((entry) => !entry.featured);
    expect(registryEntry).toEqual({
      description: registryDescription,
      featured: false,
      id: expect.stringMatching(/^registry:[a-f0-9]{64}$/u),
      installable: false,
      name: 'example/recommendation',
      requiresCredential: false,
      transport: 'http',
    });
    expect(registryEntry).not.toHaveProperty('config');
    expect(registryEntry).not.toHaveProperty('officialUrl');
    expect(JSON.stringify(registryEntry)).not.toContain(registryEndpoint);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.origin).toBe(REGISTRY_ORIGIN);
    expect(requested.pathname).toBe(REGISTRY_PATH);
    expect(requested.searchParams.get('include_deleted')).toBe('true');
    expect(requested.searchParams.get('updated_since')).toBeNull();
    expect(service.getState()).toMatchObject({ mode: 'live', syncKind: 'full' });
    expect(existsSync(path.join(userData, 'mcp', 'registry-snapshot.json'))).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(projectEndpoint);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(registryEndpoint);
    expect(childProcessHarness.spawn).not.toHaveBeenCalled();
  });

  it('uses the durable watermark for ordinary incremental synchronization', async () => {
    const { cwd, home, userData } = createCatalogFixture('claudedock-mcp-incremental-');
    const initialFetch = registryFetch({
      servers: [registryWrapper('example/incremental', { version: '1.0.0' })],
    });
    const initial = managerWithRegistry(home, userData, initialFetch);
    await initial.manager.getCatalog(cwd, true);
    const watermark = initial.service.getState().synchronizedThrough;
    expect(watermark).toBe('2026-08-20T00:00:00.000Z');

    const incrementalFetch = registryFetch({
      servers: [
        registryWrapper('example/incremental', {
          updatedAt: '2026-08-20T02:00:00.000Z',
          version: '2.0.0',
        }),
      ],
    });
    const incremental = managerWithRegistry(
      home,
      userData,
      incrementalFetch,
      Date.parse('2026-08-20T03:00:00.000Z'),
    );

    const snapshotCatalog = await incremental.manager.getCatalog(cwd);
    expect(snapshotCatalog.available.some(({ name }) => name === 'example/incremental')).toBe(true);
    await vi.waitFor(() => expect(incrementalFetch).toHaveBeenCalledOnce());
    const requested = requestedRegistryUrl(incrementalFetch);
    expect(requested.searchParams.get('updated_since')).toBe(watermark);
    await vi.waitFor(() =>
      expect(incremental.service.getState()).toMatchObject({
        mode: 'live',
        syncKind: 'incremental',
      }),
    );
  });

  it('reopens cached projects without refetching and preserves caches for unchanged Registry content', async () => {
    const { cwd, home, userData } = createCatalogFixture('claudedock-mcp-revalidate-');
    let now = 1_000;
    const fetchMock = vi
      .fn<McpRegistryFetch>()
      .mockResolvedValueOnce(
        registryResponse({ servers: [registryWrapper('example/stable', { version: '1.0.0' })] }),
      )
      .mockResolvedValueOnce(registryResponse({ servers: [] }))
      .mockResolvedValueOnce(registryResponse({ servers: [] }));
    const { manager, service } = managerWithRegistry(home, userData, fetchMock, undefined, {
      catalogCacheTtlMs: 10,
      now: () => now,
      registryRevalidateIntervalMs: 100,
    });

    await manager.getCatalog(cwd);
    await vi.waitFor(() =>
      expect(service.getState()).toMatchObject({ mode: 'live', syncKind: 'full' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now += 11;
    const reopened = await manager.getCatalog(cwd);
    expect(reopened.available.some(({ name }) => name === 'example/stable')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now = 1_101;
    const revision = service.getContentRevision();
    const beforeUnchangedSync = await manager.getCatalog(cwd);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(service.getState()).toMatchObject({ mode: 'live', syncKind: 'incremental' }),
    );
    expect(service.getContentRevision()).toBe(revision);

    now += 1;
    const afterUnchangedSync = await manager.getCatalog(cwd);
    expect(afterUnchangedSync.checkedAt).toBe(beforeUnchangedSync.checkedAt);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves a durable last-known-good catalog in degraded state', async () => {
    const { cwd, home, userData } = createCatalogFixture('claudedock-mcp-degraded-');
    const online = managerWithRegistry(
      home,
      userData,
      registryFetch({ servers: [registryWrapper('example/durable')] }),
    );
    await online.manager.getCatalog(cwd, true);

    const failingFetch = vi
      .fn<McpRegistryFetch>()
      .mockRejectedValue(new Error('Registry is offline'));
    const offline = managerWithRegistry(home, userData, failingFetch);
    const catalog = await offline.manager.getCatalog(cwd, true);

    expect(offline.service.getState()).toMatchObject({
      fallback: 'snapshot',
      mode: 'degraded',
    });
    expect(catalog.registryAvailable).toBe(false);
    expect(catalog.message).toContain('保留上次可用目录');
    expect(catalog.available.some(({ id }) => id === 'curated:filesystem')).toBe(true);
    expect(catalog.available.some(({ name }) => name === 'example/durable')).toBe(true);
  });

  it('preserves the live catalog when a forced full result is implausibly empty', async () => {
    const { cwd, home, userData } = createCatalogFixture('claudedock-mcp-empty-full-');
    const fetchMock = vi
      .fn<McpRegistryFetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ servers: [registryWrapper('example/last-known-good')] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [] }), { status: 200 }));
    const { manager, service } = managerWithRegistry(home, userData, fetchMock);
    await manager.getCatalog(cwd, true);

    const catalog = await manager.getCatalog(cwd, true);

    expect(service.getState()).toMatchObject({
      failure: { code: 'empty-full-result', stage: 'normalize' },
      fallback: 'live',
      mode: 'degraded',
    });
    expect(catalog.available.some(({ name }) => name === 'example/last-known-good')).toBe(true);
    expect(catalog.registryAvailable).toBe(false);
  });

  it('persists incremental tombstones and removes deleted Registry entries from browsing', async () => {
    const { cwd, home, userData } = createCatalogFixture('claudedock-mcp-tombstone-');
    const active = managerWithRegistry(
      home,
      userData,
      registryFetch({ servers: [registryWrapper('example/deleted', { version: '1.0.0' })] }),
    );
    await active.manager.getCatalog(cwd, true);
    const watermark = active.service.getState().synchronizedThrough;

    const tombstoneFetch = registryFetch({
      servers: [
        registryWrapper('example/deleted', {
          status: 'deleted',
          updatedAt: '2026-08-20T04:00:00.000Z',
          version: '1.0.0',
        }),
      ],
    });
    const tombstoned = managerWithRegistry(
      home,
      userData,
      tombstoneFetch,
      Date.parse('2026-08-20T05:00:00.000Z'),
    );
    await tombstoned.manager.getCatalog(cwd);
    await vi.waitFor(() =>
      expect(tombstoned.service.getState()).toMatchObject({
        mode: 'live',
        syncKind: 'incremental',
      }),
    );
    expect(requestedRegistryUrl(tombstoneFetch).searchParams.get('updated_since')).toBe(watermark);

    const reloaded = managerWithRegistry(
      home,
      userData,
      vi.fn<McpRegistryFetch>().mockRejectedValue(new Error('offline')),
      Date.parse('2026-08-20T05:00:01.000Z'),
    );
    const catalog = await reloaded.manager.getCatalog(cwd);
    expect(catalog.message).toContain('持久化注册表快照');
    expect(catalog.available.some(({ name }) => name === 'example/deleted')).toBe(false);
    expect(catalog.available.some(({ id }) => id === 'curated:filesystem')).toBe(true);
  });

  it('exposes only explicit per-server MCP actions', async () => {
    const harness = await createRendererHarness();
    try {
      harness.click('[data-extension-tab="mcp"]');
      await harness.flush();

      const page = harness.query<HTMLElement>('[data-rail-page="mcp"]');
      expect(page.textContent).toContain('每次只安装你明确选择的一项');
      expect(page.querySelector('[data-mcp-action="install-all"]')).toBeNull();
      expect(page.querySelector('[data-mcp-action="sync-all"]')).toBeNull();
      expect(page.textContent).not.toMatch(/一键全装|同步全部 MCP/i);
    } finally {
      await harness.cleanup();
    }
  });

  it('bounds toggle previews, discards cancellations, expires abandoned work, and retains no config bytes', async () => {
    const { cwd, home, userData } = createCatalogFixture('claudedock-mcp-preview-bounds-');
    let now = 10_000;
    const projectKey = cwd.replaceAll('\\', '/');
    writeFileSync(
      path.join(home, '.claude.json'),
      `${JSON.stringify({
        projects: {
          [projectKey]: {
            disabledMcpjsonServers: [],
            enabledMcpjsonServers: ['sharedServer'],
            mcpServers: {
              privateServer: { env: { PRIVATE_TOKEN: 'must-not-be-retained' }, type: 'stdio' },
            },
          },
        },
      })}\n`,
    );
    const { manager } = managerWithRegistry(
      home,
      userData,
      registryFetch({ servers: [] }),
      undefined,
      { now: () => now },
    );
    const pendingState = manager as unknown as {
      pendingToggleMetadataBytes: number;
      pendingToggles: Map<string, unknown>;
    };

    const cancelled = manager.previewToggle(cwd, 'sharedServer', false);
    expect(pendingState.pendingToggles.size).toBe(1);
    expect(pendingState.pendingToggleMetadataBytes).toBeGreaterThan(0);
    expect(JSON.stringify([...pendingState.pendingToggles.values()])).not.toContain(
      'must-not-be-retained',
    );
    expect(JSON.stringify([...pendingState.pendingToggles.values()])).not.toContain('afterBytes');
    expect(manager.discardToggle(cancelled.id)).toBe(true);
    expect(manager.discardToggle(cancelled.id)).toBe(false);
    expect(pendingState.pendingToggleMetadataBytes).toBe(0);

    const expired = manager.previewToggle(cwd, 'sharedServer', false);
    now += 5 * 60_000;
    await manager.getCatalog(cwd);
    expect(manager.discardToggle(expired.id)).toBe(false);
    await expect(manager.applyToggle(expired.id)).rejects.toThrow('已过期');

    const bounded: McpTogglePreview[] = [];
    for (let index = 0; index < 32; index += 1) {
      bounded.push(manager.previewToggle(cwd, 'sharedServer', index % 2 === 0));
    }
    expect(() => manager.previewToggle(cwd, 'sharedServer', true)).toThrow('待确认的 MCP 改动过多');
    for (const preview of bounded) expect(manager.discardToggle(preview.id)).toBe(true);
    expect(pendingState.pendingToggles.size).toBe(0);
    expect(pendingState.pendingToggleMetadataBytes).toBe(0);

    const oversizedCwd = path.join(path.dirname(cwd), 'x'.repeat(300 * 1024));
    writeFileSync(
      path.join(home, '.claude.json'),
      `${JSON.stringify({
        projects: {
          [oversizedCwd.replaceAll('\\', '/')]: {
            disabledMcpjsonServers: [],
            enabledMcpjsonServers: ['sharedServer'],
          },
        },
      })}\n`,
    );
    expect(() => manager.previewToggle(oversizedCwd, 'sharedServer', false)).toThrow(
      '待确认的 MCP 改动元数据过大',
    );
    expect(pendingState.pendingToggles.size).toBe(0);
    expect(pendingState.pendingToggleMetadataBytes).toBe(0);
  });

  it('previews, backs up, atomically toggles and byte-restores project MCP state', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-mcp-toggle-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    const userData = path.join(root, 'user-data');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const configPath = path.join(home, '.claude.json');
    const original = Buffer.from(
      `${JSON.stringify({
        projects: {
          [cwd.replaceAll('\\', '/')]: {
            disabledMcpjsonServers: [],
            enabledMcpjsonServers: ['sharedServer'],
          },
        },
      })}\n`,
    );
    writeFileSync(configPath, original);
    const { manager } = managerWithRegistry(home, userData, registryFetch({ servers: [] }));

    const preview = manager.previewToggle(cwd, 'sharedServer', false);
    expect(preview.targetPath).toBe(configPath);
    expect(preview.after).toContain('disabledMcpjsonServers');
    await manager.applyToggle(preview.id);
    await expect(manager.applyToggle(preview.id)).rejects.toThrow('已过期');
    expect(
      JSON.parse(readFileSync(configPath, 'utf8')).projects[cwd.replaceAll('\\', '/')],
    ).toMatchObject({
      disabledMcpjsonServers: ['sharedServer'],
      enabledMcpjsonServers: [],
    });

    const [backup] = manager.listBackups();
    expect(backup).toBeDefined();
    await manager.restoreBackup(backup!.id, cwd);
    expect(readFileSync(configPath)).toEqual(original);
  });
});
