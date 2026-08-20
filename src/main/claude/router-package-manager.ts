import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  ClaudeRouterInstallSource,
  ClaudeRouterManagementState,
  RouterOperationKind,
  RouterOperationProgress,
} from '../../shared/contracts';
import { runWindowsCommand } from '../infra/windows-command';
import { isRecord } from './router-provider-config';

export interface CcrCliInstallation {
  cliPath: string;
  installDirectory: string;
  nodeExecutable?: string;
  packageRoot: string;
  version: string;
}

export interface CcrServiceAccess {
  managementUrl: string;
  origin: string;
  pid: number;
  serviceToken: string;
  webToken: string;
}

export interface RouterPackageOperation {
  message: string;
  state: ClaudeRouterManagementState;
}

interface RouterOperationJournal {
  operation: 'install';
  phase: RouterOperationProgress['stage'];
  schemaVersion: 1;
  source: ClaudeRouterInstallSource;
  startedAt: number;
  updatedAt: number;
}

export const appDataRoot = (): string =>
  process.env.APPDATA ?? process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Roaming');

/** CCR shared files that CLI uninstall may remove only when no desktop installation exists. */
export const ROUTER_DATA_ENTRIES = [
  'config.sqlite',
  'api-keys.sqlite',
  'usage.sqlite',
  'gateway.config.json',
  'service.json',
  'gateway-proxy-preload.cjs',
  'claude-app-gateway-backup.json',
  'global-profile-takeover.json',
  'bin',
  'provider-icons',
  'raw-trace-spool',
] as const;

/**
 * A recursive delete only ever runs against the CCR data directory itself. Anything that does not
 * resolve to `<AppData>\claude-code-router` is refused so a tampered `APPDATA` cannot widen the
 * blast radius, and so Claude Code's and Codex's own configuration can never be reached.
 */
export const routerDataDirectory = (appData: string): string | undefined => {
  if (!appData || !path.isAbsolute(appData)) {
    return undefined;
  }
  const resolved = path.resolve(appData, 'claude-code-router');
  const parent = path.dirname(resolved);
  if (
    path.basename(resolved).toLowerCase() !== 'claude-code-router' ||
    parent === resolved ||
    path.resolve(parent) !== path.resolve(appData)
  ) {
    return undefined;
  }
  return resolved;
};

export const safeMessage = (error: unknown, secrets: string[] = []): string => {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) {
      message = message.replaceAll(secret, '[已隐藏]');
    }
  }
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer [已隐藏]')
    .replace(/ccr_web_token=[A-Za-z0-9_-]+/gi, 'ccr_web_token=[已隐藏]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
};

export abstract class ClaudeRouterPackageManager {
  private installInFlight?: Promise<RouterPackageOperation>;
  private readonly operationJournalPath: string;
  protected serviceRuntimeCache?: {
    kind: 'claudedock' | 'cli' | 'desktop' | 'unknown';
    pid: number;
    serviceToken: string;
  };

  protected constructor(
    userDataPath: string,
    private readonly onOperationProgress: (progress: RouterOperationProgress) => void,
    private readonly commandEnvironment: () => Record<string, null | string | undefined>,
    private readonly runCommand: typeof runWindowsCommand,
  ) {
    this.operationJournalPath = path.join(userDataPath, 'claude', 'router-operation.json');
  }

  public abstract getState(): Promise<ClaudeRouterManagementState>;

  protected abstract findCliInstallation(): Promise<CcrCliInstallation | undefined>;

  protected abstract findDesktopExecutable(): string | undefined;

  protected abstract getActiveServiceAccess(): Promise<CcrServiceAccess | undefined>;

  protected abstract stopCliService(
    access: CcrServiceAccess,
    desktopExecutable?: string,
  ): Promise<void>;

  protected emitProgress(
    operation: RouterOperationKind,
    stage: RouterOperationProgress['stage'],
    step: number,
    totalSteps: number,
    detail: string,
    active = true,
  ): void {
    this.onOperationProgress({
      active,
      detail,
      operation,
      stage,
      step,
      totalSteps,
      updatedAt: Date.now(),
    });
  }

