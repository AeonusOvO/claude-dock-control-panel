import { randomBytes } from 'node:crypto';
import type {
  ClaudeLaunchMode,
  ClaudeLaunchPauseDiagnostics,
  ClaudeRelaunchInput,
  NetworkPreflightResult,
  PtyGeneration,
  TerminalStatus,
} from '../../shared/contracts';
import type {
  ClaudeConnectionHistoryBaseline,
  ClaudeLaunchConfigurationBaseline,
} from '../claude/runtime-connection-config';
import type { ClaudeRuntimeLaunchBaseline } from '../claude/runtime-launch-handoff';
import type { SessionOperationStamp } from './session-operation';
import type { ProviderAccessBlockedCapture } from '../network/provider-access-guard';

const launchIntentBrand: unique symbol = Symbol('launch-preflight-intent');
const launchReservationBrand: unique symbol = Symbol('launch-preflight-reservation');

export const LAUNCH_PREFLIGHT_DECISION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_PENDING = 128;

export type ClaudeLaunchDescriptor =
  | {
      readonly cwd: string;
      readonly kind: 'launch';
      readonly mode: ClaudeLaunchMode;
      readonly sessionId: string;
    }
  | {
      readonly conversationId: string;
      readonly cwd: string;
      readonly kind: 'resume-session';
      readonly sessionId: string;
    }
  | {
      readonly cwd: string;
      readonly input: Readonly<ClaudeRelaunchInput>;
      readonly kind: 'relaunch';
      readonly sessionId: string;
    };

export interface ClaudeLaunchDecisionBaseline {
  readonly configuration: ClaudeLaunchConfigurationBaseline;
  readonly history?: ClaudeConnectionHistoryBaseline;
  readonly operation: SessionOperationStamp;
  readonly runtime: ClaudeRuntimeLaunchBaseline;
  readonly workspacePtyGeneration: PtyGeneration;
}

export interface LaunchPreflightIntent {
  readonly generation: number;
  readonly sessionId: string;
  readonly [launchIntentBrand]: true;
}

export interface LaunchPreflightDecisionReservation {
  readonly baseline: ClaudeLaunchDecisionBaseline;
  readonly blocked: ProviderAccessBlockedCapture;
  readonly choice: 'bypass' | 'cancel' | 'recheck';
  readonly decisionId: string;
  readonly descriptor: ClaudeLaunchDescriptor;
  readonly diagnostics: ClaudeLaunchPauseDiagnostics;
  readonly expiresAt: number;
  readonly intent: LaunchPreflightIntent;
  readonly [launchReservationBrand]: true;
}

export type LaunchPreflightDecisionReserveResult =
  | { readonly reservation: LaunchPreflightDecisionReservation; readonly status: 'reserved' }
  | { readonly status: 'consumed' | 'stale' };

export interface LaunchPreflightPausedRecord {
  readonly decisionId: string;
  readonly diagnostics: ClaudeLaunchPauseDiagnostics;
}

interface LiveDecisionRecord {
  readonly baseline: ClaudeLaunchDecisionBaseline;
  readonly blocked: ProviderAccessBlockedCapture;
  readonly choice?: 'bypass' | 'cancel' | 'recheck';
  readonly createdAt: number;
  readonly decisionId: string;
  readonly descriptor: ClaudeLaunchDescriptor;
  readonly diagnostics: ClaudeLaunchPauseDiagnostics;
  readonly expiresAt: number;
  readonly intent: LaunchPreflightIntent;
  readonly state: 'deciding' | 'pending';
}

interface TerminalDecisionRecord {
  readonly decisionId: string;
  readonly finishedAt: number;
  readonly sessionId: string;
  readonly state: 'consumed' | 'stale';
}

type DecisionRecord = LiveDecisionRecord | TerminalDecisionRecord;

interface ExpectedPtyReplacement {
  readonly intent: LaunchPreflightIntent;
  readonly predecessor: PtyGeneration;
}

interface LaunchPreflightDecisionCoordinatorOptions {
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly maxPending?: number;
  readonly maxRecords?: number;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
}

const freeze = <Value extends object>(value: Value): Readonly<Value> => Object.freeze(value);

