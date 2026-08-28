import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type {
  NetworkPreflightAction,
  NetworkPreflightResult,
  NetworkPreflightScope,
  NetworkProviderId,
} from '../../shared/contracts';
import {
  type NetworkPreflightLeaseContext,
  type NetworkPreflightRouteIdentity,
  NetworkPreflightService,
  NetworkPreflightSupersededError,
} from './preflight-service';
import { captureNetworkPreflightTarget, type NetworkPreflightTarget } from './preflight-target';

export interface ProviderAccessRequest {
  readonly action: NetworkPreflightAction;
  readonly cwd?: string;
  readonly networkScope?: NetworkPreflightScope;
  readonly provider: NetworkProviderId;
  readonly target?: NetworkPreflightTarget;
}

const providerAccessBlockedCaptureBrand: unique symbol = Symbol('provider-access-blocked-capture');

/** Main-only immutable authorization identity. This type is intentionally not exported by shared IPC. */
export interface ProviderAccessBlockedCapture {
  readonly action: NetworkPreflightAction;
  readonly canonicalCwd?: string;
  readonly configurationRevision: string;
  readonly generation: number;
  readonly mainRunId: number;
  readonly networkScope: NetworkPreflightScope;
  readonly provider: NetworkProviderId;
  readonly target?: Readonly<NetworkPreflightTarget>;
  readonly [providerAccessBlockedCaptureBrand]: true;
}

interface ProviderAccessOperationScope {
  active: boolean;
  readonly leaseContext: NetworkPreflightLeaseContext;
  settled: boolean;
}

type PromiseLikeThen = (...arguments_: unknown[]) => unknown;

const abortReasonFor = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('This operation was aborted', 'AbortError');

const settleOperationScope = (scope: ProviderAccessOperationScope): void => {
  scope.settled = true;
  scope.active = false;
};

const promiseLikeThenFor = (value: unknown): unknown =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? (value as { readonly then?: unknown }).then
    : undefined;

const waitForInheritedSettlementCheckpoint = (): Promise<void> =>
  new Promise((resolve) => {
    // Native Promise resolvers are not observable synchronously. A next-turn check lets every
    // settlement/adoption job already queued by the inherited branch revoke its capability first.
    setImmediate(resolve);
  });

const assimilateOperationResult = <T>(
  scope: ProviderAccessOperationScope,
  initialValue: unknown,
  initialThen: PromiseLikeThen,
): Promise<T> => {
  const adoptedThenables = new WeakSet<object>();
  let completed = false;
  const settlementPromise = new Promise<T>((resolve, reject) => {
    const finishRejected = (reason: unknown): void => {
      if (completed) return;
      completed = true;
      // Revoke before forwarding the terminal signal. Promise reactions run later and are too late
      // to stop same-stack reentry from a hostile thenable.
      settleOperationScope(scope);
      reject(reason);
    };

    const finishFulfilled = (value: unknown): void => {
      if (completed) return;
      completed = true;
      settleOperationScope(scope);
      resolve(value as T);
    };

    const resolveValue = (value: unknown): void => {
      if (completed) return;
      if (value === settlementPromise) {
        finishRejected(new TypeError('PromiseLike 不能解析为自身。'));
        return;
      }

      if (
        ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
        adoptedThenables.has(value)
      ) {
        finishRejected(new TypeError('PromiseLike 解析链包含循环。'));
        return;
      }

      let then: unknown;
      try {
        then = promiseLikeThenFor(value);
      } catch (error: unknown) {
        finishRejected(error);
        return;
      }
      if (typeof then === 'function') {
        adopt(value, then as PromiseLikeThen);
        return;
      }
      finishFulfilled(value);
    };

    const adopt = (value: unknown, then: PromiseLikeThen): void => {
      if (completed) return;
      if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
        if (adoptedThenables.has(value)) {
          finishRejected(new TypeError('PromiseLike 解析链包含循环。'));
          return;
        }
        adoptedThenables.add(value);
      }

      let called = false;
      queueMicrotask(() => {
        if (completed) return;
        try {
          Reflect.apply(then, value, [
            (resolvedValue: unknown): void => {
              if (called) return;
              called = true;
              resolveValue(resolvedValue);
            },
            (reason: unknown): void => {
              if (called) return;
              called = true;
              finishRejected(reason);
            },
          ]);
        } catch (error: unknown) {
          if (called) return;
          called = true;
          finishRejected(error);
        }
      });
    };

    adopt(initialValue, initialThen);
  });

  return settlementPromise;
};

