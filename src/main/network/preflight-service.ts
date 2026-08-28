import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  NetworkPreflightHistoryView,
  NetworkPreflightResult,
  NetworkPreflightRunInput,
  NetworkPreflightScope,
  NetworkProviderId,
} from '../../shared/contracts';
import { NetworkDiagnosticsStore } from './diagnostics-store';
import {
  type ConnectivityObservation,
  ProviderConnectivityProbe,
} from './provider-connectivity-probe';
import { cachedNetworkPreflightEvidence } from './preflight-result-projection';
import {
  captureNetworkPreflightTarget,
  sameNetworkPreflightTarget,
  type NetworkPreflightTarget,
} from './preflight-target';
import {
  networkPreflightCacheKey,
  networkPreflightCwdCacheKey,
  type NetworkPreflightIdentity,
  networkPreflightInternalFailureResult,
  type NetworkPreflightRequestCapture,
  networkPreflightRequiredScopes,
  type NetworkPreflightRouteIdentity,
  networkPreflightTestingResult,
  networkPreflightUnavailableEnvironmentAssessment,
  networkRouteRevision,
} from './preflight-service-identity';
import {
  NetworkPreflightLeaseContextError,
  NetworkPreflightSupersededError,
} from './preflight-service-errors';
import { RiskDecisionEngine } from './risk-decision-engine';

export { NetworkPreflightLeaseContextError, NetworkPreflightSupersededError };
export type { NetworkPreflightRouteIdentity };

/** Automatic checks require live evidence but must not cancel a sibling's identical check. */
interface NetworkPreflightRequestInput extends NetworkPreflightRunInput {
  readonly fresh?: boolean;
}

export type NetworkPreflightObservabilityPhase =
  'diagnostics-persistence' | 'result-notification' | 'testing-notification';

export interface NetworkPreflightLease {
  readonly epochs: Readonly<Partial<Record<NetworkPreflightScope, string>>>;
  readonly scopes: readonly NetworkPreflightScope[];
  assertCurrent(): void;
  release(): void;
}

const networkPreflightLeaseContextBrand: unique symbol = Symbol('NetworkPreflightLeaseContext');

export interface NetworkPreflightLeaseContext {
  readonly [networkPreflightLeaseContextBrand]: true;
}

interface ActiveNetworkPreflightLeaseContext {
  active: boolean;
  readonly capture: NetworkPreflightRequestCapture;
  lease: NetworkPreflightLease;
  readonly pending: Set<Promise<unknown>>;
}

interface NetworkPreflightServiceOptions {
  acquireNetworkLease: (
    scopes: NetworkPreflightScope | readonly NetworkPreflightScope[],
  ) => Promise<NetworkPreflightLease>;
  diagnosticsStore: NetworkDiagnosticsStore;
  environmentProbe?: { run(signal?: AbortSignal): Promise<ConnectivityObservation['environment']> };
  environmentTimeoutMs?: number;
  onObservabilityError?: (phase: NetworkPreflightObservabilityPhase, error: unknown) => void;
  onResult?: (result: NetworkPreflightResult) => void;
  probe: Pick<ProviderConnectivityProbe, 'run'>;
  /** Real process directory, never the logical configuration/authorization identity in input.cwd. */
  probeWorkingDirectory?: string;
  riskEngine?: RiskDecisionEngine;
  shouldAssessEnvironment?: (input: NetworkPreflightRunInput) => boolean;
}

interface ActiveNetworkPreflightRun {
  readonly authorityDrain: Promise<void>;
  readonly authorityLease: NetworkPreflightLease;
  readonly authorityOwned: boolean;
  authorityReleased: boolean;
  readonly resolveAuthorityDrain: () => void;
  readonly controller: AbortController;
  readonly identity: NetworkPreflightIdentity;
  readonly key: string;
  readonly promise: Promise<NetworkPreflightResult>;
  settled: boolean;
  waiters: number;
}

interface NetworkPreflightRunWaiter {
  readonly activeRun: ActiveNetworkPreflightRun;
  released: boolean;
}

const MAX_RETAINED_PREFLIGHT_KEYS = 256;
const ENVIRONMENT_ASSESSMENT_TIMEOUT_MS = 20_000;

const abortReasonFor = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('This operation was aborted', 'AbortError');

