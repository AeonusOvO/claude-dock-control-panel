import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DevelopmentRuntimeSwitchOperation } from '../../src/shared/contracts';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

const registerHarness = async (switchOperation?: DevelopmentRuntimeSwitchOperation) => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
  const { registerRuntimeIpc } = await import('../../src/main/ipc/runtime');
  const activeSwitch = vi.fn(() => switchOperation);
  const validateSender = vi.fn();
  registerRuntimeIpc({
    agentRuntimeStore: { get: vi.fn(() => 'claude') } as never,
    guards: { validateSender },
    projectRuntimeSwitchOperations: {
      activeSwitch,
      switchRuntime: vi.fn(),
    } as never,
    runtimeActivityRegistry: {} as never,
    services: {} as never,
    workspace: {
      getDevelopmentRuntime: vi.fn(() => 'claude'),
      getStatus: vi.fn(() => ({ cwd: 'D:\\Project', id: 'session-1' })),
    } as never,
  });
  return { activeSwitch, ipc, validateSender };
};

describe('runtime IPC ownership', () => {
  it('returns the main-owned pending switch with the stable committed runtime', async () => {
    const switchOperation = { attempt: 17, runtime: 'codex' } as const;
    const { activeSwitch, ipc, validateSender } = await registerHarness(switchOperation);

    await expect(ipc.invoke(CHANNELS.RUNTIME_GET, 'session-1')).resolves.toEqual({
      cwd: 'D:\\Project',
      runtime: 'claude',
      sessionId: 'session-1',
      switchOperation,
    });

    expect(activeSwitch).toHaveBeenCalledExactlyOnceWith('D:\\Project');
    expect(validateSender).toHaveBeenCalledOnce();
  });
});
