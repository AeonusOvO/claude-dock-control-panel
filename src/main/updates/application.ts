import type { ApplicationUpdaterState } from '../../shared/contracts';
import type { ApplicationUpdateRecoveryRecord, ApplicationUpdateRecoveryStore } from './recovery';

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
}

interface ApplicationUpdaterOptions {
  currentVersion: string;
  driver: ApplicationUpdaterDriver;
  enabled: boolean;
  onChange: (state: ApplicationUpdaterState) => void;
  onInstallError?: () => void;
  recoveryStore?: ApplicationUpdateRecoveryStore;
}

const errorMessage = (value: unknown): string =>
  value instanceof Error ? value.message : '更新服务暂时不可用。';

const numericValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

interface ComparableVersion {
  core: [number, number, number];
  prerelease: string[];
}

const parseComparableVersion = (value: string): ComparableVersion | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  };
};

const compareComparableVersions = (left: string, right: string): number | undefined => {
  const leftVersion = parseComparableVersion(left);
  const rightVersion = parseComparableVersion(right);
  if (!leftVersion || !rightVersion) return undefined;
  const [leftMajor, leftMinor, leftPatch] = leftVersion.core;
  const [rightMajor, rightMinor, rightPatch] = rightVersion.core;
  const majorDifference = leftMajor - rightMajor;
  if (majorDifference !== 0) return majorDifference;
  const minorDifference = leftMinor - rightMinor;
  if (minorDifference !== 0) return minorDifference;
  const patchDifference = leftPatch - rightPatch;
  if (patchDifference !== 0) return patchDifference;
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    return leftVersion.prerelease.length === rightVersion.prerelease.length
      ? 0
      : leftVersion.prerelease.length === 0
        ? 1
        : -1;
  }
  for (
    let index = 0;
    index < Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
    index += 1
  ) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftIdentifier) - Number(rightIdentifier);
      if (difference !== 0) return difference;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftIdentifier !== rightIdentifier) {
      return leftIdentifier < rightIdentifier ? -1 : 1;
    }
  }
  return 0;
};

