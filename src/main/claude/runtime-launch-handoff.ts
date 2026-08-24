import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeRouteHealth, NetworkProviderId, PtyGeneration } from '../../shared/contracts';
import type { ClaudeRouteKind, RouteReservationToken } from '../coordination/route-lifecycle';
import { cleanupObsoleteLaunchArtifacts } from './runtime-artifact-cleanup';
import { projectKey } from './runtime-connection';
import { ClaudeRuntimePolling } from './runtime-polling';
import type {
  ClaudeLaunchAuthorization,
  ClaudeLaunchPreflightEvidence,
  ClaudeNetworkAccess,
  ClaudePreparedLaunchToken,
  RuntimeSession,
} from './runtime-types';

export interface ClaudeRuntimeLaunchBaseline {
  readonly active: boolean;
  readonly cwdKey: string;
  readonly exists: boolean;
  readonly launchGeneration?: number;
  readonly ptyGeneration?: PtyGeneration;
}

export interface PreparedClaudeLaunchRecord {
  artifactDirectory: string;
  readonly authorization: ClaudeLaunchAuthorization;
  phase: 'prepared' | 'preparing';
  readonly predecessor: RuntimeSession;
  readonly predecessorActive: boolean;
  readonly predecessorLaunchGeneration?: number;
  readonly predecessorLaunchToken?: ClaudePreparedLaunchToken;
  readonly predecessorPtyGeneration?: PtyGeneration;
  readonly predecessorRouteKind?: ClaudeRouteKind;
  readonly predecessorRouteReservation?: RouteReservationToken;
  replacement?: RuntimeSession;
  readonly sessionDirectory: string;
  readonly targetRouteReservation: RouteReservationToken;
  readonly token: ClaudePreparedLaunchToken;
}

/** Owns exact prepared-launch identity and the atomic prepared-to-live PTY handoff. */
export abstract class ClaudeRuntimeLaunchHandoff extends ClaudeRuntimePolling {
  private nextLaunchGeneration = 0;
  private readonly preparedLaunchBySession = new Map<string, ClaudePreparedLaunchToken>();
  private readonly preparedLaunches = new Map<
    ClaudePreparedLaunchToken,
    PreparedClaudeLaunchRecord
  >();
  protected readonly runtimeLaunchToken = randomBytes(8).toString('hex');

  public captureRuntimeLaunchBaseline(sessionId: string, cwd: string): ClaudeRuntimeLaunchBaseline {
    const runtime = this.sessions.get(sessionId);
    return Object.freeze({
      active: runtime?.active ?? false,
      cwdKey: projectKey(runtime?.cwd ?? cwd),
      exists: runtime !== undefined,
      ...(runtime?.launchGeneration === undefined
        ? {}
        : { launchGeneration: runtime.launchGeneration }),
      ...(runtime?.ptyGeneration === undefined ? {} : { ptyGeneration: runtime.ptyGeneration }),
    });
  }

  public assertRuntimeLaunchBaselineCurrent(
    sessionId: string,
    cwd: string,
    baseline: ClaudeRuntimeLaunchBaseline,
  ): void {
    const current = this.captureRuntimeLaunchBaseline(sessionId, cwd);
    if (
      current.exists !== baseline.exists ||
      current.active !== baseline.active ||
      current.cwdKey !== baseline.cwdKey ||
      current.launchGeneration !== baseline.launchGeneration ||
      current.ptyGeneration !== baseline.ptyGeneration
    ) {
      throw new Error('Claude 运行时在等待确认期间已更新，本次启动已失效。');
    }
  }

