import { randomUUID } from 'node:crypto';
import type {
  SaveClaudeConfigInput,
  SubscriptionResult,
  SubscriptionState,
} from '../../shared/contracts';
import type { SubscriptionProvider } from '../../shared/claude/subscriptions';
import type { ClaudeRuntime } from '../claude/runtime';
import type { BusyRegistry } from '../coordination/busy-registry';
import { subscriptionEndpoints } from './catalog';
import { safeSubscriptionMessage, SubscriptionError, type AuthContext } from './http';
import { authorizeSubscription } from './oauth';
import type { SubscriptionRelay, SubscriptionNetwork } from './relay';

interface SetupOperation {
  provider: SubscriptionProvider;
  id: string;
  controller: AbortController;
  promise: Promise<SubscriptionResult>;
}

export interface SubscriptionServiceDependencies {
  assertAllowed: () => void;
  runtime: () => Pick<
    ClaudeRuntime,
    | 'reserveNextConversationConnection'
    | 'getSoftwareUpdates'
    | 'installOrUpdateClaudeCode'
    | 'verifyAndSaveNextConversationConfig'
  >;
  relay: SubscriptionRelay;
  authNetwork: SubscriptionNetwork;
  busyRegistry: BusyRegistry;
  open: AuthContext['open'];
  publish: (state: SubscriptionState) => void;
  authorize?: typeof authorizeSubscription;
}

/** One transaction owns provider choice, browser authorization, real test and the final commit. */
export class SubscriptionService {
  private state: SubscriptionState = {
    revision: 0,
    busy: false,
    cancellable: false,
    phase: 'idle',
    message: '',
  };
  private operation: SetupOperation | undefined;
  private closed = false;

  public constructor(private readonly deps: SubscriptionServiceDependencies) {}

  public getState(): SubscriptionState {
    return { ...this.state };
  }
  public ensureRunning(): Promise<void> {
    return this.deps.relay.ensureRunning();
  }

  private publish(update: Partial<SubscriptionState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    // A renderer teardown must not turn a committed configuration into a reported failure.
    try {
      this.deps.publish(this.getState());
    } catch {
      /* Main remains the source of truth. */
    }
  }

  public setup(provider: SubscriptionProvider): Promise<SubscriptionResult> {
    if (this.closed)
      return Promise.resolve({ ok: false, state: this.getState(), message: '应用正在退出。' });
    if (this.operation) {
      return this.operation.provider === provider
        ? this.operation.promise
        : Promise.resolve({
            ok: false,
            state: this.getState(),
            message: '请先完成或取消当前订阅登录。',
          });
    }
    const controller = new AbortController();
    const id = randomUUID();
    const promise = Promise.resolve()
      .then(() => this.perform(provider, id, controller.signal))
      .finally(() => {
        if (this.operation?.id === id) this.operation = undefined;
      });
    this.operation = { id, provider, controller, promise };
    this.publish({
      attempt: id,
      provider,
      phase: 'preparing',
      busy: true,
      cancellable: false,
      message: '正在准备…',
      userCode: undefined,
    });
    return promise;
  }

