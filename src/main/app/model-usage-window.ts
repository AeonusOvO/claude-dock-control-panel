import { BrowserWindow, screen, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import type { ModelUsageSnapshot } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';
import { preloadScriptPath, rendererEntryPath } from './paths';

/** A small independent renderer with no terminal, conversation store, or polling of its own. */
export class ModelUsageWindow {
  private window?: BrowserWindow;
  private opening?: Promise<void>;
  private openingRequest?: number;
  private position?: { x: number; y: number };
  private visibilityRequest = 0;
  private requestedVisible = false;
  private disposed = false;

  public constructor(
    private readonly onVisibility: (visible: boolean) => void,
    private readonly onVisibilityRequest: (visible: boolean) => void = () => undefined,
  ) {}

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
    if (this.disposed) {
      if (visible) throw new Error('应用正在退出。');
      return;
    }
    this.requestedVisible = visible;
    const request = ++this.visibilityRequest;
    this.onVisibilityRequest(visible);
    if (!visible) {
      this.window?.close();
      return;
    }
    await this.ensureVisible(request);
  }

  private isCurrentVisibleRequest(request: number): boolean {
    return !this.disposed && this.requestedVisible && request === this.visibilityRequest;
  }

  private async ensureVisible(request: number): Promise<void> {
    if (!this.isCurrentVisibleRequest(request)) return;
    if (this.window && !this.window.isDestroyed()) {
      this.window.showInactive();
      return;
    }
    if (this.opening) {
      const opening = this.opening;
      const openingRequest = this.openingRequest;
      try {
        await opening;
      } catch (error) {
        // A newer show request may inherit an opening that was cancelled by an intervening hide.
        // Retry only that superseded attempt; a failure belonging to this request remains visible to
        // its caller.
        if (openingRequest !== request && this.isCurrentVisibleRequest(request)) {
          return this.ensureVisible(request);
        }
        throw error;
      }
      if (!this.isCurrentVisibleRequest(request)) return;
      if (this.window && !this.window.isDestroyed()) return;
      return this.ensureVisible(request);
    }
    const opening = this.open(request);
    const trackedOpening = opening.finally(() => {
      if (this.opening === trackedOpening) {
        this.opening = undefined;
        this.openingRequest = undefined;
      }
    });
    this.opening = trackedOpening;
    this.openingRequest = request;
    await trackedOpening;
    if (this.isCurrentVisibleRequest(request) && (!this.window || this.window.isDestroyed())) {
      await this.ensureVisible(request);
    }
  }

  private async open(request: number): Promise<void> {
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
    let suppressCloseVisibility = false;
    window.on('closed', () => {
      screen.removeListener('display-removed', clamp);
      screen.removeListener('display-metrics-changed', clamp);
      if (this.window === window) {
        this.window = undefined;
        if (!this.disposed && !suppressCloseVisibility) this.onVisibility(false);
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
      if (!window.isDestroyed() && this.isCurrentVisibleRequest(request)) {
        clamp();
        window.showInactive();
        this.onVisibility(true);
      }
    } catch (error) {
      suppressCloseVisibility = true;
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
    this.requestedVisible = false;
    this.visibilityRequest += 1;
    this.window?.destroy();
  }
}
