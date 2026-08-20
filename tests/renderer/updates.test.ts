import { describe, expect, it, vi } from 'vitest';
import type {
  ApplicationUpdaterState,
  ClaudePluginCatalog,
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
  application: {
    currentVersion: '5.0.0',
    installed: true,
    latestVersion: '5.1.0',
    message: 'ClaudeDock 5.1.0 可用。',
    updateAvailable: true,
  },
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
  currentVersion: '5.0.0',
  latestVersion: '5.1.0',
  message: 'ClaudeDock 5.1.0 可用。',
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
      harness.click('#refresh-updates');
      await settle(harness);

      expect(harness.method('getSoftwareUpdates')).toHaveBeenCalledWith(true);
      expect(harness.method('refreshClaudePluginMarketplaces')).toHaveBeenCalled();
      expect(harness.query<HTMLDialogElement>('#update-center-dialog').open).toBe(true);
      expect(harness.query('#update-center-summary').textContent).toContain('2 项可更新');
      expect(harness.query('#update-center-list').textContent).toContain('ClaudeDock');
      expect(harness.query('#update-center-list').textContent).toContain('Claude Code');
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

  it('installs a downloaded application update only after in-page confirmation', async () => {
    const harness = await createRendererHarness();
    try {
      harness.emit('onApplicationUpdaterChanged', applicationUpdater('downloaded'));
      expect(harness.query('#application-update-action').textContent).toBe('重启并安装');

      harness.click('#application-update-action');
      expect(harness.query('#confirmation-dialog').textContent).toContain('安装 ClaudeDock 更新');
      harness.query<HTMLDialogElement>('#confirmation-dialog').close('confirm');
      await settle(harness);

      expect(harness.method('installApplicationUpdate')).toHaveBeenCalledOnce();
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('beforeunload'));
      expect(harness.method('onApplicationUpdaterChanged')).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });
});
