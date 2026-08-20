import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import { CHANNELS } from '../../src/shared/ipc/channels';
import type { WorkspaceState } from '../../src/shared/contracts';
import { createIpcHarness } from '../helpers/ipc-harness';
import { createMainHarness } from '../helpers/main-harness';
import {
  createTestMainServiceRegistry,
  registerTestService,
} from '../helpers/main-service-registry';
import { createRendererHarness, type RendererHarness } from '../helpers/renderer-harness';

const renderers: RendererHarness[] = [];

afterEach(async () => {
  await Promise.all(renderers.splice(0).map((renderer) => renderer.cleanup()));
  vi.useRealTimers();
  vi.doUnmock('electron');
  vi.resetModules();
});

const emptyWorkspace: WorkspaceState = {
  activeSessionId: '',
  projects: [],
  sessions: [],
};

describe('tray busy-state integration', () => {
  it('publishes every busy-registry change and refreshes the tray from bootstrap', async () => {
    const harness = await createMainHarness({ tray: true });
    const { BUSY_REGISTRY } = await import('../../src/main/infra/service-tokens');
    const before = harness.calls.filter((call) => call === 'tray.update').length;
    const registry = harness.services.resolve(BUSY_REGISTRY);

    const release = registry.acquire({
      cancellable: true,
      id: 'download:test',
      kind: 'download',
      label: '下载测试运行时',
      severity: 'resumable',
    });

    expect(harness.calls.filter((call) => call === 'tray.update')).toHaveLength(before + 1);
    expect(harness.ipc.messages.at(-1)).toEqual({
      args: [
        [
          expect.objectContaining({
            id: 'download:test',
            kind: 'download',
          }),
        ],
      ],
      channel: CHANNELS.BUSY_CHANGED,
      direction: 'main-to-renderer',
    });

    release();
    expect(harness.calls.filter((call) => call === 'tray.update')).toHaveLength(before + 2);
    harness.restore();
  });

  it('adds the native download command only while a download lease is active', async () => {
    let menuTemplate: Electron.MenuItemConstructorOptions[] = [];
    const showMainWindow = vi.fn();
    const send = vi.fn();
    const tray = {
      setContextMenu: vi.fn(),
      setImage: vi.fn(),
      setToolTip: vi.fn(),
    };
    const services = await createTestMainServiceRegistry();
    const { BUSY_REGISTRY, MAIN_WINDOW, TRAY } =
      await import('../../src/main/infra/service-tokens');
    const busyRegistry = registerTestService(services, BUSY_REGISTRY, new BusyRegistry());
    services.resolve(MAIN_WINDOW).current = {
      webContents: { send },
    } as unknown as Electron.BrowserWindow;
    services.resolve(TRAY).current = tray as unknown as Electron.Tray;
    vi.doMock('electron', () => ({
      app: { getAppPath: vi.fn(() => 'C:\\claudedock-test') },
      dialog: { showMessageBox: vi.fn() },
      Menu: {
        buildFromTemplate: vi.fn((template: Electron.MenuItemConstructorOptions[]) => {
          menuTemplate = template;
          return {};
        }),
      },
      nativeImage: { createFromPath: vi.fn(() => ({})) },
      Tray: vi.fn(),
    }));
    const { createTrayController } = await import('../../src/main/app/tray');
    const controller = createTrayController({
      activateProject: vi.fn(),
      addProject: vi.fn(() => ({ ok: true, state: emptyWorkspace })),
      chooseDirectory: vi.fn(async () => ({ canceled: true as const })),
      describeWorkspace: () => emptyWorkspace,
      directTerminalTransitions: { run: vi.fn() } as never,
      requestQuit: vi.fn(),
      services,
      showMainWindow,
      workspace: {} as never,
    });

    controller.updateTray();
    expect(menuTemplate.some(({ label }) => String(label).startsWith('打开下载中心'))).toBe(false);
    expect(tray.setToolTip).toHaveBeenLastCalledWith(expect.stringContaining('后台空闲'));

    const release = busyRegistry.acquire({
      cancellable: true,
      id: 'download:active',
      kind: 'download',
      label: '正在下载',
      severity: 'resumable',
    });
    controller.updateTray();
    const downloadItem = menuTemplate.find(({ label }) => label === '打开下载中心（1）');
    expect(downloadItem).toBeDefined();

    (downloadItem?.click as (() => void) | undefined)?.();
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(CHANNELS.APP_OPEN_DOWNLOAD_CENTER);

    release();
    controller.updateTray();
    expect(menuTemplate.some(({ label }) => String(label).startsWith('打开下载中心'))).toBe(false);
  });

  it('routes the tray event through preload and opens the renderer dialog until unsubscribed', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({
      ipcRenderer: ipc.ipcRenderer,
      webUtils: { getPathForFile: vi.fn(() => '') },
    }));
    const { appBridge } = await import('../../src/preload/bridges/app');
    const listener = vi.fn();
    const unsubscribe = appBridge.onOpenDownloadCenterRequested(listener);

    ipc.emitFromMain(CHANNELS.APP_OPEN_DOWNLOAD_CENTER);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    ipc.emitFromMain(CHANNELS.APP_OPEN_DOWNLOAD_CENTER);
    expect(listener).toHaveBeenCalledTimes(1);

    vi.doUnmock('electron');
    vi.resetModules();
    const renderer = await createRendererHarness();
    renderers.push(renderer);
    renderer.clearCalls();
    renderer.emit('onOpenDownloadCenterRequested');

    const dialog = renderer.query<HTMLDialogElement>('#download-center-dialog');
    expect(dialog.open).toBe(true);
    expect(renderer.document.activeElement).toBe(
      renderer.query<HTMLButtonElement>('#close-download-center'),
    );

    dialog.close();
    renderer.dom.window.dispatchEvent(new renderer.dom.window.Event('beforeunload'));
    renderer.emit('onOpenDownloadCenterRequested');
    expect(dialog.open).toBe(false);
  });
});
