import type { ManagedGatewayProcessLifecycle } from './managed-chatgpt-process-lifecycle';
import type {
  ManagedGatewayExactProcess,
  ManagedGatewayProcessBirthIdentity,
  ManagedGatewayProcessIdentity,
} from './managed-chatgpt-process-identity';
import type {
  PersistedGatewayProcessOwnership,
  PersistedGatewayState,
} from './managed-chatgpt-state';

const PROCESS_STOP_TIMEOUT_MS = 2_000;

const boundedPortAvailability = (
  operation: Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    timer.unref();
    void operation.then(
      (available) => finish(available),
      () => finish(false),
    );
  });

interface ManagedGatewayPersistedProcessOptions {
  configPath: string;
  executablePath: (state: PersistedGatewayState) => string;
  loadState: () => PersistedGatewayState | undefined;
  persistState: (state: PersistedGatewayState) => void;
  portAvailable: (port: number, timeoutMs?: number) => Promise<boolean>;
  processIdentity: Pick<ManagedGatewayProcessIdentity, 'matches' | 'terminate'>;
  processLifecycle: ManagedGatewayProcessLifecycle;
}

const ownershipMatches = (
  left: PersistedGatewayProcessOwnership | undefined,
  right: PersistedGatewayProcessOwnership,
): boolean =>
  left?.version === right.version &&
  left.processId === right.processId &&
  left.phase === right.phase &&
  left.identity.version === right.identity.version &&
  left.identity.startedAtTicks === right.identity.startedAtTicks;

export class ManagedGatewayProcessStopError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ManagedGatewayProcessStopError';
  }
}

/** Owns transactional persisted process records and exact-instance termination/reconciliation. */
export class ManagedGatewayPersistedProcess {
  public constructor(private readonly options: ManagedGatewayPersistedProcessOptions) {}

  public descriptor(
    state: PersistedGatewayState,
    processId = state.process?.processId,
  ): ManagedGatewayExactProcess | undefined {
    if (!state.process || state.process.processId !== processId) return undefined;
    return {
      configPath: this.options.configPath,
      executablePath: this.options.executablePath(state),
      identity: state.process.identity,
      port: state.port,
      processId: state.process.processId,
    };
  }

  public async ownedProcessId(state: PersistedGatewayState): Promise<number | undefined> {
    const ownership = state.process;
    const descriptor = this.descriptor(state);
    if (!descriptor || !ownership) return undefined;
    const match = await this.options.processIdentity.matches(descriptor);
    if (match === 'match') return descriptor.processId;
    if (match === 'absent' || match === 'inaccessible' || match === 'mismatch') {
      try {
        this.clearOwnership(ownership);
      } catch {
        // Retain the exact record when atomic state replacement fails; a later read retries cleanup.
      }
    }
    return undefined;
  }

  public persistStarting(
    state: PersistedGatewayState,
    processId: number,
    identity: ManagedGatewayProcessBirthIdentity,
  ): PersistedGatewayState {
    const starting: PersistedGatewayState = {
      ...state,
      process: { identity, phase: 'starting', processId, version: 1 },
    };
    this.options.persistState(starting);
    return starting;
  }

  public promoteReady(
    state: PersistedGatewayState,
    authorization: PersistedGatewayState['authorization'],
  ): PersistedGatewayState {
    if (!state.process) {
      throw new Error('托管网关缺少可提交的启动进程身份。');
    }
    const current = this.options.loadState();
    if (!current || !ownershipMatches(current.process, state.process)) {
      throw new Error('托管网关启动进程状态已经被其他代次替换。');
    }
    const ready: PersistedGatewayState = {
      ...state,
      ...(authorization ? { authorization } : { authorization: undefined }),
      process: { ...state.process, phase: 'ready' },
    };
    this.options.persistState(ready);
    return ready;
  }

  public clearOwnership(expected: PersistedGatewayProcessOwnership): boolean {
    const current = this.options.loadState();
    if (!current || !ownershipMatches(current.process, expected)) return false;
    this.options.persistState({ ...current, process: undefined });
    return true;
  }

  public clearOwnershipForProcessId(processId: number): boolean {
    const current = this.options.loadState();
    if (!current?.process || current.process.processId !== processId) return false;
    return this.clearOwnership(current.process);
  }

  public async stop(state: PersistedGatewayState, occupiedPortMessage: string): Promise<boolean> {
    const descriptor = this.descriptor(state);
    if (!descriptor || !state.process) return true;
    const deadline = Date.now() + PROCESS_STOP_TIMEOUT_MS;
    const result = await this.options.processIdentity.terminate(
      descriptor,
      Math.max(1, deadline - Date.now()),
    );
    if (result === 'mismatch') {
      try {
        this.clearOwnership(state.process);
      } catch {
        // No process was killed. Leave the stale exact record for a later cleanup retry.
      }
      return true;
    }
    if (result !== 'terminated') {
      throw new ManagedGatewayProcessStopError(
        result === 'timeout'
          ? 'ChatGPT 本地网关没有在停止时限内退出。'
          : '托管网关进程身份当前无法安全终止。',
      );
    }
    const remainingPortBudget = deadline - Date.now();
    if (
      remainingPortBudget <= 0 ||
      !(await boundedPortAvailability(
        this.options.portAvailable(state.port, remainingPortBudget),
        remainingPortBudget,
      ))
    ) {
      throw new ManagedGatewayProcessStopError(occupiedPortMessage);
    }
    this.clearOwnership(state.process);
    const local = this.options.processLifecycle.currentOwnership();
    if (local?.processId === descriptor.processId) {
      this.options.processLifecycle.complete(local);
    }
    return true;
  }
}
