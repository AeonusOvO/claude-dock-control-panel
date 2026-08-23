import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Event as ElectronEvent,
  FromPartitionOptions,
  Session,
} from 'electron';
import type { EgressAddressFamily } from '../../../shared/contracts/egress-diagnostics';

export const STUN_PARTITION_PREFIX = 'claudedock-egress-stun-';
export const STUN_WEBRTC_IP_HANDLING_POLICY = 'default_public_interface_only' as const;
export const STUN_DIAGNOSTIC_SCOPE = 'diagnostic-window-only' as const;
export const MAX_STUN_ENDPOINT_INPUTS = 64;
export const MAX_APPROVED_STUN_ENDPOINTS = 16;
export const MAX_STUN_ENDPOINT_URI_LENGTH = 2_048;
export const MAX_STUN_PAGE_CANDIDATES = 32;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PAGE_COLLECTION_MS = 5_000;
const MAX_IP_LITERAL_LENGTH = 64;
const ORDINARY_REQUEST_FILTER = {
  urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'],
};
const STUN_DOCUMENT = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; font-src 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'">
<title>STUN diagnostic</title>`;

export const STUN_DOCUMENT_URL = `data:text/html;charset=UTF-8,${encodeURIComponent(STUN_DOCUMENT)}`;

export interface StunDiagnosticCandidate {
  readonly address: string;
  readonly family: EgressAddressFamily;
  readonly transport: 'tcp' | 'udp';
}

export type StunDiagnosticUnavailableReason =
  | 'aborted'
  | 'busy'
  | 'disposed'
  | 'failed'
  | 'navigation-attempt'
  | 'no-approved-endpoint'
  | 'no-public-candidate'
  | 'not-opted-in'
  | 'render-process-gone'
  | 'timeout'
  | 'unresponsive';

/**
 * This result describes only the isolated diagnostic BrowserWindow's WebRTC route. It must not be
 * presented as evidence of the application Session's HTTP(S) proxy egress.
 */
export type StunDiagnosticResult =
  | {
      candidates: readonly StunDiagnosticCandidate[];
      scope: typeof STUN_DIAGNOSTIC_SCOPE;
      status: 'available';
    }
  | {
      reason: StunDiagnosticUnavailableReason;
      scope: typeof STUN_DIAGNOSTIC_SCOPE;
      status: 'unavailable';
    };

export interface StunCollectionRequest {
  /** This must be the trusted main-process caller's explicit user opt-in decision. */
  optIn: boolean;
  /** Aborting this signal represents caller disconnect/cancellation. */
  signal?: AbortSignal;
}

export type StunSessionFactory = (
  partition: string,
  options: FromPartitionOptions,
) => Promise<Session> | Session;
export type StunBrowserWindowFactory = (
  options: BrowserWindowConstructorOptions,
) => BrowserWindow | Promise<BrowserWindow>;

export interface StunDiagnosticCollectorOptions {
  /** Main-owned configuration. Collection requests cannot replace this list. */
  stunEndpoints?: readonly string[];
  timeoutMs?: number;
  pageCollectionMs?: number;
  sessionFactory?: StunSessionFactory;
  browserWindowFactory?: StunBrowserWindowFactory;
  partitionSuffixFactory?: () => string;
  /** Injectable only for deterministic deadline checks; production uses performance.now(). */
  monotonicNow?: () => number;
}

interface PlainRecord {
  [key: string]: unknown;
}

interface PageCandidate extends PlainRecord {
  address?: unknown;
  transport?: unknown;
  type?: unknown;
}

interface SessionAcquisition {
  readonly promise: Promise<Session>;
}

interface WindowCreationGuard {
  destroyed: boolean;
  state: 'claimed' | 'pending' | 'stale';
}

interface ActiveCollection {
  abortListener?: () => void;
  detachWindowListeners?: () => void;
  readonly resolveTerminal: (result: StunDiagnosticResult) => void;
  readonly signal?: AbortSignal;
  readonly startedAt: number;
  readonly terminalPromise: Promise<StunDiagnosticResult>;
  terminalResult?: StunDiagnosticResult;
  timeout?: ReturnType<typeof setTimeout>;
  window?: BrowserWindow;
  windowCreationGuard?: WindowCreationGuard;
  windowDestroyed: boolean;
}

type StageResult<T> =
  | { kind: 'failed' }
  | { kind: 'terminal'; result: StunDiagnosticResult }
  | { kind: 'value'; value: T };

const unavailable = (reason: StunDiagnosticUnavailableReason): StunDiagnosticResult =>
  Object.freeze({
    reason,
    scope: STUN_DIAGNOSTIC_SCOPE,
    status: 'unavailable',
  });

const available = (candidates: readonly StunDiagnosticCandidate[]): StunDiagnosticResult =>
  Object.freeze({
    candidates,
    scope: STUN_DIAGNOSTIC_SCOPE,
    status: 'available',
  });

const boundedDuration = (value: number | undefined, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(60_000, Math.floor(value)));
};

const monotonicTimestamp = (clock: () => number): number => {
  try {
    return clock();
  } catch {
    return Number.NaN;
  }
};

const isPlainRecord = (value: unknown): value is PlainRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const hasOwn = (record: PlainRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const canonicalIpv4 = (address: string): string | undefined => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address)) return undefined;
  const octets = address.split('.').map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return octets.join('.');
};

const canonicalIpv6 = (address: string): string | undefined => {
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return undefined;
  }
};

const ipv4Number = (address: string): number =>
  address.split('.').reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);

const matchesIpv4Range = (value: number, base: number, mask: number): boolean =>
  (value & mask) >>> 0 === (base & mask) >>> 0;

const isPublicIpv4 = (address: string): boolean => {
  const value = ipv4Number(address);
  if (value === 0xc0000009 || value === 0xc000000a) return true;
  const blockedRanges = [
    [0x00000000, 0xff000000],
    [0x0a000000, 0xff000000],
    [0x64400000, 0xffc00000],
    [0x7f000000, 0xff000000],
    [0xa9fe0000, 0xffff0000],
    [0xac100000, 0xfff00000],
    [0xc0000000, 0xffffff00],
    [0xc0000200, 0xffffff00],
    [0xc0a80000, 0xffff0000],
    [0xc0586300, 0xffffff00],
    [0xc6120000, 0xfffe0000],
    [0xc6336400, 0xffffff00],
    [0xcb007100, 0xffffff00],
    [0xe0000000, 0xf0000000],
    [0xf0000000, 0xf0000000],
  ] as const;
  return !blockedRanges.some(([base, mask]) => matchesIpv4Range(value, base, mask));
};

const ipv6Words = (address: string): readonly number[] | undefined => {
  const pieces = address.split('::');
  if (pieces.length > 2) return undefined;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || missing < 0) return undefined;
  const words = [...left, ...Array<string>(missing).fill('0'), ...right].map((word) =>
    Number.parseInt(word, 16),
  );
  return words.length === 8 && words.every((word) => Number.isInteger(word)) ? words : undefined;
};

const matchesIpv6Prefix = (
  words: readonly number[],
  prefix: readonly number[],
  prefixLength: number,
): boolean => {
  let remainingBits = prefixLength;
  for (let index = 0; remainingBits > 0; index += 1) {
    const comparedBits = Math.min(16, remainingBits);
    const mask = comparedBits === 16 ? 0xffff : (0xffff << (16 - comparedBits)) & 0xffff;
    if (((words[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
    remainingBits -= comparedBits;
  }
  return true;
};

const REACHABLE_2001_0000_23_IPV6_PREFIXES = Object.freeze([
  Object.freeze({ prefix: Object.freeze([0x2001, 0x0001, 0, 0, 0, 0, 0, 1]), prefixLength: 128 }),
  Object.freeze({ prefix: Object.freeze([0x2001, 0x0001, 0, 0, 0, 0, 0, 2]), prefixLength: 128 }),
  Object.freeze({ prefix: Object.freeze([0x2001, 0x0001, 0, 0, 0, 0, 0, 3]), prefixLength: 128 }),
  Object.freeze({ prefix: Object.freeze([0x2001, 0x0003]), prefixLength: 32 }),
  Object.freeze({ prefix: Object.freeze([0x2001, 0x0004, 0x0112]), prefixLength: 48 }),
  Object.freeze({ prefix: Object.freeze([0x2001, 0x0020]), prefixLength: 28 }),
  Object.freeze({ prefix: Object.freeze([0x2001, 0x0030]), prefixLength: 28 }),
]);

const isPublicIpv6 = (address: string): boolean => {
  const words = ipv6Words(address);
  if (!words) return false;
  const first = words[0] ?? 0;
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const ipv4Embedded =
    words.slice(0, 5).every((word) => word === 0) && (words[5] === 0 || words[5] === 0xffff);
  if (
    allZero ||
    loopback ||
    ipv4Embedded ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first & 0xe000) !== 0x2000
  ) {
    return false;
  }

  const insideReserved2001Block = matchesIpv6Prefix(words, [0x2001, 0x0000], 23);
  if (
    insideReserved2001Block &&
    !REACHABLE_2001_0000_23_IPV6_PREFIXES.some(({ prefix, prefixLength }) =>
      matchesIpv6Prefix(words, prefix, prefixLength),
    )
  ) {
    return false;
  }

  return !(
    matchesIpv6Prefix(words, [0x2001, 0x0db8], 32) ||
    matchesIpv6Prefix(words, [0x2002], 16) ||
    matchesIpv6Prefix(words, [0x3fff, 0x0000], 20)
  );
};

const normalizePublicAddress = (
  rawAddress: unknown,
): Pick<StunDiagnosticCandidate, 'address' | 'family'> | undefined => {
  if (
    typeof rawAddress !== 'string' ||
    rawAddress.length === 0 ||
    rawAddress.length > MAX_IP_LITERAL_LENGTH ||
    rawAddress !== rawAddress.trim() ||
    rawAddress.includes('%')
  ) {
    return undefined;
  }
  const ipv4 = canonicalIpv4(rawAddress);
  if (ipv4) return isPublicIpv4(ipv4) ? { address: ipv4, family: 'ipv4' } : undefined;
  if (isIP(rawAddress) === 6) {
    const address = canonicalIpv6(rawAddress);
    return address && isPublicIpv6(address) ? { address, family: 'ipv6' } : undefined;
  }
  return undefined;
};

const normalizeHostname = (hostname: string): string | undefined => {
  if (hostname.length === 0 || hostname.length > 253) return undefined;
  const labels = hostname.toLowerCase().split('.');
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    return undefined;
  }
  const normalized = labels.join('.');
  const blockedSuffixes = ['local', 'localhost', 'home.arpa'] as const;
  if (
    blockedSuffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`))
  ) {
    return undefined;
  }
  return normalized;
};

const hasForbiddenUriCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** Returns a canonical, globally addressed STUN/STUNS URI, or undefined for unsafe input. */
export const normalizeApprovedStunEndpoint = (value: unknown): string | undefined => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_STUN_ENDPOINT_URI_LENGTH ||
    value !== value.trim() ||
    hasForbiddenUriCharacter(value)
  ) {
    return undefined;
  }
  const schemeMatch = /^(stun|stuns):(.*)$/iu.exec(value);
  if (!schemeMatch) return undefined;
  const scheme = schemeMatch[1]?.toLowerCase();
  const remainder = schemeMatch[2];
  if (!scheme || !remainder || remainder.startsWith('//') || /[@/#\\]/u.test(remainder)) {
    return undefined;
  }

  const queryIndex = remainder.indexOf('?');
  const authority = queryIndex < 0 ? remainder : remainder.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : remainder.slice(queryIndex + 1);
  if (query && !/^transport=(?:tcp|udp)$/iu.test(query)) return undefined;
  const normalizedQueryValue = query.toLowerCase();
  if (scheme === 'stuns' && normalizedQueryValue === 'transport=udp') return undefined;

  let host: string;
  let port: string;
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']');
    if (closingBracket < 0) return undefined;
    const literal = authority.slice(1, closingBracket);
    if (literal.includes('%') || isIP(literal) !== 6) return undefined;
    const normalizedAddress = canonicalIpv6(literal);
    if (!normalizedAddress || !isPublicIpv6(normalizedAddress)) return undefined;
    host = `[${normalizedAddress}]`;
    const suffix = authority.slice(closingBracket + 1);
    if (suffix && !/^:\d+$/u.test(suffix)) return undefined;
    port = suffix.slice(1);
  } else {
    const separator = authority.lastIndexOf(':');
    const hostValue = separator < 0 ? authority : authority.slice(0, separator);
    port = separator < 0 ? '' : authority.slice(separator + 1);
    if (hostValue.includes(':') || (separator >= 0 && port.length === 0)) return undefined;
    const normalizedIpv4 = canonicalIpv4(hostValue);
    if (normalizedIpv4) {
      if (!isPublicIpv4(normalizedIpv4)) return undefined;
      host = normalizedIpv4;
    } else {
      if (/^[\d.]+$/u.test(hostValue)) return undefined;
      const normalizedHost = normalizeHostname(hostValue);
      if (!normalizedHost) return undefined;
      host = normalizedHost;
    }
  }
  if (port && (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65_535)) {
    return undefined;
  }
  const normalizedQuery = normalizedQueryValue ? `?${normalizedQueryValue}` : '';
  const normalized = `${scheme}:${host}${port ? `:${Number(port)}` : ''}${normalizedQuery}`;
  return normalized.length <= MAX_STUN_ENDPOINT_URI_LENGTH ? normalized : undefined;
};

