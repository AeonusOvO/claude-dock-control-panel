import type { ChildProcess } from 'node:child_process';
import {
  recommendedChatModel,
  recommendedFastModel,
} from '../../shared/claude/managed-chatgpt-models';
import type { PersistedGatewayState } from './managed-chatgpt-state';

export const MANAGED_GATEWAY_READINESS_PROBE_TIMEOUT_MS = 8_000;

export interface ManagedGatewayProcessOwnership {
  child?: ChildProcess;
  processId: number;
  state: PersistedGatewayState;
}

const copiedState = (state: PersistedGatewayState): PersistedGatewayState => ({
  ...(state.authorization ? { authorization: { ...state.authorization } } : {}),
  encryptedClientKey: state.encryptedClientKey,
  ...(state.encryptedManagementKey ? { encryptedManagementKey: state.encryptedManagementKey } : {}),
  executableRelativePath: state.executableRelativePath,
  executableSha256: state.executableSha256,
  installedVersion: state.installedVersion,
  port: state.port,
  ...(state.process
    ? {
        process: {
          identity: { ...state.process.identity },
          phase: state.process.phase,
          processId: state.process.processId,
          version: 1 as const,
        },
      }
    : {}),
  releaseDigest: state.releaseDigest,
  version: 1,
});

export const captureManagedGatewayProcessOwnership = (
  state: PersistedGatewayState,
  processId: number,
  child: ChildProcess | undefined,
): ManagedGatewayProcessOwnership => ({
  child: child?.pid === processId ? child : undefined,
  processId,
  state: copiedState(state),
});

const persistedProcessMatches = (
  left: PersistedGatewayState['process'],
  right: PersistedGatewayState['process'],
): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      left.version === right.version &&
      left.processId === right.processId &&
      left.phase === right.phase &&
      left.identity.version === right.identity.version &&
      left.identity.startedAtTicks === right.identity.startedAtTicks;

export const managedGatewayProcessOwnershipMatches = (
  left: ManagedGatewayProcessOwnership,
  right: ManagedGatewayProcessOwnership,
): boolean =>
  left.child === right.child &&
  left.processId === right.processId &&
  left.state.encryptedClientKey === right.state.encryptedClientKey &&
  left.state.executableRelativePath === right.state.executableRelativePath &&
  left.state.executableSha256 === right.state.executableSha256 &&
  left.state.installedVersion === right.state.installedVersion &&
  left.state.port === right.state.port &&
  persistedProcessMatches(left.state.process, right.state.process) &&
  left.state.releaseDigest === right.state.releaseDigest &&
  left.state.version === right.state.version;

export const persistedGatewayStateMatchesOwnership = (
  state: PersistedGatewayState | undefined,
  ownership: ManagedGatewayProcessOwnership,
): state is PersistedGatewayState =>
  Boolean(
    state &&
    ownership.state.process?.processId === ownership.processId &&
    state.process?.processId === ownership.processId &&
    state.encryptedClientKey === ownership.state.encryptedClientKey &&
    state.executableRelativePath === ownership.state.executableRelativePath &&
    state.executableSha256 === ownership.state.executableSha256 &&
    state.installedVersion === ownership.state.installedVersion &&
    state.port === ownership.state.port &&
    persistedProcessMatches(state.process, ownership.state.process) &&
    state.releaseDigest === ownership.state.releaseDigest &&
    state.version === ownership.state.version,
  );

interface ManagedGatewayProcessOwnershipVerifier {
  currentChild: () => ChildProcess | undefined;
  generationIsCurrent: (generation: number) => boolean;
  loadState: () => PersistedGatewayState | undefined;
  ownedProcessId: (state: PersistedGatewayState) => Promise<number | undefined>;
}

const managedGatewayProcessOwnershipSnapshotIsCurrent = (
  ownership: ManagedGatewayProcessOwnership,
  verifier: Pick<ManagedGatewayProcessOwnershipVerifier, 'currentChild' | 'loadState'>,
): boolean => {
  if (!persistedGatewayStateMatchesOwnership(verifier.loadState(), ownership)) return false;
  const currentChild = verifier.currentChild();
  return ownership.child
    ? currentChild === ownership.child &&
        ownership.child.exitCode === null &&
        ownership.child.signalCode === null
    : currentChild === undefined;
};

