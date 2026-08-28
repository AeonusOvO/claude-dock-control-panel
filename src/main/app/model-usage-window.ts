import { BrowserWindow, screen, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import type { ModelUsageSnapshot } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';
import { preloadScriptPath, rendererEntryPath } from './paths';

/** A small independent renderer with no terminal, conversation store, or polling of its own. */
export class ModelUsageWindow {
  private window?: BrowserWindow;
  private opening?: Promise<void>;
  private position?: { x: number; y: number };
  private disposed = false;

  public constructor(private readonly onVisibility: (visible: boolean) => void) {}

  public isSender(event: IpcMainInvokeEvent): boolean {
    const contents = this.window?.webContents;
    return (
      !!contents &&
      !contents.isDestroyed() &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame
    );
  }

  public async setVisible(visible: boolean): Promise<void> {
    if (!visible) {
      this.window?.close();
      return;
    }
    if (this.disposed) throw new Error('应用正在退出。');
    if (this.opening) return this.opening;
    if (this.window) {
      this.window.showInactive();
      return;
    }
    this.opening = this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(): Promise<void> {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const window = new BrowserWindow({
      width: 128,
      height: 144,
      x: this.position?.x ?? display.x + display.width - 160,
      y: this.position?.y ?? display.y + 100,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      title: 'ClaudeDock 模型用量',
      webPreferences: {
        preload: preloadScriptPath(),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        additionalArguments: ['--claudedock-usage-widget'],
      },
    });
    this.window = window;
    window.setAlwaysOnTop(true, 'floating');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-redirect', (event) => event.preventDefault());
    const clamp = (): void => {
      if (window.isDestroyed()) return;
      const bounds = window.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width));
      const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height));
      this.position = { x, y };
      if (x !== bounds.x || y !== bounds.y) window.setPosition(x, y);
    };
    window.on('moved', clamp);
    screen.on('display-removed', clamp);
    screen.on('display-metrics-changed', clamp);
    window.on('closed', () => {
      screen.removeListener('display-removed', clamp);
      screen.removeListener('display-metrics-changed', clamp);
      if (this.window === window) {
        this.window = undefined;
        this.onVisibility(false);
      }
    });
    try {
      if (process.env.ELECTRON_RENDERER_URL) {
        await window.loadURL(
          new URL(
            'usage-widget.html',
            `${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')}/`,
          ).toString(),
        );
      } else
        await window.loadFile(path.join(path.dirname(rendererEntryPath()), 'usage-widget.html'));
      if (!window.isDestroyed()) {
        clamp();
        window.showInactive();
        this.onVisibility(true);
      }
    } catch (error) {
      if (!window.isDestroyed()) window.close();
      throw error;
    }
  }

  public publish(snapshot: ModelUsageSnapshot): void {
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send(CHANNELS.MODEL_USAGE_CHANGED, snapshot);
  }

  public dispose(): void {
    this.disposed = true;
    this.window?.destroy();
  }
}
