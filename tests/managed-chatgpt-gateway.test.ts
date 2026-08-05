import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../src/main/busy-registry';
import {
  archiveEntriesAreSafe,
  buildManagedGatewayEnvironment,
  buildManagedGatewayConfig,
  ManagedChatGptGateway,
  parseCliProxyApiRelease,
  recommendedChatModel,
} from '../src/main/managed-chatgpt-gateway';
import type { DownloadEngine } from '../src/main/download-engine';

const releasePayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  assets: [
    {
      browser_download_url:
        'https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.116/CLIProxyAPI_7.2.116_windows_amd64.zip',
      digest: `sha256:${'a'.repeat(64)}`,
      name: 'CLIProxyAPI_7.2.116_windows_amd64.zip',
      size: 21_044_954,
    },
  ],
  tag_name: 'v7.2.116',
  ...overrides,
});

interface TestGatewayState {
  encryptedClientKey: string;
  executableRelativePath: string;
  executableSha256: string;
  installedVersion: string;
  port: number;
  processId?: number;
  releaseDigest: string;
  version: 1;
}

interface ManagedGatewayInternals {
  decryptClientKey: (state: TestGatewayState) => string | undefined;
  extractRelease: (archivePath: string, version: string) => Promise<string>;
  installLatest: () => Promise<TestGatewayState | undefined>;
  latest: () => Promise<{
    digest: string;
    downloadUrl: string;
    fileName: string;
    size: number;
    version: string;
  }>;
  persistState: (state: TestGatewayState) => void;
  probe: (port: number, credential: string) => Promise<boolean>;
  processMatchesState: (state: TestGatewayState, processId: number) => Promise<boolean>;
  start: (state: TestGatewayState) => Promise<void>;
  stopPersistedProcess: (state: TestGatewayState, processId: number) => Promise<boolean>;
  stopProcessesForState: (state: TestGatewayState, occupiedPortMessage: string) => Promise<void>;
  waitForPortAvailability: (port: number) => Promise<boolean>;
}

