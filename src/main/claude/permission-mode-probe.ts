import { CHANNELS } from '../../shared/ipc/channels';
import type { ClaudePermissionMode, PtyGeneration } from '../../shared/contracts';
import type { Registry } from '../infra/registry';
import { MAIN_WINDOW } from '../infra/service-tokens';
import type { MainState } from '../ipc/context';
import type { TerminalOutputBatcher } from '../terminal/output-batcher';
import type { TerminalWorkspace } from '../terminal/workspace';

/**
 * One outstanding request for the renderer to read the permission mode off its xterm buffer. Declared
 * here so the request path and the reply handler share the record instead of restating it; the
 * assembly owns the map because it also clears it on quit.
 */
export interface PendingPermissionModeProbe {
  ptyGeneration: PtyGeneration;
  resolve: (mode: ClaudePermissionMode | undefined) => void;
  sessionId: string;
  timer: NodeJS.Timeout;
}

export interface PermissionModeProbeDependencies {
  /* Owned by the assembly because the quit path also has to drain it. */
  pendingPermissionModeProbes: Map<number, PendingPermissionModeProbe>;
  services: Registry;
  state: MainState;
  terminalOutputBatcher: TerminalOutputBatcher;
  workspace: TerminalWorkspace;
}

export interface PermissionModeProbes {
  requestPermissionModeFromScreen: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
  ) => Promise<ClaudePermissionMode | undefined>;
  resolvePendingPermissionModeProbes: (sessionId: string, ptyGeneration?: PtyGeneration) => void;
}

const PERMISSION_MODE_PROBE_TIMEOUT_MS = 300;

export const createPermissionModeProbes = ({
  pendingPermissionModeProbes,
  services,
  state,
  terminalOutputBatcher,
  workspace,
}: PermissionModeProbeDependencies): PermissionModeProbes => {
  const resolvePendingPermissionModeProbes = (
    sessionId: string,
    ptyGeneration?: PtyGeneration,
  ): void => {
    for (const [probeId, pending] of pendingPermissionModeProbes) {
      if (
        pending.sessionId !== sessionId ||
        (ptyGeneration !== undefined && pending.ptyGeneration !== ptyGeneration)
      ) {
        continue;
      }
      clearTimeout(pending.timer);
      pendingPermissionModeProbes.delete(probeId);
      pending.resolve(undefined);
    }
  };

  /**
   * Requests a synchronous fact from the renderer's xterm buffer. Passive PTY output reports keep the
   * footer current, while this request/reply path gives a mode-switch step a fresh before/after
   * barrier and prevents another Shift+Tab from being sent against an unreadable screen.
   */
  const requestPermissionModeFromScreen = (
    sessionId: string,
    ptyGeneration: PtyGeneration,
  ): Promise<ClaudePermissionMode | undefined> =>
    new Promise((resolve) => {
      if (
        !workspace.hasSession(sessionId) ||
        workspace.getStatus(sessionId).ptyGeneration !== ptyGeneration
      ) {
        resolve(undefined);
        return;
      }
      const target = services.resolve(MAIN_WINDOW).current?.webContents;
      if (!target || target.isDestroyed()) {
        resolve(undefined);
        return;
      }

      const probeId = state.nextPermissionModeProbeId;
      state.nextPermissionModeProbeId =
        state.nextPermissionModeProbeId >= Number.MAX_SAFE_INTEGER
          ? 1
          : state.nextPermissionModeProbeId + 1;
      const timer = setTimeout(() => {
        pendingPermissionModeProbes.delete(probeId);
        resolve(undefined);
      }, PERMISSION_MODE_PROBE_TIMEOUT_MS);
      pendingPermissionModeProbes.set(probeId, {
        ptyGeneration,
        resolve,
        sessionId,
        timer,
      });
      try {
        terminalOutputBatcher.flush(sessionId, ptyGeneration);
        target.send(CHANNELS.CLAUDE_PERMISSION_MODE_PROBE, sessionId, ptyGeneration, probeId);
      } catch {
        clearTimeout(timer);
        pendingPermissionModeProbes.delete(probeId);
        resolve(undefined);
      }
    });

  return { requestPermissionModeFromScreen, resolvePendingPermissionModeProbes };
};
