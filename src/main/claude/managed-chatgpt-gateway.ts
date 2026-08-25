/* eslint-disable max-lines -- This class composes already-separated gateway installation, authentication, process, state, and model transactions behind one serialized lifecycle. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ManagedChatGptGatewayState } from '../../shared/contracts';
import type { BusyRegistry } from '../coordination/busy-registry';
import type { DownloadEngine } from '../download/engine';
import { runProcess } from '../infra/windows-command';
import { ManagedGatewayAuthenticationTransaction } from './managed-chatgpt-auth-transaction';
import {
  inspectManagedGatewayAuthentication,
  inspectManagedGatewayCodexArtifact,
  managedGatewayPublicState,
  managedGatewayAuthenticationCandidateKey,
  managedGatewayAuthenticationDirectoryIsOwned,
  parseManagedGatewayLoginArtifactPath,
  snapshotManagedGatewayAuthenticationCandidates,
  type ManagedGatewayAuthenticationInspection,
} from './managed-chatgpt-auth';
import {
  ManagedGatewayConfigFiles,
  type GatewayConfigTransaction,
} from './managed-chatgpt-config-files';
import {
  buildManagedGatewayConfig,
  buildManagedGatewayEnvironment,
  DEFAULT_PORT,
  type ManagedGatewayEnvironmentOverrides,
  findAvailablePort,
  LAST_PORT,
  OAUTH_DEFAULT_PORT,
  OAUTH_LAST_PORT,
  portIsAvailable,
} from './managed-chatgpt-config';
import { resolveManagedGatewayEnvironmentSnapshot } from './managed-chatgpt-environment-identity';
import {
  MANAGED_GATEWAY_READINESS_PROBE_TIMEOUT_MS,
  ManagedGatewayModelReconciliation,
  type ManagedChatGptGatewayProjectConfig,
} from './managed-chatgpt-model-reconciliation';
import { ManagedGatewayOwnedModelReader } from './managed-chatgpt-owned-models';
import { ManagedGatewayPersistedProcess } from './managed-chatgpt-persisted-process';
import { ManagedGatewayProcessIdentity } from './managed-chatgpt-process-identity';
import { ManagedGatewayProcessLifecycle } from './managed-chatgpt-process-lifecycle';
import {
  type ManagedChatGptSetupReporter,
  type ManagedChatGptGatewayManagementAccess,
  type ManagedGatewayConfigurationIdentity,
  ManagedGatewayEnvironmentChangedError,
  type ManagedGatewayEnvironmentIdentity,
  type ManagedGatewayEnvironmentSnapshot,
  managedGatewayDelay,
  type PreparedGatewayConfiguration,
} from './managed-chatgpt-gateway-types';
import {
  extractManagedGatewayRelease,
  fetchLatestManagedGatewayRelease,
  installLatestManagedGateway,
} from './managed-chatgpt-installation';
import {
  ManagedGatewayStartupLog,
  managedGatewayErrorMessage,
} from './managed-chatgpt-startup-log';
import { protectManagedGatewayAuthentication } from './managed-chatgpt-security';
import {
  ManagedGatewayStateStore,
  type ManagedGatewaySafeStorage,
  type PersistedGatewayState,
} from './managed-chatgpt-state';
import type { CliProxyApiRelease } from './managed-chatgpt-release';

const START_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const AUTH_ARTIFACT_RETRY_MS = 120;

const managedGatewayReadinessFailure = (
  probeFailure: unknown,
  startupDetail: string,
  sensitivePaths: readonly string[],
): Error => {
  const probeDetail =
    probeFailure === undefined ? '' : managedGatewayErrorMessage(probeFailure, sensitivePaths);
  const details = [
    ...(probeDetail ? [`模型检查：${probeDetail}`] : []),
    ...(startupDetail ? [`启动输出：${startupDetail}`] : []),
  ];
  return new Error(
    `CLIProxyAPI 已启动，但未能在 20 秒内完成本机模型接口的安全就绪检查。${
      details.length > 0 ? details.join('；') : ''
    }`,
  );
};

const managedGatewayReadinessCleanupFailure = (
  readinessFailure: Error,
  cleanupFailure: unknown,
  sensitivePaths: readonly string[],
): Error => {
  const cleanupDetail =
    managedGatewayErrorMessage(cleanupFailure, sensitivePaths) || '本机网关清理失败。';
  return new Error(
    `${readinessFailure.message}；启动失败后的本机网关清理也未完成：${cleanupDetail}`,
    { cause: new Error(cleanupDetail) },
  );
};

interface ManagedGatewayReadinessFailures {
  hasFullBudget: boolean;
  last?: unknown;
  lastFullBudget?: unknown;
}

const rememberManagedGatewayReadinessFailure = (
  failures: ManagedGatewayReadinessFailures,
  failure: unknown,
  timeoutMs: number,
): void => {
  if (failure === undefined) return;
  failures.last = failure;
  if (timeoutMs === MANAGED_GATEWAY_READINESS_PROBE_TIMEOUT_MS) {
    failures.hasFullBudget = true;
    failures.lastFullBudget = failure;
  }
};

export type { ManagedChatGptGatewayProjectConfig } from './managed-chatgpt-model-reconciliation';

export type { ManagedChatGptSetupReporter } from './managed-chatgpt-gateway-types';

export type { ManagedChatGptGatewayManagementAccess } from './managed-chatgpt-gateway-types';

export { ManagedGatewayStartupLog };

export class ManagedChatGptGateway {
  private readonly authDirectory: string;
  private readonly configFiles: ManagedGatewayConfigFiles;
  private readonly configPath: string;
  private readonly downloadsDirectory: string;
  private readonly rootDirectory: string;
  private readonly runtimeDirectory: string;
  private readonly statePath: string;
  private readonly stateStore: ManagedGatewayStateStore;
  private readonly versionsDirectory: string;
  private ensureRunningInFlight?: Promise<void>;
  private environmentIdentity?: ManagedGatewayEnvironmentIdentity;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly lifecycleControllers = new Set<AbortController>();
  private configurationIdentity?: ManagedGatewayConfigurationIdentity;
  private readonly modelReconciliation: ManagedGatewayModelReconciliation;
  private readonly ownedModelReader: ManagedGatewayOwnedModelReader;
  private readonly persistedProcess: ManagedGatewayPersistedProcess;
  private readonly processIdentity: ManagedGatewayProcessIdentity;
  private readonly processLifecycle: ManagedGatewayProcessLifecycle;
  private shutdownCleanup?: Promise<void>;
  private shutdownRequested = false;
  private setupCancellable = false;
  private setupInFlight?: Promise<ManagedChatGptGatewayProjectConfig>;

  public constructor(
    userDataPath: string,
    private readonly downloadEngine: DownloadEngine,
    private readonly busyRegistry: BusyRegistry,
    private readonly safeStorage: ManagedGatewaySafeStorage,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly environmentOverrides: () => ManagedGatewayEnvironmentOverrides = () => ({}),
    private readonly runProcessImplementation: typeof runProcess = runProcess,
    private readonly spawnImplementation: typeof spawn = spawn,
  ) {
    this.rootDirectory = path.join(userDataPath, 'managed-gateways', 'cliproxyapi');
    this.authDirectory = path.join(this.rootDirectory, 'auth');
    this.configPath = path.join(this.rootDirectory, 'config.yaml');
    this.downloadsDirectory = path.join(this.rootDirectory, 'downloads');
    this.runtimeDirectory = path.join(this.rootDirectory, 'runtime');
    this.statePath = path.join(this.rootDirectory, 'state.json');
    this.versionsDirectory = path.join(this.rootDirectory, 'versions');
    this.configFiles = new ManagedGatewayConfigFiles(this.rootDirectory, this.configPath);
    this.stateStore = new ManagedGatewayStateStore(
      this.rootDirectory,
      this.statePath,
      this.versionsDirectory,
      this.safeStorage,
    );
    this.processIdentity = new ManagedGatewayProcessIdentity();
    this.ownedModelReader = new ManagedGatewayOwnedModelReader({
      processIdentity: this.processIdentity,
    });
    this.processLifecycle = new ManagedGatewayProcessLifecycle({
      invalidateModels: () => this.modelReconciliation?.clear(),
      onExactProcessExit: () => {},
      portAvailable: (port, timeoutMs) => this.portAvailable(port, timeoutMs),
    });
    this.persistedProcess = new ManagedGatewayPersistedProcess({
      configPath: this.configPath,
      executablePath: (state) => this.executablePath(state),
      loadState: () => this.loadState(),
      persistState: (state) => this.persistState(state),
      portAvailable: (port, timeoutMs) => this.portAvailable(port, timeoutMs),
      processIdentity: this.processIdentity,
      processLifecycle: this.processLifecycle,
    });
    this.modelReconciliation = new ManagedGatewayModelReconciliation({
      currentChild: () => this.processLifecycle.activeProcess(),
      decryptClientKey: (state) => this.decryptClientKey(state),
      loadState: () => this.loadState(),
      ownedProcessId: (state) => this.ownedProcessId(state),
      readOwnedModels: (state, processId, credential, timeoutMs) =>
        this.readOwnedModels(state, processId, credential, timeoutMs),
    });
  }

  public async getState(): Promise<ManagedChatGptGatewayState> {
    const busy = Boolean(this.setupInFlight);
    const persisted = this.loadState();
    const installed = Boolean(persisted && this.executableIsValid(persisted));
    const authentication = managedGatewayPublicState(await this.inspectAuthentication());
    const managementKey = persisted ? this.decryptManagementKey(persisted) : undefined;
    const stoppingOwnedProcess =
      !busy && Boolean(persisted) && installed && this.processLifecycle.ownsStoppingProcess();
    const ownedProcessId =
      !busy && !stoppingOwnedProcess && persisted && installed
        ? await this.ownedProcessId(persisted)
        : undefined;
    let reconciliation: { availableModels: string[]; processOwned: boolean } = {
      availableModels: [],
      processOwned: stoppingOwnedProcess,
    };
    if (persisted && ownedProcessId) {
      reconciliation = await this.modelReconciliation.modelsForOwnedProcess(
        persisted,
        ownedProcessId,
      );
      if (reconciliation.availableModels.length > 0 && persisted.process?.phase === 'starting') {
        try {
          this.persistedProcess.promoteReady(persisted, persisted.authorization);
        } catch {
          reconciliation = { availableModels: [], processOwned: true };
        }
      }
    }
    const { availableModels } = reconciliation;
    const running = availableModels.length > 0;
    const degraded = reconciliation.processOwned && !running;
    const endpoint = `http://127.0.0.1:${persisted?.port ?? DEFAULT_PORT}`;
    const phase = busy
      ? 'installing'
      : !installed
        ? 'not-installed'
        : !authentication.authenticated
          ? 'login-required'
          : running
            ? 'ready'
            : 'stopped';
    const message =
      phase === 'installing'
        ? '正在下载、校验并配置托管网关；完成前无需重复点击。'
        : phase === 'not-installed'
          ? '尚未安装 ClaudeDock 托管网关。'
          : phase === 'login-required'
            ? `CLIProxyAPI ${persisted?.installedVersion ?? ''} 已安装，等待 OpenAI 授权。`
            : phase === 'ready'
              ? `CLIProxyAPI ${persisted?.installedVersion ?? ''} 已在本机安全运行。`
              : degraded
                ? `CLIProxyAPI ${persisted?.installedVersion ?? ''} 进程仍在，但模型接口未通过就绪检查；下次使用时会重新启动。`
                : `CLIProxyAPI ${persisted?.installedVersion ?? ''} 已授权，启动 Claude Code 时会自动运行。`;
    return {
      ...authentication,
      availableModels,
      busy,
      checkedAt: Date.now(),
      endpoint,
      installed,
      managementAvailable: Boolean(running && managementKey),
      message,
      phase,
      running,
      usageStatisticsEnabled: false,
      version: installed ? persisted?.installedVersion : undefined,
    };
  }

  /** Reads only ClaudeDock's validated state file; it never starts or probes the gateway. */
  public getInstalledVersion(): string | undefined {
    return this.loadState()?.installedVersion;
  }

  public setup(
    forceLogin = false,
    report?: ManagedChatGptSetupReporter,
  ): Promise<ManagedChatGptGatewayProjectConfig> {
    if (this.setupInFlight) {
      return this.setupInFlight;
    }
    const operation = this.enqueueLifecycle((signal) =>
      this.setupInternal(forceLogin, report, signal),
    );
    this.setupInFlight = operation;
    const clear = (): void => {
      if (this.setupInFlight === operation) {
        this.setupInFlight = undefined;
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  /** Cancels only the current setup lifecycle; an already-ready gateway remains untouched. */
  public async cancelSetup(): Promise<boolean> {
    const operation = this.setupInFlight;
    if (!operation || !this.setupCancellable) return false;
    this.cancelLifecycleOperations();
    try {
      await operation;
    } catch {
      // Cancellation is the expected terminal state for the setup request.
    }
    return true;
  }

  private async setupInternal(
    forceLogin: boolean,
    report: ManagedChatGptSetupReporter | undefined,
    signal: AbortSignal,
  ): Promise<ManagedChatGptGatewayProjectConfig> {
    this.assertActive(signal);
    const releaseBusy = this.busyRegistry.acquire({
      cancellable: false,
      id: 'managed-gateway:chatgpt-setup',
      kind: 'configure',
      label: '正在安装并配置 ChatGPT 托管网关',
      severity: 'blocking',
    });
    let authenticationTransaction: ManagedGatewayAuthenticationTransaction | undefined;
    let preparedState: PersistedGatewayState | undefined;
    try {
      report?.(3, '正在检查 CLIProxyAPI 的受信任上游版本。');
      const persisted = await this.installLatest(report);
      this.assertActive(signal);
      report?.(4, '正在生成仅限本机的网关配置与独立访问密钥。');
      const prepared = await this.prepareConfiguration(persisted);
      preparedState = prepared.state;
      let loginRequired = forceLogin || !(await this.inspectAuthentication());
      let successfulLoginSignature: string | undefined;
      const ready = await this.startWithStableEnvironment(
        prepared,
        async (configPath, snapshot) => {
          if (
            loginRequired ||
            (successfulLoginSignature !== undefined &&
              successfulLoginSignature !== snapshot.signature)
          ) {
            report?.(5, '正在等待你在 OpenAI 官方页面完成授权。');
            authenticationTransaction?.rollback();
            this.setupCancellable = true;
            try {
              authenticationTransaction = await this.login(
                prepared.state,
                configPath,
                snapshot.environment,
                signal,
              );
            } finally {
              this.setupCancellable = false;
            }
            this.assertEnvironmentCurrent(snapshot, signal);
            successfulLoginSignature = snapshot.signature;
            loginRequired = false;
          }
          report?.(6, '授权已确认，正在启动本机模型接口并读取可用模型。');
          return authenticationTransaction;
        },
        signal,
      );
      const configuration = await this.modelReconciliation.projectConfiguration(ready);
      authenticationTransaction?.commit();
      return configuration;
    } catch (error) {
      if (authenticationTransaction) {
        let stopped = false;
        try {
          const stoppingState = this.loadState() ?? preparedState;
          if (stoppingState) {
            await this.stopProcessesForState(
              stoppingState,
              'OpenAI 授权事务回滚前无法确认托管网关已经停止。',
            );
          } else {
            await this.processLifecycle.stopForReplacement(
              0,
              'OpenAI 授权事务回滚前无法确认托管网关已经停止。',
            );
          }
          stopped = true;
        } catch {
          // Keep the active account and its quarantine transaction intact while a process may use it.
        }
        if (stopped) authenticationTransaction.rollback();
      }
      throw error;
    } finally {
      releaseBusy();
    }
  }

  public configurationForModel(model?: string): Promise<ManagedChatGptGatewayProjectConfig> {
    return this.enqueueLifecycle(async (signal) => {
      const persisted = await this.requireInstalledAndAuthenticated(signal);
      const ready = await this.startWithStableEnvironment(
        await this.prepareConfiguration(persisted),
        undefined,
        signal,
      );
      return this.modelReconciliation.projectConfiguration(ready, model);
    });
  }

  public ensureRunning(): Promise<void> {
    if (this.ensureRunningInFlight) {
      return this.ensureRunningInFlight;
    }
    const operation = this.setupInFlight
      ? this.setupInFlight.then(() => undefined)
      : this.enqueueLifecycle(async (signal) => {
          const persisted = await this.requireInstalledAndAuthenticated(signal);
          await this.startWithStableEnvironment(
            await this.prepareConfiguration(persisted),
            undefined,
            signal,
          );
        });
    this.ensureRunningInFlight = operation;
    const clear = (): void => {
      if (this.ensureRunningInFlight === operation) {
        this.ensureRunningInFlight = undefined;
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  public async managementAccess(): Promise<ManagedChatGptGatewayManagementAccess> {
    const persisted = this.loadState();
    const managementKey = persisted ? this.decryptManagementKey(persisted) : undefined;
    if (
      !persisted ||
      !managementKey ||
      !this.executableIsValid(persisted) ||
      !(await this.ownedProcessId(persisted))
    ) {
      throw new Error('ChatGPT 托管网关当前没有运行，无法打开后台。');
    }
    return {
      url: `http://127.0.0.1:${persisted.port}/management.html`,
    };
  }

  public stop(): Promise<void> {
    this.cancelLifecycleOperations();
    this.setupInFlight = undefined;
    this.ensureRunningInFlight = undefined;
    return this.enqueueLifecycle(async () => {
      const state = this.loadState();
      if (!state) {
        await this.processLifecycle.stopForReplacement(
          0,
          'ChatGPT 本地网关子进程没有在停止时限内退出。',
        );
        this.modelReconciliation.clear();
        return;
      }
      await this.stopProcessesForState(state, 'ChatGPT 本地网关停止后端口仍被占用。');
      this.modelReconciliation.clear();
    });
  }

  /** Removes only ClaudeDock's managed OAuth artifacts and never launches or controls a browser. */
  public logout(): Promise<void> {
    return this.enqueueLifecycle(async (signal) => {
      this.assertActive(signal);
      const state = this.loadState();
      if (state) {
        await this.stopProcessesForState(
          state,
          '退出 OpenAI 账号前无法确认 ChatGPT 本地网关已经停止。',
        );
      } else {
        await this.processLifecycle.stopForReplacement(
          0,
          '退出 OpenAI 账号前无法确认 ChatGPT 本地网关已经停止。',
        );
      }
      this.assertActive(signal);
      mkdirSync(this.authDirectory, { recursive: true });
      this.assertAuthenticationDirectoryOwned();
      ManagedGatewayAuthenticationTransaction.recoverAbandoned(this.authDirectory);
      this.assertAuthenticationDirectoryOwned();
      const authenticationTransaction = new ManagedGatewayAuthenticationTransaction(
        this.authDirectory,
      );
      authenticationTransaction.commit();
      const current = this.loadState();
      if (current) {
        const loggedOutState = { ...current };
        delete loggedOutState.authorization;
        delete loggedOutState.process;
        this.persistState(loggedOutState);
      }
      this.modelReconciliation.clear();
    });
  }

  public shutdown(): void {
    if (this.shutdownCleanup) return;
    this.shutdownRequested = true;
    this.cancelLifecycleOperations();
    this.processLifecycle.stop();
    const state = this.loadState();
    const cleanup = state
      ? this.stopProcessesForState(state, '退出时托管网关端口未能及时释放。')
      : this.processLifecycle.stopForReplacement(0, '退出时托管网关子进程未能及时退出。');
    this.shutdownCleanup = cleanup.catch(() => {
      // Keep exact local and persisted ownership evidence for quit residual reporting.
    });
  }

  public async shutdownForQuit(): Promise<boolean> {
    this.shutdown();
    await this.shutdownCleanup;
    const state = this.loadState();
    return !state?.process && !this.processLifecycle.currentOwnership();
  }

  private cancelLifecycleOperations(): void {
    for (const controller of this.lifecycleControllers) controller.abort();
  }

  private enqueueLifecycle<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.lifecycleControllers.add(controller);
    const current = this.lifecycleTail.then(async () => {
      this.assertActive(controller.signal);
      return operation(controller.signal);
    });
    const clear = (): void => {
      this.lifecycleControllers.delete(controller);
    };
    void current.then(clear, clear);
    this.lifecycleTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private assertActive(signal?: AbortSignal): void {
    if (this.shutdownRequested || signal?.aborted) {
      throw new Error('ClaudeDock 正在退出或操作已取消，已停止托管网关操作。');
    }
  }

  private async requireInstalledAndAuthenticated(
    signal?: AbortSignal,
  ): Promise<PersistedGatewayState> {
    this.assertActive(signal);
    const persisted = this.loadState();
    if (!persisted || !this.executableIsValid(persisted) || !(await this.inspectAuthentication())) {
      throw new Error('ChatGPT 托管网关尚未完成一键安装与 OpenAI 授权。');
    }
    return persisted;
  }

  private environmentSnapshot(): ManagedGatewayEnvironmentSnapshot {
    const environment = buildManagedGatewayEnvironment(process.env, this.environmentOverrides());
    const resolved = resolveManagedGatewayEnvironmentSnapshot(
      this.environmentIdentity,
      environment,
    );
    this.environmentIdentity = resolved.identity;
    return resolved.snapshot;
  }

  private configurationLaunchIdentity(state: PersistedGatewayState): string {
    const encryptedManagementKey = state.encryptedManagementKey ?? '';
    if (
      this.configurationIdentity?.encryptedClientKey === state.encryptedClientKey &&
      this.configurationIdentity.encryptedManagementKey === encryptedManagementKey &&
      this.configurationIdentity.port === state.port
    ) {
      return this.configurationIdentity.identity;
    }
    const identity = randomBytes(16).toString('hex');
    this.configurationIdentity = {
      encryptedClientKey: state.encryptedClientKey,
      encryptedManagementKey,
      identity,
      port: state.port,
    };
    return identity;
  }

  private assertEnvironmentCurrent(
    snapshot: ManagedGatewayEnvironmentSnapshot,
    signal?: AbortSignal,
  ): void {
    this.assertActive(signal);
    if (this.environmentSnapshot().signature !== snapshot.signature) {
      throw new ManagedGatewayEnvironmentChangedError();
    }
  }

  private async startWithStableEnvironment(
    prepared: PreparedGatewayConfiguration,
    beforeStart?: (
      configPath: string,
      snapshot: ManagedGatewayEnvironmentSnapshot,
    ) => Promise<ManagedGatewayAuthenticationTransaction | void>,
    signal?: AbortSignal,
  ): Promise<PersistedGatewayState> {
    let lastEnvironmentError: ManagedGatewayEnvironmentChangedError | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = this.environmentSnapshot();
      const pendingConfigPath = await this.stageConfiguration(prepared.config);
      let transaction: GatewayConfigTransaction | undefined;
      try {
        transaction = await this.activateConfiguration(pendingConfigPath);
        const pendingAuthentication = await beforeStart?.(this.configPath, snapshot);
        this.assertEnvironmentCurrent(snapshot, signal);
        if (!(await this.inspectAuthentication(pendingAuthentication || undefined))) {
          throw new Error('OpenAI 授权文件缺失、损坏或尚未写入完成。');
        }
        const ready = await this.start(prepared, this.configPath, snapshot, signal);
        const authentication = await this.inspectAuthentication(pendingAuthentication || undefined);
        if (!authentication) {
          throw new Error('本机模型接口已响应，但 OpenAI 授权文件已经失效。');
        }
        const committedState: PersistedGatewayState = {
          ...ready,
          authorization: authentication.manifest,
          ...(ready.process ? { process: { ...ready.process, phase: 'ready' as const } } : {}),
        };
        if (!(await this.ownedProcessId(committedState))) {
          throw new Error('CLIProxyAPI 在就绪状态保存完成前已经退出。');
        }
        await this.commitConfiguration(transaction, committedState, snapshot);
        return committedState;
      } catch (error) {
        const stoppingState = this.loadState() ?? prepared.state;
        await this.stopProcessesForState(
          stoppingState,
          error instanceof ManagedGatewayEnvironmentChangedError
            ? '托管网关运行环境变化后，旧启动进程未能及时退出或释放端口。'
            : '托管网关启动失败后，旧进程未能及时退出或释放端口。',
        );
        if (error instanceof ManagedGatewayEnvironmentChangedError) {
          lastEnvironmentError = error;
          continue;
        }
        throw error;
      } finally {
        if (transaction && !transaction.committed) {
          this.rollbackConfiguration(transaction);
        }
        this.removeStagedConfig(pendingConfigPath);
      }
    }
    throw new Error('托管网关启动期间应用网络环境持续变化，请稍后重试。', {
      cause: lastEnvironmentError,
    });
  }

  private stageConfiguration(config: string): Promise<string> {
    return this.configFiles.stage(config);
  }

  private removeStagedConfig(pendingConfigPath: string): void {
    this.configFiles.removeStaged(pendingConfigPath);
  }

  private activateConfiguration(pendingConfigPath: string): Promise<GatewayConfigTransaction> {
    return this.configFiles.activate(pendingConfigPath);
  }

  private async commitConfiguration(
    transaction: GatewayConfigTransaction,
    state: PersistedGatewayState,
    snapshot: ManagedGatewayEnvironmentSnapshot,
  ): Promise<void> {
    this.assertEnvironmentCurrent(snapshot);
    const persisted = this.loadState();
    if (
      state.process?.phase === 'ready' &&
      persisted?.process?.phase === 'starting' &&
      persisted.process.processId === state.process.processId &&
      persisted.process.identity.startedAtTicks === state.process.identity.startedAtTicks
    ) {
      this.persistedProcess.promoteReady(
        { ...state, process: { ...state.process, phase: 'starting' } },
        state.authorization,
      );
    } else {
      this.persistState(state);
    }
    this.configFiles.commit(transaction);
  }

  private rollbackConfiguration(transaction: GatewayConfigTransaction): void {
    this.configFiles.rollback(transaction);
  }

  private async latest(): Promise<CliProxyApiRelease> {
    return fetchLatestManagedGatewayRelease(this.fetchImplementation);
  }

  private async installLatest(
    report?: ManagedChatGptSetupReporter,
  ): Promise<PersistedGatewayState | undefined> {
    return installLatestManagedGateway({
      current: this.loadState(),
      downloadEngine: this.downloadEngine,
      downloadsDirectory: this.downloadsDirectory,
      executableIsValid: (state) => this.executableIsValid(state),
      extractRelease: (archivePath, version) => this.extractRelease(archivePath, version),
      latest: () => this.latest(),
      persistState: (state) => this.persistState(state),
      ...(report ? { report } : {}),
      rootDirectory: this.rootDirectory,
      stopCurrent: (state) =>
        this.stopProcessesForState(
          state,
          '旧版 CLIProxyAPI 停止后端口仍被占用，已拒绝切换安装版本。',
        ),
      versionsDirectory: this.versionsDirectory,
    });
  }

  private async extractRelease(archivePath: string, version: string): Promise<string> {
    return extractManagedGatewayRelease(
      archivePath,
      version,
      this.rootDirectory,
      this.versionsDirectory,
      this.runProcessImplementation,
    );
  }

  private async prepareConfiguration(
    current: PersistedGatewayState | undefined,
  ): Promise<PreparedGatewayConfiguration> {
    if (!current || !existsSync(this.executablePath(current))) {
      throw new Error('CLIProxyAPI 尚未正确安装。');
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储当前不可用，拒绝生成或保存托管网关访问密钥。');
    }
    const existingKey = this.decryptClientKey(current);
    const existingManagementKey = this.decryptManagementKey(current);
    const clientKey = existingKey ?? `sk-claudedock-${randomBytes(32).toString('base64url')}`;
    const managementKey =
      existingManagementKey ?? `mgmt-claudedock-${randomBytes(32).toString('base64url')}`;
    const port = current.port || (await findAvailablePort(DEFAULT_PORT, LAST_PORT, '启动托管网关'));
    const state: PersistedGatewayState = {
      ...current,
      encryptedClientKey:
        existingKey === undefined
          ? this.safeStorage.encryptString(clientKey).toString('base64')
          : current.encryptedClientKey,
      encryptedManagementKey:
        existingManagementKey === undefined
          ? this.safeStorage.encryptString(managementKey).toString('base64')
          : current.encryptedManagementKey,
      port,
    };
    const config = buildManagedGatewayConfig({
      authDirectory: this.authDirectory,
      clientKey,
      managementKey,
      port,
    });
    mkdirSync(this.authDirectory, { recursive: true });
    this.assertAuthenticationDirectoryOwned();
    return {
      config,
      configSignature: this.configurationLaunchIdentity(state),
      state,
    };
  }

  private assertAuthenticationDirectoryOwned(): void {
    if (!managedGatewayAuthenticationDirectoryIsOwned(this.authDirectory)) {
      throw new Error('托管网关授权目录不安全，已拒绝读取或写入授权文件。');
    }
  }

  private controlledRuntimeDirectory(): string {
    mkdirSync(this.runtimeDirectory, { recursive: true });
    const resolvedRoot = path.resolve(this.rootDirectory);
    const resolvedRuntime = path.resolve(this.runtimeDirectory);
    const runtime = lstatSync(resolvedRuntime);
    if (
      path.dirname(resolvedRuntime).toLowerCase() !== resolvedRoot.toLowerCase() ||
      !runtime.isDirectory() ||
      runtime.isSymbolicLink() ||
      path.dirname(realpathSync(resolvedRuntime)).toLowerCase() !==
        realpathSync(resolvedRoot).toLowerCase() ||
      existsSync(path.join(resolvedRuntime, '.env'))
    ) {
      throw new Error('托管网关运行目录不安全，已拒绝加载外部环境配置。');
    }
    return resolvedRuntime;
  }

  private async inspectAuthentication(
    inspectedTransaction?: ManagedGatewayAuthenticationTransaction,
  ): Promise<ManagedGatewayAuthenticationInspection | undefined> {
    if (
      !managedGatewayAuthenticationDirectoryIsOwned(this.authDirectory) ||
      ManagedGatewayAuthenticationTransaction.hasPending(this.authDirectory, inspectedTransaction)
    ) {
      return undefined;
    }
    const candidates = snapshotManagedGatewayAuthenticationCandidates(this.authDirectory);
    await protectManagedGatewayAuthentication(this.authDirectory, [...candidates.keys()]);
    const first = inspectManagedGatewayAuthentication(this.authDirectory);
    if (first) return first;
    if (candidates.size === 0) return undefined;
    await managedGatewayDelay(AUTH_ARTIFACT_RETRY_MS);
    const retriedCandidates = snapshotManagedGatewayAuthenticationCandidates(this.authDirectory);
    await protectManagedGatewayAuthentication(this.authDirectory, [...retriedCandidates.keys()]);
    return inspectManagedGatewayAuthentication(this.authDirectory);
  }

  private async inspectCodexArtifact(
    candidatePath: string,
  ): Promise<ReturnType<typeof inspectManagedGatewayCodexArtifact>> {
    await protectManagedGatewayAuthentication(this.authDirectory, [candidatePath]);
    const first = inspectManagedGatewayCodexArtifact(this.authDirectory, candidatePath);
    if (first) return first;
    await managedGatewayDelay(AUTH_ARTIFACT_RETRY_MS);
    return inspectManagedGatewayCodexArtifact(this.authDirectory, candidatePath);
  }

  private async login(
    state: PersistedGatewayState,
    configPath: string,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ManagedGatewayAuthenticationTransaction> {
    await this.stopProcessesForState(state, 'OpenAI 授权前无法确认旧托管网关已经停止。');
    this.assertActive(signal);
    this.assertAuthenticationDirectoryOwned();
    ManagedGatewayAuthenticationTransaction.recoverAbandoned(this.authDirectory);
    this.assertAuthenticationDirectoryOwned();
    const existingCandidates = snapshotManagedGatewayAuthenticationCandidates(this.authDirectory);
    await protectManagedGatewayAuthentication(this.authDirectory, [...existingCandidates.keys()]);
    this.assertActive(signal);
    const executable = this.executablePath(state);
    const callbackPort = await findAvailablePort(
      OAUTH_DEFAULT_PORT,
      OAUTH_LAST_PORT,
      '启动 OpenAI 授权回调',
      signal,
    );
    const transaction = new ManagedGatewayAuthenticationTransaction(this.authDirectory);
    try {
      this.assertAuthenticationDirectoryOwned();
      const output = await this.runProcessImplementation(
        executable,
        ['-config', configPath, '-codex-login', '-oauth-callback-port', String(callbackPort)],
        environment,
        {
          cwd: this.controlledRuntimeDirectory(),
          maxBuffer: 512 * 1024,
          signal,
          timeout: LOGIN_TIMEOUT_MS,
        },
      );
      this.assertActive(signal);
      const reportedArtifactPath = parseManagedGatewayLoginArtifactPath(output.stdout);
      if (!reportedArtifactPath) {
        throw new Error('OpenAI 授权窗口已结束，但没有收到完整的凭据保存确认；请重试登录。');
      }
      const artifact = await this.inspectCodexArtifact(reportedArtifactPath);
      const candidates = snapshotManagedGatewayAuthenticationCandidates(this.authDirectory);
      if (
        !artifact ||
        candidates.size !== 1 ||
        !candidates.has(managedGatewayAuthenticationCandidateKey(artifact.filePath))
      ) {
        throw new Error('OpenAI 授权文件缺失、损坏或不唯一；请重试登录。');
      }
      await protectManagedGatewayAuthentication(this.authDirectory, [artifact.filePath]);
      return transaction;
    } catch (error) {
      transaction.rollback();
      if (signal.aborted) {
        throw new Error('OpenAI 授权已取消。', { cause: error });
      }
      throw new Error(
        `OpenAI 授权未完成：${managedGatewayErrorMessage(error, [
          this.authDirectory,
          this.rootDirectory,
        ])}`,
        { cause: error },
      );
    }
  }

  private async start(
    prepared: PreparedGatewayConfiguration,
    configPath: string,
    snapshot: ManagedGatewayEnvironmentSnapshot,
    signal?: AbortSignal,
  ): Promise<PersistedGatewayState> {
    const { state } = prepared;
    const credential = this.decryptClientKey(state);
    if (!credential) {
      throw new Error('托管网关本地访问密钥无法解密。');
    }
    this.assertEnvironmentCurrent(snapshot, signal);

    if (this.processLifecycle.ownsStoppingProcess()) {
      await this.stopProcessesForState(
        this.loadState() ?? state,
        '停止中的托管网关未能及时退出或释放端口，已拒绝继续探测。',
      );
      this.assertEnvironmentCurrent(snapshot, signal);
    }
    const activeProcess = this.processLifecycle.activeProcess();
    const existingProcessId = await this.ownedProcessId(state);
    if (
      activeProcess?.pid &&
      existingProcessId === activeProcess.pid &&
      this.processLifecycle.launchMatches(
        existingProcessId,
        prepared.configSignature,
        snapshot.signature,
      )
    ) {
      const existingModels = await this.modelReconciliation.probe(
        state,
        existingProcessId,
        credential,
      );
      this.assertEnvironmentCurrent(snapshot, signal);
      if (
        existingModels.length > 0 &&
        this.modelReconciliation.rememberModelsForChild(
          state,
          existingProcessId,
          existingModels,
          activeProcess,
        )
      ) {
        return state;
      }
    }
    if (existingProcessId || activeProcess) {
      await this.stopProcessesForState(
        this.loadState() ?? state,
        '旧托管网关进程未能及时退出或释放端口，已拒绝启动替换进程。',
      );
      this.assertEnvironmentCurrent(snapshot, signal);
    } else {
      await this.processLifecycle.stopForReplacement(
        state.port,
        '旧托管网关进程未能及时退出或释放端口，已拒绝启动替换进程。',
      );
    }
    if (!(await portIsAvailable(state.port, 1_000))) {
      throw new Error(
        `本机端口 ${state.port} 已被其他程序占用；请关闭冲突程序后重新启动 Claude Code。`,
      );
    }
    this.assertEnvironmentCurrent(snapshot, signal);
    const executable = this.executablePath(state);
    const startupLog = new ManagedGatewayStartupLog(12_000, 40, [
      this.authDirectory,
      this.rootDirectory,
    ]);
    const child = this.spawnImplementation(executable, ['-config', configPath], {
      cwd: this.controlledRuntimeDirectory(),
      env: snapshot.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', (chunk: Buffer) => startupLog.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => startupLog.append(chunk));
    if (!child.pid) {
      child.once('error', (error) => startupLog.append(error.message));
      try {
        child.kill();
      } catch {
        // Failed signal delivery is not evidence of a live process when spawn returned no PID.
      }
      throw new Error('CLIProxyAPI 后台没有返回有效进程标识。');
    }
    const ownership = this.processLifecycle.start(child, {
      configSignature: prepared.configSignature,
      environmentSignature: snapshot.signature,
      executablePath: executable,
    });
    let startingState: PersistedGatewayState | undefined;
    const complete = (): void => {
      startupLog.finish();
      this.processLifecycle.complete(ownership);
      if (startingState?.process) {
        try {
          this.persistedProcess.clearOwnership(startingState.process);
        } catch {
          // Keep the exact persisted record when the atomic clear fails; reconciliation retries it.
        }
      }
    };
    child.once('exit', complete);
    child.once('close', complete);
    child.once('error', (error) => {
      startupLog.append(error.message);
      if (!child.pid) complete();
    });
    const identity = await this.processIdentity.capture({
      configPath,
      executablePath: executable,
      port: state.port,
      processId: child.pid,
    });
    if (!identity || !this.processLifecycle.isCurrent(ownership)) {
      await this.processLifecycle.stopForReplacement(
        state.port,
        'CLIProxyAPI 启动进程身份无法确认且未能及时退出。',
      );
      throw new Error('CLIProxyAPI 启动进程身份无法确认。');
    }
    try {
      startingState = this.persistedProcess.persistStarting(state, child.pid, identity);
    } catch (error) {
      await this.processIdentity.terminate({
        configPath,
        executablePath: executable,
        identity,
        port: state.port,
        processId: child.pid,
      });
      await this.processLifecycle.stopForReplacement(
        state.port,
        'CLIProxyAPI 启动所有权保存失败后，进程未能及时退出。',
      );
      throw new Error('CLIProxyAPI 启动所有权无法安全保存，已终止启动进程。', {
        cause: error,
      });
    }
    if (!startingState) {
      throw new Error('CLIProxyAPI 启动所有权未能建立。');
    }
    const deadline = Date.now() + START_TIMEOUT_MS;
    const probeFailures: ManagedGatewayReadinessFailures = { hasFullBudget: false };
    while (Date.now() < deadline) {
      this.assertEnvironmentCurrent(snapshot, signal);
      const remaining = Math.max(1, deadline - Date.now());
      const probeTimeout = Math.min(MANAGED_GATEWAY_READINESS_PROBE_TIMEOUT_MS, remaining);
      const readiness = await this.modelReconciliation.probeReadiness(
        startingState,
        child.pid,
        credential,
        probeTimeout,
      );
      const { availableModels } = readiness;
      rememberManagedGatewayReadinessFailure(probeFailures, readiness.failure, probeTimeout);
      if (availableModels.length > 0) {
        this.assertEnvironmentCurrent(snapshot, signal);
        if (!(await this.ownedProcessId(startingState))) {
          throw new Error('CLIProxyAPI 已响应，但启动进程身份无法确认。');
        }
        if (
          !this.modelReconciliation.rememberModelsForChild(
            startingState,
            child.pid,
            availableModels,
            child,
          )
        ) {
          throw new Error('CLIProxyAPI 模型检查完成后启动进程身份已经失效。');
        }
        return startingState;
      }
      if (
        !this.processLifecycle.isCurrent(ownership) ||
        this.processLifecycle.childHasExited(child)
      ) {
        break;
      }
      await managedGatewayDelay(250);
      this.assertEnvironmentCurrent(snapshot, signal);
    }
    const sensitivePaths = [this.authDirectory, this.rootDirectory];
    const failure = managedGatewayReadinessFailure(
      probeFailures.hasFullBudget ? probeFailures.lastFullBudget : probeFailures.last,
      startupLog.summary(),
      sensitivePaths,
    );
    try {
      await this.stopProcessesForState(
        startingState,
        'CLIProxyAPI 启动超时后未能及时退出或释放端口。',
      );
    } catch (cleanupFailure) {
      throw managedGatewayReadinessCleanupFailure(failure, cleanupFailure, sensitivePaths);
    }
    throw failure;
  }

  private loadState(): PersistedGatewayState | undefined {
    return this.stateStore.load();
  }

  private persistState(state: PersistedGatewayState): void {
    this.stateStore.persist(state);
  }

  private decryptClientKey(state: PersistedGatewayState): string | undefined {
    return this.stateStore.decryptClientKey(state);
  }

  private decryptManagementKey(state: PersistedGatewayState): string | undefined {
    return this.stateStore.decryptManagementKey(state);
  }

  private executablePath(state: PersistedGatewayState): string {
    return this.stateStore.executablePath(state);
  }

  private executableIsValid(state: PersistedGatewayState): boolean {
    return this.stateStore.executableIsValid(state);
  }

  private readOwnedModels(
    state: PersistedGatewayState,
    processId: number,
    credential: string,
    timeoutMs: number,
  ): Promise<string[]> {
    const descriptor = this.persistedProcess.descriptor(state, processId);
    if (!descriptor) {
      return Promise.reject(new Error('托管网关缺少可验证的进程出生身份。'));
    }
    return this.ownedModelReader.read(descriptor, credential, timeoutMs);
  }

  private async ownedProcessId(state: PersistedGatewayState): Promise<number | undefined> {
    if (this.processLifecycle.isStoppingProcessId(state.process?.processId)) return undefined;
    const activeProcess = this.processLifecycle.activeProcess();
    if (activeProcess && activeProcess.pid !== state.process?.processId) return undefined;
    try {
      return await this.persistedProcess.ownedProcessId(state);
    } catch {
      return undefined;
    }
  }

  private readonly portAvailable = portIsAvailable;

  private async stopProcessesForState(
    state: PersistedGatewayState,
    occupiedPortMessage: string,
  ): Promise<void> {
    this.modelReconciliation.clear();
    this.processLifecycle.stop();
    if (state.process) {
      await this.persistedProcess.stop(state, occupiedPortMessage);
    }
    await this.processLifecycle.stopForReplacement(state.port, occupiedPortMessage);
  }
}