/** Validates and deduplicates in one bounded pass over main-owned configuration. */
export const approvedStunEndpoints = (values: readonly unknown[]): readonly string[] => {
  const approved: string[] = [];
  const seen = new Set<string>();
  const inputLimit = Math.min(values.length, MAX_STUN_ENDPOINT_INPUTS);
  for (
    let index = 0;
    index < inputLimit && approved.length < MAX_APPROVED_STUN_ENDPOINTS;
    index += 1
  ) {
    const normalized = normalizeApprovedStunEndpoint(values[index]);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    approved.push(normalized);
  }
  return Object.freeze(approved);
};

/** Revalidates a candidate array and strips every field except public address tuples. */
export const sanitizeStunPageCandidates = (value: unknown): readonly StunDiagnosticCandidate[] => {
  if (!Array.isArray(value)) return Object.freeze([]);
  try {
    const candidates: StunDiagnosticCandidate[] = [];
    const seen = new Set<string>();
    const inputLimit = Math.min(value.length, MAX_STUN_PAGE_CANDIDATES);
    for (let index = 0; index < inputLimit; index += 1) {
      const raw = value[index];
      if (!isPlainRecord(raw)) continue;
      const candidate = raw as PageCandidate;
      if (
        !hasOwn(candidate, 'type') ||
        !hasOwn(candidate, 'transport') ||
        !hasOwn(candidate, 'address') ||
        candidate.type !== 'srflx'
      ) {
        continue;
      }
      const transport =
        typeof candidate.transport === 'string' ? candidate.transport.toLowerCase() : '';
      if (transport !== 'tcp' && transport !== 'udp') continue;
      const normalizedAddress = normalizePublicAddress(candidate.address);
      if (!normalizedAddress) continue;
      const key = `${normalizedAddress.family}|${normalizedAddress.address}|${transport}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(Object.freeze({ ...normalizedAddress, transport }));
    }
    return Object.freeze(candidates);
  } catch {
    return Object.freeze([]);
  }
};

interface ParsedStunPageResult {
  readonly candidates: readonly StunDiagnosticCandidate[];
  readonly outcome: 'complete' | 'icecandidate-error';
}

/** The executeJavaScript boundary accepts only its expected plain-record envelope. */
const parseStunPageResult = (value: unknown): ParsedStunPageResult | undefined => {
  if (!isPlainRecord(value)) return undefined;
  try {
    if (!hasOwn(value, 'outcome') || !hasOwn(value, 'candidates')) return undefined;
    if (
      (value.outcome !== 'complete' && value.outcome !== 'icecandidate-error') ||
      !Array.isArray(value.candidates)
    ) {
      return undefined;
    }
    return Object.freeze({
      candidates: sanitizeStunPageCandidates(value.candidates),
      outcome: value.outcome,
    });
  } catch {
    return undefined;
  }
};

const serializedIceServers = (endpoints: readonly string[]): string =>
  JSON.stringify(endpoints.map((urls) => ({ urls })))
    .replaceAll('<', '\\u003c')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');

export const buildStunCollectionScript = (
  endpoints: readonly string[],
  pageCollectionMs: number,
): string => `(() => {
  const iceServers = ${serializedIceServers(endpoints)};
  const maximumCandidates = ${MAX_STUN_PAGE_CANDIDATES};
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawIceCandidateError = false;
    const results = [];
    const seen = new Set();
    let peer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { peer?.close(); } catch {}
      if (error) {
        reject(error);
        return;
      }
      resolve({
        candidates: results,
        outcome: sawIceCandidateError ? 'icecandidate-error' : 'complete',
      });
    };
    const timer = setTimeout(() => finish(), ${pageCollectionMs});
    try {
      peer = new RTCPeerConnection({ iceServers });
      peer.addEventListener('icecandidateerror', () => {
        if (!settled) sawIceCandidateError = true;
      });
      peer.addEventListener('icecandidate', (event) => {
        if (settled) return;
        const candidate = event.candidate;
        if (!candidate) {
          finish();
          return;
        }
        if (candidate.type !== 'srflx') return;
        if (typeof candidate.address !== 'string' || typeof candidate.protocol !== 'string') return;
        const address = candidate.address.toLowerCase();
        const transport = candidate.protocol.toLowerCase();
        if (address.length === 0 || address.length > ${MAX_IP_LITERAL_LENGTH}) return;
        if (transport !== 'tcp' && transport !== 'udp') return;
        const key = address + '|' + transport;
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ address, transport, type: 'srflx' });
        if (results.length >= maximumCandidates) finish();
      });
      peer.createDataChannel('claudedock-stun-diagnostic');
      peer.createOffer()
        .then((offer) => peer.setLocalDescription(offer))
        .catch((error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
})()`;

const defaultSessionFactory: StunSessionFactory = async (partition, options) => {
  const electron = await import('electron');
  return electron.session.fromPartition(partition, options);
};

const defaultBrowserWindowFactory: StunBrowserWindowFactory = async (options) => {
  const electron = await import('electron');
  return new electron.BrowserWindow(options);
};

const windowOptions = (
  diagnosticSession: Session,
  partition: string,
): BrowserWindowConstructorOptions => ({
  paintWhenInitiallyHidden: false,
  show: false,
  webPreferences: {
    backgroundThrottling: false,
    contextIsolation: true,
    devTools: false,
    enableWebSQL: false,
    navigateOnDragDrop: false,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    partition,
    sandbox: true,
    session: diagnosticSession,
    spellcheck: false,
    webSecurity: true,
    webviewTag: false,
  },
});

const destroyWindowBestEffort = (window: BrowserWindow): void => {
  try {
    window.destroy();
  } catch {
    // Teardown is best-effort after renderer failure; exact addresses are never logged.
  }
};

export class StunDiagnosticCollector {
  private readonly endpoints: readonly string[];
  private readonly timeoutMs: number;
  private readonly pageCollectionMs: number;
  private readonly script: string;
  private readonly sessionFactory: StunSessionFactory;
  private readonly browserWindowFactory: StunBrowserWindowFactory;
  private readonly partitionSuffixFactory: () => string;
  private readonly monotonicNow: () => number;
  private readonly securedSessions = new WeakSet<Session>();
  private active?: ActiveCollection;
  private diagnosticSession?: Session;
  private diagnosticSessionAcquisition?: SessionAcquisition;
  private partition?: string;
  private disposed = false;

  public constructor(options: StunDiagnosticCollectorOptions = {}) {
    this.endpoints = approvedStunEndpoints(options.stunEndpoints ?? []);
    this.timeoutMs = boundedDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.pageCollectionMs = Math.min(
      boundedDuration(options.pageCollectionMs, DEFAULT_PAGE_COLLECTION_MS),
      Math.max(1, this.timeoutMs - 1),
    );
    this.script = buildStunCollectionScript(this.endpoints, this.pageCollectionMs);
    this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
    this.browserWindowFactory = options.browserWindowFactory ?? defaultBrowserWindowFactory;
    this.partitionSuffixFactory = options.partitionSuffixFactory ?? randomUUID;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  public async collect(request: StunCollectionRequest): Promise<StunDiagnosticResult> {
    if (request?.optIn !== true) return unavailable('not-opted-in');
    if (this.disposed) return unavailable('disposed');
    if (this.endpoints.length === 0) return unavailable('no-approved-endpoint');
    if (this.active) return unavailable('busy');
    if (request.signal?.aborted) return unavailable('aborted');

    const active = this.createActiveCollection(request.signal);
    this.active = active;
    try {
      return await this.runCollection(active);
    } catch {
      return this.checkpoint(active) ?? unavailable('failed');
    } finally {
      this.cleanupActive(active);
    }
  }

  /** Idempotent lifecycle hook for caller disposal and application quit. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) this.finishTerminal(this.active, unavailable('disposed'));
  }

  private createActiveCollection(signal?: AbortSignal): ActiveCollection {
    let resolveTerminal!: (result: StunDiagnosticResult) => void;
    const terminalPromise = new Promise<StunDiagnosticResult>((resolve) => {
      resolveTerminal = resolve;
    });
    const active: ActiveCollection = {
      resolveTerminal,
      signal,
      startedAt: monotonicTimestamp(this.monotonicNow),
      terminalPromise,
      windowDestroyed: false,
    };
    active.timeout = setTimeout(
      () => this.finishTerminal(active, unavailable('timeout')),
      this.timeoutMs,
    );
    active.timeout.unref?.();
    if (signal) {
      active.abortListener = () => {
        if (active.terminalResult) return;
        this.finishTerminal(
          active,
          unavailable(this.deadlineElapsed(active) ? 'timeout' : 'aborted'),
        );
      };
      signal.addEventListener('abort', active.abortListener, { once: true });
      if (signal.aborted) active.abortListener();
    }
    return active;
  }

  private async runCollection(active: ActiveCollection): Promise<StunDiagnosticResult> {
    const initialTerminal = this.checkpoint(active);
    if (initialTerminal) return initialTerminal;

    const sessionRequest = this.getDiagnosticSession();
    const sessionStage = await this.raceStage(active, sessionRequest.promise);
    const afterSession = this.checkpoint(active);
    if (afterSession) {
      this.invalidateSessionAcquisition(sessionRequest.acquisition);
      return afterSession;
    }
    if (sessionStage.kind !== 'value') {
      this.invalidateSessionAcquisition(sessionRequest.acquisition);
      return await this.stageFailureResult(active, sessionStage);
    }
    if (!this.acceptDiagnosticSession(sessionRequest.acquisition, sessionStage.value)) {
      return this.checkpoint(active) ?? unavailable('failed');
    }

    const beforeWindow = this.checkpoint(active);
    if (beforeWindow) return beforeWindow;
    const diagnosticSession = this.diagnosticSession as Session;
    const partition = this.partition as string;
    const windowGuard: WindowCreationGuard = { destroyed: false, state: 'pending' };
    active.windowCreationGuard = windowGuard;
    const browserWindowFactory = this.browserWindowFactory;
    const options = windowOptions(diagnosticSession, partition);
    const creation = Promise.resolve().then(() => browserWindowFactory(options));
    void creation.then(
      (lateWindow) => {
        if (windowGuard.state === 'stale' && !windowGuard.destroyed) {
          windowGuard.destroyed = true;
          destroyWindowBestEffort(lateWindow);
        }
      },
      () => undefined,
    );
    const windowStage = await this.raceStage(active, creation);
    const afterWindow = this.checkpoint(active);
    if (windowStage.kind !== 'value') {
      this.markWindowCreationStale(active);
      return afterWindow ?? (await this.stageFailureResult(active, windowStage));
    }
    if (afterWindow) {
      windowGuard.state = 'stale';
      active.windowCreationGuard = undefined;
      if (!windowGuard.destroyed) {
        windowGuard.destroyed = true;
        destroyWindowBestEffort(windowStage.value);
      }
      return afterWindow;
    }
    windowGuard.state = 'claimed';
    active.windowCreationGuard = undefined;
    active.window = windowStage.value;
    this.secureWindow(active);

    const beforeLoad = this.checkpoint(active);
    if (beforeLoad) return beforeLoad;
    const window = active.window;
    const loadStage = await this.raceStage(
      active,
      Promise.resolve().then(() => window.loadURL(STUN_DOCUMENT_URL)),
    );
    if (loadStage.kind !== 'value') {
      return await this.stageFailureResult(active, loadStage, true);
    }

    const beforeScript = this.checkpoint(active);
    if (beforeScript) return beforeScript;
    const script = this.script;
    const scriptStage = await this.raceStage(
      active,
      Promise.resolve().then(() => window.webContents.executeJavaScript(script)),
    );
    if (scriptStage.kind !== 'value') {
      return await this.stageFailureResult(active, scriptStage, true);
    }

    const beforeParse = this.checkpoint(active);
    if (beforeParse) return beforeParse;
    const pageResult = parseStunPageResult(scriptStage.value);
    if (!pageResult) return this.checkpoint(active) ?? unavailable('failed');
    const beforeReturn = this.checkpoint(active);
    if (beforeReturn) return beforeReturn;
    if (pageResult.candidates.length > 0) return available(pageResult.candidates);
    return unavailable(
      pageResult.outcome === 'icecandidate-error' ? 'failed' : 'no-public-candidate',
    );
  }

  private getDiagnosticSession(): {
    acquisition?: SessionAcquisition;
    promise: Promise<Session>;
  } {
    if (this.diagnosticSession) return { promise: Promise.resolve(this.diagnosticSession) };
    if (this.diagnosticSessionAcquisition) {
      return {
        acquisition: this.diagnosticSessionAcquisition,
        promise: this.diagnosticSessionAcquisition.promise,
      };
    }
    if (!this.partition) {
      const rawSuffix = this.partitionSuffixFactory();
      const suffix = String(rawSuffix)
        .toLowerCase()
        .replace(/[^a-z0-9-]/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 80);
      this.partition = `${STUN_PARTITION_PREFIX}${suffix || randomUUID()}`;
    }
    const partition = this.partition;
    const sessionFactory = this.sessionFactory;
    const promise = Promise.resolve().then(() => sessionFactory(partition, { cache: false }));
    const acquisition = { promise };
    this.diagnosticSessionAcquisition = acquisition;
    void promise.catch(() => undefined);
    return { acquisition, promise };
  }

  private acceptDiagnosticSession(
    acquisition: SessionAcquisition | undefined,
    diagnosticSession: Session,
  ): boolean {
    if (acquisition && this.diagnosticSessionAcquisition !== acquisition) return false;
    try {
      this.secureSessionOnce(diagnosticSession);
    } catch {
      this.invalidateSessionAcquisition(acquisition);
      return false;
    }
    this.diagnosticSession = diagnosticSession;
    if (acquisition && this.diagnosticSessionAcquisition === acquisition) {
      this.diagnosticSessionAcquisition = undefined;
    }
    return true;
  }

  private invalidateSessionAcquisition(acquisition?: SessionAcquisition): void {
    if (acquisition && this.diagnosticSessionAcquisition === acquisition) {
      this.diagnosticSessionAcquisition = undefined;
    }
  }

  private secureSessionOnce(diagnosticSession: Session): void {
    if (this.securedSessions.has(diagnosticSession)) return;
    diagnosticSession.setPermissionCheckHandler(() => false);
    diagnosticSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    diagnosticSession.webRequest.onBeforeRequest(ORDINARY_REQUEST_FILTER, (_details, callback) => {
      callback({ cancel: true });
    });
    this.securedSessions.add(diagnosticSession);
  }

  private secureWindow(active: ActiveCollection): void {
    const window = active.window as BrowserWindow;
    const contents = window.webContents;
    const stopForNavigation = (event?: ElectronEvent): void => {
      event?.preventDefault();
      this.recordObservedTerminal(active, unavailable('navigation-attempt'));
    };
    const stopForCrash = (): void => {
      this.recordObservedTerminal(active, unavailable('render-process-gone'));
    };
    const stopForUnresponsive = (): void => {
      this.recordObservedTerminal(active, unavailable('unresponsive'));
    };
    const stopForClose = (event: ElectronEvent): void => stopForNavigation(event);

    contents.setWindowOpenHandler(() => {
      stopForNavigation();
      return { action: 'deny' };
    });
    contents.on('will-navigate', stopForNavigation);
    contents.on('will-frame-navigate', stopForNavigation);
    contents.on('render-process-gone', stopForCrash);
    contents.on('unresponsive', stopForUnresponsive);
    window.on('close', stopForClose);
    contents.setWebRTCIPHandlingPolicy(STUN_WEBRTC_IP_HANDLING_POLICY);
    active.detachWindowListeners = () => {
      contents.removeListener('will-navigate', stopForNavigation);
      contents.removeListener('will-frame-navigate', stopForNavigation);
      contents.removeListener('render-process-gone', stopForCrash);
      contents.removeListener('unresponsive', stopForUnresponsive);
      window.removeListener('close', stopForClose);
    };
  }

  private async raceStage<T>(active: ActiveCollection, work: Promise<T>): Promise<StageResult<T>> {
    const settledWork = work.then<StageResult<T>, StageResult<T>>(
      (value) => ({ kind: 'value', value }),
      () => ({ kind: 'failed' }),
    );
    return await Promise.race([
      settledWork,
      active.terminalPromise.then<StageResult<T>>((result) => ({ kind: 'terminal', result })),
    ]);
  }

  private async stageFailureResult<T>(
    active: ActiveCollection,
    stage: Exclude<StageResult<T>, { kind: 'value' }>,
    allowQueuedRendererEvent = false,
  ): Promise<StunDiagnosticResult> {
    if (stage.kind === 'terminal') return stage.result;
    const immediate = this.checkpoint(active);
    if (immediate) return immediate;
    if (allowQueuedRendererEvent && active.window && !active.windowDestroyed) {
      if (this.recordRendererState(active)) return active.terminalResult as StunDiagnosticResult;
      await this.waitOneEventLoopTurn(active);
      const afterTurn = this.checkpoint(active);
      if (afterTurn) return afterTurn;
      if (this.recordRendererState(active)) return active.terminalResult as StunDiagnosticResult;
    }
    return this.checkpoint(active) ?? unavailable('failed');
  }

  private recordRendererState(active: ActiveCollection): boolean {
    if (!active.window || active.windowDestroyed || active.terminalResult) {
      return this.hasRenderProcessGoneResult(active);
    }
    try {
      const contents = active.window.webContents;
      const windowDestroyed =
        typeof active.window.isDestroyed === 'function' && active.window.isDestroyed();
      const contentsDestroyed =
        typeof contents.isDestroyed === 'function' && contents.isDestroyed();
      const contentsCrashed = typeof contents.isCrashed === 'function' && contents.isCrashed();
      if (windowDestroyed || contentsDestroyed || contentsCrashed) {
        this.recordObservedTerminal(active, unavailable('render-process-gone'));
      }
    } catch {
      this.recordObservedTerminal(active, unavailable('render-process-gone'));
    }
    return this.hasRenderProcessGoneResult(active);
  }

  private hasRenderProcessGoneResult(active: ActiveCollection): boolean {
    const result = active.terminalResult;
    return result?.status === 'unavailable' && result.reason === 'render-process-gone';
  }

  private async waitOneEventLoopTurn(active: ActiveCollection): Promise<void> {
    let immediate: ReturnType<typeof setImmediate> | undefined;
    const turn = new Promise<'turn'>((resolve) => {
      immediate = setImmediate(() => resolve('turn'));
    });
    const winner = await Promise.race([
      turn,
      active.terminalPromise.then(() => 'terminal' as const),
    ]);
    if (winner === 'terminal' && immediate) clearImmediate(immediate);
  }

  private recordObservedTerminal(active: ActiveCollection, result: StunDiagnosticResult): void {
    if (!this.checkpoint(active)) this.finishTerminal(active, result);
  }

  private deadlineElapsed(active: ActiveCollection): boolean {
    const current = monotonicTimestamp(this.monotonicNow);
    return (
      !Number.isFinite(active.startedAt) ||
      !Number.isFinite(current) ||
      current < active.startedAt ||
      current - active.startedAt >= this.timeoutMs
    );
  }

  private checkpoint(active: ActiveCollection): StunDiagnosticResult | undefined {
    if (active.terminalResult) return active.terminalResult;
    if (this.deadlineElapsed(active)) {
      this.finishTerminal(active, unavailable('timeout'));
      return active.terminalResult;
    }
    if (active.signal?.aborted) {
      this.finishTerminal(active, unavailable('aborted'));
      return active.terminalResult;
    }
    return undefined;
  }

  private finishTerminal(active: ActiveCollection, result: StunDiagnosticResult): void {
    if (active.terminalResult) return;
    active.terminalResult = result;
    active.resolveTerminal(result);
    this.markWindowCreationStale(active);
    this.destroyActiveWindow(active);
  }

  private cleanupActive(active: ActiveCollection): void {
    if (active.timeout) clearTimeout(active.timeout);
    if (active.signal && active.abortListener) {
      active.signal.removeEventListener('abort', active.abortListener);
    }
    active.detachWindowListeners?.();
    this.markWindowCreationStale(active);
    this.destroyActiveWindow(active);
    if (this.active === active) this.active = undefined;
  }

  private markWindowCreationStale(active: ActiveCollection): void {
    if (!active.windowCreationGuard) return;
    active.windowCreationGuard.state = 'stale';
    active.windowCreationGuard = undefined;
  }

  private destroyActiveWindow(active: ActiveCollection): void {
    if (!active.window || active.windowDestroyed) return;
    active.windowDestroyed = true;
    destroyWindowBestEffort(active.window);
  }
}

export { StunDiagnosticCollector as StunCollector };
