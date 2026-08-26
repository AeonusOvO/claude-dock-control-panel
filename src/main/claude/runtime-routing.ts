import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ClaudeConnectionAdvice,
  ClaudeGatewayDiagnostics,
  ClaudeInstallationStatus,
  ClaudeRouterInstallSource,
  ClaudeRouterManagementState,
  RouterOperationProgress,
  SaveClaudeRouterProviderInput,
  SoftwareUpdateState,
} from '../../shared/contracts';
import {
  BackgroundTaskCoordinator,
  type BackgroundTaskPriority,
} from '../coordination/background-task';
import {
  RouteLifecycleCoordinator,
  type ClaudeRouteKind,
  type RouteReservationToken,
} from '../coordination/route-lifecycle';
import { AsyncRefreshCache } from '../infra/async-refresh-cache';
import {
  discoverOpenAiModelsAtTarget,
  type ProviderModelDiscoveryTarget,
} from '../network/provider-model-discovery';
import {
  checkSoftwareUpdates,
  installOrUpdateClaudeCode,
  type SoftwareUpdateProgress,
} from '../updates/software';
import { ClaudeConfigStore } from './config-store';
import { evaluateClaudeInstallation, type NormalizedClaudeConfig } from './configuration';
import { ClaudeGatewayDetector } from './gateway-diagnostics';
import {
  computeClaudeConnectionAdvice,
  connectionProtocolForRouterProvider,
  projectKey,
  routerRepairInputForProject,
  usesDefaultClaudeRouter,
} from './runtime-connection';
import { ClaudeRouterManager, type SavedRouterProvider } from './router-manager';
import { safeMessage } from './router-package-manager';
import type { PreparedClaudeConfigSave } from './runtime-types';

const execFileAsync = promisify(execFile);
const INSTALLATION_CACHE_MS = 30_000;
const ROUTER_HEALTH_CACHE_MS = 3_000;
const SOFTWARE_UPDATE_CACHE_MS = 5 * 60_000;

const noInstallation = (message: string): ClaudeInstallationStatus => ({
  installationKind: 'unknown',
  installed: false,
  message,
  security: 'not-installed',
});

export interface NativeRouteReservation {
  phase: 'active' | 'preparing';
  readonly token: RouteReservationToken;
}

export abstract class ClaudeRuntimeRouting {
  protected readonly backgroundTasks = new BackgroundTaskCoordinator(2);
  protected readonly installationCache = new AsyncRefreshCache<ClaudeInstallationStatus>(
    INSTALLATION_CACHE_MS,
  );
  protected readonly routerHealthCache = new AsyncRefreshCache<ClaudeRouterManagementState>(
    ROUTER_HEALTH_CACHE_MS,
  );
  protected readonly softwareUpdatesCache = new AsyncRefreshCache<SoftwareUpdateState>(
    SOFTWARE_UPDATE_CACHE_MS,
  );
  protected readonly configStore: ClaudeConfigStore;
  protected readonly fetchImplementation: typeof fetch;
  protected readonly nativeRouteReservations = new Map<string, NativeRouteReservation>();
  protected readonly routeLifecycle = new RouteLifecycleCoordinator();
  protected readonly routerManager: ClaudeRouterManager;
  private readonly gatewayDetector = new ClaudeGatewayDetector();
  private launchAdmissionGuard: () => void = () => undefined;

  protected constructor(
    userDataPath: string,
    private readonly ensureManagedChatGptGatewayReady: (cwd: string) => Promise<boolean | void>,
    fetchImplementation: typeof fetch,
    onRouterOperationProgress: (progress: RouterOperationProgress) => void,
    private readonly stopManagedChatGptGateway: () => Promise<void> | void,
    routerCommandEnvironment: () => Record<string, null | string | undefined>,
  ) {
    this.configStore = new ClaudeConfigStore(userDataPath);
    this.fetchImplementation = fetchImplementation;
    this.routerManager = new ClaudeRouterManager(
      userDataPath,
      onRouterOperationProgress,
      routerCommandEnvironment,
    );
  }