export class ApplicationUpdaterService {
  private checkOperation: Promise<UpdateCheckResultView | undefined> | undefined;
  private downloadOperation: Promise<ApplicationUpdaterState> | undefined;
  private installOperation: Promise<void> | undefined;
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
          message: '可以在 ClaudeDock 内检查、下载并安装当前发布通道的更新。',
          phase: 'idle',
        }
      : {
          currentVersion: options.currentVersion,
          message: '自动更新仅在 Windows 安装版中启用。',
          phase: 'disabled',
        };
    if (options.enabled) {
      this.reconcileInterruptedInstall();
      this.installEventHandlers();
    }
  }

  public getState(): ApplicationUpdaterState {
    return { ...this.state };
  }

  public async check(): Promise<ApplicationUpdaterState> {
    if (
      !this.options.enabled ||
      this.state.phase === 'downloaded' ||
      this.state.phase === 'installing' ||
      this.state.phase === 'install-recovery'
    ) {
      return this.getState();
    }
    if (this.downloadOperation) {
      return this.getState();
    }
    await this.checkForUpdate();
    return this.getState();
  }

  public checkAndDownload(): Promise<ApplicationUpdaterState> {
    if (
      !this.options.enabled ||
      this.state.phase === 'downloaded' ||
      this.state.phase === 'installing'
    ) {
      return Promise.resolve(this.getState());
    }
    if (this.state.phase === 'install-recovery' && !this.clearRecoveryForRetry()) {
      return Promise.resolve(this.getState());
    }
    if (this.downloadOperation) {
      return this.downloadOperation;
    }
    this.downloadOperation = (async () => {
      const result = await this.checkForUpdate();
      if (
        !result ||
        result.isUpdateAvailable !== true ||
        this.state.phase === 'downloaded' ||
        this.state.phase === 'installing'
      ) {
        return this.getState();
      }
      const latestVersion =
        typeof result.updateInfo?.version === 'string'
          ? result.updateInfo.version
          : this.state.latestVersion;
      this.updateState({
        currentVersion: this.options.currentVersion,
        latestVersion,
        message: latestVersion ? `正在下载 ClaudeDock ${latestVersion}…` : '正在下载更新…',
        phase: 'downloading',
      });
      try {
        await this.options.driver.downloadUpdate();
      } catch (error) {
        this.updateError(error);
      }
      return this.getState();
    })().finally(() => {
      this.downloadOperation = undefined;
    });
    return this.downloadOperation;
  }

  private checkForUpdate(): Promise<UpdateCheckResultView | undefined> {
    if (this.checkOperation) {
      return this.checkOperation;
    }
    this.checkOperation = (async () => {
      this.updateState({
        currentVersion: this.options.currentVersion,
        message: '正在检查更新…',
        phase: 'checking',
      });
      try {
        const result = await this.options.driver.checkForUpdates();
        if (!result) {
          throw new Error('更新服务未返回检查结果。');
        }
        const latestVersion =
          typeof result.updateInfo?.version === 'string' ? result.updateInfo.version : undefined;
        if (result.isUpdateAvailable !== true) {
          if (this.state.phase !== 'up-to-date') {
            this.updateState({
              currentVersion: this.options.currentVersion,
              latestVersion,
              message: 'ClaudeDock 已是当前发布通道的最新版本。',
              phase: 'up-to-date',
            });
          }
          return result;
        }
        if (this.state.phase !== 'available') {
          this.updateState({
            currentVersion: this.options.currentVersion,
            latestVersion,
            message: latestVersion ? `发现 ClaudeDock ${latestVersion}。` : '发现可用更新。',
            phase: 'available',
          });
        }
        return result;
      } catch (error) {
        this.updateError(error);
        return undefined;
      }
    })().finally(() => {
      this.checkOperation = undefined;
    });
    return this.checkOperation;
  }

  public installDownloaded(
    prepareInstall: () => Promise<void> = async () => undefined,
  ): Promise<void> {
    if (this.installOperation) {
      return this.installOperation;
    }
    if (this.state.phase !== 'downloaded') {
      return Promise.reject(new Error('更新安装包尚未下载完成。'));
    }
    const targetVersion = this.state.latestVersion ?? '未知版本';
    try {
      this.options.recoveryStore?.write({
        currentVersion: this.options.currentVersion,
        createdAt: Date.now(),
        phase: 'installing',
        source: 'electron-updater',
        targetVersion,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('无法保存应用安装恢复记录。');
      this.updateError(new Error(`无法保存应用安装恢复记录：${failure.message}`));
      return Promise.reject(failure);
    }
    this.updateState({
      currentVersion: this.options.currentVersion,
      latestVersion: this.state.latestVersion,
      message: `ClaudeDock ${this.state.latestVersion ?? '新版本'} 已下载并通过 SHA-512 校验，正在退出并启动安装…`,
      percent: 100,
      phase: 'installing',
    });
    const operation = (async () => {
      try {
        await prepareInstall();
        this.options.driver.quitAndInstall(true, true);
      } catch (error) {
        this.clearRecoveryAfterInstallFailure();
        this.updateInstallError(error);
        throw error;
      }
    })();
    this.installOperation = operation;
    void operation.catch(() => {
      if (this.installOperation === operation) {
        this.installOperation = undefined;
      }
    });
    return operation;
  }

  private reconcileInterruptedInstall(): void {
    const recoveryStore = this.options.recoveryStore;
    if (!recoveryStore) return;
    let record: ApplicationUpdateRecoveryRecord | undefined;
    try {
      record = recoveryStore.read();
    } catch (error) {
      this.state = {
        currentVersion: this.options.currentVersion,
        message: `无法读取上次应用安装记录：${errorMessage(error)}。请重新下载并安装。`,
        phase: 'install-recovery',
      };
      return;
    }
    if (!record) return;
    const versionOrder = compareComparableVersions(
      this.options.currentVersion,
      record.targetVersion,
    );
    if (
      (versionOrder !== undefined && versionOrder >= 0) ||
      (versionOrder === undefined && record.targetVersion === this.options.currentVersion)
    ) {
      try {
        recoveryStore.clear();
      } catch {
        // The new version is already running; a stale marker cannot authorize an installer cache.
      }
      return;
    }
    this.state = {
      currentVersion: this.options.currentVersion,
      latestVersion: record.targetVersion,
      message: `上次 ClaudeDock ${record.targetVersion} 的安装未完成。当前仍是 ${this.options.currentVersion}，请重新下载并安装。`,
      phase: 'install-recovery',
    };
  }

  private clearRecoveryForRetry(): boolean {
    try {
      this.options.recoveryStore?.clear();
      return true;
    } catch (error) {
      this.updateError(new Error(`无法清理上次应用安装记录：${errorMessage(error)}`));
      return false;
    }
  }

  private clearRecoveryAfterInstallFailure(): void {
    try {
      this.options.recoveryStore?.clear();
    } catch {
      // A stale marker is safer than trusting an installer cache; the next launch will offer recovery.
    }
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
        totalBytes: numericValue(progress?.total),
      });
    });
    driver.on('update-downloaded', (payload) => {
      const info = payload as UpdateInfoView | undefined;
      const latestVersion =
        typeof info?.version === 'string' ? info.version : this.state.latestVersion;
      this.updateState({
        currentVersion: this.options.currentVersion,
        latestVersion,
        message: `ClaudeDock ${latestVersion ?? '新版本'} 已下载并通过 SHA-512 校验，正在准备安装…`,
        percent: 100,
        phase: 'downloaded',
      });
    });
    driver.on('error', (payload) => {
      if (this.state.phase === 'installing') {
        this.updateInstallError(payload);
        return;
      }
      this.installOperation = undefined;
      this.updateError(payload);
    });
  }

  private updateInstallError(error: unknown): void {
    this.clearRecoveryAfterInstallFailure();
    this.installOperation = undefined;
    try {
      this.options.onInstallError?.();
    } catch {
      // Error reporting must still leave the updater state retryable even if host recovery fails.
    }
    this.updateError(error);
  }

  private updateError(error: unknown): void {
    this.updateState({
      currentVersion: this.options.currentVersion,
      latestVersion: this.state.latestVersion,
      message: `应用更新失败：${errorMessage(error)}`,
      phase: 'error',
    });
  }

  private updateState(state: ApplicationUpdaterState): void {
    this.state = state;
    this.options.onChange(this.getState());
  }
}