export const managedGatewayProcessOwnershipIsCurrent = async (
  ownership: ManagedGatewayProcessOwnership,
  generation: number,
  verifier: ManagedGatewayProcessOwnershipVerifier,
): Promise<boolean> => {
  if (!verifier.generationIsCurrent(generation)) return false;
  if (ownership.child) {
    if (
      verifier.currentChild() !== ownership.child ||
      ownership.child.exitCode !== null ||
      ownership.child.signalCode !== null
    ) {
      return false;
    }
    const processId = await verifier.ownedProcessId(ownership.state);
    return (
      processId === ownership.processId &&
      verifier.generationIsCurrent(generation) &&
      verifier.currentChild() === ownership.child &&
      ownership.child.exitCode === null &&
      ownership.child.signalCode === null &&
      persistedGatewayStateMatchesOwnership(verifier.loadState(), ownership)
    );
  }
  if (verifier.currentChild()) return false;
  const current = verifier.loadState();
  if (!persistedGatewayStateMatchesOwnership(current, ownership)) return false;
  const processId = await verifier.ownedProcessId(current);
  return (
    processId === ownership.processId &&
    verifier.generationIsCurrent(generation) &&
    !verifier.currentChild() &&
    persistedGatewayStateMatchesOwnership(verifier.loadState(), ownership)
  );
};

export interface ManagedGatewayModelReconciliationResult {
  availableModels: string[];
  processOwned: boolean;
}

export interface ManagedGatewayReadinessProbeResult {
  availableModels: string[];
  failure?: unknown;
}

export interface ManagedChatGptGatewayProjectConfig {
  availableModels: string[];
  baseUrl: string;
  credential: string;
  model: string;
  modelFast: string;
}

interface ManagedGatewayModelCache {
  availableModels: string[];
  generation: number;
  ownership: ManagedGatewayProcessOwnership;
}

interface ManagedGatewayModelProbe {
  generation: number;
  ownership: ManagedGatewayProcessOwnership;
  promise: Promise<ManagedGatewayModelReconciliationResult>;
}

interface ManagedGatewayModelReconciliationOptions extends Omit<
  ManagedGatewayProcessOwnershipVerifier,
  'generationIsCurrent'
> {
  decryptClientKey: (state: PersistedGatewayState) => string | undefined;
  readOwnedModels: (
    state: PersistedGatewayState,
    processId: number,
    credential: string,
    timeoutMs: number,
  ) => Promise<string[]>;
}

/** Keeps process-local model state generation-fenced to the exact ownership snapshot that produced it. */
export class ManagedGatewayModelReconciliation {
  private cache?: ManagedGatewayModelCache;
  private generation = 0;
  private probeInFlight?: ManagedGatewayModelProbe;

  public constructor(private readonly options: ManagedGatewayModelReconciliationOptions) {}

  public clear(): void {
    this.generation += 1;
    this.cache = undefined;
    this.probeInFlight = undefined;
  }

  public modelsForOwnedProcess(
    state: PersistedGatewayState,
    processId: number,
  ): Promise<ManagedGatewayModelReconciliationResult> {
    const ownership = captureManagedGatewayProcessOwnership(
      state,
      processId,
      this.options.currentChild(),
    );
    return this.modelsFor(ownership, (generation) =>
      this.probeOwnedProcessModels(ownership, generation),
    );
  }

  public probe(
    state: PersistedGatewayState,
    processId: number,
    credential: string,
    timeoutMs = MANAGED_GATEWAY_READINESS_PROBE_TIMEOUT_MS,
  ): Promise<string[]> {
    return this.probeReadiness(state, processId, credential, timeoutMs).then(
      ({ availableModels }) => availableModels,
    );
  }

  public async probeReadiness(
    state: PersistedGatewayState,
    processId: number,
    credential: string,
    timeoutMs = MANAGED_GATEWAY_READINESS_PROBE_TIMEOUT_MS,
  ): Promise<ManagedGatewayReadinessProbeResult> {
    try {
      return {
        availableModels: await this.availableModels(state, processId, credential, timeoutMs),
      };
    } catch (failure) {
      return { availableModels: [], failure };
    }
  }

  public projectConfiguration(
    state: PersistedGatewayState,
    requestedModel?: string,
  ): Promise<ManagedChatGptGatewayProjectConfig> {
    return this.projectConfigurationInternal(state, requestedModel);
  }

  public rememberModelsForChild(
    state: PersistedGatewayState,
    processId: number,
    availableModels: readonly string[],
    expectedChild: ChildProcess,
  ): boolean {
    const currentChild = this.options.currentChild();
    if (
      currentChild !== expectedChild ||
      expectedChild.pid !== processId ||
      expectedChild.exitCode !== null ||
      expectedChild.signalCode !== null ||
      state.process?.processId !== processId
    ) {
      return false;
    }
    this.remember(
      captureManagedGatewayProcessOwnership(state, processId, currentChild),
      availableModels,
    );
    return true;
  }

  private availableModels(
    state: PersistedGatewayState,
    processId: number,
    credential: string,
    timeoutMs = MANAGED_GATEWAY_READINESS_PROBE_TIMEOUT_MS,
  ): Promise<string[]> {
    return this.options.readOwnedModels(state, processId, credential, timeoutMs);
  }