export class NetworkPreflightService {
  private readonly activeLeaseContexts = new WeakMap<
    NetworkPreflightLeaseContext,
    ActiveNetworkPreflightLeaseContext
  >();
  private readonly activeRuns = new Set<ActiveNetworkPreflightRun>();
  private readonly activeUsesByKey = new Map<string, number>();
  private readonly cache = new Map<string, { result: NetworkPreflightResult }>();
  private readonly environmentTimeoutMs: number;
  private generation = 0;
  private readonly inFlight = new Map<string, ActiveNetworkPreflightRun>();
  private readonly latestRunByKey = new Map<string, number>();
  private nextRunId = 1;
  private readonly retainedKeys = new Map<string, undefined>();
  private readonly revisionKey = randomBytes(32);
  private readonly riskEngine: RiskDecisionEngine;

  public constructor(private readonly options: NetworkPreflightServiceOptions) {
    this.environmentTimeoutMs = Math.max(
      1,
      options.environmentTimeoutMs ?? ENVIRONMENT_ASSESSMENT_TIMEOUT_MS,
    );
    this.riskEngine = options.riskEngine ?? new RiskDecisionEngine();
  }

  public get(provider: NetworkProviderId): Promise<NetworkPreflightResult> {
    return this.run({ action: 'background', provider });
  }

  public run(
    input: NetworkPreflightRunInput,
    target?: NetworkPreflightTarget,
    signal?: AbortSignal,
  ): Promise<NetworkPreflightResult> {
    return this.runWithLease(input, target, (result) => result, signal);
  }

  public runWithLease<T>(
    input: NetworkPreflightRequestInput,
    target: NetworkPreflightTarget | undefined,
    operation: (
      result: NetworkPreflightResult,
      leaseContext: NetworkPreflightLeaseContext,
    ) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.runCaptured(this.captureRequest(input, target), operation, signal);
  }

  /** Acquires the exact current route without running probes or depending on cache residency. */
  public async runWithCurrentRouteLease<T>(
    input: NetworkPreflightRunInput,
    target: NetworkPreflightTarget | undefined,
    operation: (
      identity: NetworkPreflightRouteIdentity,
      leaseContext: NetworkPreflightLeaseContext,
    ) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const capture = this.captureRequest(input, target);
    const lease = await this.acquireCallerLease(networkPreflightRequiredScopes(capture), signal);
    let active: ActiveNetworkPreflightLeaseContext | undefined;
    let leaseContext: NetworkPreflightLeaseContext | undefined;
    const generation = this.generation;
    let cleanupCurrentnessError: unknown;
    let operationCompleted = false;
    let result!: T;
    try {
      signal?.throwIfAborted();
      leaseContext = Object.freeze({
        [networkPreflightLeaseContextBrand]: true as const,
      });
      active = {
        active: true,
        capture,
        lease,
        pending: new Set(),
      };
      this.activeLeaseContexts.set(leaseContext, active);
      this.assertRouteCurrent(lease, generation);
      const identity: NetworkPreflightRouteIdentity = Object.freeze({
        action: capture.action,
        ...(capture.canonicalCwd === undefined ? {} : { canonicalCwd: capture.canonicalCwd }),
        configurationRevision: networkRouteRevision(capture.provider, lease, this.revisionKey),
        generation,
        networkScope: capture.networkScope,
        provider: capture.provider,
        ...(capture.target === undefined ? {} : { target: capture.target }),
      });
      signal?.throwIfAborted();
      result = await operation(identity, leaseContext);
      signal?.throwIfAborted();
      this.assertRouteCurrent(lease, generation);
      operationCompleted = true;
    } finally {
      if (active && leaseContext) {
        while (active.pending.size > 0) {
          await Promise.allSettled([...active.pending]);
          if (operationCompleted && cleanupCurrentnessError === undefined) {
            try {
              this.assertRouteCurrent(lease, generation);
            } catch (error: unknown) {
              cleanupCurrentnessError = error;
            }
          }
        }
        active.active = false;
        this.activeLeaseContexts.delete(leaseContext);
      }
      lease.release();
    }
    signal?.throwIfAborted();
    if (cleanupCurrentnessError !== undefined) {
      throw cleanupCurrentnessError;
    }
    this.assertGenerationCurrent(generation);
    return result;
  }

