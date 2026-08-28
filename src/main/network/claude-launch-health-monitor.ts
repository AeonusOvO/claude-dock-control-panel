import type {
  ClaudeRouteHealth,
  NetworkPreflightResult,
  NetworkPreflightRunInput,
  NetworkProviderConnectivityStatus,
  NetworkProviderId,
  PtyGeneration,
} from '../../shared/contracts';
import type { NetworkPreflightService } from './preflight-service';

const DEFAULT_HEALTHY_INTERVAL_MS = 2 * 60_000;
const DEFAULT_CONCERN_BASE_INTERVAL_MS = 15_000;
const DEFAULT_MAXIMUM_INTERVAL_MS = 2 * 60_000;
const DEFAULT_JITTER_RATIO = 0.2;

export interface ClaudeLaunchHealthMonitorKey {
  readonly ptyGeneration: PtyGeneration;
  readonly runtimeLaunchGeneration: number;
  readonly sessionId: string;
}

export interface ClaudeLaunchHealthEvidence {
  readonly checkedAt: number;
  readonly provider: NetworkProviderId;
  readonly status: Exclude<NetworkProviderConnectivityStatus, 'testing'>;
}

export interface ClaudeLaunchHealthMonitorStart extends ClaudeLaunchHealthMonitorKey {
  readonly cwd: string;
  readonly initialEvidence?: ClaudeLaunchHealthEvidence;
  readonly provider: NetworkProviderId;
}

interface ClaudeLaunchHealthMonitorOptions {
  concernBaseIntervalMs?: number;
  healthyIntervalMs?: number;
  isCurrent: (key: ClaudeLaunchHealthMonitorKey) => boolean;
  jitterRatio?: number;
  maximumIntervalMs?: number;
  now?: () => number;
  onSnapshot: (key: ClaudeLaunchHealthMonitorKey, snapshot: ClaudeRouteHealth) => void;
  preflight: Pick<NetworkPreflightService, 'run'>;
  random?: () => number;
  shouldCheck?: () => boolean;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

interface MonitorRecord {
  active: boolean;
  concernCount: number;
  readonly cwd: string;
  readonly key: ClaudeLaunchHealthMonitorKey;
  readonly provider: NetworkProviderId;
  timer?: NodeJS.Timeout;
}

const cloneKey = (input: ClaudeLaunchHealthMonitorKey): ClaudeLaunchHealthMonitorKey =>
  Object.freeze({
    ptyGeneration: input.ptyGeneration,
    runtimeLaunchGeneration: input.runtimeLaunchGeneration,
    sessionId: input.sessionId,
  });

type ConnectivityHealthStatus =
  ClaudeLaunchHealthEvidence['status'] | NetworkPreflightResult['providerConnectivity']['status'];

const healthyStatus = (status: ConnectivityHealthStatus): boolean =>
  status === 'allowed' || status === 'allowed_with_notice';

const allowed = (result: NetworkPreflightResult): boolean =>
  healthyStatus(result.providerConnectivity.status);

const healthForResult = (
  result: { readonly status: ConnectivityHealthStatus },
  checkedAt: number,
): ClaudeRouteHealth => {
  if (healthyStatus(result.status)) {
    return Object.freeze({
      blocking: false,
      checkedAt,
      detail: '后台复查未发现会影响当前 Claude Code 会话的连接问题。',
      headline: '运行中连接正常',
      source: 'runtime',
      tone: 'success',
    });
  }
  if (result.status === 'blocked') {
    return Object.freeze({
      blocking: false,
      checkedAt,
      detail: '后台复查发现连接风险；当前会话不会被中断，可在“模型”页查看并处理。',
      headline: '运行中连接可能不可用',
      source: 'runtime',
      tone: 'error',
    });
  }
  return Object.freeze({
    blocking: false,
    checkedAt,
    detail: '后台复查发现连接状态需要留意；当前会话会继续运行。',
    headline: '运行中连接需要留意',
    source: 'runtime',
    tone: 'warning',
  });
};

const unavailableHealth = (checkedAt: number): ClaudeRouteHealth =>
  Object.freeze({
    blocking: false,
    checkedAt,
    detail: '暂时无法完成后台连接复查；当前 Claude Code 会话不会受到影响。',
    headline: '暂时无法复查运行中连接',
    source: 'runtime',
    tone: 'warning',
  });

/**
 * Advisory-only health observation for an exact live Claude launch. It can publish display state and
 * schedule another check, but deliberately receives no runtime, terminal, workspace, or close seam.
 */
export class ClaudeLaunchHealthMonitor {
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly concernBaseIntervalMs: number;
  private readonly healthyIntervalMs: number;
  private readonly isCurrent: ClaudeLaunchHealthMonitorOptions['isCurrent'];
  private readonly jitterRatio: number;
  private readonly maximumIntervalMs: number;
  private readonly monitors = new Map<string, MonitorRecord>();
  private readonly now: () => number;
  private readonly onSnapshot: ClaudeLaunchHealthMonitorOptions['onSnapshot'];
  private readonly preflight: Pick<NetworkPreflightService, 'run'>;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly shouldCheck: () => boolean;

