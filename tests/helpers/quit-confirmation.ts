import { vi } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import type { Registry } from '../../src/main/infra/registry';
import { createIpcHarness } from './ipc-harness';
import { createTestMainServiceRegistry, registerTestService } from './main-service-registry';

export const installQuitElectronMock = () => {
  const ipc = createIpcHarness();
  const appListeners = new Map<string, (...args: unknown[]) => void>();
  const app = {
    exit: vi.fn(),
    getAppPath: vi.fn(() => 'C:\\claudedock-test'),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      appListeners.set(event, listener);
    }),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setLoginItemSettings: vi.fn(),
    whenReady: vi.fn(async () => undefined),
  };
  const dialog = {
    showMessageBox: vi.fn(() => new Promise<Electron.MessageBoxReturnValue>(() => undefined)),
  };
  const electron = {
    app,
    BrowserWindow: {
      fromWebContents: vi.fn(() => undefined),
    },
    clipboard: {
      readText: vi.fn(() => ''),
      writeText: vi.fn(),
    },
    dialog,
    ipcMain: ipc.ipcMain,
    shell: { openExternal: vi.fn(async () => undefined) },
  };
  vi.doMock('electron', () => electron);
  return { app, appListeners, dialog, electron, ipc };
};

type QuitServiceOverrides = Partial<
  Record<
    | 'busyRegistry'
    | 'claudePermissionBridge'
    | 'claudeRuntime'
    | 'codexRuntime'
    | 'downloadEngine'
    | 'managedChatGptGateway'
    | 'nativeConversationService'
    | 'runtimeProcessRegistry',
    unknown
  >
>;

export const createQuitServices = async (
  overrides: QuitServiceOverrides = {},
): Promise<Registry> => {
  const services = await createTestMainServiceRegistry();
  const {
    BUSY_REGISTRY,
    CLAUDE_PERMISSION_BRIDGE,
    CLAUDE_RUNTIME,
    CODEX_RUNTIME,
    DOWNLOAD_ENGINE,
    MANAGED_CHATGPT_GATEWAY,
    NATIVE_CONVERSATION_SERVICE,
    RUNTIME_PROCESS_REGISTRY,
  } = await import('../../src/main/infra/service-tokens');
  registerTestService(
    services,
    BUSY_REGISTRY,
    (overrides.busyRegistry ?? new BusyRegistry()) as never,
  );
  registerTestService(
    services,
    CLAUDE_PERMISSION_BRIDGE,
    (overrides.claudePermissionBridge ?? { fallbackPending: vi.fn(), shutdown: vi.fn() }) as never,
  );
  registerTestService(
    services,
    CLAUDE_RUNTIME,
    (overrides.claudeRuntime ?? { setTheme: vi.fn(), shutdown: vi.fn() }) as never,
  );
  registerTestService(
    services,
    CODEX_RUNTIME,
    (overrides.codexRuntime ?? { dispose: vi.fn() }) as never,
  );
  registerTestService(
    services,
    DOWNLOAD_ENGINE,
    (overrides.downloadEngine ?? { flushJournal: vi.fn() }) as never,
  );
  registerTestService(
    services,
    MANAGED_CHATGPT_GATEWAY,
    (overrides.managedChatGptGateway ?? {
      shutdown: vi.fn(),
      shutdownForQuit: vi.fn(async () => true),
    }) as never,
  );
  registerTestService(
    services,
    NATIVE_CONVERSATION_SERVICE,
    (overrides.nativeConversationService ?? {
      activeIds: vi.fn(() => []),
      closeAll: vi.fn(async () => undefined),
    }) as never,
  );
  registerTestService(
    services,
    RUNTIME_PROCESS_REGISTRY,
    (overrides.runtimeProcessRegistry ?? {
      list: vi.fn(() => []),
      stop: vi.fn(),
      terminateAll: vi.fn(async () => undefined),
    }) as never,
  );
  return services;
};