  /** Main lifecycle fence used immediately before every launch-owned route process admission. */
  public setLaunchAdmissionGuard(guard: () => void): void {
    this.launchAdmissionGuard = guard;
  }

  protected assertLaunchAdmissionAllowed(): void {
    this.launchAdmissionGuard();
  }

  protected abstract hasActiveRoute(
    routeKind: ClaudeRouteKind,
    excludedSessionId?: string,
  ): boolean;
  public getGatewayDiagnostics(cwd: string): Promise<ClaudeGatewayDiagnostics> {
    const config = this.configStore.getConfig(cwd);
    return this.backgroundTasks.run(
      `gateway-diagnostics:${projectKey(cwd)}:${config.baseUrl}`,
      'background',
      () => this.gatewayDetector.detect(cwd, config),
    );
  }

  public getRouterManagementState(): Promise<ClaudeRouterManagementState> {
    return this.getRouterHealthState();
  }

  /** Plain-language verdict on how this project reaches a model, and whether Router matters. */
  public async getConnectionAdvice(cwd: string): Promise<ClaudeConnectionAdvice> {
    const [installation, router] = await Promise.all([
      this.diagnoseInstallation(),
      this.getRouterHealthState(),
    ]);
    return computeClaudeConnectionAdvice(
      this.configStore.getConfig(cwd),
      Boolean(this.configStore.getCredential(cwd)),
      router,
      installation,
    );
  }

  public async installRouterPackage(
    source: ClaudeRouterInstallSource,
  ): Promise<{ message: string; state: ClaudeRouterManagementState }> {
    const result = await this.routerManager.installFromNpm(source);
    this.routerHealthCache.set(result.state);
    this.softwareUpdatesCache.clear();
    return result;
  }

  public async recoverInterruptedRouterInstall(): Promise<void> {
    const result = await this.routerManager.recoverInterruptedInstall();
    if (result) {
      this.routerHealthCache.set(result.state);
      this.softwareUpdatesCache.clear();
    }
  }

  public async stopUnusedRoutingServices(): Promise<void> {
    await Promise.all([this.stopUnusedRoute('ccr'), this.stopUnusedRoute('managed-chatgpt')]);
  }

  public async uninstallRouter(): Promise<{
    message: string;
    state: ClaudeRouterManagementState;
  }> {
    const result = await this.routerManager.uninstall();
    this.routerHealthCache.set(result.state);
    this.softwareUpdatesCache.clear();
    return result;
  }

  public async getSoftwareUpdates(force = false): Promise<SoftwareUpdateState> {
    return this.softwareUpdatesCache.get(async () => {
      const [installation, router] = await Promise.all([
        this.diagnoseInstallation(force),
        this.getRouterHealthState(force),
      ]);
      return this.backgroundTasks.run('software-updates', 'background', () =>
        checkSoftwareUpdates(installation, router, this.fetchImplementation),
      );
    }, force);
  }

  public async installOrUpdateClaudeCode(
    onProgress?: (progress: SoftwareUpdateProgress) => void,
  ): Promise<{
    message: string;
    state: SoftwareUpdateState;
  }> {
    const installation = await this.diagnoseInstallation(true);
    const message = await installOrUpdateClaudeCode(installation, {
      fetchImpl: this.fetchImplementation,
      onProgress,
    });
    this.installationCache.clear();
    this.softwareUpdatesCache.clear();
    return { message, state: await this.getSoftwareUpdates(true) };
  }

  public discoverProviderModels(
    target: Readonly<ProviderModelDiscoveryTarget>,
    credential?: string,
  ): Promise<string[]> {
    return discoverOpenAiModelsAtTarget(target, credential, this.fetchImplementation);
  }

  public async startRouter(): Promise<ClaudeRouterManagementState> {
    const state = await this.routerManager.start();
    this.routerHealthCache.set(state);
    return state;
  }

