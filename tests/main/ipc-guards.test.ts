import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeEffects } from '../../src/main/app/profile';
import { Registry } from '../../src/main/infra/registry';
import { MAIN_WINDOW, PROVIDER_ACCESS_GUARD } from '../../src/main/infra/service-tokens';
import { createMainState } from '../../src/main/ipc/context';
import { createMainGuards } from '../../src/main/ipc/guards';

const effects: RuntimeEffects = {
  allowApplicationUpdates: true,
  allowExternalRoutingWrites: true,
  allowPluginMutations: true,
  allowRealRuntimes: true,
  restoreWorkspace: true,
  singleInstanceLock: true,
  tray: true,
};

describe('main IPC guards', () => {
  it('accepts only the exact main-window sender and exact top frame', () => {
    const services = new Registry();
    const windowReference = { current: null as BrowserWindow | null };
    services.register(MAIN_WINDOW, () => windowReference);
    const guards = createMainGuards(services, effects);
    const mainFrame = { url: 'file:///renderer/index.html' };
    const webContents = { mainFrame };

    expect(() =>
      guards.validateSender({
        sender: webContents,
        senderFrame: mainFrame,
      } as never),
    ).toThrow('Rejected IPC from an unknown renderer.');

    windowReference.current = { webContents } as never;
    expect(() =>
      guards.validateSender({
        sender: { mainFrame },
        senderFrame: mainFrame,
      } as never),
    ).toThrow('Rejected IPC from an unknown renderer.');
    expect(() =>
      guards.validateSender({
        sender: webContents,
        senderFrame: { url: 'file:///renderer/subframe.html' },
      } as never),
    ).toThrow('Rejected IPC from an unknown renderer.');
    expect(() =>
      guards.validateSender({
        sender: webContents,
        senderFrame: mainFrame,
      } as never),
    ).not.toThrow();
  });

  it('fences launch admission throughout controlled quit cleanup and final quitting', () => {
    const state = createMainState();
    const guards = createMainGuards(new Registry(), effects, state);

    expect(() => guards.assertLaunchAdmissionAllowed()).not.toThrow();
    state.quitCleanupInProgress = true;
    expect(() => guards.assertLaunchAdmissionAllowed()).toThrow(
      '应用正在退出，无法启动新的 Claude 会话。',
    );
    state.quitCleanupInProgress = false;
    state.isQuitting = true;
    expect(() => guards.assertLaunchAdmissionAllowed()).toThrow(
      '应用正在退出，无法启动新的 Claude 会话。',
    );
  });

  it('forwards authoritative access and keeps the operation inside the guard callback', async () => {
    const services = new Registry();
    const withAllowed = vi.fn(async (_request, operation) => operation());
    services.register(PROVIDER_ACCESS_GUARD, () => ({ withAllowed }) as never);
    const guards = createMainGuards(services, effects);
    const target = {
      process: 'application' as const,
      url: 'https://api.openai.com/v1/responses',
    };
    const operation = vi.fn(() => 'started');
    const signal = new AbortController().signal;
    const request = {
      action: 'first-request' as const,
      cwd: 'D:\\Project',
      networkScope: 'conversation' as const,
      provider: 'openai-codex' as const,
      target,
    };

    await expect(guards.withOfficialProviderAccess(request, operation, signal)).resolves.toBe(
      'started',
    );

    expect(withAllowed).toHaveBeenCalledWith(request, operation, signal);
    expect(operation).toHaveBeenCalledOnce();
  });
});
