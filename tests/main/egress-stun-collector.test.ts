import { runInNewContext } from 'node:vm';
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  MAX_APPROVED_STUN_ENDPOINTS,
  MAX_STUN_ENDPOINT_INPUTS,
  MAX_STUN_ENDPOINT_URI_LENGTH,
  MAX_STUN_PAGE_CANDIDATES,
  STUN_DIAGNOSTIC_SCOPE,
  STUN_DOCUMENT_URL,
  STUN_PARTITION_PREFIX,
  STUN_WEBRTC_IP_HANDLING_POLICY,
  StunDiagnosticCollector,
  approvedStunEndpoints,
  buildStunCollectionScript,
  normalizeApprovedStunEndpoint,
  sanitizeStunPageCandidates,
  type StunBrowserWindowFactory,
  type StunDiagnosticCollectorOptions,
  type StunDiagnosticResult,
  type StunDiagnosticUnavailableReason,
  type StunSessionFactory,
} from '../../src/main/egress-diagnostics/webrtc/stun-collector';

type Listener = (...args: unknown[]) => void;
type PermissionCheckHandler = (...args: unknown[]) => boolean;
type PermissionRequestHandler = (...args: unknown[]) => void;
type BeforeRequestHandler = (...args: unknown[]) => void;

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

interface HarnessOptions {
  execute?: Promise<unknown> | unknown;
  load?: Promise<void>;
}

interface ElectronHarness {
  beforeRequestFilter?: { urls: string[] };
  beforeRequestHandler?: BeforeRequestHandler;
  browserWindowFactory: Mock<StunBrowserWindowFactory>;
  destroy: ReturnType<typeof vi.fn>;
  emitContents: (event: string, ...args: unknown[]) => void;
  emitWindow: (event: string, ...args: unknown[]) => void;
  executeJavaScript: ReturnType<typeof vi.fn>;
  isContentsCrashed: ReturnType<typeof vi.fn>;
  isContentsDestroyed: ReturnType<typeof vi.fn>;
  isWindowDestroyed: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  onBeforeRequest: ReturnType<typeof vi.fn>;
  permissionCheckHandler?: PermissionCheckHandler;
  permissionRequestHandler?: PermissionRequestHandler;
  popupHandler?: () => { action: string };
  session: Session;
  sessionFactory: Mock<StunSessionFactory>;
  setPermissionCheckHandler: ReturnType<typeof vi.fn>;
  setPermissionRequestHandler: ReturnType<typeof vi.fn>;
  setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>;
  window: BrowserWindow;
}

const PUBLIC_CANDIDATE = {
  address: '8.8.8.8',
  transport: 'udp',
  type: 'srflx',
};

const completePage = (candidates: readonly unknown[] = [PUBLIC_CANDIDATE]) => ({
  candidates,
  outcome: 'complete',
});

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const addListener = (listeners: Map<string, Set<Listener>>, event: string, listener: Listener) => {
  const eventListeners = listeners.get(event) ?? new Set<Listener>();
  eventListeners.add(listener);
  listeners.set(event, eventListeners);
};

const removeListener = (
  listeners: Map<string, Set<Listener>>,
  event: string,
  listener: Listener,
) => {
  listeners.get(event)?.delete(listener);
};

const emit = (listeners: Map<string, Set<Listener>>, event: string, ...args: unknown[]) => {
  for (const listener of listeners.get(event) ?? []) listener(...args);
};

const createHarness = (options: HarnessOptions = {}): ElectronHarness => {
  const contentsListeners = new Map<string, Set<Listener>>();
  const windowListeners = new Map<string, Set<Listener>>();
  const harness = {} as ElectronHarness;
  const executeValue = options.execute === undefined ? completePage() : options.execute;
  const executeJavaScript = vi.fn(() => Promise.resolve(executeValue));
  const loadURL = vi.fn(() => options.load ?? Promise.resolve());
  const destroy = vi.fn();
  const isContentsCrashed = vi.fn(() => false);
  const isContentsDestroyed = vi.fn(() => false);
  const isWindowDestroyed = vi.fn(() => false);
  const setWebRTCIPHandlingPolicy = vi.fn();
  const webContents = {
    executeJavaScript,
    isCrashed: isContentsCrashed,
    isDestroyed: isContentsDestroyed,
    on: vi.fn((event: string, listener: Listener) =>
      addListener(contentsListeners, event, listener),
    ),
    removeListener: vi.fn((event: string, listener: Listener) =>
      removeListener(contentsListeners, event, listener),
    ),
    setWebRTCIPHandlingPolicy,
    setWindowOpenHandler: vi.fn((handler: () => { action: string }) => {
      harness.popupHandler = handler;
    }),
  };
  const window = {
    destroy,
    isDestroyed: isWindowDestroyed,
    loadURL,
    on: vi.fn((event: string, listener: Listener) => addListener(windowListeners, event, listener)),
    removeListener: vi.fn((event: string, listener: Listener) =>
      removeListener(windowListeners, event, listener),
    ),
    webContents,
  } as unknown as BrowserWindow;
  const setPermissionCheckHandler = vi.fn((handler: PermissionCheckHandler) => {
    harness.permissionCheckHandler = handler;
  });
  const setPermissionRequestHandler = vi.fn((handler: PermissionRequestHandler) => {
    harness.permissionRequestHandler = handler;
  });
  const onBeforeRequest = vi.fn((filter: { urls: string[] }, handler: BeforeRequestHandler) => {
    harness.beforeRequestFilter = filter;
    harness.beforeRequestHandler = handler;
  });
  const session = {
    setPermissionCheckHandler,
    setPermissionRequestHandler,
    webRequest: { onBeforeRequest },
  } as unknown as Session;
  const sessionFactory = vi.fn<StunSessionFactory>(() => session);
  const browserWindowFactory = vi.fn<StunBrowserWindowFactory>(() => window);
  Object.assign(harness, {
    browserWindowFactory,
    destroy,
    emitContents: (event: string, ...args: unknown[]) => emit(contentsListeners, event, ...args),
    emitWindow: (event: string, ...args: unknown[]) => emit(windowListeners, event, ...args),
    executeJavaScript,
    isContentsCrashed,
    isContentsDestroyed,
    isWindowDestroyed,
    loadURL,
    onBeforeRequest,
    session,
    sessionFactory,
    setPermissionCheckHandler,
    setPermissionRequestHandler,
    setWebRTCIPHandlingPolicy,
    window,
  });
  return harness;
};

