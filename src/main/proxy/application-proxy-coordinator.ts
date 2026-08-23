import { randomBytes } from 'node:crypto';
import type { AuthInfo, Session } from 'electron';
import type { ApplicationProxyView, SaveApplicationProxyInput } from '../../shared/contracts';
import { applicationProxyRules, buildApplicationProxyEnvironment } from './application-proxy';
import {
  type ApplicationProxyCredentials,
  type ApplicationProxyStoreSnapshot,
  ApplicationProxyStore,
  type PreparedApplicationProxySave,
} from './application-proxy-store';

export type ApplicationProxyNetworkScope = 'application' | 'conversation';
export type ApplicationProxyScopeHealth = 'stable' | 'uninitialized' | 'unknown';

type ApplicationProxySource = ApplicationProxyStoreSnapshot | PreparedApplicationProxySave;
type ApplicationProxySession = Pick<Session, 'closeAllConnections' | 'setProxy'>;

interface MutableScopeState {
  credentialSource?: ApplicationProxySource;
  effectiveIdentity?: string;
  epoch?: string;
  health: ApplicationProxyScopeHealth;
  sessionIdentity?: string;
}

interface ActivePreflightLease {
  readonly epochs: Readonly<Partial<Record<ApplicationProxyNetworkScope, string>>>;
  released: boolean;
  readonly scopes: readonly ApplicationProxyNetworkScope[];
}

export interface ApplicationProxyConfigurationCapture {
  readonly revision: string;
  readonly view: ApplicationProxyView;
}

export interface ApplicationProxyTestCredentialContext {
  readonly authInfo: AuthInfo;
  readonly requestUrl: URL;
  readonly session: Session;
}

export interface ApplicationProxyTestRequestCapture {
  readonly proxyRules: ReturnType<typeof applicationProxyRules>;
  readonly resolveProxyCredentials: (
    context: ApplicationProxyTestCredentialContext,
  ) => ApplicationProxyCredentials | undefined;
  readonly revision: string;
  readonly targetUrl: string;
  readonly view: ApplicationProxyView;
}

export interface ApplicationProxyScopeState {
  readonly epoch?: string;
  readonly health: ApplicationProxyScopeHealth;
}

export interface ApplicationNetworkLease {
  readonly epochs: Readonly<Partial<Record<ApplicationProxyNetworkScope, string>>>;
  readonly scopes: readonly ApplicationProxyNetworkScope[];
  assertCurrent(): void;
  release(): void;
}

/** Compatibility name retained for authoritative preflight callers. */
export type ApplicationProxyPreflightLease = ApplicationNetworkLease;

export class ApplicationNetworkLeaseError extends Error {
  public constructor(
    public readonly scopes: readonly ApplicationProxyNetworkScope[],
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationNetworkLeaseError';
  }
}

/** Compatibility value retained for existing authoritative preflight callers. */
export { ApplicationNetworkLeaseError as ApplicationProxyPreflightLeaseError };

export interface ApplicationProxyCoordinatorOptions {
  applicationSession: ApplicationProxySession;
  assertExternalRoutingWritesAllowed: () => void;
  conversationSession: ApplicationProxySession;
  store: ApplicationProxyStore;
}

export class ApplicationProxyTransactionError extends Error {
  public constructor(
    public readonly originalError: unknown,
    public readonly rollbackErrors: readonly unknown[],
  ) {
    super(originalError instanceof Error ? originalError.message : '应用代理配置事务失败。', {
      cause: originalError,
    });
    this.name = 'ApplicationProxyTransactionError';
  }
}

const scopeOrder: readonly ApplicationProxyNetworkScope[] = ['application', 'conversation'];
const APPLICATION_PROXY_TEST_TARGET = 'https://github.com/';

const newEpoch = (): string => randomBytes(18).toString('base64url');

const freezeView = (view: ApplicationProxyView): ApplicationProxyView =>
  Object.freeze({
    ...view,
    scope: Object.freeze({ ...view.scope }),
  });

export class ApplicationProxyCoordinator {
  private activeLeaseDrain?: { promise: Promise<void>; resolve: () => void };
  private readonly activePreflightLeases = new Set<ActivePreflightLease>();
  private configurationEpoch = newEpoch();
  private proxyTestQueueTail: Promise<void> = Promise.resolve();
  private queueTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(scope: ApplicationProxyNetworkScope) => void>();
  private readonly scopeStates: Record<ApplicationProxyNetworkScope, MutableScopeState> = {
    application: { health: 'uninitialized' },
    conversation: { health: 'uninitialized' },
  };

  public constructor(private readonly options: ApplicationProxyCoordinatorOptions) {}

  public getView(): ApplicationProxyView {
    return this.options.store.getView();
  }

  public captureConfiguration(): ApplicationProxyConfigurationCapture {
    return Object.freeze({
      revision: this.configurationEpoch,
      view: freezeView(this.options.store.getView()),
    });
  }

  public isConfigurationCurrent(revision: string): boolean {
    return revision === this.configurationEpoch;
  }