  public runWithExistingLease<T>(
    input: NetworkPreflightRequestInput,
    target: NetworkPreflightTarget | undefined,
    leaseContext: NetworkPreflightLeaseContext,
    operation: (
      result: NetworkPreflightResult,
      activeLeaseContext: NetworkPreflightLeaseContext,
    ) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.withExistingLease(
      input,
      target,
      leaseContext,
      (capture, active) =>
        this.runCapturedWithLease(capture, active.lease, leaseContext, operation, signal),
      signal,
    );
  }

  /** Reuses a live parent route without probing, while retaining its identity and lifetime checks. */
  public runWithExistingRouteLease<T>(
    input: NetworkPreflightRunInput,
    target: NetworkPreflightTarget | undefined,
    leaseContext: NetworkPreflightLeaseContext,
    operation: (activeLeaseContext: NetworkPreflightLeaseContext) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.withExistingLease(
      input,
      target,
      leaseContext,
      async (_capture, active) => {
        const generation = this.generation;
        signal?.throwIfAborted();
        this.assertRouteCurrent(active.lease, generation);
        const result = await operation(leaseContext);
        signal?.throwIfAborted();
        this.assertRouteCurrent(active.lease, generation);
        return result;
      },
      signal,
    );
  }

  private withExistingLease<T>(
    input: NetworkPreflightRequestInput,
    target: NetworkPreflightTarget | undefined,
    leaseContext: NetworkPreflightLeaseContext,
    operation: (
      capture: NetworkPreflightRequestCapture,
      active: ActiveNetworkPreflightLeaseContext,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(abortReasonFor(signal));
    }
    const active = this.activeLeaseContexts.get(leaseContext);
    if (!active?.active) {
      return Promise.reject(
        new NetworkPreflightLeaseContextError('网络预检作用范围上下文已经结束，不能继续复用。'),
      );
    }

    const capture = this.captureRequest(input, target);
    try {
      this.assertComposableCapture(active.capture, capture);
      this.assertLeaseCovers(active.lease, capture);
    } catch (error) {
      return Promise.reject(error);
    }

    const nested = operation(capture, active);
    active.pending.add(nested);
    void nested.then(
      () => active.pending.delete(nested),
      () => active.pending.delete(nested),
    );
    return nested;
  }

  private captureRequest(
    input: NetworkPreflightRequestInput,
    target: NetworkPreflightTarget | undefined,
  ): NetworkPreflightRequestCapture {
    const canonicalCwd = input.cwd === undefined ? undefined : path.resolve(input.cwd);
    const capturedTarget = captureNetworkPreflightTarget(target);
    return Object.freeze({
      action: input.action,
      ...(canonicalCwd === undefined ? {} : { canonicalCwd }),
      force: input.force === true,
      fresh: input.fresh === true,
      networkScope: input.networkScope ?? 'application',
      provider: input.provider,
      ...(capturedTarget === undefined ? {} : { target: capturedTarget }),
    });
  }

  private async runCaptured<T>(
    capture: NetworkPreflightRequestCapture,
    operation: (
      result: NetworkPreflightResult,
      leaseContext: NetworkPreflightLeaseContext,
    ) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const lease = await this.acquireCallerLease(networkPreflightRequiredScopes(capture), signal);
    let active: ActiveNetworkPreflightLeaseContext | undefined;
    let leaseContext: NetworkPreflightLeaseContext | undefined;
    let releaseLease = (): void => lease.release();
    try {
      signal?.throwIfAborted();
      leaseContext = Object.freeze({
        [networkPreflightLeaseContextBrand]: true as const,
      });
      active = {
        active: true,
        capture,
        lease,
        pending: new Set(),
      };
      this.activeLeaseContexts.set(leaseContext, active);
      return await this.runCapturedWithLease(
        capture,
        lease,
        leaseContext,
        operation,
        signal,
        (activeRun, waiter, started) => {
          if (!started) lease.release();
          active!.lease = activeRun.authorityLease;
          releaseLease = () => this.releaseRunWaiter(waiter, false, undefined);
        },
      );
    } finally {
      if (active && leaseContext) {
        while (active.pending.size > 0) {
          await Promise.allSettled([...active.pending]);
        }
        active.active = false;
        this.activeLeaseContexts.delete(leaseContext);
      }
      releaseLease();
    }
  }

