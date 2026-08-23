import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';

const fixtureRoots: string[] = [];

const createFixtureRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-network-ipc-'));
  fixtureRoots.push(root);
  return root;
};

const installElectronMock = () => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
  return ipc;
};

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('network IPC', () => {
  it('normalizes and forwards open or remembered project directories', async () => {
    const ipc = installElectronMock();
    const { registerNetworkIpc } = await import('../../src/main/ipc/network');
    const root = createFixtureRoot();
    const openProject = path.join(root, 'open-project');
    const rememberedProject = path.join(root, 'remembered-project');
    mkdirSync(openProject);
    mkdirSync(rememberedProject);
    const run = vi.fn(async () => undefined);
    const validateSender = vi.fn();

    registerNetworkIpc({
      guards: {
        requireNetworkPreflightService: () => ({ run }) as never,
        validateSender,
      },
      workspace: {
        getState: () => ({ activeSessionId: '', sessions: [{ cwd: openProject }] }),
      } as never,
      workspaceStore: {
        getProjects: () => [{ addedAt: 1, lastActiveAt: 2, path: rememberedProject }],
      } as never,
    });

    await ipc.invoke(CHANNELS.NETWORK_PREFLIGHT_RUN, {
      action: 'cli-launch',
      cwd: path.join(openProject, '..', path.basename(openProject)),
      force: true,
      networkScope: 'conversation',
      provider: 'anthropic-claude',
    });
    await ipc.invoke(CHANNELS.NETWORK_PREFLIGHT_RUN, {
      action: 'first-request',
      cwd: rememberedProject,
      provider: 'anthropic-claude',
    });

    expect(run).toHaveBeenNthCalledWith(1, {
      action: 'cli-launch',
      cwd: path.resolve(openProject),
      force: true,
      networkScope: 'conversation',
      provider: 'anthropic-claude',
    });
    expect(run).toHaveBeenNthCalledWith(2, {
      action: 'first-request',
      cwd: path.resolve(rememberedProject),
      provider: 'anthropic-claude',
    });
    expect(validateSender).toHaveBeenCalledTimes(2);
  });

  it('rejects an existing directory that is not owned by the workspace', async () => {
    const ipc = installElectronMock();
    const { registerNetworkIpc } = await import('../../src/main/ipc/network');
    const unownedProject = path.join(createFixtureRoot(), 'unowned-project');
    mkdirSync(unownedProject);
    const run = vi.fn(async () => undefined);

    registerNetworkIpc({
      guards: {
        requireNetworkPreflightService: () => ({ run }) as never,
        validateSender: vi.fn(),
      },
      workspace: {
        getState: () => ({ activeSessionId: '', sessions: [] }),
      } as never,
      workspaceStore: { getProjects: () => [] } as never,
    });

    await expect(
      ipc.invoke(CHANNELS.NETWORK_PREFLIGHT_RUN, {
        action: 'background',
        cwd: unownedProject,
        provider: 'openai-codex',
      }),
    ).rejects.toThrow('已打开或已保存的项目目录');
    expect(run).not.toHaveBeenCalled();
  });

  it('supports project-free checks and rejects unknown input fields', async () => {
    const ipc = installElectronMock();
    const { registerNetworkIpc } = await import('../../src/main/ipc/network');
    const run = vi.fn(async () => undefined);

    registerNetworkIpc({
      guards: {
        requireNetworkPreflightService: () => ({ run }) as never,
        validateSender: vi.fn(),
      },
      workspace: { getState: () => ({ activeSessionId: '', sessions: [] }) } as never,
      workspaceStore: { getProjects: () => [] } as never,
    });

    await ipc.invoke(CHANNELS.NETWORK_PREFLIGHT_RUN, {
      action: 'background',
      networkScope: 'application',
      provider: 'openai-api',
    });
    expect(run).toHaveBeenCalledWith({
      action: 'background',
      networkScope: 'application',
      provider: 'openai-api',
    });

    const rendererAuthorityAttempts = [
      { target: { process: 'application', url: 'https://api.openai.com/v1/models' } },
      { endpoint: 'https://api.openai.com/v1/models' },
      { process: 'application' },
      { transport: 'electron-conversation-session' },
      { configurationRevision: 'renderer-controlled' },
      { mainRunId: 999 },
    ];
    for (const authority of rendererAuthorityAttempts) {
      await expect(
        ipc.invoke(CHANNELS.NETWORK_PREFLIGHT_RUN, {
          action: 'background',
          provider: 'openai-api',
          ...authority,
        } as never),
      ).rejects.toThrow();
    }
    expect(run).toHaveBeenCalledTimes(1);
  });
});
