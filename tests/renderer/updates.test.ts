import { describe, expect, it, vi } from 'vitest';
import type {
  ApplicationUpdaterState,
  ClaudePluginCatalog,
  DownloadTaskView,
  SoftwareUpdateState,
} from '../../src/shared/contracts';
import { createRendererHarness } from '../helpers/renderer-harness';
import { settle } from '../helpers/renderer-interaction-fixture';

const pluginCatalog: ClaudePluginCatalog = {
  available: [],
  checkedAt: 1,
  cliAvailable: true,
  installed: [],
  marketplaces: [],
  message: '插件列表已加载。',
  updatesAvailable: 0,
};

const softwareUpdates: SoftwareUpdateState = {
  checkedAt: 1,
  claudeCode: {
    currentVersion: '1.0.0',
    installed: true,
    latestVersion: '1.1.0',
    message: 'Claude Code 1.1.0 可用。',
    updateAvailable: true,
  },
  router: {
    currentVersion: '2.0.0',
    installed: true,
    message: '路由器已是最新版本。',
    updateAvailable: false,
  },
};

const applicationUpdater = (
  phase: ApplicationUpdaterState['phase'],
  overrides: Partial<ApplicationUpdaterState> = {},
): ApplicationUpdaterState => ({
  currentVersion: '5.0.0-rc.14',
  latestVersion: '5.0.0-rc.15',
  message: 'ClaudeDock 5.0.0-rc.15 可用。',
  phase,
  ...overrides,
});

const marketplaceRefreshResult = {
  catalog: pluginCatalog,
  message: '插件更新检查完成。',
  ok: true,
};

