import { ipcRenderer } from 'electron';
import type { ControlPanelApi, OperationResult } from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const terminalBridge = {
  onTerminalData: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      sessionId: unknown,
      ptyGeneration: unknown,
      data: unknown,
    ): void => {
      if (
        typeof sessionId === 'string' &&
        typeof ptyGeneration === 'number' &&
        Number.isSafeInteger(ptyGeneration) &&
        ptyGeneration >= 0 &&
        typeof data === 'string'
      ) {
        listener(sessionId, ptyGeneration, data);
      }
    };
    ipcRenderer.on(CHANNELS.TERMINAL_DATA, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.TERMINAL_DATA, callback);
    };
  },
  onTerminalSize: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      sessionId: unknown,
      ptyGeneration: unknown,
      resizeRevision: unknown,
      cols: unknown,
      rows: unknown,
    ): void => {
      if (
        typeof sessionId === 'string' &&
        typeof ptyGeneration === 'number' &&
        Number.isSafeInteger(ptyGeneration) &&
        ptyGeneration >= 0 &&
        typeof resizeRevision === 'number' &&
        Number.isSafeInteger(resizeRevision) &&
        resizeRevision >= 0 &&
        typeof cols === 'number' &&
        typeof rows === 'number'
      ) {
        listener(sessionId, ptyGeneration, resizeRevision, cols, rows);
      }
    };
    ipcRenderer.on(CHANNELS.TERMINAL_SIZE, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.TERMINAL_SIZE, callback);
    };
  },
  resizeTerminal: (sessionId, ptyGeneration, resizeRevision, cols, rows) => {
    ipcRenderer.send(
      CHANNELS.TERMINAL_RESIZE,
      sessionId,
      ptyGeneration,
      resizeRevision,
      cols,
      rows,
    );
  },
  restartTerminal: (sessionId, expectedGeneration) =>
    ipcRenderer.invoke(
      CHANNELS.TERMINAL_RESTART,
      sessionId,
      expectedGeneration,
    ) as Promise<OperationResult>,
  startTerminal: (sessionId, expectedGeneration) =>
    ipcRenderer.invoke(
      CHANNELS.TERMINAL_START,
      sessionId,
      expectedGeneration,
    ) as Promise<OperationResult>,
  stopTerminal: (sessionId, expectedGeneration) =>
    ipcRenderer.invoke(
      CHANNELS.TERMINAL_STOP,
      sessionId,
      expectedGeneration,
    ) as Promise<OperationResult>,
  writeTerminal: (sessionId, ptyGeneration, data) => {
    ipcRenderer.send(CHANNELS.TERMINAL_WRITE, sessionId, ptyGeneration, data);
  },
} satisfies Partial<ControlPanelApi>;