  public bindPty(sessionId: string, ptyGeneration: PtyGeneration, launchToken?: object): void {
    const liveRuntime = this.sessions.get(sessionId);
    if (launchToken && liveRuntime?.launchToken === launchToken) {
      if (liveRuntime.ptyGeneration !== ptyGeneration) {
        throw new Error('Claude Code 已绑定到其他终端，这次启动结果已失效。');
      }
      // Terminal restart reporting may be retried. The exact same bind is an event-free no-op.
      return;
    }
    if (!launchToken) {
      throw new Error('Claude Code 启动缺少精确的准备令牌，无法绑定新的终端。');
    }

    const token = launchToken as ClaudePreparedLaunchToken;
    const record = this.preparedLaunches.get(token);
    if (
      !record ||
      record.token !== token ||
      token.sessionId !== sessionId ||
      record.phase !== 'prepared' ||
      !record.replacement
    ) {
      throw new Error('Claude Code 启动令牌已失效，无法绑定新的终端。');
    }
    this.assertPreparedLaunchCurrent(record);

    const replacement = record.replacement;
    replacement.ptyGeneration = ptyGeneration;
    replacement.liveNetworkAccess = record.authorization.networkAccess;
    replacement.liveOfficialNetworkProvider = record.authorization.officialNetworkProvider;
    replacement.launchToken = token;

    if (record.predecessorActive) {
      this.emitSyntheticSessionEnd(record.predecessor);
    }
    this.sessions.set(sessionId, replacement);
    this.finishPreparedLaunchRecord(record);
    cleanupObsoleteLaunchArtifacts(
      record.sessionDirectory,
      record.artifactDirectory,
      record.predecessor.artifactDirectory,
    );

    this.onActivityEvent?.({
      event: 'SessionStart',
      eventId: `launch-${replacement.launchGeneration ?? 0}`,
      launchGeneration: replacement.launchGeneration ?? 0,
      ptyGeneration,
      sessionId,
      signaledAt: Date.now(),
    });
  }