const captureDescriptor = (descriptor: ClaudeLaunchDescriptor): ClaudeLaunchDescriptor => {
  if (descriptor.kind === 'launch') {
    return freeze({ ...descriptor });
  }
  if (descriptor.kind === 'resume-session') {
    return freeze({ ...descriptor });
  }
  return freeze({
    cwd: descriptor.cwd,
    input: freeze({
      compactFirst: descriptor.input.compactFirst,
      ...(descriptor.input.model === undefined ? {} : { model: descriptor.input.model }),
      ...(descriptor.input.speed === undefined ? {} : { speed: descriptor.input.speed }),
      ...(descriptor.input.entryId === undefined ? {} : { entryId: descriptor.input.entryId }),
      ...(descriptor.input.permissionMode === undefined
        ? {}
        : { permissionMode: descriptor.input.permissionMode }),
    }),
    kind: descriptor.kind,
    sessionId: descriptor.sessionId,
  });
};

const captureDiagnostics = (
  diagnostics: ClaudeLaunchPauseDiagnostics,
): ClaudeLaunchPauseDiagnostics =>
  freeze({
    action: diagnostics.action,
    checkedAt: diagnostics.checkedAt,
    failedItems: freeze(diagnostics.failedItems.map((item) => freeze({ ...item }))),
    freshness: diagnostics.freshness,
    provider: diagnostics.provider,
    providerLabel: diagnostics.providerLabel,
    reasons: freeze([...diagnostics.reasons]),
    scope: diagnostics.scope,
    status: diagnostics.status,
    summary: diagnostics.summary,
  });

const captureBaseline = (baseline: ClaudeLaunchDecisionBaseline): ClaudeLaunchDecisionBaseline =>
  freeze({
    configuration: freeze({ ...baseline.configuration }),
    ...(baseline.history === undefined ? {} : { history: freeze({ ...baseline.history }) }),
    operation: freeze({ ...baseline.operation }),
    runtime: freeze({ ...baseline.runtime }),
    workspacePtyGeneration: baseline.workspacePtyGeneration,
  });

const captureBlocked = (blocked: ProviderAccessBlockedCapture): ProviderAccessBlockedCapture =>
  freeze({
    ...blocked,
    ...(blocked.target === undefined ? {} : { target: freeze({ ...blocked.target }) }),
  });

const WINDOWS_PATH_PLACEHOLDER = '[REDACTED_PATH]';
const WINDOWS_PATH_QUOTES = new Set(['"', "'", '`']);
const WINDOWS_PATH_TERMINATORS = new Set([
  '"',
  "'",
  '`',
  '<',
  '>',
  '|',
  '?',
  '*',
  ',',
  ';',
  ')',
  ']',
  '}',
]);

const isAsciiLetter = (value: string | undefined): boolean =>
  value !== undefined && /^[A-Za-z]$/u.test(value);

const isWindowsPathSeparator = (value: string | undefined): boolean =>
  value === '\\' || value === '/';

const isWindowsPathSegmentBoundary = (
  value: string | undefined,
  quotedBy: string | undefined,
): boolean =>
  value === undefined ||
  value === '\r' ||
  value === '\n' ||
  value === quotedBy ||
  (quotedBy === undefined && /\s/u.test(value));

const windowsAbsolutePathPrefixEnd = (
  value: string,
  index: number,
  quotedBy?: string,
): number | undefined => {
  const previous = value[index - 1];
  if (previous !== undefined && /^[A-Za-z0-9]$/u.test(previous)) return undefined;
  if (
    isAsciiLetter(value[index]) &&
    value[index + 1] === ':' &&
    isWindowsPathSeparator(value[index + 2])
  ) {
    return index + 3;
  }
  if (!isWindowsPathSeparator(value[index]) || !isWindowsPathSeparator(value[index + 1])) {
    return undefined;
  }
  if (
    (value[index + 2] === '?' || value[index + 2] === '.') &&
    isWindowsPathSeparator(value[index + 3])
  ) {
    return index + 4;
  }

  let separator = index + 2;
  while (!isWindowsPathSeparator(value[separator])) {
    if (isWindowsPathSegmentBoundary(value[separator], quotedBy)) return undefined;
    separator += 1;
  }
  const shareStart = separator + 1;
  if (
    isWindowsPathSeparator(value[shareStart]) ||
    isWindowsPathSegmentBoundary(value[shareStart], quotedBy)
  ) {
    return undefined;
  }
  return shareStart + 1;
};

