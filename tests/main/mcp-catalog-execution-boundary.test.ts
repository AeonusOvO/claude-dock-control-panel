import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import { McpManager } from '../../src/main/mcp/manager';
import { McpRegistryClient, type McpRegistryFetch } from '../../src/main/mcp/registry-client';
import { McpRegistrySyncService } from '../../src/main/mcp/registry-service';
import { McpRegistrySnapshotStore } from '../../src/main/mcp/registry-snapshot';
import type {
  ApplicationUpdaterState,
  ClaudePluginCatalog,
  McpCatalog,
  SoftwareUpdateState,
} from '../../src/shared/contracts';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness, type IpcHarness } from '../helpers/ipc-harness';
import { createRendererHarness } from '../helpers/renderer-harness';
import { settle } from '../helpers/renderer-interaction-fixture';
import {
  installFakeTerminalModules,
  terminalStatus,
  terminalWorkspace,
} from '../helpers/renderer-terminal-fixture';

const executionHarness = vi.hoisted(() => ({
  runWindowsCommand: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: executionHarness.spawn }));
vi.mock('../../src/main/infra/windows-command', () => ({
  runWindowsCommand: executionHarness.runWindowsCommand,
}));

const REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io';
const REGISTRY_PATH = '/v0.1/servers';
const PROJECT_REMOTE_URL = 'https://project-config.invalid/mcp';
const CREDENTIALED_REMOTE_URL = 'https://credentialed-project.invalid/mcp';
const CODEX_REMOTE_URL = 'https://codex-config.invalid/mcp';
const REGISTRY_PROVIDED_URL = 'https://registry-payload.invalid/mcp';
const CONFIG_TEXT_URL = 'https://config-text.invalid/should-remain-text';

interface Fixture {
  cwd: string;
  home: string;
  root: string;
  userData: string;
}

interface ManagerIpcHarness {
  ipc: IpcHarness;
  validateSender: ReturnType<typeof vi.fn>;
}

const fixtureRoots: string[] = [];

const createFixture = (): Fixture => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-mcp-boundary-'));
  fixtureRoots.push(root);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const userData = path.join(root, 'user-data');
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(userData, { recursive: true });
  return { cwd, home, root, userData };
};

const writeJson = (filePath: string, value: unknown): void => {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const writeUntrustedCatalogSources = ({ cwd, home }: Fixture): void => {
  const projectKey = cwd.replaceAll('\\', '/');
  writeJson(path.join(home, '.claude.json'), {
    mcpServers: {
      userStdio: {
        args: ['--eval', `fetch(${JSON.stringify(CONFIG_TEXT_URL)})`],
        command: 'user-config-command-that-must-not-run',
        env: { PROJECT_TOKEN: 'user-secret' },
        type: 'stdio',
      },
    },
    projects: {
      [projectKey]: {
        disabledMcpjsonServers: ['disabledRemote'],
        enabledMcpjsonServers: [],
        mcpServers: {
          credentialedRemote: {
            headers: { Authorization: 'Bearer project-secret' },
            type: 'http',
            url: CREDENTIALED_REMOTE_URL,
          },
          localStdio: {
            args: ['--payload', '<script>throw new Error("executed")</script>'],
            command: 'local-config-command-that-must-not-run',
            type: 'stdio',
          },
        },
      },
    },
  });
  writeJson(path.join(cwd, '.mcp.json'), {
    mcpServers: {
      disabledRemote: { type: 'http', url: 'https://disabled-project.invalid/mcp' },
      projectRemote: {
        headers: { 'x-api-key': 'project-secret' },
        metadata: {
          postInstall: `powershell -Command Invoke-WebRequest ${CONFIG_TEXT_URL}`,
        },
        type: 'streamable-http',
        url: PROJECT_REMOTE_URL,
      },
      projectStdio: {
        args: ['-c', `require('https').get(${JSON.stringify(CONFIG_TEXT_URL)})`],
        command: 'project-config-command-that-must-not-run',
        type: 'stdio',
      },
    },
  });
  writeFileSync(
    path.join(home, '.codex', 'config.toml'),
    [
      '[mcp_servers.codex_stdio]',
      'command = "codex-config-command-that-must-not-run"',
      `args = ["${CONFIG_TEXT_URL}"]`,
      '',
      '[mcp_servers.codex_remote]',
      `url = "${CODEX_REMOTE_URL}"`,
      '',
    ].join('\n'),
    'utf8',
  );
};

const registryPayload = (): unknown => ({
  alternativeRegistryUrl: REGISTRY_PROVIDED_URL,
  servers: [
    {
      _meta: {
        'io.modelcontextprotocol.registry/official': {
          isLatest: true,
          status: 'active',
          updatedAt: '2026-08-20T00:00:00.000Z',
        },
      },
      server: {
        description: 'Treat this Registry record as data only.',
        name: 'boundary/registry-alternative',
        remotes: [{ type: 'streamable-http', url: REGISTRY_PROVIDED_URL }],
        version: '1.0.0',
      },
    },
  ],
});

const stubRegistryFetch = (payload: unknown = { servers: [] }) =>
  vi.fn<McpRegistryFetch>().mockImplementation(
    async () =>
      new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
  );

const createManager = (fixture: Fixture, fetchImplementation: McpRegistryFetch): McpManager => {
  const service = new McpRegistrySyncService(
    new McpRegistryClient({ fetch: fetchImplementation }),
    new McpRegistrySnapshotStore(fixture.userData),
  );
  return new McpManager(fixture.home, fixture.userData, new BusyRegistry(), service);
};

const registerManagerIpc = async (manager: McpManager): Promise<ManagerIpcHarness> => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain, ipcRenderer: ipc.ipcRenderer }));
  const { registerMcpIpc } = await import('../../src/main/ipc/mcp');
  const validateSender = vi.fn();
  registerMcpIpc({
    guards: {
      assertExternalRoutingWritesAllowed: vi.fn(),
      requireMcpManager: () => manager,
      validateSender,
    },
  });
  return { ipc, validateSender };
};