const createCollector = (
  harness: ElectronHarness,
  overrides: Partial<StunDiagnosticCollectorOptions> = {},
): StunDiagnosticCollector =>
  new StunDiagnosticCollector({
    browserWindowFactory: harness.browserWindowFactory,
    pageCollectionMs: 50,
    partitionSuffixFactory: () => 'main-run-42',
    sessionFactory: harness.sessionFactory,
    stunEndpoints: ['stun:approved.example.test:3478'],
    timeoutMs: 1_000,
    ...overrides,
  });

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
};

const expectUnavailable = (
  result: StunDiagnosticResult,
  reason: StunDiagnosticUnavailableReason,
) => {
  expect(result).toEqual({
    reason,
    scope: STUN_DIAGNOSTIC_SCOPE,
    status: 'unavailable',
  });
};

const expectPublicCandidate = (result: StunDiagnosticResult, address = '8.8.8.8') => {
  expect(result).toEqual({
    candidates: [{ address, family: address.includes(':') ? 'ipv6' : 'ipv4', transport: 'udp' }],
    scope: STUN_DIAGNOSTIC_SCOPE,
    status: 'available',
  });
};

class FakeRtcPeerConnection {
  public static latest?: FakeRtcPeerConnection;
  public readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<Listener>>();

  public constructor(_options: unknown) {
    FakeRtcPeerConnection.latest = this;
  }

  public addEventListener(event: string, listener: Listener): void {
    addListener(this.listeners, event, listener);
  }

  public createDataChannel(_label: string): Record<string, never> {
    return {};
  }

  public createOffer(): Promise<Record<string, never>> {
    return Promise.resolve({});
  }

  public setLocalDescription(_offer: unknown): Promise<void> {
    return Promise.resolve();
  }

  public emitCandidate(
    candidate: { address: string; protocol: string; type: string } | null,
  ): void {
    emit(this.listeners, 'icecandidate', { candidate });
  }

  public emitCandidateError(): void {
    emit(this.listeners, 'icecandidateerror', { errorCode: 701 });
  }
}

