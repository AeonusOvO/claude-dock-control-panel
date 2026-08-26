export const CODEX_ADMISSION_CHANGE_EVENT = 'claudedock:codex-admission-change';
export const WORKSPACE_STATE_CHANGE_EVENT = 'claudedock:workspace-state-change';

const CODEX_ADMISSION_FALLBACK_MS = 5_000;

export const notifyCodexAdmissionChange = (): void => {
  document.dispatchEvent(new Event(CODEX_ADMISSION_CHANGE_EVENT));
};

export const notifyWorkspaceStateChange = (): void => {
  document.dispatchEvent(new Event(WORKSPACE_STATE_CHANGE_EVENT));
};

/**
 * Waits without polling the renderer thread. The bounded fallback is only a lost-signal safety net;
 * ordinary Codex and workspace state projections wake every owner immediately.
 */
export const waitForCodexAdmissionChange = (shouldKeepWaiting: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    let fallback = 0;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      document.removeEventListener(CODEX_ADMISSION_CHANGE_EVENT, handleChange);
      document.removeEventListener(WORKSPACE_STATE_CHANGE_EVENT, handleChange);
      resolve();
    };
    const handleChange = (): void => {
      finish();
    };
    document.addEventListener(CODEX_ADMISSION_CHANGE_EVENT, handleChange);
    document.addEventListener(WORKSPACE_STATE_CHANGE_EVENT, handleChange);
    fallback = window.setTimeout(finish, CODEX_ADMISSION_FALLBACK_MS);

    // Register first, then re-check to close the gap between the caller's predicate and listeners.
    if (!shouldKeepWaiting()) finish();
  });