  public runApplicationProxyTest<T>(
    testSession: Session,
    operation: (capture: ApplicationProxyTestRequestCapture) => Promise<T> | T,
  ): Promise<T> {
    const current = this.proxyTestQueueTail.then(async () => {
      const { capture, release } = this.captureApplicationProxyTest(testSession);
      try {
        return await operation(capture);
      } finally {
        release();
      }
    });
    this.proxyTestQueueTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  public getScopeState(scope: ApplicationProxyNetworkScope): ApplicationProxyScopeState {
    const state = this.scopeStates[scope];
    return Object.freeze({ epoch: state.epoch, health: state.health });
  }

  public subscribe(listener: (scope: ApplicationProxyNetworkScope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public acquireNetworkLease(
    scopes: ApplicationProxyNetworkScope | readonly ApplicationProxyNetworkScope[],
  ): Promise<ApplicationNetworkLease> {
    const requested = typeof scopes === 'string' ? [scopes] : scopes;
    const normalized = Object.freeze(scopeOrder.filter((scope) => requested.includes(scope)));
    if (normalized.length === 0) {
      return Promise.reject(
        new ApplicationNetworkLeaseError(normalized, '应用网络操作必须声明至少一个代理作用范围。'),
      );
    }

    return this.enqueue(async () => {
      const capturedEpochs: Partial<Record<ApplicationProxyNetworkScope, string>> = {};
      for (const scope of normalized) {
        const state = this.scopeStates[scope];
        if (state.health !== 'stable' || !state.epoch) {
          throw new ApplicationNetworkLeaseError(
            normalized,
            `应用代理作用范围 ${scope} 尚未处于稳定状态。`,
          );
        }
        capturedEpochs[scope] = state.epoch;
      }

      const leaseRecord: ActivePreflightLease = {
        epochs: Object.freeze(capturedEpochs),
        released: false,
        scopes: normalized,
      };
      if (this.activePreflightLeases.size === 0) {
        let resolve!: () => void;
        const promise = new Promise<void>((release) => {
          resolve = release;
        });
        this.activeLeaseDrain = { promise, resolve };
      }
      this.activePreflightLeases.add(leaseRecord);

      return Object.freeze({
        assertCurrent: (): void => this.assertLeaseCurrent(leaseRecord),
        epochs: leaseRecord.epochs,
        release: (): void => this.releasePreflightLease(leaseRecord),
        scopes: leaseRecord.scopes,
      });
    });
  }

  public acquirePreflightLease(
    scopes: ApplicationProxyNetworkScope | readonly ApplicationProxyNetworkScope[],
  ): Promise<ApplicationProxyPreflightLease> {
    return this.acquireNetworkLease(scopes);
  }

  public initialize(): Promise<void> {
    return this.reconcile();
  }

  public reconcile(): Promise<void> {
    return this.enqueue(async () => {
      await this.waitForPreflightLeases();
      const snapshot = this.options.store.snapshot();
      for (const scope of scopeOrder) {
        const identities = this.identities(snapshot, scope);
        const state = this.scopeStates[scope];
        if (
          state.health === 'stable' &&
          state.effectiveIdentity === identities.effective &&
          state.sessionIdentity === identities.session
        ) {
          continue;
        }
        await this.applySource(scope, snapshot);
      }
    });
  }

  public save(input: SaveApplicationProxyInput): Promise<ApplicationProxyView> {
    return this.enqueue(async () => {
      this.options.assertExternalRoutingWritesAllowed();
      await this.waitForPreflightLeases();
      const snapshot = this.options.store.snapshot();
      const prepared = this.options.store.prepare(input, snapshot);
      const affected = scopeOrder.filter((scope) => {
        const candidate = this.identities(prepared, scope);
        const state = this.scopeStates[scope];
        return (
          state.health !== 'stable' ||
          state.effectiveIdentity !== candidate.effective ||
          state.sessionIdentity !== candidate.session
        );
      });
      const touched: ApplicationProxyNetworkScope[] = [];
      try {
        for (const scope of affected) {
          touched.push(scope);
          await this.applySource(scope, prepared);
        }
        const committed = this.options.store.commit(prepared);
        this.configurationEpoch = newEpoch();
        return committed;
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const scope of [...touched].reverse()) {
          try {
            await this.applySource(scope, snapshot);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        throw new ApplicationProxyTransactionError(error, rollbackErrors);
      }
    });
  }

  public getCliEnvironment(): ReturnType<typeof buildApplicationProxyEnvironment> {
    const snapshot = this.options.store.snapshot();
    return buildApplicationProxyEnvironment(
      this.options.store.getView(snapshot),
      this.options.store.getCredentials(snapshot),
    );
  }

  public credentialsForProxy(
    requestingSession: Session,
    host: string,
    port: number,
  ): ApplicationProxyCredentials | undefined {
    const scope =
      requestingSession === this.options.applicationSession
        ? 'application'
        : requestingSession === this.options.conversationSession
          ? 'conversation'
          : undefined;
    if (!scope) return undefined;

    const state = this.scopeStates[scope];
    const source = state.health === 'stable' ? state.credentialSource : undefined;
    if (!source) return undefined;
    const view = this.options.store.getView(source);
    if (
      !view.enabled ||
      !view.scope[scope] ||
      view.host.toLowerCase() !== host.toLowerCase() ||
      view.port !== port
    ) {
      return undefined;
    }
    return this.options.store.getCredentials(source);
  }

  private captureApplicationProxyTest(testSession: Session): {
    capture: ApplicationProxyTestRequestCapture;
    release: () => void;
  } {
    const source = this.options.store.snapshot();
    const view = freezeView(this.options.store.getView(source));
    const revision = this.configurationEpoch;
    const targetUrl = APPLICATION_PROXY_TEST_TARGET;
    const targetOrigin = new URL(targetUrl).origin;
    const proxyRules = Object.freeze(
      applicationProxyRules(
        {
          ...view,
          scope: { ...view.scope, application: true },
        },
        'application',
      ),
    );
    let active = true;
    let credentials = this.options.store.getCredentials(source);
    const resolveProxyCredentials = ({
      authInfo,
      requestUrl,
      session,
    }: ApplicationProxyTestCredentialContext): ApplicationProxyCredentials | undefined => {
      if (
        !active ||
        !authInfo.isProxy ||
        session !== testSession ||
        requestUrl.protocol !== 'https:' ||
        requestUrl.origin !== targetOrigin ||
        requestUrl.username !== '' ||
        requestUrl.password !== '' ||
        !view.enabled ||
        !view.host ||
        !view.port ||
        view.host.toLowerCase() !== authInfo.host.toLowerCase() ||
        view.port !== authInfo.port ||
        !credentials
      ) {
        return undefined;
      }
      return { ...credentials };
    };
    return {
      capture: Object.freeze({
        proxyRules,
        resolveProxyCredentials,
        revision,
        targetUrl,
        view,
      }),
      release: () => {
        active = false;
        credentials = undefined;
      },
    };
  }

  private assertLeaseCurrent(lease: ActivePreflightLease): void {
    if (lease.released || !this.activePreflightLeases.has(lease)) {
      throw new ApplicationNetworkLeaseError(lease.scopes, '应用网络作用范围租约已释放。');
    }
    for (const scope of lease.scopes) {
      const state = this.scopeStates[scope];
      if (state.health !== 'stable' || !state.epoch || state.epoch !== lease.epochs[scope]) {
        throw new ApplicationNetworkLeaseError(
          lease.scopes,
          `应用代理作用范围 ${scope} 已在应用网络操作期间发生变化。`,
        );
      }
    }
  }

  private releasePreflightLease(lease: ActivePreflightLease): void {
    if (lease.released) return;
    lease.released = true;
    if (!this.activePreflightLeases.delete(lease) || this.activePreflightLeases.size > 0) {
      return;
    }
    const drain = this.activeLeaseDrain;
    this.activeLeaseDrain = undefined;
    drain?.resolve();
  }

  private async waitForPreflightLeases(): Promise<void> {
    await this.activeLeaseDrain?.promise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queueTail.then(operation);
    this.queueTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private identities(
    source: ApplicationProxySource,
    scope: ApplicationProxyNetworkScope,
  ): { effective: string; session: string } {
    const view = this.options.store.getView(source);
    const stored = source.stored;
    const routeActive = view.enabled && Boolean(view.host && view.port) && view.scope[scope];
    const session = JSON.stringify({
      authentication: routeActive ? [stored.username, stored.encryptedPassword ?? null] : null,
      rules: applicationProxyRules(view, scope),
    });
    if (scope === 'conversation') {
      return { effective: session, session };
    }
    const cli =
      view.enabled && view.scope.cli && view.protocol === 'http'
        ? [stored.host, stored.port ?? null, stored.username, stored.encryptedPassword ?? null]
        : null;
    return {
      effective: JSON.stringify({ cli, session }),
      session,
    };
  }

  private async applySource(
    scope: ApplicationProxyNetworkScope,
    source: ApplicationProxySource,
  ): Promise<void> {
    const state = this.scopeStates[scope];
    const identities = this.identities(source, scope);
    const sessionChanged =
      state.health !== 'stable' || state.sessionIdentity !== identities.session;
    if (sessionChanged) {
      state.credentialSource = undefined;
    }
    state.health = 'unknown';
    this.publish(scope);
    try {
      if (sessionChanged) {
        const adapter =
          scope === 'application'
            ? this.options.applicationSession
            : this.options.conversationSession;
        await adapter.setProxy(applicationProxyRules(this.options.store.getView(source), scope));
        await adapter.closeAllConnections();
      }
      state.credentialSource = sessionChanged ? source : state.credentialSource;
      state.effectiveIdentity = identities.effective;
      state.epoch = newEpoch();
      state.health = 'stable';
      state.sessionIdentity = identities.session;
      this.publish(scope);
    } catch (error) {
      state.credentialSource = undefined;
      state.effectiveIdentity = undefined;
      state.epoch = undefined;
      state.health = 'unknown';
      state.sessionIdentity = undefined;
      this.publish(scope);
      throw error;
    }
  }

  private publish(scope: ApplicationProxyNetworkScope): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(scope);
      } catch {
        // Observers cannot change the authoritative proxy transaction result.
      }
    }
  }
}