  private async runCapturedWithLease<T>(
    capture: NetworkPreflightRequestCapture,
    lease: NetworkPreflightLease,
    leaseContext: NetworkPreflightLeaseContext,
    operation: (
      result: NetworkPreflightResult,
      activeLeaseContext: NetworkPreflightLeaseContext,
    ) => Promise<T> | T,
    signal?: AbortSignal,
    adoptSharedRun?: (
      activeRun: ActiveNetworkPreflightRun,
      waiter: NetworkPreflightRunWaiter,
      started: boolean,
    ) => void,
  ): Promise<T> {
    signal?.throwIfAborted();
    this.assertLeaseCurrent(lease, this.generation);
    const configurationRevision = networkRouteRevision(capture.provider, lease, this.revisionKey);
    const key = networkPreflightCacheKey(capture, {
      canonicalCwd: capture.canonicalCwd,
      configurationRevision,
      networkScope: capture.networkScope,
    });
    this.beginKeyUse(key);
    let borrowedRun: ActiveNetworkPreflightRun | undefined;
    let heldWaiter: NetworkPreflightRunWaiter | undefined;
    try {
      signal?.throwIfAborted();
      if (capture.force || capture.fresh) {
        this.cache.delete(key);
      }
      if (capture.force) {
        const supersedingRunId = this.nextRunId;
        for (const activeRun of this.activeRuns) {
          if (activeRun.key === key) {
            activeRun.controller.abort(
              new NetworkPreflightSupersededError(
                activeRun.identity.generation,
                this.generation,
                activeRun.identity.mainRunId,
                supersedingRunId,
              ),
            );
          }
        }
        signal?.throwIfAborted();
      }
      const existing = this.inFlight.get(key);
      if (!capture.force && existing) {
        const waiter = this.registerRunWaiter(existing);
        if (adoptSharedRun) adoptSharedRun(existing, waiter, false);
        else heldWaiter = waiter;
        const result = await this.waitForRun(waiter, signal);
        signal?.throwIfAborted();
        this.assertCachedCurrent(
          result,
          configurationRevision,
          key,
          adoptSharedRun ? existing.authorityLease : lease,
        );
        return await this.invokeOperation(operation, result, leaseContext, signal);
      }
      const cached = this.cache.get(key)?.result;
      const now = Date.now();
      if (!capture.force && cached?.cacheExpiresAt && cached.cacheExpiresAt > now) {
        signal?.throwIfAborted();
        this.assertCachedCurrent(cached, configurationRevision, key, lease);
        return await this.invokeOperation(
          operation,
          cachedNetworkPreflightEvidence(cached),
          leaseContext,
          signal,
        );
      }

      const generationAtStart = this.generation;
      const runId = this.nextRunId;
      this.nextRunId += 1;
      this.latestRunByKey.set(key, runId);
      const identity: NetworkPreflightIdentity = {
        action: capture.action,
        ...(capture.canonicalCwd === undefined ? {} : { canonicalCwd: capture.canonicalCwd }),
        configurationRevision,
        generation: generationAtStart,
        mainRunId: runId,
        networkScope: capture.networkScope,
      };
      const activeRun = this.startRun(
        capture,
        identity,
        key,
        now,
        lease,
        adoptSharedRun !== undefined,
      );
      const waiter = this.registerRunWaiter(activeRun);
      if (adoptSharedRun) adoptSharedRun(activeRun, waiter, true);
      else {
        borrowedRun = activeRun;
        heldWaiter = waiter;
        const authorityOwner = this.activeLeaseContexts.get(leaseContext);
        if (authorityOwner?.active) {
          authorityOwner.pending.add(activeRun.authorityDrain);
          void activeRun.authorityDrain.then(() => {
            authorityOwner.pending.delete(activeRun.authorityDrain);
          });
        }
      }
      const result = await this.waitForRun(waiter, signal);
      signal?.throwIfAborted();
      this.assertRunCurrent(identity, key, lease);
      return await this.invokeOperation(operation, result, leaseContext, signal);
    } finally {
      if (heldWaiter) this.releaseRunWaiter(heldWaiter, false, undefined);
      if (borrowedRun && !borrowedRun.settled) {
        await borrowedRun.promise.then(
          () => undefined,
          () => undefined,
        );
      }
      this.endKeyUse(key);
    }
  }