  private readOperationJournal(): RouterOperationJournal | undefined {
    if (!existsSync(this.operationJournalPath)) {
      return undefined;
    }
    try {
      const value = JSON.parse(readFileSync(this.operationJournalPath, 'utf8')) as unknown;
      if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        value.operation !== 'install' ||
        (value.source !== 'npm' && value.source !== 'npmmirror') ||
        typeof value.startedAt !== 'number' ||
        typeof value.updatedAt !== 'number' ||
        typeof value.phase !== 'string'
      ) {
        return undefined;
      }
      return value as unknown as RouterOperationJournal;
    } catch {
      return undefined;
    }
  }

  private writeOperationJournal(journal: RouterOperationJournal): void {
    mkdirSync(path.dirname(this.operationJournalPath), { recursive: true });
    const temporaryPath = `${this.operationJournalPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(journal, undefined, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.operationJournalPath);
  }

  private updateOperationJournal(phase: RouterOperationProgress['stage']): void {
    const current = this.readOperationJournal();
    if (!current) {
      return;
    }
    this.writeOperationJournal({ ...current, phase, updatedAt: Date.now() });
  }

  private updateOperationJournalSource(source: ClaudeRouterInstallSource): void {
    const current = this.readOperationJournal();
    if (current) {
      this.writeOperationJournal({ ...current, source, updatedAt: Date.now() });
    }
  }

  private clearOperationJournal(): void {
    for (const journalPath of [this.operationJournalPath, `${this.operationJournalPath}.tmp`]) {
      try {
        unlinkSync(journalPath);
      } catch {
        // It is safe for an already-cleared journal to be absent.
      }
    }
  }

  public async installFromNpm(source: ClaudeRouterInstallSource): Promise<RouterPackageOperation> {
    return this.runInstallOnce(source, 'install');
  }

  /** Replays an interrupted npm install. npm's global install is idempotent, so no data is reset. */
  public async recoverInterruptedInstall(): Promise<RouterPackageOperation | undefined> {
    const journal = this.readOperationJournal();
    if (!journal) {
      // A torn or obsolete journal is not trustworthy. Clear it and let the next install start cleanly.
      if (existsSync(this.operationJournalPath) || existsSync(`${this.operationJournalPath}.tmp`)) {
        this.clearOperationJournal();
      }
      return undefined;
    }
    this.emitProgress(
      'recover',
      'recovering',
      1,
      5,
      '检测到上次安装意外中断，正在自动校验并续装。',
    );
    return this.runInstallOnce(journal.source, 'recover');
  }

  private runInstallOnce(
    source: ClaudeRouterInstallSource,
    operation: 'install' | 'recover',
  ): Promise<RouterPackageOperation> {
    if (this.installInFlight) {
      return this.installInFlight;
    }
    this.installInFlight = this.installFromNpmInternal(source, operation).finally(() => {
      this.installInFlight = undefined;
    });
    return this.installInFlight;
  }

  private async installFromNpmInternal(
    source: ClaudeRouterInstallSource,
    operation: 'install' | 'recover',
  ): Promise<RouterPackageOperation> {
    let effectiveSource = source;
    const registry =
      source === 'npmmirror' ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org';
    const commandEnvironment = this.commandEnvironment();
    const proxyNote =
      typeof commandEnvironment.HTTPS_PROXY === 'string' ||
      typeof commandEnvironment.https_proxy === 'string'
        ? '已使用 ClaudeDock 为 CLI 配置的应用代理。'
        : '将使用 npm 当前可用的网络环境。';
    const startedAt = this.readOperationJournal()?.startedAt ?? Date.now();
    try {
      this.writeOperationJournal({
        operation: 'install',
        phase: operation === 'recover' ? 'recovering' : 'checking',
        schemaVersion: 1,
        source,
        startedAt,
        updatedAt: Date.now(),
      });
      this.emitProgress(operation, 'checking', 1, 5, '正在检查 Node.js、npm 与现有 CCR CLI。');

      this.updateOperationJournal('downloading');
      this.emitProgress(
        operation,
        'downloading',
        2,
        5,
        source === 'npmmirror'
          ? `正在从 npmmirror 获取 CCR CLI；${proxyNote}`
          : `正在从 npm 官方源获取 CCR CLI；${proxyNote}`,
      );
      const installFromRegistry = (registryUrl: string): Promise<string> =>
        this.runCommand(
          'npm',
          [
            'install',
            '--global',
            '@musistudio/claude-code-router@latest',
            '--registry',
            registryUrl,
          ],
          {
            env: commandEnvironment,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 10 * 60_000,
          },
        );
      try {
        await installFromRegistry(registry);
      } catch (error) {
        if (source !== 'npm' || /未找到 npm 命令/.test(safeMessage(error))) {
          throw error;
        }
        effectiveSource = 'npmmirror';
        this.updateOperationJournalSource(effectiveSource);
        this.emitProgress(
          operation,
          'downloading',
          2,
          5,
          `npm 官方源未完成，正在自动改用 npmmirror 续传；${proxyNote}`,
        );
        await installFromRegistry('https://registry.npmmirror.com');
      }

      this.updateOperationJournal('installing');
      this.emitProgress(
        operation,
        'installing',
        3,
        5,
        'npm 已完成写入，正在定位 CLI 与配套 Node.js。',
      );
      const cli = await this.findCliInstallation();
      if (!cli) {
        throw new Error('npm 命令已结束，但没有找到 CCR CLI；可重新点击安装进行修复。');
      }

      this.updateOperationJournal('verifying');
      this.emitProgress(operation, 'verifying', 4, 5, '正在验证 CLI 版本和后台运行环境。');
      const state = await this.getState();
      if (!state.installed) {
        throw new Error('CCR CLI 安装校验未通过；已保留恢复记录供下次自动重试。');
      }
      this.clearOperationJournal();
      this.emitProgress(
        operation,
        'complete',
        5,
        5,
        operation === 'recover' ? '中断的安装已自动恢复并验证完成。' : 'CCR CLI 已安装并验证完成。',
        false,
      );
      return {
        message:
          operation === 'recover'
            ? '上次中断的 CCR CLI 安装已自动恢复。'
            : effectiveSource === 'npmmirror'
              ? '已通过 npmmirror 安装或更新 Claude Code Router CLI。'
              : '已通过 npm 官方源安装或更新 Claude Code Router CLI。',
        state,
      };
    } catch (error) {
      this.emitProgress(
        operation,
        'error',
        5,
        5,
        `安装未完成：${safeMessage(error)}。恢复记录已保留，可再次点击安装或重启后自动续装。`,
        false,
      );
      throw error;
    }
  }

  /** Removes only the CLI package. A detected desktop installation and its shared data are kept. */
  public async uninstall(): Promise<RouterPackageOperation> {
    const cli = await this.findCliInstallation();
    const desktop = this.findDesktopExecutable();
    const dataDirectory = routerDataDirectory(appDataRoot());
    const hadData = Boolean(dataDirectory && existsSync(dataDirectory));
    if (!cli) {
      return {
        message: desktop
          ? '仅检测到 CCR 桌面版；ClaudeDock 不会卸载或修改它。'
          : '当前没有检测到可卸载的 CCR CLI。',
        state: await this.getState(),
      };
    }

    const access = await this.getActiveServiceAccess();
    if (access) {
      await this.stopCliService(access, desktop);
    }

    const notes: string[] = [await this.removeCliInstallation(cli)];

    if (desktop) {
      notes.push('已保留桌面版 CCR 及其共享配置，未改写 Claude/Codex App');
    } else if (dataDirectory) {
      try {
        rmSync(dataDirectory, { force: true, maxRetries: 3, recursive: true, retryDelay: 200 });
        if (hadData) {
          notes.push('已删除全部服务提供方配置、上游密钥与用量数据');
        }
      } catch {
        notes.push(`无法删除配置目录 ${dataDirectory}，请关闭正在使用它的程序后重试`);
      }
    }

    this.serviceRuntimeCache = undefined;

    return {
      message: notes.length > 0 ? `${notes.join('；')}。` : '没有需要移除的路由器组件。',
      state: await this.getState(),
    };
  }

  /**
   * `npm uninstall --global` only reaches the package when it lives under the active npm prefix.
   * A CCR installed against another prefix (for example `D:\ClaudeCode`) survives it, so the
   * package directory is verified afterwards and removed directly when it is still present.
   */
  private async removeCliInstallation(cli: CcrCliInstallation): Promise<string> {
    try {
      await runWindowsCommand('npm', ['uninstall', '--global', '@musistudio/claude-code-router'], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10 * 60_000,
      });
    } catch {
      // Fall through to the prefix-scoped attempt and the direct removal below.
    }

    if (existsSync(cli.packageRoot)) {
      try {
        await runWindowsCommand(
          'npm',
          [
            'uninstall',
            '--global',
            '--prefix',
            cli.installDirectory,
            '@musistudio/claude-code-router',
          ],
          { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 },
        );
      } catch {
        // The directory removal below is the last resort.
      }
    }

    if (existsSync(cli.packageRoot)) {
      rmSync(cli.packageRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 200 });
    }
    for (const shim of ['ccr', 'ccr.cmd', 'ccr.ps1']) {
      const shimPath = path.join(cli.installDirectory, shim);
      if (existsSync(shimPath)) {
        try {
          unlinkSync(shimPath);
        } catch {
          // A locked shim stops working once its package is gone; report success anyway.
        }
      }
    }

    return existsSync(cli.packageRoot)
      ? `无法完全删除 ${cli.packageRoot}，请手动移除该目录`
      : '已移除命令行版路由器';
  }
}
