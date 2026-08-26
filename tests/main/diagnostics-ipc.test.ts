import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIpcHarness } from '../helpers/ipc-harness';

const FAILURE_DOMAINS = [
  'application-proxy',
  'attachment',
  'chat',
  'chat-attachment',
  'claude',
  'claude-configuration',
  'claude-connection',
  'claude-plugin',
  'claude-router',
  'codex',
  'conversation',
  'managed-chatgpt',
  'mcp',
  'router-kernel',
  'software-update',
  'terminal',
  'workspace',
] as const;

const installElectronMock = () => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({
    app: {},
    BrowserWindow: { fromWebContents: vi.fn(() => undefined) },
    clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
    ipcMain: ipc.ipcMain,
    shell: { openExternal: vi.fn(async () => undefined) },
  }));
  return ipc;
};

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('diagnostics IPC', () => {
  it('finds the log entry for a returned failure correlation code', async () => {
    const ipc = installElectronMock();
    const [
      { MainDiagnostics },
      { createFailureReporter, Logger },
      { Registry },
      { MAIN_DIAGNOSTICS },
      { registerAppIpc },
      { CHANNELS },
    ] = await Promise.all([
      import('../../src/main/infra/diagnostics'),
      import('../../src/main/infra/logger'),
      import('../../src/main/infra/registry'),
      import('../../src/main/infra/service-tokens'),
      import('../../src/main/ipc/app'),
      import('../../src/shared/ipc/channels'),
    ]);
    const logger = new Logger({ now: () => 10_000 });
    const failure = createFailureReporter('terminal', logger)(
      'environment',
      '无法启动终端。',
      new Error('spawn ENOENT'),
    );
    const diagnostics = new MainDiagnostics({
      claudeStream: { list: () => [] },
      logger,
      network: { getView: () => ({ entries: [], retentionDays: 7 }) },
      runtimeActivity: { list: () => [] },
    });
    const services = new Registry();
    services.register(MAIN_DIAGNOSTICS, () => diagnostics);
    const validateSender = vi.fn();

    registerAppIpc({
      advancedSettingsStore: {} as never,
      appPreferencesStore: {} as never,
      applyWindowTheme: vi.fn(),
      artifactService: {} as never,
      beginControlledQuit: vi.fn(async () => undefined),
      chooseDirectory: vi.fn(),
      guards: { validateSender },
      hideMainWindowToTray: vi.fn(),
      services,
      startupModelConnectionCoordinator: { onChanged: vi.fn() } as never,
      state: {} as never,
      workspace: {} as never,
      workspaceStore: {} as never,
    });

    const view = await ipc.invoke(CHANNELS.APP_GET_DIAGNOSTICS, { code: failure.code });

    expect(validateSender).toHaveBeenCalledTimes(1);
    expect(view.logs).toEqual([
      expect.objectContaining({
        code: failure.code,
        detail: failure.detail,
        domain: 'terminal',
        kind: failure.kind,
        message: failure.message,
      }),
    ]);
  });

  it('returns a complete classified failure in every reporting domain', async () => {
    const [{ createFailureReporter, Logger }, { isFailure }] = await Promise.all([
      import('../../src/main/infra/logger'),
      import('../../src/shared/diagnostics/failure'),
    ]);
    const logger = new Logger({ now: () => 20_000 });
    const kinds = ['user-input', 'environment', 'external-service', 'internal'] as const;

    for (const [index, domain] of FAILURE_DOMAINS.entries()) {
      const failure = createFailureReporter(domain, logger)(
        kinds[index % kinds.length]!,
        `${domain} operation failed`,
        { domain },
      );

      expect(isFailure(failure), domain).toBe(true);
      expect(logger.query({ code: failure.code }), domain).toEqual([
        expect.objectContaining({
          code: failure.code,
          domain,
          kind: failure.kind,
          message: failure.message,
        }),
      ]);
    }
  });
});
