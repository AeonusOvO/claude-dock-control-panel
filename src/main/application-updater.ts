import type { ApplicationUpdaterState } from '../shared/contracts';
import {
  type ApplicationUpdateSourceSelection,
  verifyDownloadedApplicationUpdate,
} from './application-update-sources';

interface UpdateInfoView {
  version?: unknown;
}

interface UpdateCheckResultView {
  isUpdateAvailable?: unknown;
  updateInfo?: UpdateInfoView;
}

interface DownloadProgressView {
  bytesPerSecond?: unknown;
  percent?: unknown;
  total?: unknown;
  transferred?: unknown;
}

export interface ApplicationUpdaterDriver {
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: () => Promise<UpdateCheckResultView | null>;
  downloadUpdate: () => Promise<string[]>;
  disableWebInstaller: boolean;
  on: (event: string, listener: (payload?: unknown) => void) => unknown;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  setFeedURL: (options: Record<string, unknown>) => void;
}

interface ApplicationUpdaterOptions {
  configureSource?: (source: ApplicationUpdateSourceSelection) => void;
  currentVersion: string;
  driver: ApplicationUpdaterDriver;
  enabled: boolean;
  onChange: (state: ApplicationUpdaterState) => void;
  onTrustedVersion?: (version: string) => void;
  selectSource?: () => Promise<ApplicationUpdateSourceSelection>;
}

const errorMessage = (value: unknown): string =>
  value instanceof Error ? value.message : '更新服务暂时不可用。';

const numericValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export class ApplicationUpdaterService {
  private operation: Promise<ApplicationUpdaterState> | undefined;
  private selection: ApplicationUpdateSourceSelection | undefined;
  private state: ApplicationUpdaterState;

  public constructor(private readonly options: ApplicationUpdaterOptions) {
    options.driver.autoDownload = false;
    options.driver.autoInstallOnAppQuit = false;
    options.driver.allowPrerelease = false;
    options.driver.allowDowngrade = false;
    options.driver.disableWebInstaller = true;
    this.state = options.enabled
      ? {
          currentVersion: options.currentVersion,
          message: '可以在 ClaudeDock 内下载并安装正式版更新。',
          phase: 'idle',
        }
      : {
          currentVersion: options.currentVersion,
          message: '自动更新仅在 Windows 安装版中启用。',
          phase: 'disabled',
        };
    this.installEventHandlers();
  }

  public getState(): ApplicationUpdaterState {
    return { ...this.state };
  }

  public checkAndDownload(): Promise<ApplicationUpdaterState> {
    if (!this.options.enabled) {
      return Promise.resolve(this.getState());
    }
    if (this.operation) {
      return this.operation;
    }
    if (this.state.phase === 'downloaded') {
      return Promise.resolve(this.getState());
    }
    this.operation = (async () => {
      this.updateState({
        currentVersion: this.options.currentVersion,
        message: '正在测试 GitHub 与可信 HTTPS 更新源…',
        phase: 'checking',
      });
      try {
        const source = await this.options.selectSource?.();
        if (!source) throw new Error('没有可验证的应用更新源。');
        this.selection = source;
        this.options.configureSource?.(source);
        this.options.onTrustedVersion?.(source.releaseVersion);
        this.options.driver.setFeedURL(source.feed);
        this.updateState({
          currentVersion: this.options.currentVersion,
          latestVersion: source.releaseVersion,
          message: source.throughputBps
            ? `已选择 ${source.label}，正在检查更新…`
            : `使用 ${source.label} 检查更新…`,
          phase: 'checking',
          sourceId: source.id,
          sourceLabel: source.label,
          sourceThroughputBps: source.throughputBps,
        });
        const result = await this.options.driver.checkForUpdates();
        if (!result) {
          throw new Error('更新服务未返回检查结果。');
        }
        const latestVersion =
          typeof result.updateInfo?.version === 'string' ? result.updateInfo.version : undefined;
        if (latestVersion && latestVersion !== source.releaseVersion) {
          throw new Error(
            `更新器返回版本 ${latestVersion}，签名发布清单声明 ${source.releaseVersion}。`,
          );
        }
        if (result.isUpdateAvailable === false || this.state.phase === 'up-to-date') {
          if (this.state.phase !== 'up-to-date') {
            this.updateState({
              currentVersion: this.options.currentVersion,
              latestVersion,
              message: 'ClaudeDock 已是当前发布通道的最新版本。',
              phase: 'up-to-date',
              sourceId: this.state.sourceId,
              sourceLabel: this.state.sourceLabel,
              sourceThroughputBps: this.state.sourceThroughputBps,
            });
          }
          return this.getState();
        }
        this.updateState({
          currentVersion: this.options.currentVersion,
          latestVersion,
          message: latestVersion ? `正在下载 ClaudeDock ${latestVersion}…` : '正在下载更新…',
          phase: 'downloading',
          sourceId: this.state.sourceId,
          sourceLabel: this.state.sourceLabel,
          sourceThroughputBps: this.state.sourceThroughputBps,
        });
        const downloadedPaths = await this.options.driver.downloadUpdate();
        await verifyDownloadedApplicationUpdate(downloadedPaths, source);
        this.updateState({
          currentVersion: this.options.currentVersion,
          latestVersion: source.releaseVersion,
          message: `ClaudeDock ${source.releaseVersion} 已通过签名清单、大小和 SHA-512 终检，可重启安装。`,
          percent: 100,
          phase: 'downloaded',
          sourceId: source.id,
          sourceLabel: source.label,
          sourceThroughputBps: source.throughputBps,
        });
        return this.getState();
      } catch (error) {
        this.updateState({
          currentVersion: this.options.currentVersion,
          latestVersion: this.state.latestVersion,
          message: `应用更新失败：${errorMessage(error)}`,
          phase: 'error',
          sourceId: this.state.sourceId,
          sourceLabel: this.state.sourceLabel,
          sourceThroughputBps: this.state.sourceThroughputBps,
        });
        return this.getState();
      } finally {
        this.operation = undefined;
      }
    })();
    return this.operation;
  }

  public installDownloaded(): void {
    if (this.state.phase !== 'downloaded') {
      throw new Error('更新安装包尚未下载完成。');
    }
    this.options.driver.quitAndInstall(false, true);
  }

  private installEventHandlers(): void {
    const { driver } = this.options;
    driver.on('update-available', (payload) => {
      const info = payload as UpdateInfoView | undefined;
      const latestVersion = typeof info?.version === 'string' ? info.version : undefined;
      this.updateState({
        currentVersion: this.options.currentVersion,
        latestVersion,
        message: latestVersion ? `发现 ClaudeDock ${latestVersion}。` : '发现可用更新。',
        phase: 'available',
        sourceId: this.state.sourceId,
        sourceLabel: this.state.sourceLabel,
        sourceThroughputBps: this.state.sourceThroughputBps,
      });
    });
    driver.on('update-not-available', (payload) => {
      const info = payload as UpdateInfoView | undefined;
      const latestVersion = typeof info?.version === 'string' ? info.version : undefined;
      this.updateState({
        currentVersion: this.options.currentVersion,
        latestVersion,
        message: 'ClaudeDock 已是当前发布通道的最新版本。',
        phase: 'up-to-date',
        sourceId: this.state.sourceId,
        sourceLabel: this.state.sourceLabel,
        sourceThroughputBps: this.state.sourceThroughputBps,
      });
    });
    driver.on('download-progress', (payload) => {
      const progress = payload as DownloadProgressView | undefined;
      const percent = numericValue(progress?.percent);
      this.updateState({
        bytesPerSecond: numericValue(progress?.bytesPerSecond),
        currentVersion: this.options.currentVersion,
        downloadedBytes: numericValue(progress?.transferred),
        latestVersion: this.state.latestVersion,
        message: `正在下载更新${percent === undefined ? '' : ` · ${Math.round(percent)}%`}…`,
        percent,
        phase: 'downloading',
        sourceId: this.state.sourceId,
        sourceLabel: this.state.sourceLabel,
        sourceThroughputBps: this.state.sourceThroughputBps,
        totalBytes: numericValue(progress?.total),
      });
    });
    driver.on('update-downloaded', (payload) => {
      const info = payload as UpdateInfoView | undefined;
      const latestVersion =
        typeof info?.version === 'string'
          ? info.version
          : (this.selection?.releaseVersion ?? this.state.latestVersion);
      this.updateState({
        currentVersion: this.options.currentVersion,
        latestVersion,
        message: `ClaudeDock ${latestVersion ?? '新版本'} 已下载，正在按签名发布清单执行终检…`,
        percent: 100,
        phase: 'downloading',
        sourceId: this.state.sourceId,
        sourceLabel: this.state.sourceLabel,
        sourceThroughputBps: this.state.sourceThroughputBps,
      });
    });
    driver.on('error', (payload) => {
      this.updateState({
        currentVersion: this.options.currentVersion,
        latestVersion: this.state.latestVersion,
        message: `应用更新失败：${errorMessage(payload)}`,
        phase: 'error',
        sourceId: this.state.sourceId,
        sourceLabel: this.state.sourceLabel,
        sourceThroughputBps: this.state.sourceThroughputBps,
      });
    });
  }

  private updateState(state: ApplicationUpdaterState): void {
    this.state = state;
    this.options.onChange(this.getState());
  }
}
