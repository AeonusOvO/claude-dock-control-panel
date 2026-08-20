import type { ApplicationProxyState } from '../../shared/contracts';

/*
 * Process state that outlives any single handler. The quit handshake is the reason most of it exists:
 * `before-quit` fires more than once, the renderer answers asynchronously, and each pass has to know what
 * the previous one decided. The rest tracks what has already been applied, so a repeat call is a no-op.
 */
export interface MainState {
  /** Proxy rules currently applied to each session, so an unchanged rule set skips a re-apply. */
  appliedApplicationProxyRules: string;
  appliedConversationProxyRules: string;
  /** Undefined until the first read; cleared on save so the next read recomputes. */
  applicationProxyState: ApplicationProxyState | undefined;
  /** Swapped for a proxied implementation when the application proxy is on. */
  chatFetch: typeof fetch;
  /** Latched by the confirmed quit so the second `before-quit` pass runs the teardown. */
  isQuitting: boolean;
  nativeSnapshotFlushTimer: NodeJS.Timeout | undefined;
  nextPermissionModeProbeId: number;
  quitCleanupInProgress: boolean;
  quitConfirmationPending: boolean;
  /** Forces the quit through if the renderer never answers. */
  quitConfirmationTimer: NodeJS.Timeout | undefined;
  /** Set when processes survived cleanup, so a retry may quit anyway. */
  quitResidualConfirmationPending: boolean;
  /** Force-exits the process if a graceful quit stalls past the watchdog budget. */
  quitWatchdogTimer: NodeJS.Timeout | undefined;
  releaseConversationBusy: (() => void) | undefined;
  runtimeShutdownForQuitDone: boolean;
}

export const createMainState = (): MainState => ({
  appliedApplicationProxyRules: '',
  appliedConversationProxyRules: '',
  applicationProxyState: undefined,
  chatFetch: fetch,
  isQuitting: false,
  nativeSnapshotFlushTimer: undefined,
  nextPermissionModeProbeId: 1,
  quitCleanupInProgress: false,
  quitConfirmationPending: false,
  quitConfirmationTimer: undefined,
  quitResidualConfirmationPending: false,
  quitWatchdogTimer: undefined,
  releaseConversationBusy: undefined,
  runtimeShutdownForQuitDone: false,
});
