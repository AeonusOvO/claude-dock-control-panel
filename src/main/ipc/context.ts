import type { ApplicationProxyState } from '../../shared/contracts';

export interface PendingQuitConfirmation {
  readonly id: string;
  readonly mode: 'ordinary' | 'residual';
  readonly owner: 'native' | 'renderer';
}

/*
 * Process state that outlives any single handler. The quit handshake is the reason most of it exists:
 * `before-quit` fires more than once, the renderer answers asynchronously, and each pass has to know what
 * the previous one decided. Other fields cache renderer state or coordinate asynchronous process work.
 */
export interface MainState {
  /** Undefined until the first read; cleared on save so the next read recomputes. */
  applicationProxyState: ApplicationProxyState | undefined;
  /** Swapped for a proxied implementation when the application proxy is on. */
  chatFetch: typeof fetch;
  /** Latched by the confirmed quit so the second `before-quit` pass runs the teardown. */
  isQuitting: boolean;
  nativeSnapshotFlushTimer: NodeJS.Timeout | undefined;
  nextPermissionModeProbeId: number;
  quitCleanupInProgress: boolean;
  /** Main-owned one-shot authority for the exact ordinary or residual prompt currently visible. */
  quitConfirmation: PendingQuitConfirmation | undefined;
  /** Falls back when the renderer does not acknowledge the exact request in time. */
  quitConfirmationTimer: NodeJS.Timeout | undefined;
  /** Force-exits the process if a graceful quit stalls past the watchdog budget. */
  quitWatchdogTimer: NodeJS.Timeout | undefined;
  releaseConversationBusy: (() => void) | undefined;
  runtimeShutdownForQuitDone: boolean;
}

export const createMainState = (): MainState => ({
  applicationProxyState: undefined,
  chatFetch: fetch,
  isQuitting: false,
  nativeSnapshotFlushTimer: undefined,
  nextPermissionModeProbeId: 1,
  quitCleanupInProgress: false,
  quitConfirmation: undefined,
  quitConfirmationTimer: undefined,
  quitWatchdogTimer: undefined,
  releaseConversationBusy: undefined,
  runtimeShutdownForQuitDone: false,
});