  public async stopRouter(): Promise<ClaudeRouterManagementState> {
    const state = await this.routerManager.stop();
    this.routerHealthCache.set(state);
    return state;
  }

  public routerManagementUrl(): Promise<string> {
    return this.routerManager.managementUrl();
  }

  public async deleteRouterProvider(providerId: string): Promise<ClaudeRouterManagementState> {
    const state = await this.routerManager.deleteProvider(providerId);
    this.routerHealthCache.set(state);
    return state;
  }

  public async saveRouterProvider(
    input: SaveClaudeRouterProviderInput,
    assertCurrent: () => void = () => undefined,
  ): Promise<SavedRouterProvider> {
    const saved = await this.routerManager.saveProvider(input);
    try {
      assertCurrent();
      this.routerHealthCache.set(saved.state);
      return saved;
    } catch (error) {
      return this.failAfterSavedRouterMutation(saved, error);
    }
  }

  public prepareRouterProjectConfig(saved: SavedRouterProvider): PreparedClaudeConfigSave {
    return {
      historyMetadata: {
        name: saved.provider.name,
        protocol: connectionProtocolForRouterProvider(saved.provider.protocol),
      },
      input: {
        authMode: 'authToken',
        baseUrl: saved.connection.baseUrl,
        credential: saved.connection.apiKey,
        credentialAction: 'replace',
        model: saved.connection.model,
        preset: 'gateway',
        provider: 'gateway',
      },
      rollbackRouterConfig: saved.rollbackConfigMutation,
    };
  }

  /** Compensates the external Router half of a prepared project-config transaction. */
  public async rollbackPreparedConfig(prepared: unknown): Promise<void> {
    if (typeof prepared !== 'object' || prepared === null) return;
    const candidate = prepared as Partial<PreparedClaudeConfigSave>;
    const failures: unknown[] = [];
    if (candidate.rollbackRouterConfig) {
      try {
        await candidate.rollbackRouterConfig();
        this.routerHealthCache.clear();
      } catch (error) {
        failures.push(error);
      }
    }
    if (candidate.rollbackRouteServices) {
      try {
        await candidate.rollbackRouteServices();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, '已准备的 Router 配置与路由服务均回滚失败。');
    }
  }

