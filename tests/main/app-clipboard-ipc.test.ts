import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CLIPBOARD_TEXT_LENGTH } from '../../src/shared/contracts/terminal';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';

const installAppClipboardIpc = async () => {
  const ipc = createIpcHarness();
  const clipboard = {
    readText: vi.fn(() => ''),
    writeText: vi.fn(),
  };
  vi.doMock('electron', () => ({
    app: {},
    BrowserWindow: { fromWebContents: vi.fn(() => undefined) },
    clipboard,
    ipcMain: ipc.ipcMain,
    shell: { openExternal: vi.fn(async () => undefined) },
  }));
  const [{ Registry }, { registerAppIpc }] = await Promise.all([
    import('../../src/main/infra/registry'),
    import('../../src/main/ipc/app'),
  ]);
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
    services: new Registry(),
    startupModelConnectionCoordinator: { onChanged: vi.fn() } as never,
    state: {} as never,
    workspace: {} as never,
    workspaceStore: {} as never,
  });
  return { clipboard, ipc, validateSender };
};

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('application clipboard IPC boundary', () => {
  it('returns exact-limit clipboard text and truncates limit-plus-one reads', async () => {
    const { clipboard, ipc, validateSender } = await installAppClipboardIpc();
    const exactText = 'x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH);
    clipboard.readText.mockReturnValueOnce(exactText).mockReturnValueOnce(`${exactText}y`);

    await expect(ipc.invoke(CHANNELS.APP_CLIPBOARD_READ)).resolves.toBe(exactText);
    await expect(ipc.invoke(CHANNELS.APP_CLIPBOARD_READ)).resolves.toBe(exactText);

    expect(clipboard.readText).toHaveBeenCalledTimes(2);
    expect(validateSender).toHaveBeenCalledTimes(2);
  });

  it('writes exact-limit clipboard text and rejects limit-plus-one input', async () => {
    const { clipboard, ipc, validateSender } = await installAppClipboardIpc();
    const exactText = 'x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH);

    await expect(ipc.invoke(CHANNELS.APP_CLIPBOARD_WRITE, exactText)).resolves.toBe(true);
    await expect(ipc.invoke(CHANNELS.APP_CLIPBOARD_WRITE, `${exactText}y`)).resolves.toBe(false);

    expect(clipboard.writeText).toHaveBeenCalledOnce();
    expect(clipboard.writeText).toHaveBeenCalledWith(exactText);
    expect(validateSender).toHaveBeenCalledTimes(2);
  });
});