  private acquireCallerLease(
    scopes: NetworkPreflightScope | readonly NetworkPreflightScope[],
    signal?: AbortSignal,
  ): Promise<NetworkPreflightLease> {
    if (signal?.aborted) {
      return Promise.reject(abortReasonFor(signal));
    }
    let acquisition: Promise<NetworkPreflightLease>;
    try {
      acquisition = this.options.acquireNetworkLease(scopes);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    if (!signal) return acquisition;

    return new Promise<NetworkPreflightLease>((resolve, reject) => {
      let settled = false;
      const stopListening = (): void => signal.removeEventListener('abort', onAbort);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        stopListening();
        reject(abortReasonFor(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void acquisition.then(
        (lease) => {
          if (settled) {
            lease.release();
            return;
          }
          settled = true;
          stopListening();
          resolve(lease);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          stopListening();
          reject(error);
        },
      );
      if (signal.aborted) onAbort();
    });
  }

  private startRun(
    capture: NetworkPreflightRequestCapture,
    identity: NetworkPreflightIdentity,
    key: string,
    startedAt: number,
    authorityLease: NetworkPreflightLease,
    authorityOwned: boolean,
  ): ActiveNetworkPreflightRun {
    const controller = new AbortController();
    let resolveAuthorityDrain!: () => void;
    const authorityDrain = new Promise<void>((resolve) => {
      resolveAuthorityDrain = resolve;
    });
    const activeRunReference = {} as { current: ActiveNetworkPreflightRun };
    const promise = this.executeRunWithAuthorityLease(
      capture,
      identity,
      key,
      authorityLease,
      startedAt,
      controller.signal,
    ).finally(() => {
      const activeRun = activeRunReference.current;
      activeRun.settled = true;
      this.activeRuns.delete(activeRun);
      if (this.inFlight.get(key) === activeRun) {
        this.inFlight.delete(key);
      }
      this.releaseRunAuthorityIfReady(activeRun);
    });
    const activeRun = {
      authorityDrain,
      authorityLease,
      authorityOwned,
      authorityReleased: false,
      controller,
      identity,
      key,
      promise,
      resolveAuthorityDrain,
      settled: false,
      waiters: 0,
    };
    activeRunReference.current = activeRun;
    this.activeRuns.add(activeRun);
    this.inFlight.set(key, activeRun);
    void promise.catch(() => undefined);
    return activeRun;
  }

  private async executeRunWithAuthorityLease(
    capture: NetworkPreflightRequestCapture,
    identity: NetworkPreflightIdentity,
    key: string,
    lease: NetworkPreflightLease,
    startedAt: number,
    signal: AbortSignal,
  ): Promise<NetworkPreflightResult> {
    try {
      signal.throwIfAborted();
      const authorityRevision = networkRouteRevision(capture.provider, lease, this.revisionKey);
      if (authorityRevision !== identity.configurationRevision) {
        throw new NetworkPreflightSupersededError(
          identity.generation,
          this.generation,
          identity.mainRunId,
          this.latestRunByKey.get(key),
        );
      }
      return await this.executeRun(capture, identity, key, lease, startedAt, signal);
    } catch (error: unknown) {
      const cached = this.cache.get(key)?.result;
      if (signal.aborted && cached?.mainRunId === identity.mainRunId) {
        this.cache.delete(key);
      }
      throw error;
    }
  }

  private registerRunWaiter(activeRun: ActiveNetworkPreflightRun): NetworkPreflightRunWaiter {
    activeRun.waiters += 1;
    return { activeRun, released: false };
  }

  private waitForRun(
    waiter: NetworkPreflightRunWaiter,
    signal?: AbortSignal,
  ): Promise<NetworkPreflightResult> {
    if (signal?.aborted) {
      const reason = abortReasonFor(signal);
      const waitForCleanup = this.releaseRunWaiter(waiter, true, reason);
      return waitForCleanup
        ? waiter.activeRun.authorityDrain.then(() => Promise.reject(reason))
        : Promise.reject(reason);
    }
    const { activeRun } = waiter;

    return new Promise<NetworkPreflightResult>((resolve, reject) => {
      let finished = false;
      const finish = (
        outcome:
          | { readonly error: unknown; readonly ok: false }
          | {
              readonly ok: true;
              readonly result: NetworkPreflightResult;
            },
        cancelled: boolean,
      ): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        if (!outcome.ok) {
          const waitForCleanup = this.releaseRunWaiter(waiter, cancelled, outcome.error);
          if (waitForCleanup) {
            void activeRun.authorityDrain.then(() => reject(outcome.error));
          } else {
            reject(outcome.error);
          }
          return;
        }
        resolve(outcome.result);
      };
      const onAbort = (): void => {
        if (!signal) return;
        finish({ error: abortReasonFor(signal), ok: false }, true);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      void activeRun.promise.then(
        (result) => finish({ ok: true, result }, false),
        (error: unknown) => finish({ error, ok: false }, false),
      );
      if (signal?.aborted) onAbort();
    });
  }

  private releaseRunWaiter(
    waiter: NetworkPreflightRunWaiter,
    cancelled: boolean,
    reason: unknown,
  ): boolean {
    if (waiter.released) return false;
    waiter.released = true;
    const { activeRun } = waiter;
    const waitForCleanup = cancelled && activeRun.waiters === 1 && !activeRun.settled;
    activeRun.waiters = Math.max(0, activeRun.waiters - 1);
    if (waitForCleanup) {
      if (this.inFlight.get(activeRun.key) === activeRun) {
        this.inFlight.delete(activeRun.key);
      }
      activeRun.controller.abort(reason);
    }
    this.releaseRunAuthorityIfReady(activeRun);
    return waitForCleanup;
  }

  private releaseRunAuthorityIfReady(activeRun: ActiveNetworkPreflightRun): void {
    if (activeRun.authorityReleased || !activeRun.settled || activeRun.waiters > 0) return;
    activeRun.authorityReleased = true;
    if (activeRun.authorityOwned) activeRun.authorityLease.release();
    activeRun.resolveAuthorityDrain();
  }

  private async invokeOperation<T>(
    operation: (
      result: NetworkPreflightResult,
      activeLeaseContext: NetworkPreflightLeaseContext,
    ) => Promise<T> | T,
    result: NetworkPreflightResult,
    leaseContext: NetworkPreflightLeaseContext,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const value = await operation(result, leaseContext);
    signal?.throwIfAborted();
    return value;
  }

  private async executeRun(
    capture: NetworkPreflightRequestCapture,
    identity: NetworkPreflightIdentity,
    key: string,
    lease: NetworkPreflightLease,
    startedAt: number,
    signal: AbortSignal,
  ): Promise<NetworkPreflightResult> {
    signal.throwIfAborted();
    this.assertRunCurrent(identity, key, lease);
    this.bestEffort('testing-notification', () => {
      this.options.onResult?.(networkPreflightTestingResult(capture.provider, identity, startedAt));
    });
    signal.throwIfAborted();
    this.assertRunCurrent(identity, key, lease);

    const probeOutcome = await this.runProbe(capture, signal).then(
      (observation) => ({ observation, ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    signal.throwIfAborted();
    this.assertRunCurrent(identity, key, lease);

    let cacheable = false;
    let result: NetworkPreflightResult;
    if (probeOutcome.ok) {
      try {
        const checkedAt = Date.now();
        result = {
          ...this.riskEngine.evaluate(
            capture.provider,
            capture.action,
            probeOutcome.observation,
            startedAt,
            checkedAt,
          ),
          ...identity,
        };
        cacheable = true;
      } catch (error: unknown) {
        result = networkPreflightInternalFailureResult(
          capture.provider,
          identity,
          startedAt,
          error,
        );
      }
    } else {
      result = networkPreflightInternalFailureResult(
        capture.provider,
        identity,
        startedAt,
        probeOutcome.error,
      );
    }

    signal.throwIfAborted();
    this.assertRunCurrent(identity, key, lease);
    if (cacheable) {
      this.cache.set(key, { result });
    } else {
      this.cache.delete(key);
    }
    signal.throwIfAborted();
    this.assertRunCurrent(identity, key, lease);

    this.bestEffort('diagnostics-persistence', () => {
      this.options.diagnosticsStore.append(result);
    });
    signal.throwIfAborted();
    this.assertRunCurrent(identity, key, lease);

    this.bestEffort('result-notification', () => {
      this.options.onResult?.(result);
    });
    signal.throwIfAborted();
    this.assertRunCurrent(identity, key, lease);
    return result;
  }

  private async collectEnvironmentAssessment(
    environmentProbe: NonNullable<NetworkPreflightServiceOptions['environmentProbe']>,
    signal: AbortSignal,
  ): Promise<ConnectivityObservation['environment']> {
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort(abortReasonFor(signal));
    if (signal.aborted) onParentAbort();
    else signal.addEventListener('abort', onParentAbort, { once: true });

    const timeoutError = new DOMException('网络环境建议证据收集超时。', 'TimeoutError');
    const timer = setTimeout(() => controller.abort(timeoutError), this.environmentTimeoutMs);
    timer.unref?.();
    let onCollectionAbort: (() => void) | undefined;
    const collectionAborted = new Promise<never>((_resolve, reject) => {
      onCollectionAbort = (): void => reject(abortReasonFor(controller.signal));
      if (controller.signal.aborted) onCollectionAbort();
      else controller.signal.addEventListener('abort', onCollectionAbort, { once: true });
    });
    const collection = Promise.resolve().then(() => environmentProbe.run(controller.signal));

    try {
      return await Promise.race([collection, collectionAborted]);
    } catch (error: unknown) {
      signal.throwIfAborted();
      return networkPreflightUnavailableEnvironmentAssessment(error);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
      if (onCollectionAbort) {
        controller.signal.removeEventListener('abort', onCollectionAbort);
      }
    }
  }

  private async runProbe(
    capture: NetworkPreflightRequestCapture,
    signal: AbortSignal,
  ): Promise<ConnectivityObservation> {
    const connectivity = this.options.probe.run(
      capture.provider,
      capture.action,
      this.options.probeWorkingDirectory ?? homedir(),
      capture.networkScope,
      capture.target,
      signal,
    );
    const input: NetworkPreflightRunInput = {
      action: capture.action,
      ...(capture.canonicalCwd ? { cwd: capture.canonicalCwd } : {}),
      force: capture.force,
      networkScope: capture.networkScope,
      provider: capture.provider,
    };
    const environmentProbe = this.options.environmentProbe;
    if (!environmentProbe || !this.options.shouldAssessEnvironment?.(input)) {
      return connectivity;
    }
    const environment = this.collectEnvironmentAssessment(environmentProbe, signal);
    const [observation, environmentAssessment] = await Promise.all([connectivity, environment]);
    signal.throwIfAborted();
    return environmentAssessment
      ? { ...observation, environment: environmentAssessment }
      : observation;
  }

  private beginKeyUse(key: string): void {
    this.activeUsesByKey.set(key, (this.activeUsesByKey.get(key) ?? 0) + 1);
    this.retainedKeys.delete(key);
    this.retainedKeys.set(key, undefined);
    this.pruneRetainedKeys();
  }

  private endKeyUse(key: string): void {
    const remaining = (this.activeUsesByKey.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.activeUsesByKey.set(key, remaining);
    } else {
      this.activeUsesByKey.delete(key);
    }
    this.pruneRetainedKeys();
  }

  private pruneRetainedKeys(): void {
    const now = Date.now();
    for (const key of this.retainedKeys.keys()) {
      if ((this.activeUsesByKey.get(key) ?? 0) > 0 || this.inFlight.has(key)) {
        continue;
      }
      const cached = this.cache.get(key)?.result;
      const expired = cached?.cacheExpiresAt !== undefined && cached.cacheExpiresAt <= now;
      if (!this.latestRunByKey.has(key) || expired) {
        this.deleteRetainedKey(key);
      }
    }

    while (this.retainedKeys.size > MAX_RETAINED_PREFLIGHT_KEYS) {
      let removed = false;
      for (const key of this.retainedKeys.keys()) {
        if ((this.activeUsesByKey.get(key) ?? 0) > 0 || this.inFlight.has(key)) {
          continue;
        }
        this.deleteRetainedKey(key);
        removed = true;
        break;
      }
      if (!removed) {
        break;
      }
    }
  }

  private deleteRetainedKey(key: string): void {
    this.cache.delete(key);
    this.latestRunByKey.delete(key);
    this.retainedKeys.delete(key);
  }

  private assertComposableCapture(
    outer: NetworkPreflightRequestCapture,
    nested: NetworkPreflightRequestCapture,
  ): void {
    if (
      outer.provider !== nested.provider ||
      outer.networkScope !== nested.networkScope ||
      networkPreflightCwdCacheKey(outer.canonicalCwd) !==
        networkPreflightCwdCacheKey(nested.canonicalCwd) ||
      !sameNetworkPreflightTarget(outer.target, nested.target)
    ) {
      throw new NetworkPreflightLeaseContextError(
        '嵌套网络操作与当前预检的服务商、项目或网络作用范围不一致。',
      );
    }
  }

  private assertLeaseCovers(
    lease: NetworkPreflightLease,
    capture: NetworkPreflightRequestCapture,
  ): void {
    const required = networkPreflightRequiredScopes(capture);
    if (required.some((scope) => !lease.scopes.includes(scope))) {
      throw new NetworkPreflightLeaseContextError('当前网络预检作用范围不能覆盖嵌套网络操作。');
    }
    lease.assertCurrent();
  }

  private assertLeaseCurrent(
    lease: NetworkPreflightLease,
    startedGeneration: number,
    startedRunId?: number,
    currentRunId?: number,
  ): void {
    try {
      lease.assertCurrent();
    } catch (error: unknown) {
      throw new NetworkPreflightSupersededError(
        startedGeneration,
        this.generation,
        startedRunId,
        currentRunId,
        error,
      );
    }
  }

  private assertGenerationCurrent(startedGeneration: number): void {
    if (startedGeneration !== this.generation) {
      throw new NetworkPreflightSupersededError(startedGeneration, this.generation);
    }
  }

  private assertRouteCurrent(lease: NetworkPreflightLease, startedGeneration: number): void {
    this.assertLeaseCurrent(lease, startedGeneration);
    this.assertGenerationCurrent(startedGeneration);
  }

  private assertCachedCurrent(
    cached: NetworkPreflightResult,
    configurationRevision: string,
    key: string,
    lease: NetworkPreflightLease,
  ): void {
    const currentRunId = this.latestRunByKey.get(key);
    this.assertLeaseCurrent(lease, cached.generation, cached.mainRunId, currentRunId);
    if (
      cached.generation !== this.generation ||
      cached.configurationRevision !== configurationRevision ||
      currentRunId !== cached.mainRunId
    ) {
      throw new NetworkPreflightSupersededError(
        cached.generation,
        this.generation,
        cached.mainRunId,
        currentRunId,
      );
    }
  }

  private assertRunCurrent(
    identity: NetworkPreflightIdentity,
    key: string,
    lease: NetworkPreflightLease,
  ): void {
    const currentRunId = this.latestRunByKey.get(key);
    this.assertLeaseCurrent(lease, identity.generation, identity.mainRunId, currentRunId);
    if (identity.generation !== this.generation || currentRunId !== identity.mainRunId) {
      throw new NetworkPreflightSupersededError(
        identity.generation,
        this.generation,
        identity.mainRunId,
        currentRunId,
      );
    }
  }

  private bestEffort(phase: NetworkPreflightObservabilityPhase, operation: () => void): void {
    try {
      operation();
    } catch (error: unknown) {
      try {
        this.options.onObservabilityError?.(phase, error);
      } catch {
        // Observability must never replace the authoritative network verdict with its own failure.
      }
    }
  }

  public invalidate(_reason: string): void {
    this.generation += 1;
    this.cache.clear();
    this.latestRunByKey.clear();
    this.retainedKeys.clear();
    /*
     * In-flight work started under the superseded configuration must stop being shared. Dropping
     * the map forces later callers onto a fresh probe, while aborting every older authoritative run
     * releases its network resources and leases without allowing it to publish an obsolete verdict.
     */
    this.inFlight.clear();
    for (const activeRun of this.activeRuns) {
      if (activeRun.identity.generation < this.generation) {
        activeRun.controller.abort(
          new NetworkPreflightSupersededError(
            activeRun.identity.generation,
            this.generation,
            activeRun.identity.mainRunId,
            undefined,
          ),
        );
      }
    }
  }

  public getHistory(): NetworkPreflightHistoryView {
    return this.options.diagnosticsStore.getView();
  }

  public clearHistory(): NetworkPreflightHistoryView {
    return this.options.diagnosticsStore.clear();
  }
}
