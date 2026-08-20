import type { IpcMainEvent, IpcMainInvokeEvent, IpcRendererEvent, WebContents } from 'electron';
import { vi } from 'vitest';
import type {
  IpcRequestArgs,
  IpcRequestChannel,
  IpcRequestResult,
} from '../../src/shared/ipc/schema';

type MainInvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;
type MainListener = (event: IpcMainEvent, ...args: unknown[]) => void;
type RendererListener = (event: IpcRendererEvent, ...args: unknown[]) => void;

export interface IpcRegistration {
  channel: string;
  kind: 'handle' | 'main-listener' | 'renderer-listener';
}

export interface IpcMessage {
  args: unknown[];
  channel: string;
  direction: 'main-to-renderer' | 'renderer-to-main';
}

export interface IpcHarness {
  readonly handlers: ReadonlyMap<string, MainInvokeHandler>;
  readonly ipcMain: {
    handle: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  readonly ipcRenderer: {
    invoke: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  readonly mainListeners: ReadonlyMap<string, readonly MainListener[]>;
  readonly messages: readonly IpcMessage[];
  readonly registrations: readonly IpcRegistration[];
  readonly rendererListeners: ReadonlyMap<string, readonly RendererListener[]>;
  readonly webContents: WebContents;
  emitFromMain: (channel: string, ...args: unknown[]) => void;
  invoke: <Channel extends IpcRequestChannel>(
    channel: Channel,
    ...args: IpcRequestArgs<Channel>
  ) => Promise<IpcRequestResult<Channel>>;
  sendFromRenderer: (channel: string, ...args: unknown[]) => void;
}

const appendListener = <Listener>(
  listeners: Map<string, Listener[]>,
  channel: string,
  listener: Listener,
): void => {
  const current = listeners.get(channel) ?? [];
  current.push(listener);
  listeners.set(channel, current);
};

export const createIpcHarness = (): IpcHarness => {
  const handlers = new Map<string, MainInvokeHandler>();
  const mainListeners = new Map<string, MainListener[]>();
  const rendererListeners = new Map<string, RendererListener[]>();
  const messages: IpcMessage[] = [];
  const registrations: IpcRegistration[] = [];

  const rendererEvent = {} as IpcRendererEvent;

  const emitFromMain = (channel: string, ...args: unknown[]): void => {
    messages.push({ args, channel, direction: 'main-to-renderer' });
    for (const listener of rendererListeners.get(channel) ?? []) {
      listener(rendererEvent, ...args);
    }
  };

  const sendFromRenderer = (channel: string, ...args: unknown[]): void => {
    messages.push({ args, channel, direction: 'renderer-to-main' });
    for (const listener of mainListeners.get(channel) ?? []) {
      listener(mainEvent(), ...args);
    }
  };

  const webContents = {
    id: 1,
    isCrashed: () => false,
    isDestroyed: () => false,
    isLoading: () => false,
    send: emitFromMain,
  } as unknown as WebContents;
  const mainEvent = (): IpcMainEvent =>
    ({
      sender: webContents,
      senderFrame: { url: 'file:///renderer/index.html' },
    }) as IpcMainEvent;
  const invokeEvent = (): IpcMainInvokeEvent =>
    ({
      sender: webContents,
      senderFrame: { url: 'file:///renderer/index.html' },
    }) as IpcMainInvokeEvent;

  const invoke = async <Channel extends IpcRequestChannel>(
    channel: Channel,
    ...args: IpcRequestArgs<Channel>
  ): Promise<IpcRequestResult<Channel>> => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`No IPC handler registered for ${channel}.`);
    }
    return (await handler(invokeEvent(), ...args)) as IpcRequestResult<Channel>;
  };

  const ipcMain = {
    handle: vi.fn((channel: string, handler: MainInvokeHandler) => {
      if (handlers.has(channel)) {
        throw new Error(`IPC handler already registered for ${channel}.`);
      }
      handlers.set(channel, handler);
      registrations.push({ channel, kind: 'handle' });
    }),
    on: vi.fn((channel: string, listener: MainListener) => {
      appendListener(mainListeners, channel, listener);
      registrations.push({ channel, kind: 'main-listener' });
      return ipcMain;
    }),
  };

  const ipcRenderer = {
    invoke: vi.fn((channel: IpcRequestChannel, ...args: unknown[]) =>
      invoke(channel, ...(args as IpcRequestArgs<typeof channel>)),
    ),
    on: vi.fn((channel: string, listener: RendererListener) => {
      appendListener(rendererListeners, channel, listener);
      registrations.push({ channel, kind: 'renderer-listener' });
      return ipcRenderer;
    }),
    removeListener: vi.fn((channel: string, listener: RendererListener) => {
      const current = rendererListeners.get(channel);
      if (current) {
        rendererListeners.set(
          channel,
          current.filter((candidate) => candidate !== listener),
        );
      }
      return ipcRenderer;
    }),
    send: vi.fn(sendFromRenderer),
  };

  return {
    handlers,
    ipcMain,
    ipcRenderer,
    mainListeners,
    messages,
    registrations,
    rendererListeners,
    webContents,
    emitFromMain,
    invoke,
    sendFromRenderer,
  };
};
