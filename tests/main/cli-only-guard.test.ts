import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeConfigurationHint } from '../../src/shared/contracts';
import { ClaudeRouterManager } from '../../src/main/claude/router-manager';
import {
  createTestMainServiceRegistry,
  registerTestService,
} from '../helpers/main-service-registry';

const fixtureRoots: string[] = [];

const createFixtureRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-cli-only-'));
  fixtureRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
  vi.doUnmock('electron');
  vi.doUnmock('node:fs');
  vi.doUnmock('node:os');
  vi.resetModules();
});

describe('CLI-only product boundary', () => {
  it('forces every CCR configuration save to leave profile takeover disabled', async () => {
    const manager = new ClaudeRouterManager('D:\\ClaudeDockData');
    const access = {
      managementUrl: 'http://127.0.0.1:3456/ui',
      origin: 'http://127.0.0.1:3456',
      pid: 4321,
      serviceToken: 'service-token',
      webToken: 'web-token',
    };
    const config = { Providers: [{ name: 'Example' }] };
    const rpcWithAccess = vi.fn(async () => config);
    const internals = manager as unknown as {
      rpcWithAccess: typeof rpcWithAccess;
      saveConfigWithoutProfileTakeover: (
        service: typeof access,
        value: typeof config,
        secrets?: string[],
      ) => Promise<typeof config>;
    };
    internals.rpcWithAccess = rpcWithAccess;

    await expect(
      internals.saveConfigWithoutProfileTakeover(access, config, ['secret-value']),
    ).resolves.toBe(config);
    expect(rpcWithAccess).toHaveBeenCalledWith(
      access,
      'saveConfig',
      [config, { applyProfile: false }],
      ['secret-value'],
    );
  });

  it('reports a desktop-only CCR installation without treating it as installed or uninstallable', async () => {
    const runCommand = vi.fn();
    const manager = new ClaudeRouterManager(
      createFixtureRoot(),
      vi.fn(),
      () => ({}),
      runCommand as never,
    );
    const desktopExecutable = 'D:\\Program Files\\CCR\\ccr-desktop.exe';
    const internals = manager as unknown as {
      findCliInstallation: () => Promise<undefined>;
      findDesktopExecutable: () => string;
      getActiveServiceAccess: () => Promise<undefined>;
    };
    internals.findCliInstallation = vi.fn(async () => undefined);
    internals.findDesktopExecutable = vi.fn(() => desktopExecutable);
    internals.getActiveServiceAccess = vi.fn(async () => undefined);

    await expect(manager.getState()).resolves.toMatchObject({
      canUninstall: false,
      installationKind: 'desktop',
      installed: false,
      manageable: false,
      serviceRunning: false,
    });
    const uninstalled = await manager.uninstall();
    expect(uninstalled.message).toBe('仅检测到 CCR 桌面版；ClaudeDock 不会卸载或修改它。');
    expect(uninstalled.state).toMatchObject({ installationKind: 'desktop', installed: false });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('changes only Electron session proxy scopes and closes connections after rule changes', async () => {
    const defaultSetProxy = vi.fn(async () => undefined);
    const defaultCloseConnections = vi.fn(async () => undefined);
    vi.doMock('electron', () => ({
      session: {
        defaultSession: {
          closeAllConnections: defaultCloseConnections,
          setProxy: defaultSetProxy,
        },
      },
    }));
    const { createProxyScopes } = await import('../../src/main/proxy/scopes');
    const conversationSetProxy = vi.fn(async () => undefined);
    const conversationCloseConnections = vi.fn(async () => undefined);
    const proxyView = {
      enabled: true,
      host: '127.0.0.1',
      passwordConfigured: false,
      port: 7890,
      protocol: 'http' as const,
      scope: { application: true, cli: true, conversation: true },
      username: '',
    };
    const state = {
      appliedApplicationProxyRules: '',
      appliedConversationProxyRules: '',
    };
    const services = await createTestMainServiceRegistry();
    const { APPLICATION_PROXY_STORE, CONVERSATION_NETWORK_SESSION } =
      await import('../../src/main/infra/service-tokens');
    registerTestService(services, APPLICATION_PROXY_STORE, { getView: () => proxyView } as never);
    registerTestService(services, CONVERSATION_NETWORK_SESSION, {
      closeAllConnections: conversationCloseConnections,
      setProxy: conversationSetProxy,
    } as never);
    const scopes = createProxyScopes({
      services,
      state: state as never,
    });

    await scopes.applyApplicationProxyScope();
    await scopes.applyConversationProxyScope();
    expect(defaultSetProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyBypassRules: '127.0.0.1,localhost,[::1]',
      proxyRules: 'http://127.0.0.1:7890',
    });
    expect(conversationSetProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyBypassRules: '127.0.0.1,localhost,[::1]',
      proxyRules: 'http://127.0.0.1:7890',
    });
    expect(defaultCloseConnections).toHaveBeenCalledOnce();
    expect(conversationCloseConnections).toHaveBeenCalledOnce();

    await scopes.applyApplicationProxyScope();
    await scopes.applyConversationProxyScope();
    expect(defaultSetProxy).toHaveBeenCalledOnce();
    expect(conversationSetProxy).toHaveBeenCalledOnce();
  });

  it('reads only Claude Code settings hints and leaves every settings file unchanged', async () => {
    const root = createFixtureRoot();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    const userSettings = path.join(home, '.claude', 'settings.json');
    const projectSettings = path.join(cwd, '.claude', 'settings.json');
    const localSettings = path.join(cwd, '.claude', 'settings.local.json');
    const desktopSettings = path.join(
      home,
      'AppData',
      'Roaming',
      'Claude',
      'claude_desktop_config.json',
    );
    for (const file of [userSettings, projectSettings, localSettings, desktopSettings]) {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    writeFileSync(
      userSettings,
      JSON.stringify({
        apiKeyHelper: 'credential-helper',
        env: { ANTHROPIC_BASE_URL: 'https://user.example.com', ANTHROPIC_AUTH_TOKEN: 'token' },
      }),
      'utf8',
    );
    writeFileSync(
      projectSettings,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://project.example.com' } }),
      'utf8',
    );
    writeFileSync(localSettings, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'key' } }), 'utf8');
    writeFileSync(desktopSettings, JSON.stringify({ untouched: true }), 'utf8');
    const before = new Map(
      [userSettings, projectSettings, localSettings, desktopSettings].map((file) => [
        file,
        readFileSync(file, 'utf8'),
      ]),
    );
    const readPaths: string[] = [];
    const observedRead = vi.fn((file: string | Buffer | URL | number, encoding: BufferEncoding) => {
      readPaths.push(String(file));
      return readFileSync(file, encoding);
    });
    vi.doMock('node:fs', async () => ({
      ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
      readFileSync: observedRead,
    }));
    vi.doMock('node:os', async () => ({
      ...(await vi.importActual<typeof import('node:os')>('node:os')),
      homedir: () => home,
    }));
    const { ClaudeGatewayDetector } = await import('../../src/main/claude/gateway-diagnostics');
    const detector = new ClaudeGatewayDetector();
    const hints = (
      detector as unknown as {
        getConfigurationHints: (directory: string) => ClaudeConfigurationHint[];
      }
    ).getConfigurationHints(cwd);

    expect(hints.filter(({ source }) => source !== 'environment')).toEqual([
      {
        apiKeyHelperConfigured: true,
        authConfigured: true,
        baseUrl: 'https://user.example.com',
        label: 'Claude Code 用户设置',
        source: 'user-settings',
      },
      {
        apiKeyHelperConfigured: false,
        authConfigured: false,
        baseUrl: 'https://project.example.com',
        label: '当前项目共享设置',
        source: 'project-settings',
      },
      {
        apiKeyHelperConfigured: false,
        authConfigured: true,
        baseUrl: undefined,
        label: '当前项目本地设置',
        source: 'project-settings',
      },
    ]);
    expect(readPaths).toEqual([userSettings, projectSettings, localSettings]);
    expect(readPaths).not.toContain(desktopSettings);
    for (const [file, content] of before) {
      expect(readFileSync(file, 'utf8')).toBe(content);
    }
  });
});