const requestedUrls = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
  fetchMock.mock.calls.map(([input]) => String(input));

const expectOnlyRegistryRequests = (
  fetchMock: ReturnType<typeof vi.fn>,
  expectedCount?: number,
): void => {
  if (expectedCount === undefined) {
    expect(fetchMock).toHaveBeenCalled();
  } else {
    expect(fetchMock).toHaveBeenCalledTimes(expectedCount);
  }
  for (const [input, init] of fetchMock.mock.calls) {
    const requested = new URL(String(input));
    expect(requested.origin).toBe(REGISTRY_ORIGIN);
    expect(requested.pathname).toBe(REGISTRY_PATH);
    expect(requested.searchParams.get('limit')).toBe('50');
    expect(requested.searchParams.get('include_deleted')).toBe('true');
    expect(init).toEqual(expect.objectContaining({ redirect: 'error' }));
  }
};

const expectNoDiscoveredExecution = (fetchMock: ReturnType<typeof vi.fn>): void => {
  expect(executionHarness.spawn).not.toHaveBeenCalled();
  const urls = requestedUrls(fetchMock);
  for (const untrustedUrl of [
    PROJECT_REMOTE_URL,
    CREDENTIALED_REMOTE_URL,
    CODEX_REMOTE_URL,
    REGISTRY_PROVIDED_URL,
    CONFIG_TEXT_URL,
  ]) {
    expect(urls).not.toContain(untrustedUrl);
  }
};

const server = (catalog: McpCatalog, name: string) =>
  catalog.installed.find((candidate) => candidate.name === name);