  /** Returns the exact network route captured by the launch owning this live PTY generation. */
  public networkAccessForActivePty(
    sessionId: string,
    expectedGeneration: PtyGeneration,
  ): Readonly<ClaudeNetworkAccess> | undefined {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.active) return undefined;
    if (runtime.ptyGeneration !== expectedGeneration) {
      throw new Error('Claude Code 已绑定到其他终端，这次重新启动已取消。');
    }
    return runtime.liveNetworkAccess;
  }

  /** Returns only official-provider capability, kept separate from custom gateway identity. */
  public officialNetworkProviderForActivePty(
    sessionId: string,
    expectedGeneration: PtyGeneration,
  ): NetworkProviderId | undefined {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.active) return undefined;
    if (runtime.ptyGeneration !== expectedGeneration) {
      throw new Error('Claude Code 已绑定到其他终端，这次重新启动已取消。');
    }
    return runtime.liveOfficialNetworkProvider;
  }

  public ownsLaunch(sessionId: string, launchGeneration: number): boolean {
    const runtime = this.sessions.get(sessionId);
    return Boolean(runtime?.active && runtime.launchGeneration === launchGeneration);
  }

  /** Seeds only the exact live PTY from the authoritative check that admitted its launch. */
  public seedActiveLaunchPreflightEvidence(
    sessionId: string,
    ptyGeneration: PtyGeneration,
    evidence: ClaudeLaunchPreflightEvidence,
  ): boolean {
    const runtime = this.sessions.get(sessionId);
    if (
      !runtime?.active ||
      runtime.ptyGeneration !== ptyGeneration ||
      runtime.liveOfficialNetworkProvider !== evidence.provider
    ) {
      return false;
    }
    runtime.launchPreflightEvidence = Object.freeze({ ...evidence });
    return true;
  }

  /** Consumes a launch seed once and only for the activity event's exact runtime and PTY generations. */
  public takeActiveLaunchPreflightEvidence(
    sessionId: string,
    launchGeneration: number,
    ptyGeneration: PtyGeneration,
  ): ClaudeLaunchPreflightEvidence | undefined {
    const runtime = this.sessions.get(sessionId);
    if (
      !runtime?.active ||
      runtime.launchGeneration !== launchGeneration ||
      runtime.ptyGeneration !== ptyGeneration
    ) {
      return undefined;
    }
    const evidence = runtime.launchPreflightEvidence;
    runtime.launchPreflightEvidence = undefined;
    return evidence;
  }

  /** Applies only display state to the exact live launch; it has no terminal or runtime control path. */
  public applyAdvisoryRouteHealth(
    sessionId: string,
    launchGeneration: number,
    ptyGeneration: PtyGeneration,
    health: ClaudeRouteHealth,
  ): boolean {
    const runtime = this.sessions.get(sessionId);
    if (
      !runtime?.active ||
      runtime.launchGeneration !== launchGeneration ||
      runtime.ptyGeneration !== ptyGeneration
    ) {
      return false;
    }
    runtime.advisoryRouteHealth = Object.freeze({ ...health, blocking: false });
    void this.emitState(runtime).catch(() => {
      // Advisory publication must not affect the exact running launch it describes.
    });
    return true;
  }

  public isBoundToPty(sessionId: string, ptyGeneration: PtyGeneration): boolean {
    const runtime = this.sessions.get(sessionId);
    return Boolean(runtime?.active && runtime.ptyGeneration === ptyGeneration);
  }

  public writeTerminal(sessionId: string, ptyGeneration: PtyGeneration, data: string): boolean {
    return (
      this.isBoundToPty(sessionId, ptyGeneration) &&
      this.writeToTerminal(sessionId, ptyGeneration, data)
    );
  }

  protected reservePreparedLaunch(
    sessionId: string,
    cwd: string,
    routeKind: ClaudeRouteKind,
    authorization: ClaudeLaunchAuthorization,
    runtimeRoot: string,
  ): PreparedClaudeLaunchRecord {
    if (this.preparedLaunchBySession.has(sessionId)) {
      throw new Error('该 Claude Code 会话已有启动正在准备，请稍候。');
    }
    const existing = this.sessions.get(sessionId);
    if (existing?.active && projectKey(existing.cwd) !== projectKey(cwd)) {
      throw new Error('Claude Code 会话已绑定到其他项目，本次启动已取消。');
    }
    const predecessor = existing ?? this.ensureSession(sessionId, cwd);
    if (!predecessor.active) {
      predecessor.cwd = cwd;
    }

    const generation = ++this.nextLaunchGeneration;
    const token: ClaudePreparedLaunchToken = Object.freeze({ generation, sessionId });
    const targetRouteReservation = this.routeLifecycle.reserve(
      `claude-launch:${sessionId}:${generation}:target`,
      routeKind,
    );
    const predecessorRouteReservation =
      predecessor.active && predecessor.routeKind
        ? this.routeLifecycle.reserve(
            `claude-launch:${sessionId}:${generation}:predecessor`,
            predecessor.routeKind,
          )
        : undefined;
    const sessionDirectory = path.join(runtimeRoot, sessionId);
    const artifactDirectory = path.join(
      sessionDirectory,
      `launch-${this.runtimeLaunchToken}-${generation}`,
    );
    const record: PreparedClaudeLaunchRecord = {
      artifactDirectory,
      authorization,
      phase: 'preparing',
      predecessor,
      predecessorActive: predecessor.active,
      predecessorLaunchGeneration: predecessor.launchGeneration,
      predecessorLaunchToken: predecessor.launchToken,
      predecessorPtyGeneration: predecessor.active ? predecessor.ptyGeneration : undefined,
      predecessorRouteKind: predecessor.routeKind,
      predecessorRouteReservation,
      sessionDirectory,
      targetRouteReservation,
      token,
    };
    this.preparedLaunches.set(token, record);
    this.preparedLaunchBySession.set(sessionId, token);
    return record;
  }

  protected assertPreparedLaunchCurrent(record: PreparedClaudeLaunchRecord): void {
    const { predecessor, token } = record;
    if (
      this.preparedLaunches.get(token) !== record ||
      this.preparedLaunchBySession.get(token.sessionId) !== token ||
      this.sessions.get(token.sessionId) !== predecessor ||
      predecessor.active !== record.predecessorActive ||
      predecessor.launchGeneration !== record.predecessorLaunchGeneration ||
      predecessor.launchToken !== record.predecessorLaunchToken ||
      predecessor.ptyGeneration !== record.predecessorPtyGeneration ||
      predecessor.routeKind !== record.predecessorRouteKind ||
      projectKey(predecessor.cwd) !== record.authorization.cwdKey
    ) {
      throw new Error('Claude Code 会话在启动准备期间已更新，本次启动已取消。');
    }
    this.assertLaunchAuthorizationCurrent(predecessor.cwd, record.authorization);
  }

  private finishPreparedLaunchRecord(record: PreparedClaudeLaunchRecord): void {
    if (this.preparedLaunches.get(record.token) === record) {
      this.preparedLaunches.delete(record.token);
    }
    if (this.preparedLaunchBySession.get(record.token.sessionId) === record.token) {
      this.preparedLaunchBySession.delete(record.token.sessionId);
    }
    const releasedRoutes = new Set<ClaudeRouteKind>();
    if (this.routeLifecycle.release(record.targetRouteReservation)) {
      releasedRoutes.add(record.targetRouteReservation.routeKind);
    }
    if (
      record.predecessorRouteReservation &&
      this.routeLifecycle.release(record.predecessorRouteReservation)
    ) {
      releasedRoutes.add(record.predecessorRouteReservation.routeKind);
    }
    for (const releasedRoute of releasedRoutes) {
      void this.stopUnusedRoute(releasedRoute).catch(() => {});
    }
  }

  public abortPreparedLaunch(launchToken: object, expectedGeneration?: PtyGeneration): boolean {
    const token = launchToken as ClaudePreparedLaunchToken;
    const record = this.preparedLaunches.get(token);
    if (record?.token === token) {
      this.finishPreparedLaunchRecord(record);
      this.removeExactLaunchArtifacts(record.artifactDirectory);
      return true;
    }

    const runtime =
      typeof token.sessionId === 'string' ? this.sessions.get(token.sessionId) : undefined;
    if (
      !runtime?.active ||
      runtime.launchToken !== token ||
      (expectedGeneration !== undefined && runtime.ptyGeneration !== expectedGeneration)
    ) {
      return false;
    }
    const artifactDirectory = runtime.artifactDirectory;
    const deactivated = this.deactivateRuntime(runtime);
    if (deactivated && artifactDirectory) {
      this.removeExactLaunchArtifacts(artifactDirectory);
    }
    return deactivated;
  }

  private removeExactLaunchArtifacts(artifactDirectory: string): void {
    try {
      rmSync(artifactDirectory, { force: true, recursive: true });
    } catch {
      // Exact ownership is already released; a later bounded cleanup retries locked files.
    }
  }

  public cleanupFailedLaunchGeneration(
    sessionId: string,
    expectedGeneration: PtyGeneration,
  ): boolean {
    const runtime = this.sessions.get(sessionId);
    return runtime?.launchToken && runtime.ptyGeneration === expectedGeneration
      ? this.abortPreparedLaunch(runtime.launchToken, expectedGeneration)
      : false;
  }

  public setInactive(sessionId: string, expectedGeneration: PtyGeneration): boolean {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.active || runtime.ptyGeneration !== expectedGeneration) {
      return false;
    }
    return this.deactivateRuntime(runtime);
  }

  public cleanupPreparedLaunch(sessionId: string): boolean {
    const token = this.preparedLaunchBySession.get(sessionId);
    return token ? this.abortPreparedLaunch(token) : false;
  }

  protected abortAllPreparedLaunches(): void {
    for (const token of [...this.preparedLaunches.keys()]) {
      this.abortPreparedLaunch(token);
    }
  }

  private deactivateRuntime(runtime: RuntimeSession): boolean {
    const waitingForCompact = runtime.waitingForCompact;
    this.emitSyntheticSessionEnd(runtime);
    runtime.active = false;
    runtime.advisoryRouteHealth = undefined;
    runtime.launchGeneration = undefined;
    runtime.launchPreflightEvidence = undefined;
    runtime.launchToken = undefined;
    runtime.liveNetworkAccess = undefined;
    runtime.liveOfficialNetworkProvider = undefined;
    runtime.permissionModeRequest = undefined;
    runtime.ptyGeneration = undefined;
    runtime.exitMarker = undefined;
    runtime.markerRemainder = '';
    runtime.waitingForCompact = undefined;
    waitingForCompact?.(0);
    if (runtime.routeKind) {
      void this.stopUnusedRoute(runtime.routeKind).catch(() => {});
    }
    void this.emitState(runtime);
    return true;
  }

  protected emitSyntheticSessionEnd(runtime: RuntimeSession): void {
    if (runtime.launchGeneration === undefined || runtime.ptyGeneration === undefined) return;
    this.onActivityEvent?.({
      event: 'SessionEnd',
      eventId: `session-end-${Date.now()}`,
      launchGeneration: runtime.launchGeneration,
      ptyGeneration: runtime.ptyGeneration,
      sessionId: runtime.sessionId,
      signaledAt: Date.now(),
    });
  }
}