describe('managed ChatGPT gateway', () => {
  it('removes inherited provider routes and credentials but keeps transport proxies', () => {
    expect(
      buildManagedGatewayEnvironment({
        ANTHROPIC_BASE_URL: 'https://old-relay.example.com',
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        CODEX_ACCESS_TOKEN: 'old-codex-token',
        ELECTRON_RUN_AS_NODE: '1',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        OpenAi_Api_Key: 'old-openai-key',
        PATH: 'C:\\Windows\\System32',
      }),
    ).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      PATH: 'C:\\Windows\\System32',
    });
  });

  it('selects a usable chat model from the live catalog instead of assuming a fixed identifier', () => {
    expect(recommendedChatModel(['text-embedding-3-large', 'gpt-5.4-mini', 'gpt-5.6-sol'])).toBe(
      'gpt-5.6-sol',
    );
    expect(recommendedChatModel(['audio-preview', 'team-coder', 'team-mini'])).toBe('team-coder');
    expect(() => recommendedChatModel([])).toThrow('没有返回可用模型');
  });

  it('accepts only the matching upstream Windows x64 release asset', () => {
    expect(parseCliProxyApiRelease(releasePayload())).toEqual({
      digest: 'a'.repeat(64),
      downloadUrl:
        'https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.116/CLIProxyAPI_7.2.116_windows_amd64.zip',
      fileName: 'CLIProxyAPI_7.2.116_windows_amd64.zip',
      size: 21_044_954,
      version: '7.2.116',
    });
    expect(() =>
      parseCliProxyApiRelease(
        releasePayload({
          tag_name: 'latest',
        }),
      ),
    ).toThrow('版本格式');
    expect(() =>
      parseCliProxyApiRelease({
        ...releasePayload(),
        assets: [
          {
            browser_download_url: 'https://example.com/CLIProxyAPI.zip',
            digest: `sha256:${'a'.repeat(64)}`,
            name: 'CLIProxyAPI_7.2.116_windows_amd64.zip',
            size: 21_044_954,
          },
        ],
      }),
    ).toThrow('来源');
  });

  it('rejects archive traversal and absolute entries before extraction', () => {
    expect(archiveEntriesAreSafe(['cli-proxy-api.exe', 'config.example.yaml'])).toBe(true);
    expect(archiveEntriesAreSafe(['../cli-proxy-api.exe'])).toBe(false);
    expect(archiveEntriesAreSafe(['C:\\Windows\\system32\\tool.exe'])).toBe(false);
    expect(archiveEntriesAreSafe(['/absolute/tool.exe'])).toBe(false);
  });

  it('writes a loopback-only, key-protected local management configuration', () => {
    const authDirectory = path.resolve('C:\\Users\\Tester\\ClaudeDock\\gateway-auth');
    const config = buildManagedGatewayConfig({
      authDirectory,
      clientKey: `sk-claudedock-${'x'.repeat(43)}`,
      managementKey: `mgmt-claudedock-${'y'.repeat(43)}`,
      port: 8317,
    });
    expect(config).toContain('host: "127.0.0.1"');
    expect(config).toContain('port: 8317');
    expect(config).toContain('allow-remote: false');
    expect(config).toContain(`secret-key: "mgmt-claudedock-${'y'.repeat(43)}"`);
    expect(config).toContain('disable-control-panel: false');
    expect(config).toContain('disable-auto-update-panel: true');
    expect(config).toContain('router-for-me/Cli-Proxy-API-Management-Center');
    expect(config).toContain('usage-statistics-enabled: false');
    expect(config).toContain(`sk-claudedock-${'x'.repeat(43)}`);
    expect(config).not.toMatch(/oauth|cookie|password/i);
  });

  it('reads the installed version without starting or probing the gateway', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-version-'));
    const root = path.join(userDataPath, 'managed-gateways', 'cliproxyapi');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, 'state.json'),
      JSON.stringify({
        encryptedClientKey: '',
        executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
        executableSha256: 'a'.repeat(64),
        installedVersion: '7.2.117',
        port: 8317,
        releaseDigest: 'b'.repeat(64),
        version: 1,
      }),
      'utf8',
    );
    const fetchImplementation = vi.fn();
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => false),
      },
      fetchImplementation as unknown as typeof fetch,
    );
    try {
      expect(manager.getInstalledVersion()).toBe('7.2.117');
      expect(fetchImplementation).not.toHaveBeenCalled();
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('stops the running installed version before persisting an upgrade', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-upgrade-'));
    const root = path.join(userDataPath, 'managed-gateways', 'cliproxyapi');
    mkdirSync(root, { recursive: true });
    const current: TestGatewayState = {
      encryptedClientKey: '',
      executableRelativePath: path.join('versions', '7.2.116', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.116',
      port: 8317,
      processId: 42,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    writeFileSync(path.join(root, 'state.json'), JSON.stringify(current), 'utf8');
    const startDownload = vi.fn(async () => {});
    const manager = new ManagedChatGptGateway(
      userDataPath,
      { start: startDownload } as unknown as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => false),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const events: string[] = [];
    vi.spyOn(internals, 'latest').mockResolvedValue({
      digest: 'c'.repeat(64),
      downloadUrl:
        'https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.117/CLIProxyAPI_7.2.117_windows_amd64.zip',
      fileName: 'CLIProxyAPI_7.2.117_windows_amd64.zip',
      size: 21_000_000,
      version: '7.2.117',
    });
    vi.spyOn(internals, 'extractRelease').mockImplementation(async () => {
      const relative = path.join('versions', '7.2.117', 'cli-proxy-api.exe');
      const executable = path.join(root, relative);
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(executable, 'validated 7.2.117 executable', 'utf8');
      return relative;
    });
    vi.spyOn(internals, 'stopProcessesForState').mockImplementation(async (state) => {
      expect(state.installedVersion).toBe('7.2.116');
      events.push('stop:7.2.116');
    });
    vi.spyOn(internals, 'persistState').mockImplementation((state) => {
      events.push(`persist:${state.installedVersion}`);
    });
    try {
      const upgraded = await internals.installLatest();
      expect(upgraded).toMatchObject({ installedVersion: '7.2.117' });
      expect(upgraded).not.toHaveProperty('processId');
      expect(startDownload).toHaveBeenCalledOnce();
      expect(events).toEqual(['stop:7.2.116', 'persist:7.2.117']);
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('does not trust a responsive gateway without an exact process identity', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-owner-'));
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => false),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const state: TestGatewayState = {
      encryptedClientKey: '',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    vi.spyOn(internals, 'decryptClientKey').mockReturnValue(`sk-claudedock-${'x'.repeat(43)}`);
    vi.spyOn(internals, 'probe').mockResolvedValue(true);
    try {
      await expect(internals.start(state)).rejects.toThrow('进程身份或运行版本无法确认');
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('does not require an unowned remembered port to become available during stop', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-stop-'));
    const root = path.join(userDataPath, 'managed-gateways', 'cliproxyapi');
    mkdirSync(root, { recursive: true });
    const state: TestGatewayState = {
      encryptedClientKey: '',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    writeFileSync(path.join(root, 'state.json'), JSON.stringify(state), 'utf8');
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => false),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const waitForPortAvailability = vi
      .spyOn(internals, 'waitForPortAvailability')
      .mockResolvedValue(false);
    try {
      await expect(manager.stop()).resolves.toBeUndefined();
      expect(waitForPortAvailability).not.toHaveBeenCalled();
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('still requires port release after stopping a verified managed process', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-owned-stop-'));
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => false),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const state: TestGatewayState = {
      encryptedClientKey: '',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      processId: 42,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    vi.spyOn(internals, 'stopPersistedProcess').mockResolvedValue(true);
    vi.spyOn(internals, 'waitForPortAvailability').mockResolvedValue(false);
    try {
      await expect(internals.stopProcessesForState(state, 'port still occupied')).rejects.toThrow(
        'port still occupied',
      );
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('shares one in-flight setup and reports a busy public state', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-'));
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchImplementation = vi.fn(() => pendingFetch);
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => false),
      },
      fetchImplementation as unknown as typeof fetch,
    );
    try {
      const first = manager.setup();
      const state = await manager.getState();
      const second = manager.setup(true);

      expect(state).toMatchObject({ busy: true, phase: 'installing' });
      expect(fetchImplementation).toHaveBeenCalledOnce();

      resolveFetch(
        new Response('{}', {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
      const results = await Promise.allSettled([first, second]);
      expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect((await manager.getState()).busy).toBe(false);
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });
});
