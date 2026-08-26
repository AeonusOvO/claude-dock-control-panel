import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { rendererStyles } from '../helpers/renderer-css';
import { createIpcHarness } from '../helpers/ipc-harness';
import { createRendererHarness, type RendererHarness } from '../helpers/renderer-harness';

const renderers: RendererHarness[] = [];

afterEach(async () => {
  await Promise.all(renderers.splice(0).map((renderer) => renderer.cleanup()));
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('quit dialog delivery', () => {
  it('acknowledges the exact request only after notifying and echoes ids with decisions', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({
      ipcRenderer: ipc.ipcRenderer,
      webUtils: { getPathForFile: vi.fn(() => '') },
    }));
    const { appBridge } = await import('../../src/preload/bridges/app');
    const observedMessageCounts: number[] = [];
    const invalidated: string[] = [];
    const unsubscribe = appBridge.onAppQuitRequested(() => {
      observedMessageCounts.push(ipc.messages.length);
    });
    const unsubscribeInvalidated = appBridge.onAppQuitRequestInvalidated((requestId) => {
      invalidated.push(requestId);
    });

    ipc.emitFromMain(CHANNELS.APP_QUIT_REQUESTED, {
      hasBlocking: false,
      leases: [],
      requestId: 'quit-request-1',
    });
    expect(observedMessageCounts).toEqual([1]);
    expect(ipc.messages[1]).toEqual({
      args: ['quit-request-1'],
      channel: CHANNELS.APP_QUIT_REQUEST_RECEIVED,
      direction: 'renderer-to-main',
    });

    appBridge.confirmQuit({ decision: false, requestId: 'quit-request-1' });
    appBridge.confirmQuit({ decision: 'retry', requestId: 'quit-request-2' });
    appBridge.confirmQuit({ decision: true, requestId: 'quit-request-3' });
    appBridge.confirmQuit({ decision: 'minimize', requestId: 'quit-request-4' });
    appBridge.minimizeToTray();
    expect(ipc.messages.slice(2).map(({ args, channel }) => ({ args, channel }))).toEqual([
      {
        args: [{ decision: false, requestId: 'quit-request-1' }],
        channel: CHANNELS.APP_CONFIRM_QUIT,
      },
      {
        args: [{ decision: 'retry', requestId: 'quit-request-2' }],
        channel: CHANNELS.APP_CONFIRM_QUIT,
      },
      {
        args: [{ decision: true, requestId: 'quit-request-3' }],
        channel: CHANNELS.APP_CONFIRM_QUIT,
      },
      {
        args: [{ decision: 'minimize', requestId: 'quit-request-4' }],
        channel: CHANNELS.APP_CONFIRM_QUIT,
      },
      { args: [], channel: CHANNELS.APP_MINIMIZE_TO_TRAY },
    ]);

    ipc.emitFromMain(CHANNELS.APP_QUIT_REQUEST_INVALIDATED, 'quit-request-1');
    expect(invalidated).toEqual(['quit-request-1']);

    unsubscribe();
    unsubscribeInvalidated();
    const acknowledgementsBeforeThrow = ipc.messages.filter(
      ({ channel }) => channel === CHANNELS.APP_QUIT_REQUEST_RECEIVED,
    ).length;
    const unsubscribeThrowing = appBridge.onAppQuitRequested(() => {
      throw new Error('dialog listener failed');
    });
    expect(() =>
      ipc.emitFromMain(CHANNELS.APP_QUIT_REQUESTED, {
        hasBlocking: false,
        leases: [],
        requestId: 'quit-request-4',
      }),
    ).toThrow('dialog listener failed');
    expect(
      ipc.messages.filter(({ channel }) => channel === CHANNELS.APP_QUIT_REQUEST_RECEIVED),
    ).toHaveLength(acknowledgementsBeforeThrow);
    unsubscribeThrowing();
    expect(observedMessageCounts).toEqual([1]);
  });

  it('renders exact requests and makes superseded dialogs and force decisions inert', async () => {
    const renderer = await createRendererHarness();
    renderers.push(renderer);
    renderer.clearCalls();
    const dialog = renderer.query<HTMLDialogElement>('#quit-confirmation-dialog');
    const confirmationDialog = renderer.query<HTMLDialogElement>('#confirmation-dialog');
    const minimize = renderer.query<HTMLButtonElement>('#quit-minimize');
    const force = renderer.query<HTMLButtonElement>('#quit-force');
    const cancel = renderer.query<HTMLButtonElement>('#quit-cancel');

    expect(minimize.autofocus).toBe(true);
    expect(
      [minimize, force, cancel].map((button) =>
        Array.from(button.parentElement?.children ?? []).indexOf(button),
      ),
    ).toEqual([0, 1, 2]);

    renderer.emit('onAppQuitRequested', {
      hasBlocking: true,
      leases: [
        {
          cancellable: false,
          id: 'install:critical',
          kind: 'install',
          label: '关键安装正在提交',
          severity: 'blocking',
          stage: '安装包正在写入；强制退出可能留下不完整文件。',
        },
      ],
      requestId: 'quit-request-1',
    });
    expect(dialog.open).toBe(true);
    expect(renderer.query('#quit-confirmation-title').textContent).toBe('正在完成退出前的收尾工作');
    expect(renderer.query('#quit-confirmation-list').textContent).toContain('关键安装正在提交');
    expect(renderer.query('#quit-confirmation-list').textContent).toContain(
      '安装包正在写入；强制退出可能留下不完整文件。',
    );
    expect(renderer.query('#quit-confirmation-list').textContent).toContain('强制退出有风险');
    expect(cancel.textContent).toBe('不退出，返回软件');
    expect(renderer.document.activeElement).toBe(minimize);

    force.click();
    expect(confirmationDialog.open).toBe(true);
    renderer.emit('onAppQuitRequestInvalidated', 'quit-request-1');
    expect(dialog.open).toBe(false);
    expect(confirmationDialog.open).toBe(false);
    await renderer.flush();
    expect(renderer.method('confirmQuit')).not.toHaveBeenCalled();

    renderer.emit('onAppQuitRequested', {
      hasBlocking: true,
      leases: [],
      requestId: 'quit-request-2',
      runtimeCleanupFailed: true,
    });
    expect(renderer.query('#quit-confirmation-title').textContent).toBe(
      '仍有会话或派生进程未能安全结束',
    );
    expect(renderer.query('#quit-confirmation-message').textContent).toContain('会话或进程');
    expect(minimize.textContent).toBe('重试安全清理');
    expect(cancel.hidden).toBe(true);
    minimize.click();
    expect(renderer.method('confirmQuit')).toHaveBeenLastCalledWith({
      decision: 'retry',
      requestId: 'quit-request-2',
    });
    expect(renderer.method('minimizeToTray')).not.toHaveBeenCalled();

    renderer.emit('onAppQuitRequested', {
      hasBlocking: false,
      leases: [],
      requestId: 'quit-request-3',
    });
    force.click();
    expect(renderer.method('confirmQuit')).toHaveBeenLastCalledWith({
      decision: true,
      requestId: 'quit-request-3',
    });

    renderer.emit('onAppQuitRequested', {
      hasBlocking: false,
      leases: [],
      requestId: 'quit-request-4',
    });
    const cancelEvent = new renderer.dom.window.Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(renderer.method('confirmQuit')).toHaveBeenLastCalledWith({
      decision: false,
      requestId: 'quit-request-4',
    });

    expect(dialog.classList.contains('popover')).toBe(true);
    expect(rendererStyles).toContain('.quit-confirmation-dialog');
    expect(rendererStyles).toMatch(
      /dialog\.popover::backdrop \{[^}]*?overlay var\(--dur-exit\) allow-discrete,[^}]*?display var\(--dur-exit\) allow-discrete;/,
    );
    expect(rendererStyles).toMatch(
      /@starting-style \{[\s\S]*?dialog\.popover\[open\][\s\S]*?dialog\.popover\[open\]::backdrop/,
    );
  });
});
