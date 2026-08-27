import { randomUUID } from 'node:crypto';
import type { PtyGeneration, RuntimeWebProcessView } from '../../shared/contracts';
import {
  defaultRuntimeProcessSystem,
  type RuntimeProcessSystem,
  type WindowsProcessSnapshot,
} from './process-registry-system';

export {
  parseWindowsProcessSnapshot,
  type RuntimeProcessStopReceipt,
  type RuntimeProcessStopTarget,
  type RuntimeProcessSystem,
  type WindowsProcessSnapshot,
} from './process-registry-system';

const SCAN_INTERVAL_MS = 2_000;
const MAX_STOP_ATTEMPTS = 256;
const MAX_TERMINATE_ALL_PASSES = 8;
const URL_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1_000;
const OPERATION_INVALIDATED_MESSAGE = '进程观察已停止，当前操作已取消。';
const WEB_EXECUTABLES = new Set([
  'bun.exe',
  'deno.exe',
  'dotnet.exe',
  'java.exe',
  'node.exe',
  'php.exe',
  'python.exe',
  'pythonw.exe',
  'ruby.exe',
  'uvicorn.exe',
]);
const TREE_BARRIER_EXECUTABLE_PARTS = [
  'chrome',
  'msedge',
  'firefox',
  'browser',
  'docker',
  'dockerd',
];
const FORBIDDEN_EXECUTABLE_PARTS = [...TREE_BARRIER_EXECUTABLE_PARTS, 'claude', 'codex', 'ccr'];

type SnapshotProcess = WindowsProcessSnapshot['processes'][number];

export interface RuntimeProcessOwner {
  launchGeneration: number;
  ptyGeneration: PtyGeneration;
  rootPid: number;
  sessionId: string;
}

interface ConfirmedUrl {
  identity?: string;
  observedAt: number;
  url: string;
}

interface OwnedProcess {
  identity: string;
  owner: RuntimeProcessOwner;
  process: SnapshotProcess;
  processKey: string;
  rootStartedAt: number;
  view: RuntimeWebProcessView;
}

interface ScanRequest {
  cancel: () => void;
  coalescingEpoch: number;
  generation: number;
  promise: Promise<void>;
  state: 'queued' | 'running' | 'settled';
}

interface TerminationScope {
  frozenOwners: RuntimeProcessOwner[];
  ownerProvider: () => RuntimeProcessOwner[];
  ownerProviderRevision: number;
  rootStartedAtByOwner: Map<string, number>;
  sessionId?: string;
}

interface ScopedProcessState {
  discovered: Map<string, OwnedProcess>;
  owners: RuntimeProcessOwner[];
  rootStartedAtByOwner: Map<string, number>;
  snapshot: WindowsProcessSnapshot;
}

interface StopPassResult {
  attempted: number;
  error?: unknown;
  snapshot: WindowsProcessSnapshot;
}

interface TerminationResult {
  error?: unknown;
  state: ScopedProcessState;
}

export class RuntimeProcessScanCancelledError extends Error {
  public constructor() {
    super(OPERATION_INVALIDATED_MESSAGE);
    this.name = 'RuntimeProcessScanCancelledError';
  }
}

const validStartedAt = (startedAt: number): boolean =>
  Number.isSafeInteger(startedAt) && startedAt > 0;

const forbiddenProcess = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return FORBIDDEN_EXECUTABLE_PARTS.some((part) => normalized.includes(part));
};

const cloneProcessView = (view: RuntimeWebProcessView): RuntimeWebProcessView => ({
  ...view,
  ports: [...view.ports],
  urls: view.urls.map((url) => ({ ...url })),
});

const processViewsFingerprint = (views: RuntimeWebProcessView[]): string =>
  JSON.stringify([...views].sort((left, right) => left.processKey.localeCompare(right.processKey)));

const webProcess = (name: string): boolean => WEB_EXECUTABLES.has(name.toLowerCase());
const processIdentity = (pid: number, startedAt: number): string => `${pid}:${startedAt}`;
const runtimeOwnerKey = (owner: RuntimeProcessOwner): string =>
  `${owner.sessionId}:${owner.launchGeneration}:${owner.ptyGeneration}:${owner.rootPid}`;
const ownerSetFingerprint = (owners: RuntimeProcessOwner[]): string =>
  owners.map(runtimeOwnerKey).sort().join('|');
const treeBarrierProcess = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return TREE_BARRIER_EXECUTABLE_PARTS.some((part) => normalized.includes(part));
};

const processAtPid = (
  snapshot: WindowsProcessSnapshot,
  pid: number,
): SnapshotProcess | undefined => {
  const matches = snapshot.processes.filter((process) => process.pid === pid);
  return matches.length === 1 ? matches[0] : undefined;
};