  private invalidateOwnership(ownership: ManagedGatewayProcessOwnership): void {
    const cacheMatches =
      this.cache && managedGatewayProcessOwnershipMatches(this.cache.ownership, ownership);
    const probeMatches =
      this.probeInFlight &&
      managedGatewayProcessOwnershipMatches(this.probeInFlight.ownership, ownership);
    if (!cacheMatches && !probeMatches) return;
    this.generation += 1;
    if (cacheMatches) this.cache = undefined;
    if (probeMatches) this.probeInFlight = undefined;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private modelsFor(
    ownership: ManagedGatewayProcessOwnership,
    load: (generation: number) => Promise<ManagedGatewayModelReconciliationResult>,
  ): Promise<ManagedGatewayModelReconciliationResult> {
    if (
      this.cache?.generation === this.generation &&
      managedGatewayProcessOwnershipMatches(this.cache.ownership, ownership) &&
      this.cache.availableModels.length > 0
    ) {
      return Promise.resolve({
        availableModels: [...this.cache.availableModels],
        processOwned: true,
      });
    }
    if (
      this.probeInFlight?.generation === this.generation &&
      managedGatewayProcessOwnershipMatches(this.probeInFlight.ownership, ownership)
    ) {
      return this.probeInFlight.promise;
    }
    if (!managedGatewayProcessOwnershipSnapshotIsCurrent(ownership, this.options)) {
      return Promise.resolve({ availableModels: [], processOwned: false });
    }

    this.clear();
    const generation = this.generation;
    const probe = {} as ManagedGatewayModelProbe;
    probe.generation = generation;
    probe.ownership = ownership;
    probe.promise = load(generation)
      .then((result) => {
        if (result.availableModels.length === 0 || !result.processOwned) {
          return { availableModels: [], processOwned: result.processOwned };
        }
        if (!this.isCurrent(generation)) {
          return { availableModels: [], processOwned: false };
        }
        this.remember(ownership, result.availableModels, generation);
        return { availableModels: [...result.availableModels], processOwned: true };
      })
      .finally(() => {
        if (this.probeInFlight === probe) this.probeInFlight = undefined;
      });
    this.probeInFlight = probe;
    return probe.promise;
  }

  private async probeOwnedProcessModels(
    ownership: ManagedGatewayProcessOwnership,
    generation: number,
  ): Promise<ManagedGatewayModelReconciliationResult> {
    const credential = this.options.decryptClientKey(ownership.state);
    const availableModels = credential
      ? await this.probe(ownership.state, ownership.processId, credential)
      : [];
    return {
      availableModels,
      processOwned: await managedGatewayProcessOwnershipIsCurrent(ownership, generation, {
        ...this.options,
        generationIsCurrent: (expected) => this.isCurrent(expected),
      }),
    };
  }

  private async projectConfigurationInternal(
    state: PersistedGatewayState,
    requestedModel?: string,
  ): Promise<ManagedChatGptGatewayProjectConfig> {
    const credential = this.options.decryptClientKey(state);
    if (!credential) {
      throw new Error('托管网关本地访问密钥无法解密，请重新执行一键配置。');
    }
    const processId = await this.options.ownedProcessId(state);
    if (!processId) {
      throw new Error('托管网关进程身份已经失效，已拒绝读取模型接口。');
    }
    const ownership = captureManagedGatewayProcessOwnership(
      state,
      processId,
      this.options.currentChild(),
    );
    const generation = this.generation;
    const availableModels = await this.availableModels(state, processId, credential, 15_000);
    if (
      !(await managedGatewayProcessOwnershipIsCurrent(ownership, generation, {
        ...this.options,
        generationIsCurrent: (expected) => this.isCurrent(expected),
      }))
    ) {
      this.invalidateOwnership(ownership);
      throw new Error('本机模型接口已响应，但托管网关进程身份已经失效。');
    }
    if (!this.remember(ownership, availableModels, generation)) {
      throw new Error('模型接口响应完成后托管网关模型代次已经失效。');
    }
    if (requestedModel && !availableModels.includes(requestedModel)) {
      throw new Error('所选模型已不在网关实时模型列表中，请重新选择。');
    }
    const model = requestedModel ?? recommendedChatModel(availableModels);
    return {
      availableModels,
      baseUrl: `http://127.0.0.1:${state.port}`,
      credential,
      model,
      modelFast: recommendedFastModel(availableModels, model),
    };
  }

  private remember(
    ownership: ManagedGatewayProcessOwnership,
    availableModels: readonly string[],
    expectedGeneration?: number,
  ): boolean {
    if (expectedGeneration !== undefined && !this.isCurrent(expectedGeneration)) return false;
    this.generation += 1;
    this.cache = {
      availableModels: [...availableModels],
      generation: this.generation,
      ownership,
    };
    this.probeInFlight = undefined;
    return true;
  }
}
