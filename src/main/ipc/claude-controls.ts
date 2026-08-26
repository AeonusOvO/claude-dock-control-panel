import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type {
  ClaudeOperationResult,
  ClaudePermissionMode,
  PtyGeneration,
} from '../../shared/contracts';
import type { ReportClaudeOperationFailure } from '../claude/operation-failure';
import type { PendingPermissionModeProbe } from '../claude/permission-mode-probe';
import { effectiveClaudeNetworkAccess } from '../claude/runtime-types';
import type { WithSessionOperation } from '../coordination/session-operation';
import {
  cleanupFailedRuntimeLaunch,
  type FailedRuntimeLaunchCleanupDependencies,
  type RestartRuntimeTerminal,
} from '../terminal/lifecycle';
import type { TerminalWorkspace } from '../terminal/workspace';
import type { Registry } from '../infra/registry';
import { CLAUDE_PERMISSION_BRIDGE } from '../infra/service-tokens';
import {
  validateClaudeEffortRequest,
  validateClaudePermissionDecision,
  validateClaudePermissionMode,
  validateModelOptionId,
  validateModelSpeedMode,
  validatePtyGeneration,
  validateSessionId,
} from './validation';
import type { MainGuards } from './guards';

export interface ClaudeControlsIpcDependencies {
  claudeFailure: ReportClaudeOperationFailure;
  failedRuntimeLaunchCleanupDependencies: FailedRuntimeLaunchCleanupDependencies;
  guards: Pick<
    MainGuards,
    'withOfficialProviderAccess' | 'requireClaudeRuntime' | 'validateSender'
  >;
  /* Shared with the request path that opens each probe and with quit cleanup, which resolves the rest. */
  pendingPermissionModeProbes: Map<number, PendingPermissionModeProbe>;
  restartRuntimeTerminal: RestartRuntimeTerminal;
  services: Registry;
  withDevelopmentSessionOperation: WithSessionOperation;
  workspace: TerminalWorkspace;
}

const registerPermissionObservationIpc = (
  requireClaudeRuntime: ClaudeControlsIpcDependencies['guards']['requireClaudeRuntime'],
  validateSender: ClaudeControlsIpcDependencies['guards']['validateSender'],
  pendingPermissionModeProbes: Map<number, PendingPermissionModeProbe>,
  workspace: TerminalWorkspace,
): void => {
  ipcMain.on(
    CHANNELS.CLAUDE_PERMISSION_MODE_OBSERVED,
    (event, sessionId: unknown, ptyGeneration: unknown, mode: unknown) => {
      validateSender(event);
      try {
        const validatedSessionId = validateSessionId(sessionId);
        const validatedGeneration = validatePtyGeneration(ptyGeneration);
        const status = workspace.getStatus(validatedSessionId);
        requireClaudeRuntime().observePermissionModeFromScreen(
          validatedSessionId,
          status.cwd,
          validatedGeneration,
          validateClaudePermissionMode(mode),
        );
      } catch {
        // A queued xterm write can finish immediately after its project or Claude session is closed.
      }
    },
  );
  ipcMain.on(
    CHANNELS.CLAUDE_PERMISSION_MODE_PROBE_RESULT,
    (event, sessionId: unknown, ptyGeneration: unknown, probeId: unknown, mode: unknown) => {
      validateSender(event);
      if (
        typeof probeId !== 'number' ||
        !Number.isSafeInteger(probeId) ||
        probeId < 1 ||
        typeof sessionId !== 'string'
      ) {
        return;
      }
      const pending = pendingPermissionModeProbes.get(probeId);
      if (!pending || pending.sessionId !== sessionId) {
        return;
      }

      let validatedMode: ClaudePermissionMode | undefined;
      let validatedGeneration: PtyGeneration;
      try {
        const validatedSessionId = validateSessionId(sessionId);
        validatedGeneration = validatePtyGeneration(ptyGeneration);
        const current = workspace.getStatus(validatedSessionId);
        if (
          pending.ptyGeneration !== validatedGeneration ||
          current.ptyGeneration !== validatedGeneration
        ) {
          throw new Error('终端代次已经失效。');
        }
        validatedMode = mode === undefined ? undefined : validateClaudePermissionMode(mode);
      } catch {
        clearTimeout(pending.timer);
        pendingPermissionModeProbes.delete(probeId);
        pending.resolve(undefined);
        return;
      }
      clearTimeout(pending.timer);
      pendingPermissionModeProbes.delete(probeId);
      pending.resolve(validatedMode);
    },
  );
};