  private async perform(
    provider: SubscriptionProvider,
    id: string,
    cancellation: AbortSignal,
  ): Promise<SubscriptionResult> {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(12 * 60_000)]);
    let releaseConnection: (() => void) | undefined;
    let releaseBusy: (() => void) | undefined;
    let candidateId: string | undefined;
    const assertCurrent = (): void => {
      signal.throwIfAborted();
      if (this.closed || this.operation?.id !== id) throw new SubscriptionError('订阅连接已取消。');
    };
    try {
      assertCurrent();
      this.deps.assertAllowed();
      const runtime = this.deps.runtime();
      let reservation: ReturnType<typeof runtime.reserveNextConversationConnection>;
      try {
        reservation = runtime.reserveNextConversationConnection();
      } catch {
        throw new SubscriptionError('已有接入操作正在进行，请稍候。');
      }
      releaseConnection = reservation.release;
      releaseBusy = this.deps.busyRegistry.acquire({
        id: `subscription:${id}`,
        kind: 'configure',
        domain: 'gateway',
        severity: 'blocking',
        cancellable: false,
        label: `正在连接 ${subscriptionEndpoints[provider].label} 订阅`,
      });
      let environment = await runtime.getSoftwareUpdates();
      assertCurrent();
      if (!environment.claudeCode.installed)
        environment = (await runtime.installOrUpdateClaudeCode()).state;
      assertCurrent();
      if (!environment.claudeCode.installed)
        throw new SubscriptionError('Claude Code 环境准备失败，请重试。');
      await this.deps.relay.ensureRunning();
      assertCurrent();
      this.publish({ phase: 'authorizing', cancellable: true, message: '请在浏览器中完成登录。' });
      const credential = await (this.deps.authorize ?? authorizeSubscription)(provider, {
        ...this.deps.authNetwork,
        signal,
        open: this.deps.open,
        userCode: (code) => {
          assertCurrent();
          this.publish({ userCode: code });
        },
      });
      assertCurrent();
      if (credential.provider !== provider)
        throw new SubscriptionError('授权账号与所选服务不匹配。');
      const slot = this.deps.relay.addCandidate(credential);
      candidateId = slot.id;
      this.publish({ phase: 'testing', message: '正在连接…', userCode: undefined });
      const available = await this.deps.relay.discoverModels(slot.id, signal);
      assertCurrent();
      const preferred = subscriptionEndpoints[provider].models;
      const model = preferred.find((value) => available.includes(value)) ?? available[0];
      if (!model) throw new SubscriptionError('订阅没有可用模型。');
      const input: SaveClaudeConfigInput = {
        preset: provider,
        provider: 'gateway',
        protocol: 'anthropic',
        authMode: 'authToken',
        baseUrl: this.deps.relay.baseUrl(slot.id),
        credential: slot.clientKey,
        credentialAction: 'replace',
        apiKeyHelperPolicy: 'prefer-claudedock',
        model,
        modelFast: preferred.find((value) => value !== model && available.includes(value)) ?? model,
      };
      const applied = await runtime.verifyAndSaveNextConversationConfig(input, undefined, {
        reservation: reservation.token,
        signal,
        beforeCommit: () => {
          assertCurrent();
          this.deps.relay.persist(slot.id);
          // This synchronous commit boundary cannot race IPC cancellation or another configuration.
          this.publish({ cancellable: false });
        },
      });
      if (!applied.connectionTest.ok)
        throw new SubscriptionError('订阅连接未通过，请检查套餐或稍后重试。');
      this.publish({ phase: 'complete', busy: false, cancellable: false, message: '订阅已连接。' });
      return {
        ok: true,
        message: '订阅已连接。',
        state: this.getState(),
        nextConnection: applied.state,
      };
    } catch (error) {
      const message =
        cancellation.aborted || this.closed
          ? '已取消订阅连接。'
          : signal.aborted
            ? '订阅登录已超时，请重试。'
            : safeSubscriptionMessage(error);
      this.publish({
        phase: 'error',
        busy: false,
        cancellable: false,
        message,
        userCode: undefined,
      });
      return { ok: false, message, state: this.getState() };
    } finally {
      if (candidateId) this.deps.relay.discard(candidateId);
      releaseConnection?.();
      releaseBusy?.();
    }
  }

  public async cancel(attempt: string): Promise<SubscriptionResult> {
    const current = this.operation;
    if (!current || current.id !== attempt || !this.state.cancellable) {
      return { ok: false, state: this.getState(), message: '当前步骤不可取消。' };
    }
    this.publish({ cancellable: false, message: '正在取消…' });
    current.controller.abort();
    await current.promise;
    return { ok: true, state: this.getState(), message: '已取消订阅连接。' };
  }

  public shutdown(): void {
    this.closed = true;
    this.operation?.controller.abort();
    this.deps.relay.shutdown();
  }

  public async shutdownForQuit(): Promise<void> {
    this.shutdown();
    await this.operation?.promise;
    await this.deps.relay.shutdownForQuit();
  }
}