describe('renderer updates feature', () => {
  it('checks every update source and runs an application update from the center', async () => {
    let updaterState = applicationUpdater('available');
    const harness = await createRendererHarness({
      downloadApplicationUpdate: vi.fn(async () => {
        updaterState = applicationUpdater('downloading', {
          bytesPerSecond: 512,
          downloadedBytes: 512,
          percent: 50,
          totalBytes: 1_024,
        });
        return updaterState;
      }),
      getApplicationUpdaterState: vi.fn(async () => updaterState),
      getSoftwareUpdates: vi.fn(async () => softwareUpdates),
      refreshClaudePluginMarketplaces: vi.fn(async () => marketplaceRefreshResult),
    });
    try {
      await settle(harness);
      expect(harness.method('getApplicationUpdaterState')).toHaveBeenCalledWith(true);
      harness.clearCalls();

      harness.click('#refresh-updates');
      await settle(harness);

      expect(harness.method('getSoftwareUpdates')).toHaveBeenCalledWith(true);
      expect(harness.method('getApplicationUpdaterState')).toHaveBeenCalledWith(true);
      expect(harness.method('getApplicationUpdaterState')).toHaveBeenLastCalledWith(true);
      expect(harness.method('downloadApplicationUpdate')).not.toHaveBeenCalled();
      expect(harness.method('refreshClaudePluginMarketplaces')).toHaveBeenCalled();
      expect(harness.query('#application-update-version').textContent).toBe(
        'v5.0.0-rc.14 → 5.0.0-rc.15',
      );
      expect(harness.query<HTMLDialogElement>('#update-center-dialog').open).toBe(true);
      expect(harness.query('#update-center-summary').textContent).toContain('2 项可更新');
      expect(harness.query('#update-center-list').textContent).toContain('ClaudeDock');
      expect(harness.query('#update-center-list').textContent).toContain('Claude Code');
      expect(harness.query('#update-center-list').textContent).toContain('下载并更新');
      expect(harness.query('#refresh-updates').getAttribute('aria-label')).toContain('2 项可更新');

      harness.click('[data-update-id="application"] .update-center-item__action');
      await settle(harness);

      expect(harness.method('downloadApplicationUpdate')).toHaveBeenCalled();
      expect(harness.query<HTMLDialogElement>('#update-center-dialog').open).toBe(false);
      expect(harness.query<HTMLDialogElement>('#download-center-dialog').open).toBe(true);
      expect(harness.query('#download-active-count').textContent).toBe('1');
    } finally {
      await harness.cleanup();
    }
  });

  it('offers a fresh download after an interrupted application install', async () => {
    const interrupted = applicationUpdater('install-recovery', {
      message: '上次 ClaudeDock 5.0.0-rc.16 的安装未完成，请重新下载并安装。',
    });
    const harness = await createRendererHarness({
      getApplicationUpdaterState: vi.fn(async () => interrupted),
      getSoftwareUpdates: vi.fn(async () => softwareUpdates),
    });
    try {
      await settle(harness);
      expect(harness.query('#application-update-action').textContent).toBe('重新下载并安装');

      harness.click('#refresh-updates');
      await settle(harness);

      expect(
        harness.query('[data-update-id="application"] .update-center-item__action').textContent,
      ).toBe('重新下载并安装');
      expect(harness.query('#update-center-list').textContent).toContain('安装未完成');
    } finally {
      await harness.cleanup();
    }
  });

  it('runs the application update last because success exits into the installer', async () => {
    const operationOrder: string[] = [];
    let updaterState = applicationUpdater('available');
    const harness = await createRendererHarness({
      downloadApplicationUpdate: vi.fn(async () => {
        operationOrder.push('application');
        updaterState = applicationUpdater('installing', {
          message: '正在退出并启动安装。',
          percent: 100,
        });
        return updaterState;
      }),
      getApplicationUpdaterState: vi.fn(async () => updaterState),
      getSoftwareUpdates: vi.fn(async () => softwareUpdates),
      installOrUpdateClaudeCode: vi.fn(async () => {
        operationOrder.push('claude-code');
        return {
          message: 'Claude Code 更新完成。',
          ok: true,
          state: softwareUpdates,
        };
      }),
      refreshClaudePluginMarketplaces: vi.fn(async () => marketplaceRefreshResult),
    });
    try {
      await settle(harness);
      harness.click('#refresh-updates');
      await settle(harness);
      harness.click('#update-center-all');
      await settle(harness);

      expect(operationOrder).toEqual(['claude-code', 'application']);
    } finally {
      await harness.cleanup();
    }
  });

  it('asks before resuming an interrupted download and refreshes the recovery state', async () => {
    const recoveryTask: DownloadTaskView = {
      bytesPerSecond: 128,
      canPause: false,
      canResume: true,
      elapsedMs: 10_000,
      id: 'recovered-tool',
      label: '恢复生命周期测试下载',
      percent: 10,
      receivedBytes: 100,
      remainingMs: 70_000,
      recoveryPending: true,
      recoveryToken: '00000000-0000-4000-8000-000000000001',
      startedAt: 1_000,
      state: 'paused',
      totalBytes: 1_000,
    };
    let recoveryVisible = true;
    const harness = await createRendererHarness({
      discardDownloadRecovery: vi.fn(async () => {
        recoveryVisible = false;
        return [];
      }),
      listDownloadRecoveryPending: vi.fn(async () => (recoveryVisible ? [recoveryTask] : [])),
      listDownloads: vi.fn(async () => (recoveryVisible ? [recoveryTask] : [])),
      resumeDownloadRecovery: vi.fn(async () => {
        recoveryVisible = false;
        return { ...recoveryTask, recoveryPending: false };
      }),
    });
    try {
      harness.click('#refresh-updates');
      expect(harness.query<HTMLDialogElement>('#update-center-dialog').open).toBe(true);
      await settle(harness);

      expect(harness.query<HTMLDialogElement>('#update-center-dialog').open).toBe(true);
      expect(harness.query<HTMLDialogElement>('#confirmation-dialog').open).toBe(true);
      expect(harness.query('#confirmation-dialog-message').textContent).toContain('上次下载被中断');
      expect(harness.query('#confirmation-dialog-confirm').textContent).toBe('恢复更新');

      harness.query<HTMLDialogElement>('#confirmation-dialog').close('confirm');
      await settle(harness);

      expect(harness.method('resumeDownloadRecovery')).toHaveBeenCalledWith(
        'recovered-tool',
        '00000000-0000-4000-8000-000000000001',
      );
      expect(harness.method('discardDownloadRecovery')).not.toHaveBeenCalled();
      expect(harness.query<HTMLDialogElement>('#confirmation-dialog').open).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it('shows verified downloads as automatically installing without a second confirmation', async () => {
    const harness = await createRendererHarness();
    try {
      harness.emit('onApplicationUpdaterChanged', applicationUpdater('downloaded'));
      expect(harness.query('#application-update-action').textContent).toBe('正在安装…');
      expect(harness.query<HTMLButtonElement>('#application-update-action').disabled).toBe(true);
      expect(harness.query('#confirmation-dialog').textContent).not.toContain(
        '安装 ClaudeDock 更新',
      );
      harness.emit(
        'onApplicationUpdaterChanged',
        applicationUpdater('installing', {
          message: '已校验，正在退出并启动安装。',
          percent: 100,
        }),
      );
      expect(harness.query('#application-update-action').textContent).toBe('正在安装…');
      expect(harness.method('installApplicationUpdate')).not.toHaveBeenCalled();
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('beforeunload'));
      expect(harness.method('onApplicationUpdaterChanged')).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });
});