const isUnquotedWindowsPathTerminator = (value: string, index: number): boolean => {
  const character = value[index];
  if (character === undefined || /\s/u.test(character)) return true;
  if (WINDOWS_PATH_TERMINATORS.has(character)) return true;
  return (
    character === ':' &&
    !(isAsciiLetter(value[index - 1]) && isWindowsPathSeparator(value[index + 1]))
  );
};

const redactWindowsAbsolutePaths = (value: string): string => {
  let redacted = '';
  let index = 0;
  while (index < value.length) {
    const quote = WINDOWS_PATH_QUOTES.has(value[index] ?? '') ? value[index] : undefined;
    const quotedPathStart = quote === undefined ? undefined : index + 1;
    const quotedPrefixEnd =
      quotedPathStart === undefined
        ? undefined
        : windowsAbsolutePathPrefixEnd(value, quotedPathStart, quote);
    if (quote !== undefined && quotedPathStart !== undefined && quotedPrefixEnd !== undefined) {
      let closingQuote = quotedPrefixEnd;
      while (
        closingQuote < value.length &&
        value[closingQuote] !== quote &&
        value[closingQuote] !== '\r' &&
        value[closingQuote] !== '\n'
      ) {
        closingQuote += 1;
      }
      if (value[closingQuote] === quote) {
        redacted += `${quote}${WINDOWS_PATH_PLACEHOLDER}${quote}`;
        index = closingQuote + 1;
        continue;
      }
    }

    const prefixEnd = windowsAbsolutePathPrefixEnd(value, index);
    if (prefixEnd === undefined) {
      redacted += value[index];
      index += 1;
      continue;
    }
    let pathEnd = prefixEnd;
    while (!isUnquotedWindowsPathTerminator(value, pathEnd)) pathEnd += 1;
    redacted += WINDOWS_PATH_PLACEHOLDER;
    index = pathEnd;
  }
  return redacted;
};

const safeDiagnosticText = (value: string, maximum = 240): string => {
  const collapsed = redactWindowsAbsolutePaths(
    value
      .replaceAll(/https?:\/\/\S+/gu, '网络目标')
      .replaceAll(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
      .replaceAll(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/giu, '[REDACTED_CREDENTIAL]'),
  )
    .replaceAll(/(?:[A-Za-z]:)?[\\/]Users[\\/][^\s]+/giu, WINDOWS_PATH_PLACEHOLDER)
    .trim();
  return collapsed.slice(0, maximum) || '网络检查项';
};

const safeTarget = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const target = new URL(value);
    target.username = '';
    target.password = '';
    target.search = '';
    target.hash = '';
    return target.toString().slice(0, 320);
  } catch {
    return safeDiagnosticText(value, 320);
  }
};

/** Builds an attributed launch decision payload from a strict renderer-safe allow-list. */
export const launchPauseDiagnosticsFromResult = (
  result: NetworkPreflightResult,
): ClaudeLaunchPauseDiagnostics => {
  const connectivity = result.providerConnectivity;
  const failedItems = connectivity.probes
    .filter((probe) => probe.status === 'failed' || probe.status === 'warning')
    .slice(0, 8)
    .map((probe) => {
      const target = safeTarget(probe.target);
      return freeze({
        checkedAt: probe.checkedAt,
        detail: safeDiagnosticText(probe.detail),
        kind: probe.kind,
        label: safeDiagnosticText(probe.label, 120),
        process: probe.process,
        required: probe.required,
        status: probe.status as 'failed' | 'warning',
        ...(target ? { target } : {}),
      });
    });
  const signalLabels = connectivity.signals
    .filter((signal) => signal.severity !== 'info')
    .map((signal) => safeDiagnosticText(`${signal.label} · 来源：${signal.source}`));
  const reasons = [
    ...new Set([
      ...signalLabels,
      ...(failedItems.length === 0 ? ['请求的网络能力未通过检查。'] : []),
    ]),
  ].slice(0, 8);
  const checkedAt = result.checkedAt ?? result.startedAt;
  const freshness =
    result.cacheExpiresAt !== undefined && result.cacheExpiresAt >= Date.now()
      ? 'fresh'
      : 'unknown';
  return freeze({
    action: result.action,
    checkedAt,
    failedItems: freeze(failedItems),
    freshness,
    provider: result.provider,
    providerLabel: safeDiagnosticText(result.providerLabel, 120),
    reasons: freeze(reasons),
    scope: result.networkScope,
    status: connectivity.status === 'blocked' ? 'blocked' : 'degraded',
    summary: '网络检查未通过，Claude 启动已暂停。',
  });
};