  /** Rolls back a prepared Router mutation when a later handoff check rejects the prepared value. */
  protected async failAfterPreparedConfig(
    prepared: PreparedClaudeConfigSave,
    error: unknown,
  ): Promise<never> {
    try {
      await this.rollbackPreparedConfig(prepared);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `${safeMessage(error)}；已准备的 Router 配置回滚失败：${safeMessage(rollbackError)}`,
        { cause: rollbackError },
      );
    }
    throw error;
  }

  protected async failAfterSavedRouterMutation(
    saved: SavedRouterProvider,
    error: unknown,
  ): Promise<never> {
    try {
      await saved.rollbackConfigMutation();
      this.routerHealthCache.clear();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `${safeMessage(error)}；Router 配置回滚失败：${safeMessage(rollbackError)}`,
        { cause: rollbackError },
      );
    }
    throw error;
  }

  public async repairRouterProviderFromProject(
    cwd: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<SavedRouterProvider> {
    // The caller owns the directory transaction before this source profile is read. Keep the exact
    // config/credential pair in memory while CCR management performs its asynchronous work.
    const launchSnapshot = this.configStore.createLaunchSnapshot(cwd);
    const input = routerRepairInputForProject(launchSnapshot.config, launchSnapshot.credential);
    const current = await this.getRouterHealthState(true);
    assertCurrent();
    if (!current.managementAvailable) {
      throw new Error('CCR 管理服务尚未就绪，无法写入服务提供方。');
    }
    if (current.providers.length > 0) {
      throw new Error('CCR 已存在服务提供方；请编辑现有配置或手动选择要使用的服务提供方。');
    }

    const saved = await this.routerManager.saveProvider(input);
    try {
      assertCurrent();
      const routerState = await this.routerManager.start();
      assertCurrent();
      this.routerHealthCache.set(routerState);
      if (routerState.gatewayState !== 'running') {
        throw new Error(routerState.message);
      }
      return { ...saved, state: routerState };
    } catch (error) {
      return this.failAfterSavedRouterMutation(saved, error);
    }
  }

  protected routeKindForConfig(config: NormalizedClaudeConfig): ClaudeRouteKind {
    if (config.preset === 'chatgpt-subscription') {
      return 'managed-chatgpt';
    }
    return usesDefaultClaudeRouter(config) ? 'ccr' : 'direct';
  }

  protected async stopUnusedRoute(
    routeKind: ClaudeRouteKind,
    excludedSessionId?: string,
  ): Promise<void> {
    if (routeKind === 'direct') {
      return;
    }
    const stopped = await this.routeLifecycle.stopWhenUnused({
      excludedSessionId,
      hasActiveUser: (candidateRoute, excludedSession) =>
        this.hasActiveRoute(candidateRoute, excludedSession),
      isServiceRunning:
        routeKind === 'ccr'
          ? async () => (await this.routerManager.getState()).serviceRunning
          : async () => true,
      routeKind,
      stop:
        routeKind === 'ccr'
          ? async () => {
              await this.routerManager.stop();
            }
          : async () => {
              await this.stopManagedChatGptGateway();
            },
    });
    if (stopped && routeKind === 'ccr') {
      this.routerHealthCache.clear();
    }
  }

  protected async prepareRouteServices(
    routeKind: ClaudeRouteKind,
    _ownerId: string,
    cwd: string,
  ): Promise<boolean> {
    this.assertLaunchAdmissionAllowed();
    if (routeKind === 'managed-chatgpt') {
      return this.routeLifecycle
        .runExclusive(() => {
          this.assertLaunchAdmissionAllowed();
          return this.ensureManagedChatGptGatewayReady(cwd);
        })
        .then((started) => started === true);
    }
    if (routeKind === 'ccr') {
      return this.routeLifecycle.runExclusive(async () => {
        this.assertLaunchAdmissionAllowed();
        let state = await this.routerManager.getState();
        let started = false;
        this.assertLaunchAdmissionAllowed();
        if (!state.installed) {
          state = (await this.routerManager.installFromNpm('npm')).state;
          started = true;
          this.assertLaunchAdmissionAllowed();
        }
        if (!state.managementAvailable || state.gatewayState !== 'running') {
          this.assertLaunchAdmissionAllowed();
          state = await this.routerManager.start();
          started = true;
        }
        this.routerHealthCache.set(state);
        return started;
      });
    }
    return false;
  }

  protected getRouterHealthState(
    force = false,
    priority: BackgroundTaskPriority = 'background',
  ): Promise<ClaudeRouterManagementState> {
    return this.routerHealthCache.get(
      () =>
        this.backgroundTasks.run('router-health', priority, () => this.routerManager.getState()),
      force,
    );
  }

  protected diagnoseInstallation(force = false): Promise<ClaudeInstallationStatus> {
    return this.installationCache.get(
      () =>
        this.backgroundTasks.run('claude-installation', 'background', async () => {
          try {
            const result = await execFileAsync(
              'powershell.exe',
              [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                '$command = Get-Command claude -ErrorAction Stop; Write-Output $command.Source; & claude --version',
              ],
              {
                encoding: 'utf8',
                timeout: 10_000,
                windowsHide: true,
              },
            );
            const lines = result.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            const executable = lines.shift();
            return evaluateClaudeInstallation(lines.join(' '), executable);
          } catch (error) {
            const message =
              error instanceof Error && error.message.includes('timed out')
                ? '检查 Claude Code 版本超时。'
                : '未找到 claude 命令，请先安装 Claude Code 2.1.197 或更高版本。';
            return noInstallation(message);
          }
        }),
      force,
    );
  }
}
