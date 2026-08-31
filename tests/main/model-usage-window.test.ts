import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelUsageWindow } from '../../src/main/app/model-usage-window';

type Listener = (...args: unknown[]) => void;

interface WindowHarness {
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
  isDestroyed: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  window: BrowserWindow;
}

const electronHarness = vi.hoisted(() => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
  },
  BrowserWindow: vi.fn(),
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 1, y: 1 })),
    getDisplayMatching: vi.fn(() => ({ workArea: { height: 900, width: 1_600, x: 0, y: 0 } })),
    getDisplayNearestPoint: vi.fn(() => ({ workArea: { height: 900, width: 1_600, x: 0, y: 0 } })),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('electron', () => electronHarness);

const addListener = (listeners: Map<string, Set<Listener>>, event: string, listener: Listener) => {
  const eventListeners = listeners.get(event) ?? new Set<Listener>();
  eventListeners.add(listener);
  listeners.set(event, eventListeners);
};

const removeListener = (
  listeners: Map<string, Set<Listener>>,
  event: string,
  listener: Listener,
): void => {
  listeners.get(event)?.delete(listener);
};

const createHarness = (loadError?: Error, loadReady?: Promise<void>): WindowHarness => {
  const listeners = new Map<string, Set<Listener>>();
  let destroyed = false;
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const isDestroyed = vi.fn(() => destroyed);
  const close = vi.fn(() => {
    destroyed = true;
    emit('closed');
  });
  const destroy = vi.fn(() => {
    destroyed = true;
    emit('closed');
  });
  const loadURL = vi.fn(async () => {
    await loadReady;
    if (loadError) throw loadError;
  });
  const showInactive = vi.fn();
  const webContents = {
    isCrashed: vi.fn(() => false),
    isDestroyed,
    mainFrame: {},
    on: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const window = {
    close,
    destroy,
    getBounds: vi.fn(() => ({ height: 144, width: 128, x: 1_440, y: 100 })),
    isDestroyed,
    loadURL,
    on: vi.fn((event: string, listener: Listener) => addListener(listeners, event, listener)),
    removeListener: vi.fn((event: string, listener: Listener) =>
      removeListener(listeners, event, listener),
    ),
    setAlwaysOnTop: vi.fn(),
    setPosition: vi.fn(),
    showInactive,
    webContents,
  } as unknown as BrowserWindow;
  electronHarness.BrowserWindow.mockImplementationOnce(function () {
    return window;
  });
  return { close, destroy, emit, isDestroyed, loadURL, showInactive, window };
};

const createUsageWindow = (visibility: boolean[], requests: boolean[]): ModelUsageWindow =>
  new ModelUsageWindow(
    (visible) => visibility.push(visible),
    (visible) => requests.push(visible),
  );

afterEach(() => {
  delete process.env.ELECTRON_RENDERER_URL;
  electronHarness.BrowserWindow.mockReset();
  electronHarness.screen.getCursorScreenPoint.mockClear();
  electronHarness.screen.getDisplayMatching.mockClear();
  electronHarness.screen.getDisplayNearestPoint.mockClear();
  electronHarness.screen.on.mockClear();
  electronHarness.screen.removeListener.mockClear();
});

describe('model usage window lifecycle', () => {
  it('reports explicit show and native close transitions', async () => {
    process.env.ELECTRON_RENDERER_URL = 'http://renderer.test';
    const harness = createHarness();
    const visibility: boolean[] = [];
    const requests: boolean[] = [];
    const usageWindow = createUsageWindow(visibility, requests);

    await usageWindow.setVisible(true);
    expect(requests).toEqual([true]);
    expect(visibility).toEqual([true]);
    expect(harness.showInactive).toHaveBeenCalledTimes(1);

    await usageWindow.setVisible(false);
    expect(requests).toEqual([true, false]);
    expect(visibility).toEqual([true, false]);
  });

  it('replays the latest show request after show-hide-show during async opening', async () => {
    process.env.ELECTRON_RENDERER_URL = 'http://renderer.test';
    let finishLoad!: () => void;
    const loadReady = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    const first = createHarness(undefined, loadReady);
    const second = createHarness();
    const visibility: boolean[] = [];
    const requests: boolean[] = [];
    const usageWindow = createUsageWindow(visibility, requests);

    const firstShow = usageWindow.setVisible(true);
    await Promise.resolve();
    await usageWindow.setVisible(false);
    const secondShow = usageWindow.setVisible(true);
    finishLoad();
    await Promise.all([firstShow, secondShow]);

    expect(first.showInactive).not.toHaveBeenCalled();
    expect(second.showInactive).toHaveBeenCalledOnce();
    expect(visibility).toEqual([false, true]);
    expect(requests).toEqual([true, false, true]);
  });

  it('retries the latest show after a superseded opening rejects', async () => {
    process.env.ELECTRON_RENDERER_URL = 'http://renderer.test';
    let finishLoad!: () => void;
    const loadReady = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    createHarness(new Error('stale opening'), loadReady);
    const second = createHarness();
    const usageWindow = createUsageWindow([], []);

    const firstShow = usageWindow.setVisible(true);
    await Promise.resolve();
    await usageWindow.setVisible(false);
    const secondShow = usageWindow.setVisible(true);
    finishLoad();

    await expect(firstShow).rejects.toThrow('stale opening');
    await expect(secondShow).resolves.toBeUndefined();
    expect(second.showInactive).toHaveBeenCalledOnce();
  });

  it('does not report shutdown destruction as an explicit hide', async () => {
    process.env.ELECTRON_RENDERER_URL = 'http://renderer.test';
    const harness = createHarness();
    const visibility: boolean[] = [];
    const usageWindow = createUsageWindow(visibility, []);

    await usageWindow.setVisible(true);
    usageWindow.dispose();

    expect(harness.destroy).toHaveBeenCalledOnce();
    expect(visibility).toEqual([true]);
  });

  it('does not erase visibility when opening fails', async () => {
    process.env.ELECTRON_RENDERER_URL = 'http://renderer.test';
    const harness = createHarness(new Error('load failed'));
    const visibility: boolean[] = [];
    const requests: boolean[] = [];
    const usageWindow = createUsageWindow(visibility, requests);

    await expect(usageWindow.setVisible(true)).rejects.toThrow('load failed');

    expect(requests).toEqual([true]);
    expect(visibility).toEqual([]);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('rejects opening after disposal and ignores a redundant hide', async () => {
    const requests: boolean[] = [];
    const usageWindow = createUsageWindow([], requests);
    usageWindow.dispose();

    await expect(usageWindow.setVisible(true)).rejects.toThrow('应用正在退出');
    await expect(usageWindow.setVisible(false)).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });
});