/**
 * Main-owned one-shot launch decision coordinator. It stores data only in memory and never retains
 * operation closures, abort signals, lease contexts, prepared launch tokens, renderer generations,
 * conversation owners, or credential-bearing authorization snapshots.
 */
export class LaunchPreflightDecisionCoordinator {
  private readonly clearTimerImplementation: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly currentIntentBySession = new Map<string, LaunchPreflightIntent>();
  private readonly decisionBySession = new Map<string, string>();
  private readonly expectedPtyReplacementBySession = new Map<string, ExpectedPtyReplacement>();
  private readonly maxPending: number;
  private readonly maxRecords: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly records = new Map<string, DecisionRecord>();
  private readonly setTimerImplementation: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private nextIntentGeneration = 0;

  public constructor(options: LaunchPreflightDecisionCoordinatorOptions = {}) {
    this.clearTimerImplementation = options.clearTimer ?? clearTimeout;
    this.maxRecords = Math.max(1, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS));
    this.maxPending = Math.min(
      this.maxRecords,
      Math.max(1, Math.floor(options.maxPending ?? DEFAULT_MAX_PENDING)),
    );
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => randomBytes(32).toString('base64url'));
    this.setTimerImplementation = options.setTimer ?? setTimeout;
  }

  /** Synchronously supersedes any older same-session decision before launch work starts. */
  public beginLaunch(sessionId: string): LaunchPreflightIntent {
    this.invalidateSessionDecision(sessionId);
    this.expectedPtyReplacementBySession.delete(sessionId);
    const intent = freeze({
      generation: ++this.nextIntentGeneration,
      sessionId,
      [launchIntentBrand]: true as const,
    });
    this.currentIntentBySession.set(sessionId, intent);
    return intent;
  }

  public assertIntentCurrent(intent: LaunchPreflightIntent): void {
    if (this.currentIntentBySession.get(intent.sessionId) !== intent) {
      throw new LaunchPreflightDecisionStaleError();
    }
  }

  /**
   * Arms one exact synchronous PTY replacement. The workspace observer consumes the matching
   * generation edge before `restart` returns; every other edge must still stale the launch intent.
   */
  public withExpectedPtyReplacement(
    intent: LaunchPreflightIntent,
    predecessor: PtyGeneration,
    restart: () => TerminalStatus,
  ): TerminalStatus {
    this.assertIntentCurrent(intent);
    if (this.expectedPtyReplacementBySession.has(intent.sessionId)) {
      throw new LaunchPreflightDecisionStaleError();
    }
    const expected = freeze({ intent, predecessor });
    this.expectedPtyReplacementBySession.set(intent.sessionId, expected);
    try {
      return restart();
    } finally {
      if (this.expectedPtyReplacementBySession.get(intent.sessionId) === expected) {
        this.expectedPtyReplacementBySession.delete(intent.sessionId);
        this.invalidateSession(intent.sessionId);
      }
    }
  }

  /** Accepts only the first matching edge while the exact launch-owned restart is still on stack. */
  public consumeExpectedPtyReplacement(
    sessionId: string,
    predecessor: PtyGeneration,
    replacement: PtyGeneration,
  ): boolean {
    const expected = this.expectedPtyReplacementBySession.get(sessionId);
    if (
      !expected ||
      expected.predecessor !== predecessor ||
      predecessor === replacement ||
      this.currentIntentBySession.get(sessionId) !== expected.intent
    ) {
      return false;
    }
    this.expectedPtyReplacementBySession.delete(sessionId);
    return true;
  }

  public pause(
    intent: LaunchPreflightIntent,
    descriptor: ClaudeLaunchDescriptor,
    blocked: ProviderAccessBlockedCapture,
    diagnostics: ClaudeLaunchPauseDiagnostics,
    baseline: ClaudeLaunchDecisionBaseline,
  ): LaunchPreflightPausedRecord {
    this.expireDue();
    this.assertIntentCurrent(intent);
    this.invalidateSessionDecision(intent.sessionId);
    this.evictPendingIfNeeded();
    const decisionId = this.createDecisionId();
    const createdAt = this.now();
    const capturedBaseline = captureBaseline(baseline);
    const capturedDescriptor = captureDescriptor(descriptor);
    const capturedDiagnostics = captureDiagnostics(diagnostics);
    const record: LiveDecisionRecord = freeze({
      baseline: capturedBaseline,
      blocked: captureBlocked(blocked),
      createdAt,
      decisionId,
      descriptor: capturedDescriptor,
      diagnostics: capturedDiagnostics,
      expiresAt: createdAt + LAUNCH_PREFLIGHT_DECISION_TTL_MS,
      intent,
      state: 'pending',
    });
    this.records.set(decisionId, record);
    this.decisionBySession.set(intent.sessionId, decisionId);
    this.pruneRecords();
    this.scheduleExpiry();
    return freeze({ decisionId, diagnostics: capturedDiagnostics });
  }

  public reserve(
    decisionId: string,
    choice: 'bypass' | 'cancel' | 'recheck',
  ): LaunchPreflightDecisionReserveResult {
    this.expireDue();
    const record = this.records.get(decisionId);
    if (!record || record.state === 'stale') return freeze({ status: 'stale' });
    if (record.state !== 'pending') {
      return freeze({ status: 'consumed' });
    }
    if (this.currentIntentBySession.get(record.intent.sessionId) !== record.intent) {
      this.finish(record, 'stale');
      return freeze({ status: 'stale' });
    }
    const deciding: LiveDecisionRecord = freeze({ ...record, choice, state: 'deciding' });
    this.records.set(decisionId, deciding);
    const reservation: LaunchPreflightDecisionReservation = freeze({
      baseline: deciding.baseline,
      blocked: deciding.blocked,
      choice,
      decisionId,
      descriptor: deciding.descriptor,
      diagnostics: deciding.diagnostics,
      expiresAt: deciding.expiresAt,
      intent: deciding.intent,
      [launchReservationBrand]: true as const,
    });
    return freeze({ reservation, status: 'reserved' });
  }

  /** Cancel and recheck consume immediately; bypass calls this at its final operation-entry boundary. */
  public consume(reservation: LaunchPreflightDecisionReservation): void {
    const record = this.requireReservation(reservation);
    this.assertIntentCurrent(reservation.intent);
    this.finish(record, 'consumed');
  }

  public stale(reservation: LaunchPreflightDecisionReservation): void {
    const record = this.records.get(reservation.decisionId);
    if (record?.state === 'deciding' && record.intent === reservation.intent) {
      this.finish(record, 'stale');
    }
  }

  /** Creates a replacement ID after the old recheck ID has already been permanently consumed. */
  public pauseAfterRecheck(
    reservation: LaunchPreflightDecisionReservation,
    blocked: ProviderAccessBlockedCapture,
    diagnostics: ClaudeLaunchPauseDiagnostics,
    baseline: ClaudeLaunchDecisionBaseline,
  ): LaunchPreflightPausedRecord {
    this.assertIntentCurrent(reservation.intent);
    return this.pause(reservation.intent, reservation.descriptor, blocked, diagnostics, baseline);
  }

  public invalidateSession(sessionId: string): void {
    this.invalidateSessionDecision(sessionId);
    this.expectedPtyReplacementBySession.delete(sessionId);
    this.currentIntentBySession.delete(sessionId);
  }

  public invalidateAll(): void {
    for (const record of [...this.records.values()]) {
      if (record.state === 'pending' || record.state === 'deciding') {
        this.finish(record, 'stale');
      }
    }
    this.currentIntentBySession.clear();
    this.decisionBySession.clear();
    this.expectedPtyReplacementBySession.clear();
    this.cancelExpiryTimer();
  }

  public hasPending(sessionId: string): boolean {
    this.expireDue();
    const decisionId = this.decisionBySession.get(sessionId);
    return decisionId !== undefined && this.records.get(decisionId)?.state === 'pending';
  }

  private cancelExpiryTimer(): void {
    if (this.expiryTimer !== undefined) {
      this.clearTimerImplementation(this.expiryTimer);
      this.expiryTimer = undefined;
    }
  }

  private createDecisionId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const decisionId = this.randomId();
      if (!this.records.has(decisionId)) return decisionId;
    }
    throw new Error('无法生成唯一的启动决策标识。');
  }

  private evictPendingIfNeeded(): void {
    const live = [...this.records.values()].filter(
      (record): record is LiveDecisionRecord =>
        record.state === 'pending' || record.state === 'deciding',
    );
    while (live.length >= this.maxPending) {
      const oldest = live.shift();
      if (!oldest) break;
      this.finish(oldest, 'stale');
    }
  }

  private expireDue(): void {
    const now = this.now();
    for (const record of [...this.records.values()]) {
      if ((record.state === 'pending' || record.state === 'deciding') && record.expiresAt <= now) {
        this.finish(record, 'stale');
      }
    }
    this.scheduleExpiry();
  }

  private finish(record: LiveDecisionRecord, state: 'consumed' | 'stale'): void {
    const terminal: TerminalDecisionRecord = freeze({
      decisionId: record.decisionId,
      finishedAt: this.now(),
      sessionId: record.intent.sessionId,
      state,
    });
    this.records.delete(record.decisionId);
    this.records.set(record.decisionId, terminal);
    if (this.decisionBySession.get(record.intent.sessionId) === record.decisionId) {
      this.decisionBySession.delete(record.intent.sessionId);
    }
    this.pruneRecords();
    this.scheduleExpiry();
  }

  private invalidateSessionDecision(sessionId: string): void {
    const decisionId = this.decisionBySession.get(sessionId);
    const record = decisionId === undefined ? undefined : this.records.get(decisionId);
    if (record?.state === 'pending' || record?.state === 'deciding') {
      this.finish(record, 'stale');
    }
    this.decisionBySession.delete(sessionId);
  }

  private pruneRecords(): void {
    if (this.records.size <= this.maxRecords) return;
    for (const [decisionId, record] of this.records) {
      if (this.records.size <= this.maxRecords) break;
      if (record.state === 'consumed' || record.state === 'stale') {
        this.records.delete(decisionId);
      }
    }
  }

  private requireReservation(reservation: LaunchPreflightDecisionReservation): LiveDecisionRecord {
    this.expireDue();
    const record = this.records.get(reservation.decisionId);
    if (
      record?.state !== 'deciding' ||
      record.intent !== reservation.intent ||
      record.choice !== reservation.choice
    ) {
      throw new LaunchPreflightDecisionStaleError();
    }
    return record;
  }

  private scheduleExpiry(): void {
    this.cancelExpiryTimer();
    let nearest = Number.POSITIVE_INFINITY;
    for (const record of this.records.values()) {
      if (record.state === 'pending' || record.state === 'deciding') {
        nearest = Math.min(nearest, record.expiresAt);
      }
    }
    if (!Number.isFinite(nearest)) return;
    const timer = this.setTimerImplementation(
      () => {
        this.expiryTimer = undefined;
        this.expireDue();
      },
      Math.max(0, nearest - this.now()),
    );
    timer.unref?.();
    this.expiryTimer = timer;
  }
}

export class LaunchPreflightDecisionStaleError extends Error {
  public constructor() {
    super('这次 Claude 启动授权已失效。');
    this.name = 'LaunchPreflightDecisionStaleError';
  }
}