const descendantProcesses = (
  snapshot: WindowsProcessSnapshot,
  root: SnapshotProcess,
  barrier: (name: string) => boolean = treeBarrierProcess,
): SnapshotProcess[] => {
  const descendants: SnapshotProcess[] = [];
  const seen = new Set([processIdentity(root.pid, root.startedAt)]);
  let frontier = [root];
  while (frontier.length > 0) {
    const next: SnapshotProcess[] = [];
    for (const parent of frontier) {
      for (const child of snapshot.processes) {
        const identity = processIdentity(child.pid, child.startedAt);
        if (
          child.parentPid !== parent.pid ||
          !validStartedAt(child.startedAt) ||
          child.startedAt < parent.startedAt ||
          seen.has(identity) ||
          barrier(child.name)
        ) {
          continue;
        }
        const occupant = processAtPid(snapshot, child.pid);
        if (occupant !== child) continue;
        seen.add(identity);
        descendants.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return descendants;
};

const normalizedUrlPort = (value: string): number | undefined => {
  try {
    const url = new URL(value);
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {
    return undefined;
  }
};

const safeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '0.0.0.0', '[::]', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

const normalizedListenerAddress = (address: string): string => {
  const trimmed = address.trim();
  if (trimmed === '' || trimmed === '*') return '0.0.0.0';
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
};

const listenerUrl = (address: string, port: number): string => {
  const normalized = normalizedListenerAddress(address);
  const host = normalized.includes(':') ? `[${normalized.replaceAll('%', '%25')}]` : normalized;
  return `http://${host}:${port}`;
};

const listenerIsExposed = (address: string): boolean => {
  const normalized = normalizedListenerAddress(address).toLowerCase();
  return !(
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('::ffff:127.')
  );
};

const asError = (error: unknown, fallback: string): Error =>
  error instanceof Error ? error : new Error(fallback);

export class RuntimeProcessRegistry {
  private readonly confirmedUrls = new Map<string, ConfirmedUrl[]>();
  private readonly lastPublishedFingerprints = new Map<string, string>();
  private observerGeneration = 0;
  private operationQueue: Promise<void> = Promise.resolve();
  private ownerProvider: () => RuntimeProcessOwner[] = () => [];
  private ownerProviderRevision = 0;
  private readonly ownerRootStartedAt = new Map<string, number>();
  private readonly owned = new Map<string, OwnedProcess>();
  private queueMutationEpoch = 0;
  private readonly pollingPauses = new Map<number, number>();
  private scanRequests: ScanRequest[] = [];
  private started = false;
  private timer?: NodeJS.Timeout;

  public constructor(
    private readonly onChange: (sessionId: string, processes: RuntimeWebProcessView[]) => void,
    private readonly system: RuntimeProcessSystem = defaultRuntimeProcessSystem,
  ) {}

  public start(ownerProvider: () => RuntimeProcessOwner[]): void {
    this.ownerProvider = ownerProvider;
    this.ownerProviderRevision += 1;
    this.queueMutationEpoch += 1;
    if (this.started) {
      void this.scan().catch(() => undefined);
      return;
    }
    this.started = true;
    void this.runScheduledScan(this.observerGeneration);
  }

  public observeTerminalOutput(
    sessionId: string,
    ptyGeneration: PtyGeneration,
    data: string,
  ): void {
    const urls =
      data
        .replaceAll(String.fromCharCode(27), '')
        .match(
          /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:\/\S*)?/gi,
        ) ?? [];
    if (urls.length === 0) return;
    const key = `${sessionId}:${ptyGeneration}`;
    const now = Date.now();
    const retained = (this.confirmedUrls.get(key) ?? []).filter(
      (entry) => now - entry.observedAt <= URL_CONFIRMATION_TTL_MS,
    );
    for (const url of urls.filter(safeUrl).slice(0, 20)) {
      const duplicateIndex = retained.findIndex((entry) => entry.url === url);
      if (duplicateIndex >= 0) retained.splice(duplicateIndex, 1);
      retained.push({ observedAt: now, url });
    }
    this.confirmedUrls.set(key, retained.slice(-20));
  }

  public scan(): Promise<void> {
    const pending = this.scanRequests.filter(
      (request) =>
        request.generation === this.observerGeneration &&
        request.coalescingEpoch === this.queueMutationEpoch &&
        request.state !== 'settled',
    );
    const trailing = pending.at(-1);
    if (trailing?.state === 'queued') return trailing.promise;
    return this.createScanRequest().promise;
  }

  public terminate(sessionId: string, processKey: string): Promise<void> {
    return this.enqueueTermination(
      (generation, scope) => this.terminateOwnedProcess(generation, scope, sessionId, processKey),
      sessionId,
    );
  }

  public terminateSession(sessionId: string): Promise<void> {
    return this.enqueueTermination(
      (generation, scope) => this.terminateOwnedSession(generation, scope, sessionId),
      sessionId,
    );
  }

  public terminateAll(): Promise<void> {
    return this.enqueueTermination((generation, scope) =>
      this.terminateAllOwnedProcesses(generation, scope),
    );
  }

  public list(): Array<{ sessionId: string; view: RuntimeWebProcessView }> {
    return [...this.owned.values()].map((entry) => ({
      sessionId: entry.owner.sessionId,
      view: cloneProcessView(entry.view),
    }));
  }

  public stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pollingPauses.delete(this.observerGeneration);
    for (const request of this.scanRequests) request.cancel();
    this.observerGeneration += 1;
    this.ownerProviderRevision += 1;
    this.queueMutationEpoch += 1;
    this.scanRequests = [];
  }

  private async scanOnce(generation: number): Promise<void> {
    this.assertScanActive(generation);
    const provider = this.ownerProvider;
    const providerRevision = this.ownerProviderRevision;
    const ownersBeforeCapture = this.readOwners(provider);
    const snapshot =
      ownersBeforeCapture.length === 0
        ? { listeners: [], processes: [] }
        : await this.system.capture();
    this.assertScanActive(generation);
    if (provider !== this.ownerProvider || providerRevision !== this.ownerProviderRevision) {
      throw new RuntimeProcessScanCancelledError();
    }
    const ownersAfterCapture = this.readOwners(provider);
    if (ownerSetFingerprint(ownersBeforeCapture) !== ownerSetFingerprint(ownersAfterCapture)) {
      throw new RuntimeProcessScanCancelledError();
    }
    this.pruneConfirmedUrls(ownersAfterCapture);
    const rootStartedAtByOwner = this.prunedRootBindings(
      this.ownerRootStartedAt,
      ownersAfterCapture,
    );
    const discovered = this.discoverOwnedProcesses(
      snapshot,
      ownersAfterCapture,
      rootStartedAtByOwner,
      true,
    );
    this.assertScanActive(generation);
    if (provider !== this.ownerProvider || providerRevision !== this.ownerProviderRevision) {
      throw new RuntimeProcessScanCancelledError();
    }
    this.replaceRootBindings(rootStartedAtByOwner);
    this.replaceOwnedProcesses(
      discovered,
      generation,
      true,
      ownersAfterCapture.map((owner) => owner.sessionId),
      () => provider === this.ownerProvider && providerRevision === this.ownerProviderRevision,
    );
  }

  private assertScanActive(generation: number): void {
    if (!this.isCurrent(generation)) throw new RuntimeProcessScanCancelledError();
  }

  private createScanRequest(): ScanRequest {
    const generation = this.observerGeneration;
    let rejectCancellation!: (error: RuntimeProcessScanCancelledError) => void;
    const cancellation = new Promise<void>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const request: ScanRequest = {
      cancel: () => {
        if (request.state !== 'settled') rejectCancellation(new RuntimeProcessScanCancelledError());
      },
      coalescingEpoch: this.queueMutationEpoch,
      generation,
      promise: Promise.resolve(),
      state: 'queued',
    };
    const operation = this.enqueueOperation(async (queuedGeneration) => {
      request.state = 'running';
      try {
        await this.scanOnce(queuedGeneration);
      } finally {
        request.state = 'settled';
      }
    });
    request.promise = Promise.race([operation, cancellation]);
    this.scanRequests.push(request);
    void request.promise.then(
      () => this.removeScanRequest(request),
      () => this.removeScanRequest(request),
    );
    return request;
  }

  private captureTerminationScope(sessionId?: string): TerminationScope {
    const ownerProvider = this.ownerProvider;
    const rootStartedAtByOwner = new Map(this.ownerRootStartedAt);
    for (const entry of this.owned.values()) {
      rootStartedAtByOwner.set(runtimeOwnerKey(entry.owner), entry.rootStartedAt);
    }
    return {
      frozenOwners: this.readOwners(ownerProvider, sessionId),
      ownerProvider,
      ownerProviderRevision: this.ownerProviderRevision,
      rootStartedAtByOwner,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  private enqueueTermination(
    operation: (generation: number, scope: TerminationScope) => Promise<void>,
    sessionId?: string,
  ): Promise<void> {
    let scope: TerminationScope;
    try {
      scope = this.captureTerminationScope(sessionId);
    } catch (error) {
      return Promise.reject(error);
    }
    this.queueMutationEpoch += 1;
    return this.withPollingPaused(() =>
      this.enqueueOperation((generation) => operation(generation, scope)),
    );
  }

  private enqueueOperation<T>(operation: (generation: number) => Promise<T>): Promise<T> {
    const generation = this.observerGeneration;
    const result = this.operationQueue.then(() => operation(generation));
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.observerGeneration;
  }

  private removeScanRequest(request: ScanRequest): void {
    this.scanRequests = this.scanRequests.filter((candidate) => candidate !== request);
  }

  private readOwners(
    provider: () => RuntimeProcessOwner[],
    sessionId?: string,
  ): RuntimeProcessOwner[] {
    const owners = provider();
    const unique = new Map<string, RuntimeProcessOwner>();
    for (const owner of owners) {
      if (
        (sessionId !== undefined && owner.sessionId !== sessionId) ||
        !Number.isSafeInteger(owner.rootPid) ||
        owner.rootPid <= 0 ||
        !Number.isSafeInteger(owner.launchGeneration) ||
        !Number.isSafeInteger(owner.ptyGeneration) ||
        typeof owner.sessionId !== 'string' ||
        owner.sessionId.length === 0
      ) {
        continue;
      }
      const copy = { ...owner };
      unique.set(runtimeOwnerKey(copy), copy);
    }
    return [...unique.values()];
  }

  private pruneConfirmedUrls(owners: RuntimeProcessOwner[]): void {
    const activeKeys = new Set(owners.map((owner) => `${owner.sessionId}:${owner.ptyGeneration}`));
    const now = Date.now();
    for (const [key, entries] of this.confirmedUrls) {
      if (!activeKeys.has(key)) {
        this.confirmedUrls.delete(key);
        continue;
      }
      const retained = entries.filter((entry) => now - entry.observedAt <= URL_CONFIRMATION_TTL_MS);
      if (retained.length === 0) this.confirmedUrls.delete(key);
      else if (retained.length !== entries.length) this.confirmedUrls.set(key, retained);
    }
  }

  private prunedRootBindings(
    source: Map<string, number>,
    owners: RuntimeProcessOwner[],
  ): Map<string, number> {
    const activeOwners = new Set(owners.map(runtimeOwnerKey));
    return new Map([...source].filter(([key]) => activeOwners.has(key)));
  }

  private replaceRootBindings(bindings: Map<string, number>): void {
    this.ownerRootStartedAt.clear();
    for (const [key, startedAt] of bindings) this.ownerRootStartedAt.set(key, startedAt);
  }

  private discoverOwnedProcesses(
    snapshot: WindowsProcessSnapshot,
    owners: RuntimeProcessOwner[],
    rootStartedAtByOwner: Map<string, number>,
    bindConfirmedUrls: boolean,
  ): Map<string, OwnedProcess> {
    const previous = new Map(
      [...this.owned.values()].map((entry) => [
        `${runtimeOwnerKey(entry.owner)}:${entry.rootStartedAt}:${entry.identity}`,
        entry,
      ]),
    );
    const next = new Map<string, OwnedProcess>();
    for (const owner of owners) {
      const ownerKey = runtimeOwnerKey(owner);
      const rootProcess = processAtPid(snapshot, owner.rootPid);
      if (!rootProcess || !validStartedAt(rootProcess.startedAt)) continue;
      const boundRootStartedAt = rootStartedAtByOwner.get(ownerKey);
      if (boundRootStartedAt !== undefined && boundRootStartedAt !== rootProcess.startedAt)
        continue;
      if (boundRootStartedAt === undefined) {
        rootStartedAtByOwner.set(ownerKey, rootProcess.startedAt);
      }
      const descendants = descendantProcesses(snapshot, rootProcess);
      for (const process of descendants) {
        if (!webProcess(process.name) || forbiddenProcess(process.name)) continue;
        const listeners = snapshot.listeners.filter((listener) => listener.pid === process.pid);
        if (listeners.length === 0) continue;
        const identity = processIdentity(process.pid, process.startedAt);
        const ownershipKey = `${ownerKey}:${rootProcess.startedAt}:${identity}`;
        const known = previous.get(ownershipKey);
        const processKey = known?.processKey ?? randomUUID();
        const ports = [...new Set(listeners.map((listener) => listener.port))].sort(
          (left, right) => left - right,
        );
        const confirmations =
          this.confirmedUrls.get(`${owner.sessionId}:${owner.ptyGeneration}`) ?? [];
        const confirmedForProcess = confirmations.filter((entry) => {
          const port = normalizedUrlPort(entry.url);
          return (
            port !== undefined &&
            ports.includes(port) &&
            (entry.identity === undefined || entry.identity === identity)
          );
        });
        if (bindConfirmedUrls) {
          for (const confirmation of confirmedForProcess) confirmation.identity = identity;
        }
        const confirmedPorts = new Set(
          confirmedForProcess
            .map((entry) => normalizedUrlPort(entry.url))
            .filter((port): port is number => port !== undefined),
        );
        const urls = [
          ...confirmedForProcess.map((entry) => ({ confirmed: true, url: entry.url })),
          ...listeners
            .filter((listener) => !confirmedPorts.has(listener.port))
            .map((listener) => ({
              confirmed: false,
              url: listenerUrl(listener.address, listener.port),
            }))
            .filter(
              (entry, index, entries) =>
                entries.findIndex((candidate) => candidate.url === entry.url) === index,
            ),
        ];
        const exposed = listeners.some((listener) => listenerIsExposed(listener.address));
        const view: RuntimeWebProcessView = {
          commandSummary: `${process.name} · 当前终端的已验证后代进程`,
          ...(exposed ? { exposureWarning: '监听所有网络接口，可能可从局域网访问。' } : {}),
          name: process.name.replace(/\.exe$/i, ''),
          pid: process.pid,
          ports,
          processKey,
          startedAt: process.startedAt,
          status: known?.view.status ?? 'running',
          urls,
        };
        next.set(processKey, {
          identity,
          owner: { ...owner },
          process,
          processKey,
          rootStartedAt: rootProcess.startedAt,
          view,
        });
      }
    }
    return next;
  }

  private replaceOwnedProcesses(
    discovered: Map<string, OwnedProcess>,
    generation: number,
    publish: boolean,
    additionalSessions: string[] = [],
    publicationFence: () => boolean = () => true,
  ): void {
    const sessions = new Set([
      ...[...this.owned.values()].map((entry) => entry.owner.sessionId),
      ...[...discovered.values()].map((entry) => entry.owner.sessionId),
      ...additionalSessions,
    ]);
    this.owned.clear();
    for (const [key, entry] of discovered) this.owned.set(key, entry);
    if (!publish) return;
    for (const sessionId of sessions) {
      if (!this.isCurrent(generation) || !publicationFence()) break;
      this.publishSession(sessionId, generation);
    }
  }

  private pausePolling(generation: number): void {
    this.pollingPauses.set(generation, (this.pollingPauses.get(generation) ?? 0) + 1);
    if (generation === this.observerGeneration && this.timer) clearTimeout(this.timer);
    if (generation === this.observerGeneration) this.timer = undefined;
  }

  private releasePolling(generation: number): void {
    const count = this.pollingPauses.get(generation);
    if (count === undefined) return;
    if (count > 1) {
      this.pollingPauses.set(generation, count - 1);
      return;
    }
    this.pollingPauses.delete(generation);
    this.schedulePolling(generation);
  }

  private async runScheduledScan(generation: number): Promise<void> {
    if (!this.started || !this.isCurrent(generation) || this.pollingPauses.has(generation)) {
      return;
    }
    try {
      await this.scan();
    } catch {
      // A failed observation must not stop future polling.
    }
    this.schedulePolling(generation);
  }

  private schedulePolling(generation: number): void {
    if (
      !this.started ||
      !this.isCurrent(generation) ||
      this.pollingPauses.has(generation) ||
      this.timer
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runScheduledScan(generation);
    }, SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  private scopeIsLive(scope: TerminationScope): boolean {
    return (
      this.ownerProvider === scope.ownerProvider &&
      this.ownerProviderRevision === scope.ownerProviderRevision
    );
  }

  private async captureScopedState(scope: TerminationScope): Promise<ScopedProcessState> {
    const liveAtStart = this.scopeIsLive(scope);
    const ownersBeforeCapture = liveAtStart
      ? this.readOwners(scope.ownerProvider, scope.sessionId)
      : scope.frozenOwners.map((owner) => ({ ...owner }));
    const snapshot =
      ownersBeforeCapture.length === 0
        ? { listeners: [], processes: [] }
        : await this.system.capture();
    let owners = ownersBeforeCapture;
    if (liveAtStart && this.scopeIsLive(scope)) {
      const ownersAfterCapture = this.readOwners(scope.ownerProvider, scope.sessionId);
      if (ownerSetFingerprint(ownersBeforeCapture) !== ownerSetFingerprint(ownersAfterCapture)) {
        throw new Error('进程所有权在扫描期间发生变化，已拒绝应用扫描结果。');
      }
      owners = ownersAfterCapture;
    } else if (liveAtStart) {
      owners = scope.frozenOwners.map((owner) => ({ ...owner }));
    }
    const rootStartedAtByOwner = this.prunedRootBindings(scope.rootStartedAtByOwner, owners);
    const discovered = this.discoverOwnedProcesses(snapshot, owners, rootStartedAtByOwner, false);
    scope.rootStartedAtByOwner = rootStartedAtByOwner;
    return { discovered, owners, rootStartedAtByOwner, snapshot };
  }

  private canApplyTerminationState(generation: number, scope: TerminationScope): boolean {
    if (this.isCurrent(generation) && this.scopeIsLive(scope)) return true;
    return (
      !this.started &&
      this.ownerProvider === scope.ownerProvider &&
      this.observerGeneration === generation + 1
    );
  }

  private applyTerminationState(
    generation: number,
    scope: TerminationScope,
    state: ScopedProcessState,
  ): void {
    if (!this.canApplyTerminationState(generation, scope)) return;
    const publish = this.isCurrent(generation) && this.scopeIsLive(scope);
    // A single-session cleanup must neither depend on sibling launch generations nor overwrite
    // their observations. Global shutdown still captures and replaces the complete owner set.
    const discovered =
      scope.sessionId === undefined
        ? state.discovered
        : new Map([
            ...[...this.owned].filter(([, entry]) => entry.owner.sessionId !== scope.sessionId),
            ...state.discovered,
          ]);
    this.replaceRootBindings(
      scope.sessionId === undefined
        ? state.rootStartedAtByOwner
        : new Map([...this.ownerRootStartedAt, ...state.rootStartedAtByOwner]),
    );
    this.replaceOwnedProcesses(
      discovered,
      generation,
      publish,
      state.owners.map((owner) => owner.sessionId),
      () => this.scopeIsLive(scope),
    );
  }

  private async terminateAllOwnedProcesses(
    generation: number,
    scope: TerminationScope,
  ): Promise<void> {
    let firstError: unknown;
    for (let pass = 0; pass < MAX_TERMINATE_ALL_PASSES; pass += 1) {
      const state = await this.captureScopedState(scope);
      if (state.discovered.size === 0) {
        this.applyTerminationState(generation, scope, state);
        if (firstError !== undefined) {
          throw asError(firstError, '至少一个已验证的 Web 进程未能结束。');
        }
        return;
      }
      const result = await this.terminateTargetGroup(generation, scope, state, [
        ...state.discovered.values(),
      ]);
      firstError ??= result.error;
      if (result.state.discovered.size === 0 && firstError !== undefined) {
        throw asError(firstError, '至少一个已验证的 Web 进程未能结束。');
      }
      if (result.state.discovered.size === 0) return;
    }
    throw asError(firstError, '仍有已验证的 Web 进程未能结束，已达到安全清理上限。');
  }

  private async terminateOwnedProcess(
    generation: number,
    scope: TerminationScope,
    sessionId: string,
    processKey: string,
  ): Promise<void> {
    const remembered = this.owned.get(processKey);
    if (!remembered || remembered.owner.sessionId !== sessionId) {
      throw new Error('该进程已结束或不再属于当前会话。');
    }
    const state = await this.captureScopedState(scope);
    const target = state.discovered.get(processKey);
    if (
      !target ||
      target.owner.sessionId !== sessionId ||
      target.identity !== remembered.identity ||
      target.rootStartedAt !== remembered.rootStartedAt
    ) {
      this.applyTerminationState(generation, scope, state);
      throw new Error('进程所有权已变化，已拒绝结束。');
    }
    const result = await this.terminateTargetGroup(generation, scope, state, [target]);
    if (result.error !== undefined) {
      throw asError(result.error, '已验证的进程未能结束。');
    }
  }

  private async terminateOwnedSession(
    generation: number,
    scope: TerminationScope,
    sessionId: string,
  ): Promise<void> {
    const state = await this.captureScopedState(scope);
    const targets = [...state.discovered.values()].filter(
      (entry) => entry.owner.sessionId === sessionId,
    );
    if (targets.length === 0) {
      this.applyTerminationState(generation, scope, state);
      return;
    }
    const result = await this.terminateTargetGroup(generation, scope, state, targets);
    if (result.error !== undefined) {
      throw asError(result.error, '当前会话至少有一个已验证的 Web 进程未能结束。');
    }
    if (
      [...result.state.discovered.values()].some((entry) => entry.owner.sessionId === sessionId)
    ) {
      throw new Error('当前会话仍有已验证的 Web 进程未能结束。');
    }
  }

  private async terminateTargetGroup(
    generation: number,
    scope: TerminationScope,
    initialState: ScopedProcessState,
    targets: OwnedProcess[],
  ): Promise<TerminationResult> {
    const known = new Map<string, SnapshotProcess>();
    for (const target of targets) {
      const subtree = this.verifiedSubtree(target, initialState.snapshot);
      if (subtree.length === 0) {
        this.applyTerminationState(generation, scope, initialState);
        return {
          error: new Error('进程所有权已变化，已拒绝结束。'),
          state: initialState,
        };
      }
      for (const process of subtree) {
        known.set(processIdentity(process.pid, process.startedAt), process);
      }
    }
    const historicalParentCutoffs = new Map<string, number>();
    this.markStopping(targets, generation, scope);
    try {
      await this.stopKnownProcesses(known, historicalParentCutoffs, false);
      await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      const forceResult = await this.stopKnownProcesses(known, historicalParentCutoffs, true);
      const finalState = await this.captureScopedState(scope);
      this.expandKnownSubtree(known, historicalParentCutoffs, finalState.snapshot);
      const survivors = this.knownSurvivors(known, finalState.snapshot);
      const uncertain = this.hasUnverifiedKnownPid(known, finalState.snapshot);
      let error = forceResult.error;
      if (survivors.length > 0 || uncertain) {
        error ??= new Error(
          uncertain
            ? '无法验证已知进程的创建时间，结束操作未能安全确认。'
            : '已验证的进程仍在运行，结束操作未完成。',
        );
      }
      this.applyTerminationState(generation, scope, finalState);
      if (error !== undefined) this.restoreRunningStatuses(targets, generation, scope);
      return { ...(error === undefined ? {} : { error }), state: finalState };
    } catch (error) {
      this.restoreRunningStatuses(targets, generation, scope);
      throw error;
    }
  }

  private markStopping(targets: OwnedProcess[], generation: number, scope: TerminationScope): void {
    if (!this.isCurrent(generation) || !this.scopeIsLive(scope)) return;
    const sessions = new Set<string>();
    for (const target of targets) {
      const current = this.owned.get(target.processKey);
      if (!current || current.identity !== target.identity) continue;
      current.view.status = 'stopping';
      sessions.add(current.owner.sessionId);
    }
    for (const sessionId of sessions) {
      if (!this.scopeIsLive(scope)) break;
      this.publishSession(sessionId, generation);
    }
  }

  private expandKnownSubtree(
    known: Map<string, SnapshotProcess>,
    historicalParentCutoffs: Map<string, number>,
    snapshot: WindowsProcessSnapshot,
  ): void {
    const frontier = [...known.values()];
    const visited = new Set<string>();
    while (frontier.length > 0) {
      const parent = frontier.shift();
      if (!parent) break;
      const parentIdentity = processIdentity(parent.pid, parent.startedAt);
      if (visited.has(parentIdentity)) continue;
      visited.add(parentIdentity);
      const occupants = snapshot.processes.filter((process) => process.pid === parent.pid);
      const exactParentSurvives = occupants.some(
        (process) => processIdentity(process.pid, process.startedAt) === parentIdentity,
      );
      const historicalCutoff = historicalParentCutoffs.get(parentIdentity);
      if (
        !(occupants.length === 1 && exactParentSurvives) &&
        !(occupants.length === 0 && historicalCutoff !== undefined)
      ) {
        continue;
      }
      for (const child of snapshot.processes) {
        if (
          child.parentPid !== parent.pid ||
          !validStartedAt(child.startedAt) ||
          child.startedAt < parent.startedAt ||
          (!exactParentSurvives && child.startedAt > (historicalCutoff ?? -1)) ||
          forbiddenProcess(child.name) ||
          processAtPid(snapshot, child.pid) !== child
        ) {
          continue;
        }
        const childIdentity = processIdentity(child.pid, child.startedAt);
        if (!known.has(childIdentity)) {
          known.set(childIdentity, child);
          frontier.push(child);
        }
      }
    }
  }

  private knownSurvivors(
    known: Map<string, SnapshotProcess>,
    snapshot: WindowsProcessSnapshot,
  ): SnapshotProcess[] {
    return snapshot.processes.filter(
      (process) =>
        validStartedAt(process.startedAt) &&
        known.has(processIdentity(process.pid, process.startedAt)),
    );
  }

  private hasUnverifiedKnownPid(
    known: Map<string, SnapshotProcess>,
    snapshot: WindowsProcessSnapshot,
  ): boolean {
    const knownPids = new Set([...known.values()].map((process) => process.pid));
    return snapshot.processes.some(
      (process) => knownPids.has(process.pid) && !validStartedAt(process.startedAt),
    );
  }

  private restoreRunningStatuses(
    targets: OwnedProcess[],
    generation: number,
    scope: TerminationScope,
  ): void {
    if (!this.canApplyTerminationState(generation, scope)) return;
    const sessions = new Set<string>();
    for (const target of targets) {
      const current = this.owned.get(target.processKey);
      if (!current || current.identity !== target.identity || current.view.status !== 'stopping') {
        continue;
      }
      current.view.status = 'running';
      sessions.add(current.owner.sessionId);
    }
    if (!this.isCurrent(generation) || !this.scopeIsLive(scope)) return;
    for (const sessionId of sessions) {
      if (!this.scopeIsLive(scope)) break;
      this.publishSession(sessionId, generation);
    }
  }

  private async stopKnownProcesses(
    known: Map<string, SnapshotProcess>,
    historicalParentCutoffs: Map<string, number>,
    force: boolean,
  ): Promise<StopPassResult> {
    const attempted = new Set<string>();
    let attemptedCount = 0;
    let firstError: unknown;
    let snapshot = await this.system.capture();
    while (true) {
      this.expandKnownSubtree(known, historicalParentCutoffs, snapshot);
      const survivors = this.knownSurvivors(known, snapshot);
      if (survivors.length === 0) {
        if (this.hasUnverifiedKnownPid(known, snapshot)) {
          firstError ??= new Error('无法验证已知进程的创建时间，结束操作未能安全确认。');
        }
        return {
          attempted: attemptedCount,
          ...(firstError === undefined ? {} : { error: firstError }),
          snapshot,
        };
      }
      const candidates = survivors
        .filter((process) => !attempted.has(processIdentity(process.pid, process.startedAt)))
        .sort((left, right) => right.startedAt - left.startedAt || right.pid - left.pid);
      if (candidates.length === 0) {
        firstError ??= new Error('已验证的进程仍在运行，结束操作未完成。');
        return { attempted: attemptedCount, error: firstError, snapshot };
      }
      const remainingBudget = MAX_STOP_ATTEMPTS - attemptedCount;
      if (remainingBudget <= 0) {
        firstError ??= new Error('结束操作已达到安全尝试上限。');
        return { attempted: attemptedCount, error: firstError, snapshot };
      }
      const planned = candidates.slice(0, remainingBudget);
      for (const process of planned) {
        attempted.add(processIdentity(process.pid, process.startedAt));
      }
      attemptedCount += planned.length;
      const stopTargets = planned.map((process) => ({
        pid: process.pid,
        startedAt: process.startedAt,
      }));
      try {
        const receipts = force
          ? await this.system.forceStop(stopTargets)
          : await this.system.gracefulStop(stopTargets);
        for (const receipt of receipts ?? []) {
          const identity = processIdentity(receipt.pid, receipt.startedAt);
          if (!known.has(identity) || receipt.reuseSafeBefore < receipt.startedAt) continue;
          historicalParentCutoffs.set(
            identity,
            Math.max(historicalParentCutoffs.get(identity) ?? 0, receipt.reuseSafeBefore),
          );
        }
      } catch (error) {
        firstError ??= error;
      }
      snapshot = await this.system.capture();
    }
  }

  private verifiedSubtree(
    target: OwnedProcess,
    snapshot: WindowsProcessSnapshot,
  ): SnapshotProcess[] {
    const root = processAtPid(snapshot, target.process.pid);
    if (
      !root ||
      !validStartedAt(root.startedAt) ||
      processIdentity(root.pid, root.startedAt) !== target.identity ||
      forbiddenProcess(root.name)
    ) {
      return [];
    }
    return [root, ...descendantProcesses(snapshot, root, forbiddenProcess)];
  }

  private withPollingPaused<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.observerGeneration;
    this.pausePolling(generation);
    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      this.releasePolling(generation);
      throw error;
    }
    return result.finally(() => this.releasePolling(generation));
  }

  private publishSession(sessionId: string, generation: number): void {
    if (!this.isCurrent(generation)) return;
    const processes = [...this.owned.values()]
      .filter((entry) => entry.owner.sessionId === sessionId)
      .map((entry) => cloneProcessView(entry.view));
    const fingerprint = processViewsFingerprint(processes);
    const previousFingerprint = this.lastPublishedFingerprints.get(sessionId);
    if (fingerprint === previousFingerprint) return;
    this.lastPublishedFingerprints.set(sessionId, fingerprint);
    try {
      this.onChange(sessionId, processes);
    } catch {
      if (previousFingerprint === undefined) this.lastPublishedFingerprints.delete(sessionId);
      else this.lastPublishedFingerprints.set(sessionId, previousFingerprint);
      // Observers cannot change the authoritative process snapshot.
    }
  }
}