  public constructor(options: ClaudeLaunchHealthMonitorOptions) {
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.concernBaseIntervalMs = options.concernBaseIntervalMs ?? DEFAULT_CONCERN_BASE_INTERVAL_MS;
    this.healthyIntervalMs = options.healthyIntervalMs ?? DEFAULT_HEALTHY_INTERVAL_MS;
    this.isCurrent = options.isCurrent;
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.maximumIntervalMs = options.maximumIntervalMs ?? DEFAULT_MAXIMUM_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onSnapshot = options.onSnapshot;
    this.preflight = options.preflight;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? setTimeout;
    this.shouldCheck = options.shouldCheck ?? (() => true);
  }

  /** Synchronously supersedes any older launch monitor for this workspace session. */
  public start(input: ClaudeLaunchHealthMonitorStart): void {
    this.invalidateSession(input.sessionId);
    const record: MonitorRecord = {
      active: true,
      concernCount: 0,
      cwd: input.cwd,
      key: cloneKey(input),
      provider: input.provider,
    };
    this.monitors.set(input.sessionId, record);
    if (!this.owns(record)) {
      this.stop(record);
      return;
    }
    if (input.initialEvidence?.provider === input.provider) {
      record.concernCount = healthyStatus(input.initialEvidence.status) ? 0 : 1;
      this.publish(record, healthForResult(input.initialEvidence, input.initialEvidence.checkedAt));
      if (this.owns(record)) this.schedule(record);
      else this.stop(record);
      return;
    }
    void this.check(record);
  }

  public invalidateExact(key: ClaudeLaunchHealthMonitorKey): void {
    const record = this.monitors.get(key.sessionId);
    if (
      record &&
      record.key.runtimeLaunchGeneration === key.runtimeLaunchGeneration &&
      record.key.ptyGeneration === key.ptyGeneration
    ) {
      this.stop(record);
    }
  }

  public invalidateSession(sessionId: string): void {
    const record = this.monitors.get(sessionId);
    if (record) this.stop(record);
  }

  public invalidateAll(): void {
    for (const record of [...this.monitors.values()]) this.stop(record);
  }

  public activeCount(): number {
    return this.monitors.size;
  }

  private async check(record: MonitorRecord): Promise<void> {
    if (!this.owns(record)) {
      this.stop(record);
      return;
    }

    const input: NetworkPreflightRunInput = {
      action: 'background',
      cwd: record.cwd,
      provider: record.provider,
    };
    try {
      const result = await this.preflight.run(input);
      if (!this.owns(record)) {
        this.stop(record);
        return;
      }
      record.concernCount = allowed(result) ? 0 : Math.min(record.concernCount + 1, 31);
      this.publish(
        record,
        healthForResult(result.providerConnectivity, result.checkedAt ?? this.now()),
      );
    } catch {
      if (!this.owns(record)) {
        this.stop(record);
        return;
      }
      record.concernCount = Math.min(record.concernCount + 1, 31);
      this.publish(record, unavailableHealth(this.now()));
    }

    if (this.owns(record)) this.schedule(record);
    else this.stop(record);
  }

  private owns(record: MonitorRecord): boolean {
    if (!record.active || this.monitors.get(record.key.sessionId) !== record) return false;
    try {
      return this.shouldCheck() && this.isCurrent(record.key);
    } catch {
      return false;
    }
  }

  private publish(record: MonitorRecord, snapshot: ClaudeRouteHealth): void {
    try {
      this.onSnapshot(record.key, snapshot);
    } catch {
      // Display-only publication must never affect the running session or the monitor schedule.
    }
  }

  private schedule(record: MonitorRecord): void {
    const baseInterval =
      record.concernCount === 0
        ? this.healthyIntervalMs
        : Math.min(
            this.maximumIntervalMs,
            this.concernBaseIntervalMs * 2 ** (record.concernCount - 1),
          );
    const random = Math.min(1, Math.max(0, this.random()));
    const factor = 1 - this.jitterRatio + random * this.jitterRatio * 2;
    const delay = Math.max(1, Math.min(this.maximumIntervalMs, Math.round(baseInterval * factor)));
    record.timer = this.setTimer(() => {
      record.timer = undefined;
      void this.check(record);
    }, delay);
    record.timer.unref?.();
  }

  private stop(record: MonitorRecord): void {
    record.active = false;
    if (record.timer) {
      this.clearTimer(record.timer);
      record.timer = undefined;
    }
    if (this.monitors.get(record.key.sessionId) === record) {
      this.monitors.delete(record.key.sessionId);
    }
  }
}