export class ProviderAccessContextExpiredError extends Error {
  public constructor() {
    super('官方网络访问上下文已经结束，不能在未等待的后续任务中继续使用。');
    this.name = 'ProviderAccessContextExpiredError';
  }
}

const blockedCapture = (
  result: NetworkPreflightResult,
  target: Readonly<NetworkPreflightTarget> | undefined,
): ProviderAccessBlockedCapture =>
  Object.freeze({
    action: result.action,
    ...(result.canonicalCwd === undefined ? {} : { canonicalCwd: result.canonicalCwd }),
    configurationRevision: result.configurationRevision,
    generation: result.generation,
    mainRunId: result.mainRunId,
    networkScope: result.networkScope,
    provider: result.provider,
    ...(target === undefined ? {} : { target }),
    [providerAccessBlockedCaptureBrand]: true as const,
  });

export class ProviderAccessBlockedError extends Error {
  public readonly capture: ProviderAccessBlockedCapture;

  public constructor(
    public readonly result: NetworkPreflightResult,
    target?: Readonly<NetworkPreflightTarget>,
  ) {
    const { featureAccess, reasons, summary } = result.providerConnectivity;
    const deniedReason = featureAccess.find(
      (access) => access.action === result.action && !access.allowed,
    )?.reason;
    const recommendation = reasons.find((reason) => reason.startsWith('建议：'));
    const detailParts = [
      summary,
      ...(deniedReason && deniedReason !== summary ? [`当前操作仍被阻止：${deniedReason}`] : []),
      ...[reasons[0], recommendation].filter(
        (reason, index, candidates): reason is string =>
          Boolean(reason) && reason !== summary && candidates.indexOf(reason) === index,
      ),
    ];
    super(`${detailParts.join(' ')} 请在网络预检详情中重新检查。`);
    this.name = 'ProviderAccessBlockedError';
    this.capture = blockedCapture(result, target);
  }
}

const exactBlockedRouteIdentity = (
  capture: ProviderAccessBlockedCapture,
  identity: NetworkPreflightRouteIdentity,
): boolean =>
  identity.action === capture.action &&
  identity.provider === capture.provider &&
  identity.canonicalCwd === capture.canonicalCwd &&
  identity.networkScope === capture.networkScope &&
  identity.configurationRevision === capture.configurationRevision &&
  identity.target?.process === capture.target?.process &&
  identity.target?.url === capture.target?.url;

const TRANSIENT_RETRY_ACTIONS = new Set<NetworkPreflightAction>([
  'cli-launch',
  'first-request',
  'login',
  'provider-switch',
]);
const TRANSIENT_FAILURE_PATTERN =
  /连接超时|DNS 解析失败|连接失败|\bHTTP 5\d{2}\b|timed?\s*out|ENOTFOUND|ECONNRESET/i;

const transientNetworkBlock = (result: NetworkPreflightResult): boolean => {
  const connectivity = result.providerConnectivity;
  if (!TRANSIENT_RETRY_ACTIONS.has(result.action) || connectivity.status !== 'blocked')
    return false;
  if (
    connectivity.signals.some(
      ({ id }) =>
        id.startsWith('tls-invalid:') ||
        id.startsWith('unexpected-redirect:') ||
        id.startsWith('captive-portal:') ||
        id === 'preflight-internal-failure',
    )
  ) {
    return false;
  }
  const requiredFailures = connectivity.probes.filter(
    (probe) => probe.required && probe.status === 'failed',
  );
  return (
    requiredFailures.length > 0 &&
    requiredFailures.every(({ detail }) => TRANSIENT_FAILURE_PATTERN.test(detail))
  );
};