export const registerClaudeControlsIpc = ({
  claudeFailure,
  failedRuntimeLaunchCleanupDependencies,
  guards: { requireClaudeRuntime, validateSender, withOfficialProviderAccess },
  pendingPermissionModeProbes,
  restartRuntimeTerminal,
  services,
  withDevelopmentSessionOperation,
  workspace,
}: ClaudeControlsIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_PERMISSION_RESPONSE,
    (event, requestId: unknown, decision: unknown): boolean => {
      validateSender(event);
      if (typeof requestId !== 'string' || requestId.length > 200) {
        throw new Error('权限请求已失效。');
      }
      return services
        .resolve(CLAUDE_PERMISSION_BRIDGE)
        .respond(requestId, validateClaudePermissionDecision(decision));
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_SWITCH_MODEL,
    async (event, sessionId: unknown, optionId: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        return {
          ok: true,
          state: await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
            requireClaudeRuntime().switchModel(
              validatedSessionId,
              status.cwd,
              validateModelOptionId(optionId),
              assertCurrent,
            ),
          ),
        };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_SET_PERMISSION_MODE,
    async (event, sessionId: unknown, mode: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        return {
          ok: true,
          state: await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
            requireClaudeRuntime().setPermissionMode(
              validatedSessionId,
              status.cwd,
              validateClaudePermissionMode(mode),
              assertCurrent,
            ),
          ),
        };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_SET_EFFORT,
    async (event, sessionId: unknown, effort: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        return {
          ok: true,
          state: await withDevelopmentSessionOperation(validatedSessionId, (assertCurrent) =>
            requireClaudeRuntime().setEffort(
              validatedSessionId,
              status.cwd,
              validateClaudeEffortRequest(effort),
              assertCurrent,
            ),
          ),
        };
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_SET_MODEL_SPEED,
    async (event, sessionId: unknown, mode: unknown): Promise<ClaudeOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          let launchToken: object | undefined;
          let ownedGeneration: PtyGeneration | undefined;
          try {
            const validatedMode = validateModelSpeedMode(mode);
            if (!runtime.isActive(validatedSessionId)) {
              assertCurrent();
              const state = await runtime.saveModelSpeedPreference(
                validatedSessionId,
                status.cwd,
                validatedMode,
              );
              assertCurrent();
              return { ok: true, state };
            }

            const authorization = runtime.captureLaunchAuthorization(
              status.cwd,
              validatedSessionId,
            );
            const relaunchWithModelSpeed = async (): Promise<ClaudeOperationResult> => {
              try {
                assertCurrent();
                runtime.assertLaunchAuthorizationCurrent(
                  status.cwd,
                  authorization,
                  validatedSessionId,
                );
                const prepared = await runtime.prepareModelSpeedRelaunch(
                  validatedSessionId,
                  status.cwd,
                  validatedMode,
                  authorization,
                );
                launchToken = prepared.token;
                assertCurrent();
                restartRuntimeTerminal(
                  runtime,
                  validatedSessionId,
                  prepared.environment,
                  prepared.command,
                  '无法为 Claude Code 启动安全终端。',
                  assertCurrent,
                  (ptyGeneration) => {
                    ownedGeneration = ptyGeneration;
                  },
                  prepared.token,
                );
                const state = await runtime.commitModelSpeedPreference(
                  validatedSessionId,
                  status.cwd,
                  prepared.targetKey,
                  prepared.preference,
                );
                assertCurrent();
                return { ok: true, state };
              } catch (error) {
                if (launchToken || ownedGeneration !== undefined) {
                  cleanupFailedRuntimeLaunch(
                    failedRuntimeLaunchCleanupDependencies,
                    runtime,
                    validatedSessionId,
                    ownedGeneration,
                    launchToken,
                  );
                }
                throw error;
              }
            };
            const networkAccess = effectiveClaudeNetworkAccess(
              authorization.networkAccess,
              authorization.officialNetworkProvider,
            );
            return networkAccess
              ? await withOfficialProviderAccess(
                  {
                    action: 'cli-launch',
                    cwd: status.cwd,
                    ...networkAccess,
                  },
                  relaunchWithModelSpeed,
                )
              : await relaunchWithModelSpeed();
          } catch (error) {
            return claudeFailure(validatedSessionId, error);
          }
        });
      } catch (error) {
        return claudeFailure(validatedSessionId, error);
      }
    },
  );
  registerPermissionObservationIpc(
    requireClaudeRuntime,
    validateSender,
    pendingPermissionModeProbes,
    workspace,
  );
};
