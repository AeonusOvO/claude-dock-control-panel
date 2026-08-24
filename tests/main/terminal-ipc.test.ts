import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CLIPBOARD_TEXT_LENGTH,
  MAX_TERMINAL_WRITE_LENGTH,
} from '../../src/shared/contracts/terminal';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('terminal IPC input boundary', () => {
  it('admits one full bracketed clipboard payload and rejects larger messages', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const [{ Registry }, { registerTerminalIpc }] = await Promise.all([
      import('../../src/main/infra/registry'),
      import('../../src/main/ipc/terminal'),
    ]);
    const write = vi.fn();
    const validateSender = vi.fn();
    registerTerminalIpc({
      directTerminalTransitions: {} as never,
      guards: { validateSender },
      services: new Registry(),
      workspace: { write } as never,
    });
    const payload = `\x1b[200~${'x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH)}\x1b[201~`;

    expect(payload).toHaveLength(MAX_TERMINAL_WRITE_LENGTH);
    ipc.sendFromRenderer(CHANNELS.TERMINAL_WRITE, 'session-1', 7, payload);

    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]).toEqual(['session-1', 7, payload]);

    ipc.sendFromRenderer(
      CHANNELS.TERMINAL_WRITE,
      'session-1',
      7,
      'x'.repeat(MAX_TERMINAL_WRITE_LENGTH + 1),
    );
    expect(write).toHaveBeenCalledOnce();
    expect(validateSender).toHaveBeenCalledTimes(2);
  });
});