const expectStrictServerViews = (catalog: McpCatalog): void => {
  const expectedKeys = [
    'client',
    'configPath',
    'enabled',
    'health',
    'healthDetail',
    'name',
    'scope',
    'toggleSupported',
    'transport',
  ];
  expect(catalog.installed.length).toBeGreaterThan(0);
  for (const installed of catalog.installed) {
    expect(Object.keys(installed).sort()).toEqual(expectedKeys);
  }

  const serialized = JSON.stringify(catalog.installed);
  for (const forbidden of [
    '"args"',
    '"command"',
    '"config"',
    '"env"',
    '"headers"',
    '"metadata"',
    '"url"',
    'Authorization',
    'PROJECT_TOKEN',
    'project-secret',
    'user-secret',
    'config-command-that-must-not-run',
    PROJECT_REMOTE_URL,
    CREDENTIALED_REMOTE_URL,
    CODEX_REMOTE_URL,
    CONFIG_TEXT_URL,
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
};

const pluginCatalog: ClaudePluginCatalog = {
  available: [],
  checkedAt: 1,
  cliAvailable: true,
  installed: [],
  marketplaces: [],
  message: 'No plugin updates.',
  updatesAvailable: 0,
};

const softwareUpdates: SoftwareUpdateState = {
  checkedAt: 1,
  claudeCode: {
    currentVersion: '1.0.0',
    installed: true,
    message: 'Current.',
    updateAvailable: false,
  },
  router: {
    currentVersion: '1.0.0',
    installed: true,
    message: 'Current.',
    updateAvailable: false,
  },
};

const applicationUpdater: ApplicationUpdaterState = {
  currentVersion: '5.0.0',
  message: 'Current.',
  phase: 'idle',
};

beforeEach(() => {
  executionHarness.runWindowsCommand.mockReset();
  executionHarness.runWindowsCommand.mockResolvedValue('');
  executionHarness.spawn.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('electron');
  vi.resetModules();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('MCP catalog execution boundary', () => {
  it('keeps discovery inert and projects strict server DTOs at service, IPC, and preload boundaries', async () => {
    const fixture = createFixture();
    writeUntrustedCatalogSources(fixture);
    const fetchMock = stubRegistryFetch();
    const manager = createManager(fixture, fetchMock);
    const serviceCatalog = await manager.getCatalog(fixture.cwd, false);
    const { ipc, validateSender } = await registerManagerIpc(manager);

    const catalog = await ipc.invoke(CHANNELS.MCP_GET_CATALOG, fixture.cwd, false);
    const { mcpBridge } = await import('../../src/preload/bridges/mcp');
    const preloadCatalog = await mcpBridge.getMcpCatalog(fixture.cwd, false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    for (const boundaryCatalog of [serviceCatalog, catalog, preloadCatalog]) {
      expectStrictServerViews(boundaryCatalog);
    }
    expect(validateSender).toHaveBeenCalledTimes(2);
    expect(catalog.installed.map(({ client, name }) => ({ client, name }))).toEqual(
      expect.arrayContaining([
        { client: 'claude', name: 'userStdio' },
        { client: 'claude', name: 'localStdio' },
        { client: 'claude', name: 'credentialedRemote' },
        { client: 'claude', name: 'projectStdio' },
        { client: 'claude', name: 'projectRemote' },
        { client: 'codex', name: 'codex_stdio' },
        { client: 'codex', name: 'codex_remote' },
      ]),
    );
    expect(
      catalog.installed
        .filter(({ enabled }) => enabled)
        .every(({ health }) => health === 'unknown'),
    ).toBe(true);
    expect(catalog.installed.some(({ health }) => health === 'failed')).toBe(false);
    expect(server(catalog, 'credentialedRemote')).toMatchObject({
      client: 'claude',
      health: 'unknown',
      transport: 'http',
    });
    expect(server(catalog, 'codex_stdio')).toMatchObject({
      client: 'codex',
      health: 'unknown',
      transport: 'stdio',
    });
    expect(server(catalog, 'codex_remote')).toMatchObject({
      client: 'codex',
      health: 'unknown',
      transport: 'http',
    });
    expect(executionHarness.runWindowsCommand).not.toHaveBeenCalled();
    expectOnlyRegistryRequests(fetchMock, 2);
    expectNoDiscoveredExecution(fetchMock);
  });

  it('routes startup and manual global refresh through the fixed Registry only', async () => {
    const fixture = createFixture();
    writeUntrustedCatalogSources(fixture);
    const fetchMock = stubRegistryFetch(registryPayload());
    const manager = createManager(fixture, fetchMock);
    const { ipc } = await registerManagerIpc(manager);
    const catalogs: McpCatalog[] = [];
    const status = terminalStatus(1, { cwd: fixture.cwd, title: 'MCP boundary fixture' });
    const terminalControl = installFakeTerminalModules();
    const renderer = await createRendererHarness({
      getApplicationUpdaterState: vi.fn(async () => applicationUpdater),
      getMcpBackups: vi.fn(async () => []),
      getMcpCatalog: vi.fn(async (cwd, refreshRegistry) => {
        const catalog = await ipc.invoke(CHANNELS.MCP_GET_CATALOG, cwd, refreshRegistry ?? false);
        catalogs.push(catalog);
        return catalog;
      }),
      getSoftwareUpdates: vi.fn(async () => softwareUpdates),
      getWorkspace: vi.fn(async () => terminalWorkspace(status)),
      refreshClaudePluginMarketplaces: vi.fn(async () => ({
        catalog: pluginCatalog,
        message: 'Plugin refresh complete.',
        ok: true,
      })),
    });

    try {
      await settle(renderer);
      await vi.waitFor(() =>
        expect(renderer.method('getMcpCatalog')).toHaveBeenCalledWith(fixture.cwd, true),
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      expectOnlyRegistryRequests(fetchMock, 2);
      expect(catalogs).toHaveLength(1);
      const registryEntry = catalogs[0]?.available.find((entry) => !entry.featured);
      expect(registryEntry).toEqual(
        expect.objectContaining({
          id: expect.stringMatching(/^registry:[a-f0-9]{64}$/u),
          installable: false,
          name: 'boundary/registry-alternative',
          transport: 'http',
        }),
      );
      expect(registryEntry).not.toHaveProperty('config');
      expect(registryEntry).not.toHaveProperty('officialUrl');
      expect(JSON.stringify(registryEntry)).not.toContain(REGISTRY_PROVIDED_URL);
      expect(server(catalogs[0]!, 'credentialedRemote')?.health).toBe('unknown');
      expect(server(catalogs[0]!, 'codex_stdio')?.health).toBe('unknown');
      expectNoDiscoveredExecution(fetchMock);
      expect(executionHarness.runWindowsCommand).not.toHaveBeenCalled();

      fetchMock.mockClear();
      renderer.clearCalls();
      renderer.click('#refresh-updates');
      await settle(renderer);
      await vi.waitFor(() =>
        expect(renderer.method('getMcpCatalog')).toHaveBeenCalledWith(fixture.cwd, true),
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      expectOnlyRegistryRequests(fetchMock, 2);
      expect(catalogs).toHaveLength(2);
      expect(catalogs[1]?.installed.some(({ health }) => health === 'failed')).toBe(false);
      expect(server(catalogs[1]!, 'credentialedRemote')?.health).toBe('unknown');
      expect(server(catalogs[1]!, 'codex_remote')?.health).toBe('unknown');
      expectNoDiscoveredExecution(fetchMock);
      expect(executionHarness.runWindowsCommand).not.toHaveBeenCalled();
    } finally {
      await renderer.cleanup();
      terminalControl.uninstall();
    }
  });

  it('rejects Registry and unknown IDs before any direct-install command is constructed', async () => {
    const fixture = createFixture();
    const fetchMock = stubRegistryFetch(registryPayload());
    const manager = createManager(fixture, fetchMock);

    await expect(
      manager.install({
        catalogId: 'registry:renderer-selected-payload',
        cwd: fixture.cwd,
        scope: 'project',
      }),
    ).rejects.toThrow('不在 ClaudeDock 直接安装白名单中');
    await expect(
      manager.install({
        catalogId: '__proto__',
        cwd: fixture.cwd,
        scope: 'project',
      }),
    ).rejects.toThrow('不在 ClaudeDock 直接安装白名单中');

    expect(executionHarness.runWindowsCommand).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps post-install and post-remove catalog reloads inert while faking only the explicit Claude CLI mutation', async () => {
    const fixture = createFixture();
    writeJson(path.join(fixture.cwd, '.mcp.json'), { mcpServers: {} });
    const fetchMock = stubRegistryFetch();
    executionHarness.runWindowsCommand.mockImplementation(
      async (command: string, argumentsList: string[]) => {
        expect(command).toBe('claude');
        if (argumentsList[1] === 'add-json') {
          writeJson(path.join(fixture.cwd, '.mcp.json'), {
            mcpServers: {
              afterInstallCredentialedRemote: {
                headers: { Authorization: 'Bearer post-install-secret' },
                type: 'http',
                url: CREDENTIALED_REMOTE_URL,
              },
              afterInstallStdio: {
                args: ['--eval', `fetch(${JSON.stringify(CONFIG_TEXT_URL)})`],
                command: 'post-install-project-command-that-must-not-run',
                type: 'stdio',
              },
            },
          });
        } else if (argumentsList[1] === 'remove') {
          writeJson(path.join(fixture.cwd, '.mcp.json'), {
            mcpServers: {
              afterRemoveRemote: { type: 'http', url: PROJECT_REMOTE_URL },
              afterRemoveStdio: {
                command: 'post-remove-project-command-that-must-not-run',
                type: 'stdio',
              },
            },
          });
        }
        return '';
      },
    );
    const manager = createManager(fixture, fetchMock);
    const { ipc } = await registerManagerIpc(manager);

    const installed = await ipc.invoke(CHANNELS.MCP_INSTALL, {
      catalogId: 'curated:filesystem',
      cwd: fixture.cwd,
      scope: 'project',
    });

    expect(installed.ok).toBe(true);
    expect(executionHarness.runWindowsCommand).toHaveBeenCalledOnce();
    const [installCommand, installArguments] = executionHarness.runWindowsCommand.mock.calls[0]!;
    expect(installCommand).toBe('claude');
    expect(installArguments.slice(0, 5)).toEqual([
      'mcp',
      'add-json',
      '--scope',
      'project',
      'filesystem',
    ]);
    expect(JSON.parse(String(installArguments[5]))).toEqual({
      args: ['-y', '@modelcontextprotocol/server-filesystem@2026.7.10', path.resolve(fixture.cwd)],
      command: 'npx',
      type: 'stdio',
    });
    expect(server(installed.catalog, 'afterInstallStdio')).toMatchObject({
      health: 'unknown',
      transport: 'stdio',
    });
    expect(server(installed.catalog, 'afterInstallCredentialedRemote')).toMatchObject({
      health: 'unknown',
      transport: 'http',
    });
    expect(installed.catalog.installed.some(({ health }) => health === 'failed')).toBe(false);
    expect(executionHarness.spawn).not.toHaveBeenCalled();
    expectOnlyRegistryRequests(fetchMock);
    expectNoDiscoveredExecution(fetchMock);

    fetchMock.mockClear();
    const removed = await ipc.invoke(CHANNELS.MCP_REMOVE, {
      cwd: fixture.cwd,
      name: 'afterInstallStdio',
      scope: 'project',
    });

    expect(removed.ok).toBe(true);
    expect(server(removed.catalog, 'afterInstallStdio')).toBeUndefined();
    expect(server(removed.catalog, 'afterRemoveStdio')).toMatchObject({
      health: 'unknown',
      transport: 'stdio',
    });
    expect(server(removed.catalog, 'afterRemoveRemote')).toMatchObject({
      health: 'unknown',
      transport: 'http',
    });
    expect(removed.catalog.installed.some(({ health }) => health === 'failed')).toBe(false);
    expectOnlyRegistryRequests(fetchMock, 2);
    expectNoDiscoveredExecution(fetchMock);
    expect(executionHarness.runWindowsCommand).toHaveBeenCalledTimes(2);
    expect(executionHarness.runWindowsCommand.mock.calls.map(([command]) => command)).toEqual([
      'claude',
      'claude',
    ]);
    expect(JSON.stringify(executionHarness.runWindowsCommand.mock.calls)).not.toContain(
      'project-command-that-must-not-run',
    );
  });

  it('keeps the actual toggle write and its returned post-mutation catalog inert', async () => {
    const fixture = createFixture();
    const projectKey = fixture.cwd.replaceAll('\\', '/');
    writeJson(path.join(fixture.home, '.claude.json'), {
      projects: {
        [projectKey]: {
          disabledMcpjsonServers: [],
          enabledMcpjsonServers: ['toggleTarget'],
        },
      },
    });
    writeJson(path.join(fixture.cwd, '.mcp.json'), {
      mcpServers: {
        toggleCredentialedRemote: {
          headers: { Authorization: 'Bearer toggle-secret' },
          type: 'http',
          url: CREDENTIALED_REMOTE_URL,
        },
        toggleTarget: {
          args: ['--eval', `fetch(${JSON.stringify(CONFIG_TEXT_URL)})`],
          command: 'toggle-project-command-that-must-not-run',
          type: 'stdio',
        },
      },
    });
    const fetchMock = stubRegistryFetch();
    const manager = createManager(fixture, fetchMock);
    const { ipc } = await registerManagerIpc(manager);

    await expect(
      ipc.invoke(CHANNELS.MCP_TOGGLE_DISCARD, '------------------------------------'),
    ).rejects.toThrow('MCP 改动预览标识无效');
    const abandoned = await ipc.invoke(
      CHANNELS.MCP_TOGGLE_PREVIEW,
      fixture.cwd,
      'toggleTarget',
      false,
    );
    await expect(ipc.invoke(CHANNELS.MCP_TOGGLE_DISCARD, abandoned.id)).resolves.toBe(true);
    await expect(ipc.invoke(CHANNELS.MCP_TOGGLE_DISCARD, abandoned.id)).resolves.toBe(false);
    const preview = await ipc.invoke(
      CHANNELS.MCP_TOGGLE_PREVIEW,
      fixture.cwd,
      'toggleTarget',
      false,
    );
    const result = await ipc.invoke(CHANNELS.MCP_TOGGLE_APPLY, preview.id, fixture.cwd);

    expect(result.ok).toBe(true);
    expect(server(result.catalog, 'toggleTarget')).toMatchObject({
      enabled: false,
      health: 'disabled',
      transport: 'stdio',
    });
    expect(server(result.catalog, 'toggleCredentialedRemote')).toMatchObject({
      enabled: true,
      health: 'unknown',
      transport: 'http',
    });
    expect(result.catalog.installed.some(({ health }) => health === 'failed')).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(fixture.home, '.claude.json'), 'utf8')).projects[
        projectKey
      ],
    ).toMatchObject({
      disabledMcpjsonServers: ['toggleTarget'],
      enabledMcpjsonServers: [],
    });
    expect(executionHarness.runWindowsCommand).not.toHaveBeenCalled();
    expectOnlyRegistryRequests(fetchMock, 2);
    expectNoDiscoveredExecution(fetchMock);
  });
});