const runPageScript = (
  script: string,
): {
  peer: FakeRtcPeerConnection;
  result: Promise<unknown>;
} => {
  FakeRtcPeerConnection.latest = undefined;
  const result = runInNewContext(script, {
    RTCPeerConnection: FakeRtcPeerConnection,
    clearTimeout,
    setTimeout,
  }) as Promise<unknown>;
  const peer = FakeRtcPeerConnection.latest;
  if (!peer) throw new Error('The page script did not create its diagnostic peer.');
  return { peer, result };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('STUN-only egress diagnostic collector', () => {
  it('creates only a hardened hidden window in a unique non-persistent session', async () => {
    const harness = createHarness();
    const collector = createCollector(harness);

    const result = await collector.collect({ optIn: true });

    expectPublicCandidate(result);
    expect(harness.sessionFactory).toHaveBeenCalledTimes(1);
    const [partition, sessionOptions] = harness.sessionFactory.mock.calls[0] as [
      string,
      { cache: boolean },
    ];
    expect(partition).toBe(`${STUN_PARTITION_PREFIX}main-run-42`);
    expect(partition).not.toMatch(/^persist:/u);
    expect(sessionOptions).toEqual({ cache: false });

    const windowOptions = harness.browserWindowFactory.mock.calls[0]?.[0] as
      BrowserWindowConstructorOptions | undefined;
    expect(windowOptions).toMatchObject({
      paintWhenInitiallyHidden: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        devTools: false,
        nodeIntegration: false,
        partition,
        sandbox: true,
        session: harness.session,
        webSecurity: true,
        webviewTag: false,
      },
    });
    expect(windowOptions?.webPreferences).not.toHaveProperty('preload');
    expect(harness.loadURL).toHaveBeenCalledExactlyOnceWith(STUN_DOCUMENT_URL);
    expect(STUN_DOCUMENT_URL).toMatch(/^data:text\/html/u);
    expect(decodeURIComponent(STUN_DOCUMENT_URL)).toContain("default-src 'none'");
    expect(decodeURIComponent(STUN_DOCUMENT_URL)).not.toContain('<script');
    expect(harness.setWebRTCIPHandlingPolicy).toHaveBeenCalledExactlyOnceWith(
      STUN_WEBRTC_IP_HANDLING_POLICY,
    );
    expect(harness.setWebRTCIPHandlingPolicy).not.toHaveBeenCalledWith('default');
    expect(harness.popupHandler?.()).toEqual({ action: 'deny' });
    expect(harness.destroy).toHaveBeenCalledTimes(1);
  });

  it('denies all permissions, blocks ordinary requests, and secures a cached Session once', async () => {
    const harness = createHarness();
    const collector = createCollector(harness);

    expectPublicCandidate(await collector.collect({ optIn: true }));
    expectPublicCandidate(await collector.collect({ optIn: true }));

    expect(harness.sessionFactory).toHaveBeenCalledTimes(1);
    expect(harness.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(harness.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(harness.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(harness.permissionCheckHandler?.(null, 'geolocation', 'data:', {})).toBe(false);
    const permissionCallback = vi.fn();
    harness.permissionRequestHandler?.({}, 'media', permissionCallback, {});
    expect(permissionCallback).toHaveBeenCalledExactlyOnceWith(false);
    expect(harness.beforeRequestFilter).toEqual({
      urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'],
    });
    expect(harness.beforeRequestFilter?.urls).not.toContain('stun://*/*');
    const requestCallback = vi.fn();
    harness.beforeRequestHandler?.({ url: 'https://ordinary.example.test/' }, requestCallback);
    expect(requestCallback).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  });

  it('uses only validated main-owned STUN endpoints without TURN or credentials', async () => {
    const harness = createHarness();
    const collector = createCollector(harness, {
      stunEndpoints: [
        'STUN:Approved.Example.Test:03478?transport=UDP',
        'stuns:[2606:4700:4700::1111]:5349',
        'turn:renderer.example.test:3478',
        'turns:renderer.example.test:5349',
        'stun:user:secret@renderer.example.test:3478',
      ],
    });

    await collector.collect({
      optIn: true,
      ...({ stunEndpoints: ['turn:run-input.example.test'] } as Record<string, unknown>),
    });

    const script = harness.executeJavaScript.mock.calls[0]?.[0] as string;
    expect(script).toContain('"urls":"stun:approved.example.test:3478?transport=udp"');
    expect(script).toContain('"urls":"stuns:[2606:4700:4700::1111]:5349"');
    expect(script).not.toContain('turn:');
    expect(script).not.toContain('turns:');
    expect(script).not.toContain('username');
    expect(script).not.toContain('credential');
    expect(script).not.toContain('run-input.example.test');
    expect(script).toContain('new RTCPeerConnection');
    expect(script).toContain('createDataChannel');
    expect(script).toContain('setLocalDescription');
    expect(script).toContain("candidate.type !== 'srflx'");
    expect(script).toContain(`const maximumCandidates = ${MAX_STUN_PAGE_CANDIDATES}`);
  });

  it('prebuilds and reuses an immutable page script', async () => {
    const endpoints = ['stun:first.example.test:3478'];
    const harness = createHarness();
    const collector = createCollector(harness, { stunEndpoints: endpoints });
    endpoints[0] = 'stun:mutated.example.test:3478';

    await collector.collect({ optIn: true });
    await collector.collect({ optIn: true });

    const first = harness.executeJavaScript.mock.calls[0]?.[0] as string;
    const second = harness.executeJavaScript.mock.calls[1]?.[0] as string;
    expect(first).toBe(second);
    expect(first).toContain('stun:first.example.test:3478');
    expect(first).not.toContain('mutated.example.test');
  });

  it('short-circuits without side effects unless opted in and an endpoint is approved', async () => {
    const optedOutHarness = createHarness();
    const optedOut = createCollector(optedOutHarness);
    expectUnavailable(await optedOut.collect({ optIn: false }), 'not-opted-in');
    expectUnavailable(await optedOut.collect({ optIn: 1 as unknown as boolean }), 'not-opted-in');
    expect(optedOutHarness.sessionFactory).not.toHaveBeenCalled();
    expect(optedOutHarness.browserWindowFactory).not.toHaveBeenCalled();

    const noEndpointHarness = createHarness();
    const noEndpoint = createCollector(noEndpointHarness, {
      stunEndpoints: ['turn:not-approved.example.test', 'stun:router.local'],
    });
    expectUnavailable(await noEndpoint.collect({ optIn: true }), 'no-approved-endpoint');
    expect(noEndpointHarness.sessionFactory).not.toHaveBeenCalled();
    expect(noEndpointHarness.browserWindowFactory).not.toHaveBeenCalled();

    const productionDefaultHarness = createHarness();
    const noProductionDefault = createCollector(productionDefaultHarness, { stunEndpoints: [] });
    expectUnavailable(await noProductionDefault.collect({ optIn: true }), 'no-approved-endpoint');
  });

  it('accepts only srflx public IP tuples and strips raw SDP/candidate fields', async () => {
    const harness = createHarness({
      execute: completePage([
        { ...PUBLIC_CANDIDATE, type: 'host' },
        { ...PUBLIC_CANDIDATE, type: 'relay' },
        { address: 'host-name.local', transport: 'udp', type: 'srflx' },
        { address: '0.0.0.0', transport: 'udp', type: 'srflx' },
        { address: '10.0.0.4', transport: 'udp', type: 'srflx' },
        { address: '100.64.1.2', transport: 'udp', type: 'srflx' },
        { address: '127.0.0.1', transport: 'udp', type: 'srflx' },
        { address: '169.254.1.2', transport: 'udp', type: 'srflx' },
        { address: '224.0.0.1', transport: 'udp', type: 'srflx' },
        { address: '::', transport: 'udp', type: 'srflx' },
        { address: '::1', transport: 'udp', type: 'srflx' },
        { address: 'fc00::1', transport: 'udp', type: 'srflx' },
        { address: 'fe80::1', transport: 'udp', type: 'srflx' },
        { address: 'ff02::1', transport: 'udp', type: 'srflx' },
        { address: '2001::1', transport: 'udp', type: 'srflx' },
        { address: '2001:db8::1', transport: 'udp', type: 'srflx' },
        { address: '2002::1', transport: 'udp', type: 'srflx' },
        { address: '3fff::1', transport: 'udp', type: 'srflx' },
        { address: '8.8.4.4', transport: 'sctp', type: 'srflx' },
        {
          address: '8.8.4.4',
          candidate: 'candidate:raw-secret',
          rawSdp: 'v=0 raw-secret',
          transport: 'UDP',
          type: 'srflx',
        },
        {
          address: '2606:4700:4700:0:0:0:0:1111',
          completeCandidate: 'candidate:other-secret',
          transport: 'TCP',
          type: 'srflx',
        },
        { address: '8.8.4.4', transport: 'udp', type: 'srflx' },
      ]),
    });

    const result = await createCollector(harness).collect({ optIn: true });

    expect(result).toEqual({
      candidates: [
        { address: '8.8.4.4', family: 'ipv4', transport: 'udp' },
        { address: '2606:4700:4700::1111', family: 'ipv6', transport: 'tcp' },
      ],
      scope: STUN_DIAGNOSTIC_SCOPE,
      status: 'available',
    });
    expect(JSON.stringify(result)).not.toContain('candidate:');
    expect(JSON.stringify(result)).not.toContain('v=0');
    if (result.status === 'available') {
      for (const candidate of result.candidates) {
        expect(Object.keys(candidate).sort()).toEqual(['address', 'family', 'transport']);
      }
    }
  });

  it('distinguishes successful no-candidate collection from ICE candidate errors', async () => {
    const noCandidateHarness = createHarness({ execute: completePage([]) });
    expectUnavailable(
      await createCollector(noCandidateHarness).collect({ optIn: true }),
      'no-public-candidate',
    );

    const iceErrorHarness = createHarness({
      execute: { candidates: [], outcome: 'icecandidate-error' },
    });
    expectUnavailable(await createCollector(iceErrorHarness).collect({ optIn: true }), 'failed');

    const recoveredHarness = createHarness({
      execute: { candidates: [PUBLIC_CANDIDATE], outcome: 'icecandidate-error' },
    });
    expectPublicCandidate(await createCollector(recoveredHarness).collect({ optIn: true }));
  });

  it('accepts only a plain page-result record at the executeJavaScript boundary', async () => {
    const arrayHarness = createHarness({ execute: [PUBLIC_CANDIDATE] });
    expectUnavailable(await createCollector(arrayHarness).collect({ optIn: true }), 'failed');

    class PageEnvelope {
      public readonly candidates = [PUBLIC_CANDIDATE];
      public readonly outcome = 'complete';
    }
    const classHarness = createHarness({ execute: new PageEnvelope() });
    expectUnavailable(await createCollector(classHarness).collect({ optIn: true }), 'failed');

    class CandidateRecord {
      public readonly address = '8.8.8.8';
      public readonly transport = 'udp';
      public readonly type = 'srflx';
    }
    const classCandidateHarness = createHarness({
      execute: completePage([new CandidateRecord()]),
    });
    expectUnavailable(
      await createCollector(classCandidateHarness).collect({ optIn: true }),
      'no-public-candidate',
    );

    const nullPrototypeCandidate = Object.assign(
      Object.create(null) as Record<string, unknown>,
      PUBLIC_CANDIDATE,
    );
    const nullPrototypePage = Object.assign(Object.create(null) as Record<string, unknown>, {
      candidates: [nullPrototypeCandidate],
      outcome: 'complete',
    });
    expectPublicCandidate(
      await createCollector(createHarness({ execute: nullPrototypePage })).collect({ optIn: true }),
    );
  });

  it('destroys the window on no-candidate, script failure, and load failure paths', async () => {
    const noCandidateHarness = createHarness({ execute: completePage([]) });
    expectUnavailable(
      await createCollector(noCandidateHarness).collect({ optIn: true }),
      'no-public-candidate',
    );
    expect(noCandidateHarness.destroy).toHaveBeenCalledTimes(1);

    const scriptFailureHarness = createHarness({ execute: Promise.reject(new Error('script')) });
    expectUnavailable(
      await createCollector(scriptFailureHarness).collect({ optIn: true }),
      'failed',
    );
    expect(scriptFailureHarness.destroy).toHaveBeenCalledTimes(1);

    const loadFailureHarness = createHarness({ load: Promise.reject(new Error('load')) });
    expectUnavailable(await createCollector(loadFailureHarness).collect({ optIn: true }), 'failed');
    expect(loadFailureHarness.executeJavaScript).not.toHaveBeenCalled();
    expect(loadFailureHarness.destroy).toHaveBeenCalledTimes(1);
  });

  it('uses renderer crash state when executeJavaScript throws synchronously', async () => {
    const harness = createHarness();
    harness.executeJavaScript.mockImplementation(() => {
      harness.isContentsCrashed.mockReturnValue(true);
      throw new Error('renderer disconnected');
    });

    expectUnavailable(
      await createCollector(harness).collect({ optIn: true }),
      'render-process-gone',
    );
    expect(harness.destroy).toHaveBeenCalledTimes(1);
  });

  it('lets a queued renderer-gone event beat a generic executeJavaScript rejection', async () => {
    const pending = deferred<unknown>();
    const harness = createHarness({ execute: pending.promise });
    const collection = createCollector(harness).collect({ optIn: true });
    await flushPromises();
    const rendererEvent = new Promise<void>((resolve) => {
      setImmediate(() => {
        harness.emitContents('render-process-gone', {}, { reason: 'crashed' });
        resolve();
      });
    });

    pending.reject(new Error('renderer disconnected'));

    expectUnavailable(await collection, 'render-process-gone');
    await rendererEvent;
    expect(harness.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['render-process-gone', 'render-process-gone'],
    ['unresponsive', 'unresponsive'],
  ] as const)('destroys the window when the renderer reports %s', async (event, reason) => {
    const pending = deferred<unknown>();
    const harness = createHarness({ execute: pending.promise });
    const collection = createCollector(harness).collect({ optIn: true });
    await flushPromises();

    harness.emitContents(event, {}, { reason: 'crashed' });

    expectUnavailable(await collection, reason);
    expect(harness.destroy).toHaveBeenCalledTimes(1);
    pending.resolve(completePage());
  });

  it('prevents navigation and destroys instead of closing', async () => {
    const pending = deferred<unknown>();
    const harness = createHarness({ execute: pending.promise });
    const collection = createCollector(harness).collect({ optIn: true });
    await flushPromises();
    const event = { preventDefault: vi.fn() };

    harness.emitContents('will-navigate', event, 'https://escape.example.test');

    expectUnavailable(await collection, 'navigation-attempt');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.destroy).toHaveBeenCalledTimes(1);
    pending.resolve(completePage());
  });

  it('enforces the timer deadline and ignores a stale late script result', async () => {
    vi.useFakeTimers();
    const pending = deferred<unknown>();
    const harness = createHarness({ execute: pending.promise });
    const collection = createCollector(harness, { timeoutMs: 25 }).collect({ optIn: true });
    await flushPromises();

    await vi.advanceTimersByTimeAsync(25);
    expectUnavailable(await collection, 'timeout');
    expect(harness.destroy).toHaveBeenCalledTimes(1);

    pending.resolve(completePage());
    await flushPromises();
    expect(harness.destroy).toHaveBeenCalledTimes(1);
    expect(harness.browserWindowFactory).toHaveBeenCalledTimes(1);
  });

  it('uses monotonic post-await checks before window, script, and successful return work', async () => {
    let now = 0;
    const sessionPending = deferred<Session>();
    const sessionHarness = createHarness();
    sessionHarness.sessionFactory.mockImplementationOnce(() => sessionPending.promise);
    const afterSession = createCollector(sessionHarness, {
      monotonicNow: () => now,
      timeoutMs: 25,
    }).collect({ optIn: true });
    await flushPromises();
    now = 25;
    sessionPending.resolve(sessionHarness.session);
    expectUnavailable(await afterSession, 'timeout');
    expect(sessionHarness.browserWindowFactory).not.toHaveBeenCalled();
    expect(sessionHarness.setPermissionCheckHandler).not.toHaveBeenCalled();

    now = 0;
    const loadPending = deferred<void>();
    const loadHarness = createHarness({ load: loadPending.promise });
    const afterLoad = createCollector(loadHarness, {
      monotonicNow: () => now,
      timeoutMs: 25,
    }).collect({ optIn: true });
    await flushPromises();
    now = 25;
    loadPending.resolve();
    expectUnavailable(await afterLoad, 'timeout');
    expect(loadHarness.executeJavaScript).not.toHaveBeenCalled();

    now = 0;
    const scriptPending = deferred<unknown>();
    const scriptHarness = createHarness({ execute: scriptPending.promise });
    const afterScript = createCollector(scriptHarness, {
      monotonicNow: () => now,
      timeoutMs: 25,
    }).collect({ optIn: true });
    await flushPromises();
    now = 25;
    scriptPending.resolve(completePage());
    expectUnavailable(await afterScript, 'timeout');
  });

  it('keeps terminal reason precedence deterministic across abort, deadline, and renderer races', async () => {
    let now = 0;
    const abortFirstPending = deferred<unknown>();
    const abortFirstHarness = createHarness({ execute: abortFirstPending.promise });
    const abortFirstController = new AbortController();
    const abortFirst = createCollector(abortFirstHarness, {
      monotonicNow: () => now,
      timeoutMs: 25,
    }).collect({ optIn: true, signal: abortFirstController.signal });
    await flushPromises();
    abortFirstController.abort();
    now = 25;
    abortFirstHarness.emitContents('render-process-gone');
    expectUnavailable(await abortFirst, 'aborted');
    abortFirstPending.resolve(completePage());

    now = 0;
    const rendererFirstPending = deferred<unknown>();
    const rendererFirstHarness = createHarness({ execute: rendererFirstPending.promise });
    const rendererFirstController = new AbortController();
    const rendererFirst = createCollector(rendererFirstHarness, {
      monotonicNow: () => now,
      timeoutMs: 25,
    }).collect({ optIn: true, signal: rendererFirstController.signal });
    await flushPromises();
    rendererFirstHarness.emitContents('render-process-gone');
    rendererFirstController.abort();
    expectUnavailable(await rendererFirst, 'render-process-gone');
    rendererFirstPending.resolve(completePage());

    now = 0;
    const lateAbortPending = deferred<unknown>();
    const lateAbortHarness = createHarness({ execute: lateAbortPending.promise });
    const lateAbortController = new AbortController();
    const lateAbort = createCollector(lateAbortHarness, {
      monotonicNow: () => now,
      timeoutMs: 25,
    }).collect({ optIn: true, signal: lateAbortController.signal });
    await flushPromises();
    now = 25;
    lateAbortController.abort();
    lateAbortHarness.emitContents('render-process-gone');
    expectUnavailable(await lateAbort, 'timeout');
    lateAbortPending.resolve(completePage());
  });

  it('does not start STUN traffic when abort wins after page load settles', async () => {
    const load = deferred<void>();
    const harness = createHarness({ load: load.promise });
    const controller = new AbortController();
    const collection = createCollector(harness).collect({
      optIn: true,
      signal: controller.signal,
    });
    await flushPromises();
    expect(harness.loadURL).toHaveBeenCalledTimes(1);

    load.resolve();
    controller.abort();

    expectUnavailable(await collection, 'aborted');
    expect(harness.executeJavaScript).not.toHaveBeenCalled();
    expect(harness.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys on caller abort and app-quit disposal through idempotent dispose()', async () => {
    const abortPending = deferred<unknown>();
    const abortHarness = createHarness({ execute: abortPending.promise });
    const abortController = new AbortController();
    const aborted = createCollector(abortHarness).collect({
      optIn: true,
      signal: abortController.signal,
    });
    await flushPromises();
    abortController.abort();
    expectUnavailable(await aborted, 'aborted');
    expect(abortHarness.destroy).toHaveBeenCalledTimes(1);
    abortPending.resolve(completePage());

    const disposePending = deferred<unknown>();
    const disposeHarness = createHarness({ execute: disposePending.promise });
    const collector = createCollector(disposeHarness);
    const disposed = collector.collect({ optIn: true });
    await flushPromises();
    collector.dispose();
    collector.dispose();
    expectUnavailable(await disposed, 'disposed');
    expect(disposeHarness.destroy).toHaveBeenCalledTimes(1);
    expectUnavailable(await collector.collect({ optIn: true }), 'disposed');
    expect(disposeHarness.browserWindowFactory).toHaveBeenCalledTimes(1);
    disposePending.resolve(completePage());
  });

  it('rejects overlapping collections without creating another window', async () => {
    const pending = deferred<unknown>();
    const harness = createHarness({ execute: pending.promise });
    const controller = new AbortController();
    const collector = createCollector(harness);
    const first = collector.collect({ optIn: true, signal: controller.signal });
    await flushPromises();

    expectUnavailable(await collector.collect({ optIn: true }), 'busy');
    expect(harness.browserWindowFactory).toHaveBeenCalledTimes(1);

    controller.abort();
    expectUnavailable(await first, 'aborted');
    expect(harness.destroy).toHaveBeenCalledTimes(1);
    pending.resolve(completePage());
  });

  it('destroys late window factory results after disposal and timeout', async () => {
    const disposalCreation = deferred<BrowserWindow>();
    const disposalHarness = createHarness();
    disposalHarness.browserWindowFactory.mockImplementation(() => disposalCreation.promise);
    const collector = createCollector(disposalHarness);
    const disposed = collector.collect({ optIn: true });
    await flushPromises();
    collector.dispose();
    expectUnavailable(await disposed, 'disposed');
    disposalCreation.resolve(disposalHarness.window);
    await flushPromises();
    expect(disposalHarness.destroy).toHaveBeenCalledTimes(1);
    expect(disposalHarness.loadURL).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const timeoutCreation = deferred<BrowserWindow>();
    const timeoutHarness = createHarness();
    timeoutHarness.browserWindowFactory.mockImplementation(() => timeoutCreation.promise);
    const timedOut = createCollector(timeoutHarness, { timeoutMs: 25 }).collect({ optIn: true });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(25);
    expectUnavailable(await timedOut, 'timeout');
    timeoutCreation.resolve(timeoutHarness.window);
    await flushPromises();
    expect(timeoutHarness.destroy).toHaveBeenCalledTimes(1);
    expect(timeoutHarness.loadURL).not.toHaveBeenCalled();
  });

  it('replaces timed-out, aborted, and failed Session acquisitions without stale poisoning', async () => {
    vi.useFakeTimers();
    const timeoutPending = deferred<Session>();
    const timeoutHarness = createHarness();
    timeoutHarness.sessionFactory.mockImplementationOnce(() => timeoutPending.promise);
    const timeoutCollector = createCollector(timeoutHarness, { timeoutMs: 25 });
    const firstTimedOut = timeoutCollector.collect({ optIn: true });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(25);
    expectUnavailable(await firstTimedOut, 'timeout');
    expectPublicCandidate(await timeoutCollector.collect({ optIn: true }));
    expect(timeoutHarness.sessionFactory).toHaveBeenCalledTimes(2);
    timeoutPending.resolve(timeoutHarness.session);
    await flushPromises();
    expect(timeoutHarness.setPermissionCheckHandler).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    const abortPending = deferred<Session>();
    const abortHarness = createHarness();
    abortHarness.sessionFactory.mockImplementationOnce(() => abortPending.promise);
    const abortCollector = createCollector(abortHarness);
    const abortController = new AbortController();
    const firstAborted = abortCollector.collect({ optIn: true, signal: abortController.signal });
    await flushPromises();
    abortController.abort();
    expectUnavailable(await firstAborted, 'aborted');
    expectPublicCandidate(await abortCollector.collect({ optIn: true }));
    expect(abortHarness.sessionFactory).toHaveBeenCalledTimes(2);
    abortPending.reject(new Error('late stale rejection'));
    await flushPromises();

    const failedHarness = createHarness();
    failedHarness.sessionFactory.mockRejectedValueOnce(new Error('factory failure'));
    const failedCollector = createCollector(failedHarness);
    expectUnavailable(await failedCollector.collect({ optIn: true }), 'failed');
    expectPublicCandidate(await failedCollector.collect({ optIn: true }));
    expect(failedHarness.sessionFactory).toHaveBeenCalledTimes(2);
  });
});

describe('STUN endpoint and page result validation', () => {
  it('normalizes only credential-free globally addressed STUN schemes', () => {
    expect(normalizeApprovedStunEndpoint('STUN:Example.COM:03478?transport=TCP')).toBe(
      'stun:example.com:3478?transport=tcp',
    );
    expect(normalizeApprovedStunEndpoint('stuns:[2606:4700:4700::1111]:5349')).toBe(
      'stuns:[2606:4700:4700::1111]:5349',
    );
    expect(normalizeApprovedStunEndpoint('stuns:example.com:5349?transport=TCP')).toBe(
      'stuns:example.com:5349?transport=tcp',
    );
    expect(normalizeApprovedStunEndpoint('stuns:example.com:5349?transport=udp')).toBeUndefined();
    expect(normalizeApprovedStunEndpoint('turn:example.com')).toBeUndefined();
    expect(normalizeApprovedStunEndpoint('stun:user:secret@example.com')).toBeUndefined();
    expect(normalizeApprovedStunEndpoint('stun://example.com')).toBeUndefined();
    expect(normalizeApprovedStunEndpoint('stun:example.com:')).toBeUndefined();
  });

  it('rejects local/LAN IP literals and local hostname namespaces', () => {
    for (const endpoint of [
      'stun:0.0.0.0',
      'stun:10.0.0.1',
      'stun:100.64.0.1',
      'stun:127.0.0.1',
      'stun:169.254.1.1',
      'stun:172.16.0.1',
      'stun:192.168.0.1',
      'stun:224.0.0.1',
      'stun:[::]',
      'stun:[::1]',
      'stun:[fc00::1]',
      'stun:[fe80::1]',
      'stun:[ff02::1]',
      'stun:localhost',
      'stun:worker.localhost',
      'stun:printer.local',
      'stun:home.arpa',
      'stun:router.office.home.arpa',
      'stun:intranet',
    ]) {
      expect(normalizeApprovedStunEndpoint(endpoint), endpoint).toBeUndefined();
    }
    expect(normalizeApprovedStunEndpoint('stun:stun.example.com')).toBe('stun:stun.example.com');
    expect(normalizeApprovedStunEndpoint('stun:8.8.8.8')).toBe('stun:8.8.8.8');
  });

  it('canonicalizes equivalent IPv4 and IPv6 endpoint literals before deduplication', () => {
    expect(
      approvedStunEndpoints([
        'stun:008.008.008.008:03478',
        'stun:8.8.8.8:3478',
        'stun:[2606:4700:4700:0:0:0:0:1111]:3478',
        'stun:[2606:4700:4700::1111]:3478',
      ]),
    ).toEqual(['stun:8.8.8.8:3478', 'stun:[2606:4700:4700::1111]:3478']);
  });

  it('bounds URI length, inspected inputs, and approved endpoint count', () => {
    expect(
      normalizeApprovedStunEndpoint(`stun:${'a'.repeat(MAX_STUN_ENDPOINT_URI_LENGTH)}.example.com`),
    ).toBeUndefined();

    const beyondInputBound = Array.from(
      { length: MAX_STUN_ENDPOINT_INPUTS + 1 },
      (_value, index) =>
        index === MAX_STUN_ENDPOINT_INPUTS ? 'stun:late.example.com' : 'turn:invalid.example.com',
    );
    const guardedInputs = new Proxy(beyondInputBound, {
      get(target, property, receiver) {
        if (property === String(MAX_STUN_ENDPOINT_INPUTS)) {
          throw new Error('read beyond configured input bound');
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(() => approvedStunEndpoints(guardedInputs)).not.toThrow();
    expect(approvedStunEndpoints(guardedInputs)).toEqual([]);

    const unique = Array.from(
      { length: MAX_APPROVED_STUN_ENDPOINTS + 5 },
      (_value, index) => `stun:server-${index}.example.com`,
    );
    const approved = approvedStunEndpoints(unique);
    expect(approved).toHaveLength(MAX_APPROVED_STUN_ENDPOINTS);
    expect(approved[0]).toBe('stun:server-0.example.com');
    expect(approved.at(-1)).toBe(`stun:server-${MAX_APPROVED_STUN_ENDPOINTS - 1}.example.com`);
  });

  it('implements the required IPv4 and IPv6 IANA global-address exceptions', () => {
    const accepted = sanitizeStunPageCandidates([
      { address: '192.0.0.9', transport: 'udp', type: 'srflx' },
      { address: '192.0.0.10', transport: 'udp', type: 'srflx' },
      { address: '2001:1::1', transport: 'udp', type: 'srflx' },
      { address: '2001:1::2', transport: 'udp', type: 'srflx' },
      { address: '2001:1::3', transport: 'udp', type: 'srflx' },
      { address: '2001:3::1234', transport: 'udp', type: 'srflx' },
      { address: '2001:4:112::1', transport: 'udp', type: 'srflx' },
      { address: '2001:20::1', transport: 'udp', type: 'srflx' },
      { address: '2001:30::1', transport: 'udp', type: 'srflx' },
      { address: '2620:4f:8000::1', transport: 'udp', type: 'srflx' },
      { address: '192.0.0.8', transport: 'udp', type: 'srflx' },
      { address: '192.0.0.11', transport: 'udp', type: 'srflx' },
      { address: '2001::1', transport: 'udp', type: 'srflx' },
      { address: '2001:1::4', transport: 'udp', type: 'srflx' },
      { address: '2001:db8::1', transport: 'udp', type: 'srflx' },
      { address: '2002::1', transport: 'udp', type: 'srflx' },
      { address: '3fff::1', transport: 'udp', type: 'srflx' },
    ]);

    expect(accepted.map(({ address }) => address)).toEqual([
      '192.0.0.9',
      '192.0.0.10',
      '2001:1::1',
      '2001:1::2',
      '2001:1::3',
      '2001:3::1234',
      '2001:4:112::1',
      '2001:20::1',
      '2001:30::1',
      '2620:4f:8000::1',
    ]);
    expect(normalizeApprovedStunEndpoint('stun:192.0.0.9')).toBe('stun:192.0.0.9');
    expect(normalizeApprovedStunEndpoint('stun:[2620:4f:8000::1]')).toBe('stun:[2620:4f:8000::1]');
    expect(normalizeApprovedStunEndpoint('stun:192.0.0.8')).toBeUndefined();
    expect(normalizeApprovedStunEndpoint('stun:[2001:db8::1]')).toBeUndefined();
  });

  it('main-side validation accepts only plain srflx records and remains bounded', () => {
    class CandidateRecord {
      public readonly address = '8.8.8.8';
      public readonly transport = 'udp';
      public readonly type = 'srflx';
    }
    expect(
      sanitizeStunPageCandidates([
        { address: '192.168.1.1', transport: 'udp', type: 'srflx' },
        { address: '8.8.8.8', transport: 'udp', type: 'host' },
        new CandidateRecord(),
        { address: '8.8.8.8', rawSdp: 'secret', transport: 'UDP', type: 'srflx' },
        { address: '008.008.008.008', transport: 'udp', type: 'srflx' },
      ]),
    ).toEqual([{ address: '8.8.8.8', family: 'ipv4', transport: 'udp' }]);
    expect(sanitizeStunPageCandidates({ candidates: [PUBLIC_CANDIDATE] })).toEqual([]);

    const validAfterBound = [
      ...Array.from({ length: MAX_STUN_PAGE_CANDIDATES }, () => null),
      PUBLIC_CANDIDATE,
    ];
    expect(sanitizeStunPageCandidates(validAfterBound)).toEqual([]);
  });
});

describe('STUN page collector script', () => {
  it('deduplicates srflx tuples and finishes at 32 before returning across IPC', async () => {
    const { peer, result } = runPageScript(
      buildStunCollectionScript(['stun:stun.example.com:3478'], 1_000),
    );
    const first = { address: '203.0.113.1', protocol: 'UDP', type: 'srflx' };
    peer.emitCandidate(first);
    peer.emitCandidate(first);
    for (let index = 2; index <= MAX_STUN_PAGE_CANDIDATES; index += 1) {
      peer.emitCandidate({
        address: `203.0.113.${index}`,
        protocol: 'udp',
        type: 'srflx',
      });
    }

    const pageResult = result as Promise<{
      candidates: unknown[];
      outcome: string;
    }>;
    const value = await pageResult;
    expect(value.outcome).toBe('complete');
    expect(value.candidates).toHaveLength(MAX_STUN_PAGE_CANDIDATES);
    expect(peer.close).toHaveBeenCalledTimes(1);

    peer.emitCandidate({ address: '203.0.113.99', protocol: 'udp', type: 'srflx' });
    expect(value.candidates).toHaveLength(MAX_STUN_PAGE_CANDIDATES);
  });

  it('reports icecandidateerror only when no successful srflx tuple exists', async () => {
    const failedRun = runPageScript(
      buildStunCollectionScript(['stun:stun.example.com:3478'], 1_000),
    );
    failedRun.peer.emitCandidateError();
    failedRun.peer.emitCandidate(null);
    await expect(failedRun.result).resolves.toMatchObject({
      candidates: [],
      outcome: 'icecandidate-error',
    });

    const recoveredRun = runPageScript(
      buildStunCollectionScript(['stun:stun.example.com:3478'], 1_000),
    );
    recoveredRun.peer.emitCandidateError();
    recoveredRun.peer.emitCandidate({
      address: '8.8.8.8',
      protocol: 'UDP',
      type: 'srflx',
    });
    recoveredRun.peer.emitCandidate(null);
    await expect(recoveredRun.result).resolves.toMatchObject({
      candidates: [PUBLIC_CANDIDATE],
      outcome: 'icecandidate-error',
    });

    const cleanEmptyRun = runPageScript(
      buildStunCollectionScript(['stun:stun.example.com:3478'], 1_000),
    );
    cleanEmptyRun.peer.emitCandidate(null);
    await expect(cleanEmptyRun.result).resolves.toMatchObject({
      candidates: [],
      outcome: 'complete',
    });
  });
});
