/* eslint-disable max-lines -- This integration specification keeps the gateway transaction fault matrix in one shared fixture. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import type { ManagedGatewayAuthenticationInspection } from '../../src/main/claude/managed-chatgpt-auth';
import {
  buildManagedGatewayConfig,
  buildManagedGatewayEnvironment,
} from '../../src/main/claude/managed-chatgpt-config';
import {
  ManagedChatGptGateway,
  ManagedGatewayStartupLog,
} from '../../src/main/claude/managed-chatgpt-gateway';
import { recommendedChatModel } from '../../src/shared/claude/managed-chatgpt-models';
import {
  protectManagedGatewayAuthentication,
  protectManagedGatewayConfig,
} from '../../src/main/claude/managed-chatgpt-security';
import {
  archiveEntriesAreSafe,
  parseCliProxyApiRelease,
} from '../../src/main/claude/managed-chatgpt-release';
import type { DownloadEngine } from '../../src/main/download/engine';

const validCodexArtifact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  access_token: 'access-secret',
  account_id: '',
  disabled: false,
  email: 'account@example.com',
  expired: '2020-01-01T00:00:00Z',
  id_token: 'identity-secret',
  last_refresh: '2026-08-20T12:34:56.123+00:00',
  refresh_token: 'refresh-secret',
  type: 'codex',
  ...overrides,
});

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
  authorization?: {
    artifactCount: number;
    fingerprint: string;
    provider: 'openai-codex';
    validatedAt: number;
    version: 1;
  };
  encryptedClientKey: string;
  encryptedManagementKey?: string;
  executableRelativePath: string;
  executableSha256: string;
  installedVersion: string;
  port: number;
  process?: {
    identity: { startedAtTicks: string; version: 1 };
    phase: 'ready' | 'starting';
    processId: number;
    version: 1;
  };
  releaseDigest: string;
  version: 1;
}

interface TestPreparedGatewayConfiguration {
  config: string;
  configSignature: string;
  state: TestGatewayState;
}

interface TestEnvironmentSnapshot {
  environment: NodeJS.ProcessEnv;
  signature: string;
}

interface TestConfigTransaction {
  backupPath?: string;
  committed: boolean;
}

interface TestAuthenticationTransaction {
  commit: () => void;
  rollback: () => void;
}

const testProcess = (
  processId: number,
  phase: 'ready' | 'starting' = 'ready',
): NonNullable<TestGatewayState['process']> => ({
  identity: { startedAtTicks: String(638900000000000000n + BigInt(processId)), version: 1 },
  phase,
  processId,
  version: 1,
});

const testAuthentication = (): ManagedGatewayAuthenticationInspection => ({
  artifacts: [
    {
      changedAt: 1,
      filePath: path.resolve('C:\\Users\\Tester\\ClaudeDock\\auth\\codex-user.json'),
      size: 512,
    },
  ],
  manifest: {
    artifactCount: 1,
    fingerprint: 'c'.repeat(64),
    provider: 'openai-codex',
    validatedAt: 1,
    version: 1,
  },
});

interface ManagedGatewayInternals {
  activateConfiguration: (pendingConfigPath: string) => Promise<TestConfigTransaction>;
  configFiles: {
    commit: (transaction: TestConfigTransaction) => void;
  };
  controlledRuntimeDirectory: () => string;
  commitConfiguration: (
    transaction: TestConfigTransaction,
    state: TestGatewayState,
    snapshot: TestEnvironmentSnapshot,
  ) => Promise<void>;
  configurationLaunchIdentity: (state: TestGatewayState) => string;
  decryptClientKey: (state: TestGatewayState) => string | undefined;
  environmentSnapshot: () => TestEnvironmentSnapshot;
  executableIsValid: (state: TestGatewayState) => boolean;
  extractRelease: (archivePath: string, version: string) => Promise<string>;
  inspectAuthentication: () => Promise<ManagedGatewayAuthenticationInspection | undefined>;
  installLatest: () => Promise<TestGatewayState | undefined>;
  login: (
    state: TestGatewayState,
    configPath: string,
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => Promise<TestAuthenticationTransaction>;
  latest: () => Promise<{
    digest: string;
    downloadUrl: string;
    fileName: string;
    size: number;
    version: string;
  }>;
  loadState: () => TestGatewayState | undefined;
  modelReconciliation: {
    probe: (state: TestGatewayState, processId: number, credential: string) => Promise<string[]>;
  };
  ownedProcessId: (state: TestGatewayState) => Promise<number | undefined>;
  persistedProcess: {
    promoteReady: (
      state: TestGatewayState,
      authorization: TestGatewayState['authorization'],
    ) => TestGatewayState;
    stop: (state: TestGatewayState, occupiedPortMessage: string) => Promise<boolean>;
  };
  persistState: (state: TestGatewayState) => void;
  portAvailable: (port: number, timeoutMs?: number) => Promise<boolean>;
  prepareConfiguration: (state: TestGatewayState) => Promise<TestPreparedGatewayConfiguration>;
  removeStagedConfig: (pendingConfigPath: string) => void;
  requireInstalledAndAuthenticated: () => Promise<TestGatewayState>;
  rollbackConfiguration: (transaction: TestConfigTransaction) => void;
  stageConfiguration: (config: string) => Promise<string>;
  start: (
    prepared: TestPreparedGatewayConfiguration,
    configPath: string,
    snapshot: TestEnvironmentSnapshot,
  ) => Promise<TestGatewayState>;
  startWithStableEnvironment: (
    prepared: TestPreparedGatewayConfiguration,
  ) => Promise<TestGatewayState>;
  stopProcessesForState: (state: TestGatewayState, occupiedPortMessage: string) => Promise<void>;
}

describe('managed ChatGPT gateway', () => {
  it('removes inherited provider routes and credentials but keeps transport proxies', () => {
    expect(
      buildManagedGatewayEnvironment({
        ANTHROPIC_BASE_URL: 'https://old-relay.example.com',
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        CLAUDEDOCK_GATEWAY_PROCESS_CONFIG: 'must-not-survive',
        CODEX_ACCESS_TOKEN: 'old-codex-token',
        CUSTOM_ENVIRONMENT_CANARY: 'must-not-survive',
        DEPLOY: 'cloud',
        ELECTRON_RUN_AS_NODE: '1',
        GITSTORE_REPO: 'external-auth-store',
        HOME_JWT: 'external-home',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        OBJECTSTORE_BUCKET: 'external-auth-store',
        OpenAi_Api_Key: 'old-openai-key',
        PATH: 'C:\\Windows\\System32',
        PGSTORE_DSN: 'external-auth-store',
      }),
    ).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      PATH: 'C:\\Windows\\System32',
    });
  });

  it('applies the selected CLI proxy environment case-insensitively', () => {
    expect(
      buildManagedGatewayEnvironment(
        {
          ALL_PROXY: 'socks5://old.example:1080',
          HTTP_PROXY: 'http://old.example:8080',
          NO_PROXY: 'old.example',
          OPENAI_API_KEY: 'must-not-survive',
          PATH: 'C:\\Windows\\System32',
        },
        {
          ALL_PROXY: null,
          http_proxy: 'http://127.0.0.1:7890',
          no_proxy: '127.0.0.1,localhost',
        },
      ),
    ).toEqual({
      http_proxy: 'http://127.0.0.1:7890',
      no_proxy: '127.0.0.1,localhost',
      PATH: 'C:\\Windows\\System32',
    });
  });

  it('keeps bounded startup output without authorization secrets or account identity', () => {
    const authDirectory = path.resolve('C:\\Users\\Tester\\ClaudeDock\\auth');
    const log = new ManagedGatewayStartupLog(1_000, 3, [authDirectory]);
    log.append('first line\n');
    log.append(
      `access_token=secret-token token=generic-token-secret email=field@example.com ` +
        `account_id=acct-sensitive-42 plan_name=enterprise-secret ` +
        `standalone@example.com ${authDirectory} ` +
        'https://user:password@example.com codex-account@example.com-plus.json\n',
    );
    log.append('middle line\n');
    log.append('last line\n');

    const summary = log.summary();
    expect(summary.length).toBeLessThanOrEqual(1_000);
    expect(summary).not.toContain('secret-token');
    expect(summary).not.toContain('generic-token-secret');
    expect(summary).not.toContain('field@example.com');
    expect(summary).not.toContain('acct-sensitive-42');
    expect(summary).not.toContain('enterprise-secret');
    expect(summary).not.toContain('standalone@example.com');
    expect(summary).not.toContain(authDirectory);
    expect(summary).not.toContain('user:password');
    expect(summary).not.toContain('account@example.com');
    expect(summary).not.toContain('first line');
    expect(summary).toContain('[授权目录]');
    expect(summary).toContain('last line');
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
    expect(config).toContain('request-retry: 5');
    expect(config).toContain('max-retry-credentials: 0');
    expect(config).toContain('max-retry-interval: 60');
    expect(config).toContain('strategy: "round-robin"');
    expect(config).toContain('session-affinity: true');
    expect(config).toContain('session-affinity-ttl: "36h"');
    expect(config).toContain('keepalive-seconds: 15');
    expect(config).toContain('bootstrap-retries: 2');
    expect(config).toContain(`sk-claudedock-${'x'.repeat(43)}`);
    expect(config).not.toMatch(/oauth|cookie|password/i);
  });

  it('applies and verifies a Windows ACL without interpolating the config path into script text', async () => {
    const run = vi.fn(async () => ({ stderr: '', stdout: '' }));
    const configPath = path.resolve('C:\\Users\\Tester\\ClaudeDock\\config.yaml');

    await protectManagedGatewayConfig(configPath, {
      platform: 'win32',
      run: run as never,
    });

    expect(run).toHaveBeenCalledOnce();
    const [executable, argumentsList, environment, options] =
      (run.mock.calls as unknown[][])[0] ?? [];
    expect(executable).toBe('powershell.exe');
    expect(argumentsList as string[]).toContain('-NonInteractive');
    expect((argumentsList as string[]).at(-1)).not.toContain(configPath);
    expect((argumentsList as string[]).at(-1)).toContain('ReparsePoint');
    expect(environment).toMatchObject({ CLAUDEDOCK_GATEWAY_CONFIG_PATH: configPath });
    expect(options).toEqual({ maxBuffer: 64 * 1024, timeout: 10_000 });
    await expect(
      protectManagedGatewayConfig('relative-config.yaml', {
        platform: 'win32',
        run: run as never,
      }),
    ).rejects.toThrow('路径无效');
  });

  it('protects the auth directory and every exact child artifact without script interpolation', async () => {
    const run = vi.fn(async () => ({ stderr: '', stdout: '' }));
    const authDirectory = path.resolve('C:\\Users\\Tester\\ClaudeDock\\auth');
    const artifactPath = path.join(authDirectory.toUpperCase(), 'codex-user.json');

    await protectManagedGatewayAuthentication(authDirectory, [artifactPath], {
      platform: 'win32',
      run: run as never,
    });

    expect(run).toHaveBeenCalledTimes(2);
    for (const call of run.mock.calls as unknown[][]) {
      const argumentsList = call[1] as string[];
      const environment = call[2] as NodeJS.ProcessEnv;
      const script = argumentsList.at(-1) ?? '';
      expect(script).not.toContain(authDirectory);
      expect(script).not.toContain(artifactPath);
      expect(script).toContain('ReparsePoint');
      expect(script).toContain('SetAccessRuleProtection($true, $false)');
      expect(script).toContain('FileSystemRights]::FullControl');
      expect(environment.CLAUDEDOCK_GATEWAY_AUTH_PATH).toBeTruthy();
      expect(environment.CUSTOM_ENVIRONMENT_CANARY).toBeUndefined();
      expect(call[3]).toEqual({ maxBuffer: 64 * 1024, timeout: 10_000 });
    }
    expect((run.mock.calls as unknown[][])[0]?.[2]).toMatchObject({
      CLAUDEDOCK_GATEWAY_AUTH_PATH: authDirectory,
      CLAUDEDOCK_GATEWAY_AUTH_PATH_KIND: 'directory',
    });
    expect((run.mock.calls as unknown[][])[1]?.[2]).toMatchObject({
      CLAUDEDOCK_GATEWAY_AUTH_PATH: path.resolve(artifactPath),
      CLAUDEDOCK_GATEWAY_AUTH_PATH_KIND: 'file',
    });

    await expect(
      protectManagedGatewayAuthentication(
        authDirectory,
        [path.resolve('C:\\Users\\Tester\\outside\\codex-user.json')],
        { platform: 'win32', run: run as never },
      ),
    ).rejects.toThrow('授权文件路径无效');
    expect(run).toHaveBeenCalledTimes(2);
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

  it('retries one transient non-atomic Codex artifact read', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-auth-retry-'));
    const authDirectory = path.join(userDataPath, 'managed-gateways', 'cliproxyapi', 'auth');
    mkdirSync(authDirectory, { recursive: true });
    const candidatePath = path.join(authDirectory, 'codex-rewritten.json');
    writeFileSync(candidatePath, '{', 'utf8');
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    try {
      const inspection = internals.inspectAuthentication();
      setTimeout(() => {
        writeFileSync(candidatePath, JSON.stringify(validCodexArtifact()), 'utf8');
      }, 20);
      await expect(inspection).resolves.toMatchObject({
        manifest: { artifactCount: 1, provider: 'openai-codex' },
      });
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('rolls back account A after failed forced login and commits only account B', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-auth-freshness-'));
    const root = path.join(userDataPath, 'managed-gateways', 'cliproxyapi');
    const authDirectory = path.join(root, 'auth');
    mkdirSync(authDirectory, { recursive: true });
    const artifactPath = path.join(authDirectory, 'codex-account.json');
    writeFileSync(
      artifactPath,
      JSON.stringify(validCodexArtifact({ email: 'account-a@example.com' })),
      'utf8',
    );
    const run = vi.fn(async (): Promise<{ stderr: string; stdout: string }> => {
      throw new Error('browser closed before saving account B');
    });
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
      () => ({}),
      run as never,
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
    vi.spyOn(internals, 'stopProcessesForState').mockResolvedValue();
    const environment = { HTTPS_PROXY: 'http://127.0.0.1:7890' };
    const configPath = path.join(root, 'config.yaml');
    try {
      await expect(internals.login(state, configPath, environment)).rejects.toThrow(
        'OpenAI 授权未完成',
      );
      const restored = readdirSync(authDirectory).filter((name) => name.endsWith('.json'));
      expect(restored).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(path.join(authDirectory, restored[0]!), 'utf8')),
      ).toMatchObject({ email: 'account-a@example.com' });

      run.mockImplementation(async () => {
        writeFileSync(
          artifactPath,
          JSON.stringify(validCodexArtifact({ email: 'account-b@example.com' })),
          'utf8',
        );
        return {
          stderr: 'warning: browser launch was unavailable; manual OAuth still completed\n',
          stdout: `Authentication saved to ${artifactPath}\nCodex authentication successful!\n`,
        };
      });
      const transaction = await internals.login(state, configPath, environment);
      expect(readdirSync(authDirectory)).toContain(path.basename(artifactPath));
      transaction.commit();

      const committed = readdirSync(authDirectory).filter((name) => name.endsWith('.json'));
      expect(committed).toEqual([path.basename(artifactPath)]);
      expect(JSON.parse(readFileSync(artifactPath, 'utf8'))).toMatchObject({
        email: 'account-b@example.com',
      });
      expect(readdirSync(authDirectory).some((name) => name.startsWith('.quarantine-'))).toBe(
        false,
      );
      const calls = run.mock.calls as unknown[][];
      expect(calls[1]?.[2]).toBe(environment);
      expect(calls[1]?.[3]).toMatchObject({
        cwd: path.join(root, 'runtime'),
        maxBuffer: 512 * 1024,
      });
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('uses an app-owned empty runtime directory and rejects a local dotenv override', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-runtime-cwd-'));
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    try {
      const runtimeDirectory = internals.controlledRuntimeDirectory();
      expect(runtimeDirectory).toBe(
        path.join(userDataPath, 'managed-gateways', 'cliproxyapi', 'runtime'),
      );
      writeFileSync(path.join(runtimeDirectory, '.env'), 'PGSTORE_DSN=external', 'utf8');
      expect(() => internals.controlledRuntimeDirectory()).toThrow('运行目录不安全');
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
      process: testProcess(42),
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
      expect(upgraded).not.toHaveProperty('process');
      expect(startDownload).toHaveBeenCalledOnce();
      expect(events).toEqual(['stop:7.2.116', 'persist:7.2.117']);
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('does not trust a responsive loopback binder without an exact process identity', async () => {
    const binder = createServer((socket) => {
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"data":[]}');
    });
    await new Promise<void>((resolve, reject) => {
      binder.once('error', reject);
      binder.listen(0, '127.0.0.1', resolve);
    });
    const address = binder.address();
    if (!address || typeof address === 'string') {
      throw new Error('test loopback binder did not expose a port');
    }
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-owner-'));
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
    const internals = manager as unknown as ManagedGatewayInternals;
    const state: TestGatewayState = {
      encryptedClientKey: '',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: address.port,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    vi.spyOn(internals, 'decryptClientKey').mockReturnValue(`sk-claudedock-${'x'.repeat(43)}`);
    const prepared: TestPreparedGatewayConfiguration = {
      config: 'config',
      configSignature: 'config-signature',
      state,
    };
    try {
      await expect(
        internals.start(
          prepared,
          path.join(userDataPath, 'config.yaml'),
          internals.environmentSnapshot(),
        ),
      ).rejects.toThrow(`本机端口 ${address.port} 已被其他程序占用`);
      expect(fetchImplementation).not.toHaveBeenCalled();
    } finally {
      manager.shutdown();
      await new Promise<void>((resolve, reject) => {
        binder.close((error) => (error ? reject(error) : resolve()));
      });
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
    const portAvailable = vi.spyOn(internals, 'portAvailable').mockResolvedValue(false);
    try {
      await expect(manager.stop()).resolves.toBeUndefined();
      expect(portAvailable).not.toHaveBeenCalled();
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('logs out by removing only managed authorization without invoking browser login', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-logout-'));
    const root = path.join(userDataPath, 'managed-gateways', 'cliproxyapi');
    const authDirectory = path.join(root, 'auth');
    mkdirSync(authDirectory, { recursive: true });
    writeFileSync(
      path.join(authDirectory, 'codex-account.json'),
      JSON.stringify(validCodexArtifact()),
      'utf8',
    );
    const state: TestGatewayState = {
      authorization: testAuthentication().manifest,
      encryptedClientKey: '',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    writeFileSync(path.join(root, 'state.json'), JSON.stringify(state), 'utf8');
    const run = vi.fn();
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
      () => ({}),
      run as never,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const stop = vi.spyOn(internals, 'stopProcessesForState').mockResolvedValue();
    try {
      await expect(manager.logout()).resolves.toBeUndefined();

      expect(stop).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
      expect(readdirSync(authDirectory)).toEqual([]);
      expect(JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'))).toEqual({
        encryptedClientKey: '',
        executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
        executableSha256: 'a'.repeat(64),
        installedVersion: '7.2.117',
        port: 8317,
        releaseDigest: 'b'.repeat(64),
        version: 1,
      });
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('propagates exact persisted-process port-release failure', async () => {
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
      process: testProcess(42),
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const stopPersistedProcess = vi
      .spyOn(internals.persistedProcess, 'stop')
      .mockRejectedValue(new Error('port still occupied'));
    try {
      await expect(internals.stopProcessesForState(state, 'port still occupied')).rejects.toThrow(
        'port still occupied',
      );
      expect(stopPersistedProcess).toHaveBeenCalledWith(state, 'port still occupied');
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('uses one global in-flight readiness operation for concurrent launch callers', async () => {
    const userDataPath = mkdtempSync(
      path.join(tmpdir(), 'claudedock-managed-gateway-singleflight-'),
    );
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared: TestPreparedGatewayConfiguration = {
      config: 'config',
      configSignature: 'config-signature',
      state,
    };
    let release!: (value: TestGatewayState) => void;
    const readiness = new Promise<TestGatewayState>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, 'requireInstalledAndAuthenticated').mockResolvedValue(state);
    vi.spyOn(internals, 'prepareConfiguration').mockResolvedValue(prepared);
    const startWithStableEnvironment = vi
      .spyOn(internals, 'startWithStableEnvironment')
      .mockReturnValue(readiness);

    try {
      const first = manager.ensureRunning();
      const second = manager.ensureRunning();
      expect(second).toBe(first);
      await vi.waitFor(() => {
        expect(startWithStableEnvironment).toHaveBeenCalledOnce();
      });
      release(state);
      await expect(first).resolves.toBeUndefined();
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('uses an opaque in-memory route identity and rotates it when proxy credentials change', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-signature-'));
    let proxyUrl = 'http://user:password-one@127.0.0.1:7890';
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
      () => ({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }),
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    try {
      const first = internals.environmentSnapshot();
      const unchanged = internals.environmentSnapshot();
      proxyUrl = 'http://user:password-two@127.0.0.1:7890';
      const changed = internals.environmentSnapshot();

      expect(first.signature).toMatch(/^[0-9a-f]{32}$/);
      expect(unchanged.signature).toBe(first.signature);
      expect(changed.signature).not.toBe(first.signature);
      expect(first.signature).not.toContain('password-one');
      expect(changed.signature).not.toContain('password-two');
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('uses opaque configuration identities without deriving them from gateway keys', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-config-id-'));
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key-one',
      encryptedManagementKey: 'encrypted-management-key-one',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };

    try {
      const first = internals.configurationLaunchIdentity(state);
      const unchanged = internals.configurationLaunchIdentity({ ...state });
      const changedClientKey = internals.configurationLaunchIdentity({
        ...state,
        encryptedClientKey: 'encrypted-client-key-two',
      });
      const changedManagementKey = internals.configurationLaunchIdentity({
        ...state,
        encryptedClientKey: 'encrypted-client-key-two',
        encryptedManagementKey: 'encrypted-management-key-two',
      });
      const changedPort = internals.configurationLaunchIdentity({
        ...state,
        encryptedClientKey: 'encrypted-client-key-two',
        encryptedManagementKey: 'encrypted-management-key-two',
        port: 8318,
      });

      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(unchanged).toBe(first);
      expect(changedClientKey).not.toBe(first);
      expect(changedManagementKey).not.toBe(changedClientKey);
      expect(changedPort).not.toBe(changedManagementKey);
      for (const identity of [first, changedClientKey, changedManagementKey, changedPort]) {
        expect(identity).not.toContain('encrypted-client-key');
        expect(identity).not.toContain('encrypted-management-key');
      }
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('commits config state only after readiness and final ownership succeed', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-staging-'));
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared: TestPreparedGatewayConfiguration = {
      config: 'config',
      configSignature: 'config-signature',
      state,
    };
    const transaction: TestConfigTransaction = { committed: false };
    let release!: (value: TestGatewayState) => void;
    const readiness = new Promise<TestGatewayState>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, 'stageConfiguration').mockResolvedValue(
      path.join(userDataPath, 'config-0123456789abcdef01234567.pending.yaml'),
    );
    vi.spyOn(internals, 'activateConfiguration').mockResolvedValue(transaction);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue(testAuthentication());
    vi.spyOn(internals, 'start').mockReturnValue(readiness);
    const ownedProcessId = vi.spyOn(internals, 'ownedProcessId').mockResolvedValue(42);
    const commit = vi
      .spyOn(internals, 'commitConfiguration')
      .mockImplementation(async (activeTransaction) => {
        activeTransaction.committed = true;
      });
    const rollback = vi.spyOn(internals, 'rollbackConfiguration').mockImplementation(() => {});
    vi.spyOn(internals, 'removeStagedConfig').mockImplementation(() => {});

    try {
      const operation = internals.startWithStableEnvironment(prepared);
      await Promise.resolve();
      expect(commit).not.toHaveBeenCalled();
      release({ ...state, process: testProcess(42, 'starting') });
      await expect(operation).resolves.toMatchObject({
        authorization: testAuthentication().manifest,
        process: { phase: 'ready', processId: 42 },
      });
      expect(commit).toHaveBeenCalledWith(
        transaction,
        expect.objectContaining({ authorization: testAuthentication().manifest }),
        expect.any(Object),
      );
      expect(ownedProcessId).toHaveBeenCalledWith(
        expect.objectContaining({ authorization: testAuthentication().manifest }),
      );
      expect(ownedProcessId.mock.invocationCallOrder[0]).toBeLessThan(
        commit.mock.invocationCallOrder[0]!,
      );
      expect(rollback).not.toHaveBeenCalled();
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('stops exact ready ownership when config commit fails after ready-state persistence', async () => {
    const userDataPath = mkdtempSync(
      path.join(tmpdir(), 'claudedock-managed-gateway-config-commit-'),
    );
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared = { config: 'config', configSignature: 'config-signature', state };
    const transaction: TestConfigTransaction = { committed: false };
    let current: TestGatewayState = { ...state, process: testProcess(42, 'starting') };
    vi.spyOn(internals, 'loadState').mockImplementation(() => current);
    vi.spyOn(internals, 'stageConfiguration').mockResolvedValue(
      path.join(userDataPath, 'config-0123456789abcdef01234567.pending.yaml'),
    );
    vi.spyOn(internals, 'activateConfiguration').mockResolvedValue(transaction);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue(testAuthentication());
    vi.spyOn(internals, 'start').mockResolvedValue(current);
    vi.spyOn(internals, 'ownedProcessId').mockResolvedValue(42);
    const promoteReady = vi
      .spyOn(internals.persistedProcess, 'promoteReady')
      .mockImplementation((starting, authorization) => {
        current = {
          ...starting,
          authorization,
          process: { ...starting.process!, phase: 'ready' },
        };
        return current;
      });
    vi.spyOn(internals.configFiles, 'commit').mockImplementation(() => {
      throw new Error('injected config commit failure');
    });
    const stop = vi.spyOn(internals, 'stopProcessesForState').mockImplementation(async () => {
      current = { ...current, process: undefined };
    });
    const rollback = vi.spyOn(internals, 'rollbackConfiguration').mockImplementation(() => {});
    vi.spyOn(internals, 'removeStagedConfig').mockImplementation(() => {});

    try {
      await expect(internals.startWithStableEnvironment(prepared)).rejects.toThrow(
        'injected config commit failure',
      );
      expect(promoteReady).toHaveBeenCalledWith(
        expect.objectContaining({ process: testProcess(42, 'starting') }),
        testAuthentication().manifest,
      );
      expect(stop).toHaveBeenCalledWith(
        expect.objectContaining({ process: testProcess(42, 'ready') }),
        '托管网关启动失败后，旧进程未能及时退出或释放端口。',
      );
      expect(rollback).toHaveBeenCalledWith(transaction);
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('stops exact starting ownership when atomic ready-state promotion fails', async () => {
    const userDataPath = mkdtempSync(
      path.join(tmpdir(), 'claudedock-managed-gateway-ready-state-'),
    );
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared = { config: 'config', configSignature: 'config-signature', state };
    const transaction: TestConfigTransaction = { committed: false };
    const starting = { ...state, process: testProcess(42, 'starting') };
    let current: TestGatewayState = starting;
    vi.spyOn(internals, 'loadState').mockImplementation(() => current);
    vi.spyOn(internals, 'stageConfiguration').mockResolvedValue(
      path.join(userDataPath, 'config-0123456789abcdef01234567.pending.yaml'),
    );
    vi.spyOn(internals, 'activateConfiguration').mockResolvedValue(transaction);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue(testAuthentication());
    vi.spyOn(internals, 'start').mockResolvedValue(starting);
    vi.spyOn(internals, 'ownedProcessId').mockResolvedValue(42);
    vi.spyOn(internals.persistedProcess, 'promoteReady').mockImplementation(() => {
      throw new Error('injected ready-state rename failure');
    });
    const configCommit = vi.spyOn(internals.configFiles, 'commit');
    const stop = vi.spyOn(internals, 'stopProcessesForState').mockImplementation(async () => {
      current = { ...current, process: undefined };
    });
    const rollback = vi.spyOn(internals, 'rollbackConfiguration').mockImplementation(() => {});
    vi.spyOn(internals, 'removeStagedConfig').mockImplementation(() => {});

    try {
      await expect(internals.startWithStableEnvironment(prepared)).rejects.toThrow(
        'injected ready-state rename failure',
      );
      expect(configCommit).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledWith(
        expect.objectContaining({ process: testProcess(42, 'starting') }),
        '托管网关启动失败后，旧进程未能及时退出或释放端口。',
      );
      expect(rollback).toHaveBeenCalledWith(transaction);
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('does not commit authorization state when final process ownership is lost', async () => {
    const userDataPath = mkdtempSync(
      path.join(tmpdir(), 'claudedock-managed-gateway-final-owner-'),
    );
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared: TestPreparedGatewayConfiguration = {
      config: 'config',
      configSignature: 'config-signature',
      state,
    };
    const transaction: TestConfigTransaction = { committed: false };
    vi.spyOn(internals, 'stageConfiguration').mockResolvedValue(
      path.join(userDataPath, 'config-0123456789abcdef01234567.pending.yaml'),
    );
    vi.spyOn(internals, 'activateConfiguration').mockResolvedValue(transaction);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue(testAuthentication());
    vi.spyOn(internals, 'start').mockResolvedValue({
      ...state,
      process: testProcess(42, 'starting'),
    });
    vi.spyOn(internals, 'ownedProcessId').mockResolvedValue(undefined);
    const commit = vi.spyOn(internals, 'commitConfiguration');
    const rollback = vi.spyOn(internals, 'rollbackConfiguration').mockImplementation(() => {});
    vi.spyOn(internals, 'removeStagedConfig').mockImplementation(() => {});

    try {
      await expect(internals.startWithStableEnvironment(prepared)).rejects.toThrow(
        '就绪状态保存完成前已经退出',
      );
      expect(commit).not.toHaveBeenCalled();
      expect(transaction.committed).toBe(false);
      expect(rollback).toHaveBeenCalledWith(transaction);
    } finally {
      manager.shutdown();
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it('rolls back the active config when readiness fails before state commit', async () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-managed-gateway-rollback-'));
    const manager = new ManagedChatGptGateway(
      userDataPath,
      {} as DownloadEngine,
      new BusyRegistry(),
      {
        decryptString: vi.fn(),
        encryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
      },
      vi.fn() as unknown as typeof fetch,
    );
    const internals = manager as unknown as ManagedGatewayInternals;
    const state: TestGatewayState = {
      encryptedClientKey: 'encrypted-client-key',
      executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
      executableSha256: 'a'.repeat(64),
      installedVersion: '7.2.117',
      port: 8317,
      releaseDigest: 'b'.repeat(64),
      version: 1,
    };
    const prepared: TestPreparedGatewayConfiguration = {
      config: 'config',
      configSignature: 'config-signature',
      state,
    };
    const transaction: TestConfigTransaction = { committed: false };
    vi.spyOn(internals, 'stageConfiguration').mockResolvedValue(
      path.join(userDataPath, 'config-0123456789abcdef01234567.pending.yaml'),
    );
    vi.spyOn(internals, 'activateConfiguration').mockResolvedValue(transaction);
    vi.spyOn(internals, 'inspectAuthentication').mockResolvedValue(testAuthentication());
    vi.spyOn(internals, 'start').mockRejectedValue(new Error('not ready'));
    const commit = vi.spyOn(internals, 'commitConfiguration');
    const rollback = vi.spyOn(internals, 'rollbackConfiguration').mockImplementation(() => {});
    vi.spyOn(internals, 'removeStagedConfig').mockImplementation(() => {});

    try {
      await expect(internals.startWithStableEnvironment(prepared)).rejects.toThrow('not ready');
      expect(commit).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledWith(transaction);
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
      await expect(manager.cancelSetup()).resolves.toBe(false);

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
