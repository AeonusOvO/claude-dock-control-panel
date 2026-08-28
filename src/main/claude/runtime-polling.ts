import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeRuntimeActivityEvent } from '../runtime/activity-registry';
import { ClaudeRuntimeControls } from './runtime-controls';
import { optionalFiniteNumber, optionalString, parseClaudeMetrics } from './runtime-metrics';
import type { RuntimeSession } from './runtime-types';

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

export abstract class ClaudeRuntimePolling extends ClaudeRuntimeControls {
  protected activityScriptPath?: string;
  protected onActivityEvent?: (event: ClaudeRuntimeActivityEvent) => void;
  private metricsPollInFlight?: Promise<void>;
  private metricsTimer?: NodeJS.Timeout;

  protected abstract restoreEffortAfterCompatibilityTurn(runtime: RuntimeSession): Promise<void>;

  protected initializeRuntimePolling(): void {
    this.metricsTimer = setInterval(() => {
      this.pollMetrics();
    }, 1000);
    this.metricsTimer.unref();
  }

  protected shutdownRuntimePolling(): void {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
    }
  }

  public setRuntimeActivityHandler(
    scriptPath: string,
    handler: (event: ClaudeRuntimeActivityEvent) => void,
  ): void {
    this.activityScriptPath = scriptPath;
    this.onActivityEvent = handler;
  }

  private async pollRuntimeSignal(runtime: RuntimeSession): Promise<void> {
    const waitingForCompact = runtime.waitingForCompact;
    const signalPath = runtime.signalPath;
    const launchGeneration = runtime.launchGeneration;
    const ptyGeneration = runtime.ptyGeneration;
    if (
      !waitingForCompact ||
      !signalPath ||
      launchGeneration === undefined ||
      ptyGeneration === undefined ||
      !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration)
    ) {
      return;
    }

    try {
      // `Set-Content -Encoding UTF8` writes a BOM on Windows PowerShell; JSON.parse rejects it.
      const raw = await this.readLaunchArtifact(signalPath);
      if (
        !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration) ||
        runtime.signalPath !== signalPath ||
        runtime.waitingForCompact !== waitingForCompact
      ) {
        return;
      }
      const parsed = JSON.parse(
        raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw,
      ) as {
        event?: unknown;
        signaledAt?: unknown;
      };
      const signaledAt = optionalFiniteNumber(parsed.signaledAt);
      if (parsed.event !== 'PostCompact' || !signaledAt || signaledAt === runtime.signalSeenAt) {
        return;
      }
      runtime.signalSeenAt = signaledAt;
      waitingForCompact(signaledAt);
    } catch {
      // The helper replaces the file atomically; retry on the next poll.
    }
  }

  private async pollTurnStopSignal(runtime: RuntimeSession): Promise<void> {
    const turnStopPath = runtime.turnStopPath;
    const launchGeneration = runtime.launchGeneration;
    const ptyGeneration = runtime.ptyGeneration;
    if (
      runtime.effortRestoreInProgress ||
      !turnStopPath ||
      launchGeneration === undefined ||
      ptyGeneration === undefined ||
      !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration)
    ) {
      return;
    }

    try {
      const raw = await this.readLaunchArtifact(turnStopPath);
      if (
        !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration) ||
        runtime.turnStopPath !== turnStopPath ||
        runtime.effortRestoreInProgress
      ) {
        return;
      }
      const parsed = JSON.parse(
        raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw,
      ) as {
        event?: unknown;
        signaledAt?: unknown;
      };
      const signaledAt = optionalFiniteNumber(parsed.signaledAt);
      if (parsed.event !== 'Stop' || !signaledAt || signaledAt === runtime.turnStopSeenAt) {
        return;
      }
      runtime.turnStopSeenAt = signaledAt;
      if (
        !runtime.effortRestoreAfterTurn ||
        (runtime.effortCompatibility && signaledAt <= runtime.effortCompatibility.detectedAt)
      ) {
        return;
      }
      void this.restoreEffortAfterCompatibilityTurn(runtime);
    } catch {
      // The helper replaces the file atomically; retry on the next poll.
    }
  }

  private async pollRuntimeActivityEvents(runtime: RuntimeSession): Promise<void> {
    const eventsPath = runtime.activityEventsPath;
    const launchGeneration = runtime.launchGeneration;
    const ptyGeneration = runtime.ptyGeneration;
    const handler = this.onActivityEvent;
    if (
      !eventsPath ||
      !handler ||
      launchGeneration === undefined ||
      ptyGeneration === undefined ||
      !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration)
    ) {
      return;
    }
    try {
      const files = (await readdir(eventsPath))
        .filter((name) => /^event-\d+-[a-f0-9]{32}\.json$/i.test(name))
        .sort()
        .slice(0, 100);
      for (const name of files) {
        const eventPath = path.join(eventsPath, name);
        try {
          const raw = await readFile(eventPath, 'utf8');
          if (!this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration)) return;
          const parsed = JSON.parse(
            raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw,
          ) as Partial<ClaudeRuntimeActivityEvent>;
          if (
            typeof parsed.event !== 'string' ||
            typeof parsed.eventId !== 'string' ||
            parsed.sessionId !== runtime.sessionId ||
            parsed.launchGeneration !== launchGeneration ||
            typeof parsed.signaledAt !== 'number'
          ) {
            await unlink(eventPath);
            continue;
          }
          handler({
            agentId: optionalString(parsed.agentId),
            agentType: optionalString(parsed.agentType),
            backgroundTasks: Array.isArray(parsed.backgroundTasks)
              ? parsed.backgroundTasks.slice(0, 50).map((task) => ({
                  description: optionalString(task?.description),
                  id: optionalString(task?.id),
                  kind: optionalString(task?.kind),
                }))
              : undefined,
            backgroundTasksPresent: parsed.backgroundTasksPresent === true,
            description: optionalString(parsed.description),
            event: parsed.event,
            eventId: parsed.eventId,
            failureKind: optionalString(parsed.failureKind),
            launchGeneration,
            ptyGeneration,
            sessionId: runtime.sessionId,
            signaledAt: parsed.signaledAt,
            taskId: optionalString(parsed.taskId),
          });
          await unlink(eventPath);
        } catch {
          // A file may still be completing or temporarily locked; retry it on the next poll.
        }
      }
    } catch {
      // The event directory is optional and can disappear during generation cleanup.
    }
  }

  protected override ensureSession(sessionId: string, cwd: string): RuntimeSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.cwd = cwd;
      return existing;
    }

    const created: RuntimeSession = {
      active: false,
      cwd,
      diagnosticBuffer: '',
      effortRestoreInProgress: false,
      markerRemainder: '',
      permissionModeCycle: [],
      sessionId,
      thinkingEnabledForHighEffort: false,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private readLaunchArtifact(artifactPath: string): Promise<string> {
    return readFile(artifactPath, 'utf8');
  }

  private async pollRuntimeMetrics(runtime: RuntimeSession): Promise<void> {
    const metricsPath = runtime.metricsPath;
    const launchGeneration = runtime.launchGeneration;
    const ptyGeneration = runtime.ptyGeneration;
    if (
      !metricsPath ||
      launchGeneration === undefined ||
      ptyGeneration === undefined ||
      !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration)
    ) {
      return;
    }

    try {
      const raw = await this.readLaunchArtifact(metricsPath);
      if (
        !this.isRuntimeLaunchPtyCurrent(runtime, launchGeneration, ptyGeneration) ||
        runtime.metricsPath !== metricsPath
      ) {
        return;
      }
      const metrics = parseClaudeMetrics(raw);
      if (!metrics || metrics.capturedAt === runtime.metrics?.capturedAt) {
        return;
      }
      if (metrics.effortLevel === 'xhigh' || metrics.effortLevel === 'max') {
        this.enableThinkingForHighEffort(runtime);
      }
      runtime.metrics = metrics;
      this.modelUsageObserver?.observe(
        runtime.usageConnection,
        runtime.cwd,
        metrics.sessionId,
        metrics,
      );
      if (runtime.lastApiError && metrics.capturedAt > runtime.lastApiError.detectedAt) {
        runtime.lastApiError = undefined;
      }
      this.captureConversationPreferences(runtime);
      this.replayRememberedEffort(runtime);
      void this.emitState(runtime);
    } catch {
      // The status-line helper replaces the file atomically; retry on the next poll.
    }
  }

  private async pollMetricsOnce(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async (runtime) => {
        await Promise.all([
          this.pollRuntimeActivityEvents(runtime),
          this.pollRuntimeSignal(runtime),
          this.pollTurnStopSignal(runtime),
          this.pollRuntimeMetrics(runtime),
        ]);
      }),
    );
  }

  private pollMetrics(): void {
    if (this.metricsPollInFlight) {
      return;
    }
    const poll = this.pollMetricsOnce();
    this.metricsPollInFlight = poll;
    void poll.then(
      () => {
        if (this.metricsPollInFlight === poll) {
          this.metricsPollInFlight = undefined;
        }
      },
      () => {
        if (this.metricsPollInFlight === poll) {
          this.metricsPollInFlight = undefined;
        }
      },
    );
  }
}