const waitForTransientRetry = (signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(abortReasonFor(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, 150);
    timer.unref();
    function finish(): void {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortReasonFor(signal!));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
};

export class ProviderAccessGuard {
  private readonly operationScope = new AsyncLocalStorage<ProviderAccessOperationScope>();

  public constructor(
    private readonly service: NetworkPreflightService,
    private readonly forceFreshCheck: (request: ProviderAccessRequest) => boolean = () => false,
    private readonly shouldCheck: (request: ProviderAccessRequest) => boolean = () => true,
  ) {}

  public async withAllowed<T>(
    request: ProviderAccessRequest,
    operation: (result: NetworkPreflightResult | undefined) => PromiseLike<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const parentScope = this.operationScope.getStore();
    if (parentScope && !parentScope.active) {
      throw new ProviderAccessContextExpiredError();
    }

    const capturedTarget = captureNetworkPreflightTarget(request.target);
    const canonicalCwd = request.cwd === undefined ? undefined : path.resolve(request.cwd);
    const input = Object.freeze({
      action: request.action,
      ...(canonicalCwd === undefined ? {} : { cwd: canonicalCwd }),
      ...(this.forceFreshCheck(request) ? { fresh: true } : {}),
      ...(request.networkScope === undefined ? {} : { networkScope: request.networkScope }),
      provider: request.provider,
    });
    const policyRequest: ProviderAccessRequest = Object.freeze({
      ...input,
      ...(capturedTarget === undefined ? {} : { target: capturedTarget }),
    });

    if (parentScope) {
      await waitForInheritedSettlementCheckpoint();
      signal?.throwIfAborted();
      if (!parentScope.active) {
        throw new ProviderAccessContextExpiredError();
      }
    }

    let supersededRetries = 0;
    let transientRetries = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal?.throwIfAborted();
      let operationStarted = false;
      try {
        const enterOperation = (
          leaseContext: NetworkPreflightLeaseContext,
          result?: NetworkPreflightResult,
        ): Promise<T> | T => {
          signal?.throwIfAborted();
          if (parentScope && !parentScope.active) {
            throw new ProviderAccessContextExpiredError();
          }
          return this.runOperation(
            leaseContext,
            () => {
              operationStarted = true;
              return operation(result);
            },
            signal,
          );
        };
        if (!this.shouldCheck(policyRequest)) {
          // Disabling automatic diagnostics does not disable route ownership, cancellation or TLS.
          // No synthetic successful preflight result is created, cached, recorded or broadcast.
          return parentScope
            ? await this.service.runWithExistingRouteLease(
                input,
                capturedTarget,
                parentScope.leaseContext,
                (leaseContext) => enterOperation(leaseContext),
                signal,
              )
            : await this.service.runWithCurrentRouteLease(
                input,
                capturedTarget,
                (_identity, leaseContext) => enterOperation(leaseContext),
                signal,
              );
        }
        const attemptInput = transientRetries > 0 ? { ...input, fresh: true } : input;
        const run = parentScope
          ? <TResult>(
              guardedOperation: (
                result: NetworkPreflightResult,
                leaseContext: NetworkPreflightLeaseContext,
              ) => Promise<TResult> | TResult,
            ): Promise<TResult> =>
              this.service.runWithExistingLease(
                attemptInput,
                capturedTarget,
                parentScope.leaseContext,
                guardedOperation,
                signal,
              )
          : <TResult>(
              guardedOperation: (
                result: NetworkPreflightResult,
                leaseContext: NetworkPreflightLeaseContext,
              ) => Promise<TResult> | TResult,
            ): Promise<TResult> =>
              this.service.runWithLease(attemptInput, capturedTarget, guardedOperation, signal);
        return await run(async (result, leaseContext) => {
          signal?.throwIfAborted();
          if (parentScope && !parentScope.active) {
            throw new ProviderAccessContextExpiredError();
          }
          const connectivity = result.providerConnectivity;
          const access = connectivity.featureAccess.find(
            (candidate) => candidate.action === attemptInput.action,
          );
          if (!access?.allowed || connectivity.status === 'blocked') {
            throw new ProviderAccessBlockedError(result, capturedTarget);
          }
          return enterOperation(leaseContext, result);
        });
      } catch (error: unknown) {
        if (
          supersededRetries === 0 &&
          !operationStarted &&
          error instanceof NetworkPreflightSupersededError
        ) {
          supersededRetries += 1;
          continue;
        }
        if (
          transientRetries === 0 &&
          !operationStarted &&
          error instanceof ProviderAccessBlockedError &&
          transientNetworkBlock(error.result)
        ) {
          transientRetries += 1;
          await waitForTransientRetry(signal);
          continue;
        }
        throw error;
      }
    }
    throw new Error('网络预检未能在当前配置下完成。');
  }

  /** Forces a new authoritative check and runs the continuation inside its newly acquired lease. */
  public recheck<T>(
    capture: ProviderAccessBlockedCapture,
    operation: (result: NetworkPreflightResult) => PromiseLike<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const input = {
      action: capture.action,
      ...(capture.canonicalCwd === undefined ? {} : { cwd: capture.canonicalCwd }),
      force: true,
      networkScope: capture.networkScope,
      provider: capture.provider,
    } as const;
    return this.service.runWithCurrentRouteLease(
      input,
      capture.target,
      async (identity, leaseContext) => {
        signal?.throwIfAborted();
        if (!exactBlockedRouteIdentity(capture, identity)) {
          throw new ProviderAccessBypassStaleError();
        }
        return this.service.runWithExistingLease(
          input,
          capture.target,
          leaseContext,
          async (result, activeLeaseContext) => {
            signal?.throwIfAborted();
            const connectivity = result.providerConnectivity;
            const access = connectivity.featureAccess.find(
              (candidate) => candidate.action === capture.action,
            );
            if (!access?.allowed || connectivity.status === 'blocked') {
              throw new ProviderAccessBlockedError(result, capture.target);
            }
            return this.runOperation(activeLeaseContext, () => operation(result), signal);
          },
          signal,
        );
      },
      signal,
    );
  }

  /**
   * Reacquires the exact blocked route and skips only its negative verdict. The caller's callback is
   * invoked after every identity check and immediately before operation entry.
   */
  public bypass<T>(
    capture: ProviderAccessBlockedCapture,
    beforeOperationEntry: () => void,
    operation: () => PromiseLike<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    return this.service.runWithCurrentRouteLease(
      {
        action: capture.action,
        ...(capture.canonicalCwd === undefined ? {} : { cwd: capture.canonicalCwd }),
        networkScope: capture.networkScope,
        provider: capture.provider,
      },
      capture.target,
      async (identity, leaseContext) => {
        signal?.throwIfAborted();
        if (!exactBlockedRouteIdentity(capture, identity)) {
          throw new ProviderAccessBypassStaleError();
        }
        signal?.throwIfAborted();
        beforeOperationEntry();
        signal?.throwIfAborted();
        return this.runOperation(leaseContext, operation, signal);
      },
      signal,
    );
  }

  private runOperation<T>(
    leaseContext: NetworkPreflightLeaseContext,
    operation: () => PromiseLike<T> | T,
    signal?: AbortSignal,
  ): Promise<T> | T {
    const scope: ProviderAccessOperationScope = {
      active: true,
      leaseContext,
      settled: false,
    };
    let aborted = false;
    let abortReason: unknown;
    const onAbort = (): void => {
      if (aborted || scope.settled) return;
      aborted = true;
      abortReason = signal ? abortReasonFor(signal) : undefined;
      // Cancellation stops admitting inherited work immediately, but the real route lease remains
      // held until the already-started callback and every adopted PromiseLike have unwound.
      scope.active = false;
    };
    const stopListening = (): void => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (aborted) {
      settleOperationScope(scope);
      stopListening();
      throw abortReason;
    }

    return this.operationScope.run(scope, () => {
      let operationResult: PromiseLike<T> | T;
      try {
        operationResult = operation();
      } catch (error: unknown) {
        settleOperationScope(scope);
        stopListening();
        if (aborted) throw abortReason;
        throw error;
      }

      let then: unknown;
      try {
        then = promiseLikeThenFor(operationResult);
      } catch (error: unknown) {
        settleOperationScope(scope);
        stopListening();
        if (aborted) throw abortReason;
        throw error;
      }
      if (typeof then === 'function') {
        // The captured accessor is invoked exactly once and asynchronously. Its accepted settlement
        // branch owns revocation, including recursively adopted PromiseLike values.
        return assimilateOperationResult<T>(scope, operationResult, then as PromiseLikeThen).then(
          (value) => {
            stopListening();
            if (aborted) throw abortReason;
            return value;
          },
          (error: unknown) => {
            stopListening();
            if (aborted) throw abortReason;
            throw error;
          },
        );
      }
      // Plain synchronous callbacks expire before their queued microtasks can inherit live authority.
      settleOperationScope(scope);
      stopListening();
      if (aborted) throw abortReason;
      return operationResult as T;
    });
  }
}

export class ProviderAccessBypassStaleError extends Error {
  public constructor() {
    super('网络路由或预检身份已更新，原有一次性授权不能继续使用。');
    this.name = 'ProviderAccessBypassStaleError';
  }
}
