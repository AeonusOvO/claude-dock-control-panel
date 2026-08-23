import type { ClaudeOperationResult, PtyGeneration, TerminalStatus } from '../../shared/contracts';
import { createFailureReporter } from '../infra/logger';
import type { MainGuards } from '../ipc/guards';
import type { ClaudeLaunchAuthorization } from './runtime-types';
import type { PermissionModeProbes } from './permission-mode-probe';
import {
  cleanupFailedRuntimeLaunch,
  type FailedRuntimeLaunchCleanupDependencies,
  type RestartRuntimeTerminal,
  type WithExpectedPtyReplacement,
} from '../terminal/lifecycle';
import type { TerminalOutputBatcher } from '../terminal/output-batcher';
import type { TerminalWorkspace } from '../terminal/workspace';

export interface ClaudeLaunchOperationDependencies {
  guards: Pick<
    MainGuards,
    'assertLaunchAdmissionAllowed' | 'assertRealRuntimeAllowed' | 'requireClaudeRuntime'
  >;
  resolvePendingPermissionModeProbes: PermissionModeProbes['resolvePendingPermissionModeProbes'];
  terminalOutputBatcher: TerminalOutputBatcher;
  workspace: TerminalWorkspace;
}

/** The PTY-replacing steps every Claude and Codex launch path shares, plus its failure reporting. */
export interface ClaudeLaunchOperations {
  claudeFailure: (sessionId: string, error: unknown) => Promise<ClaudeOperationResult>;
  failedRuntimeLaunchCleanupDependencies: FailedRuntimeLaunchCleanupDependencies;
  restartRuntimeTerminal: RestartRuntimeTerminal;
  runClaudeResumeLaunch: (
    sessionId: string,
    cwd: string,
    conversationId: string,
    failureMessage: string,
    assertCurrent: () => void,
    launchAuthorization?: object,
    assertPreparationCurrent?: () => void,
    signal?: AbortSignal,
    withExpectedPtyReplacement?: WithExpectedPtyReplacement,
  ) => Promise<PtyGeneration>;
}

const reportClaudeFailure = createFailureReporter('claude');

export const createClaudeLaunchOperations = ({
  guards: { assertLaunchAdmissionAllowed, assertRealRuntimeAllowed, requireClaudeRuntime },
  resolvePendingPermissionModeProbes,
  terminalOutputBatcher,
  workspace,
}: ClaudeLaunchOperationDependencies): ClaudeLaunchOperations => {
  const claudeFailure = async (
    sessionId: string,
    error: unknown,
  ): Promise<ClaudeOperationResult> => {
    const runtime = requireClaudeRuntime();
    const status = workspace.getStatus(sessionId);
    const message = error instanceof Error ? error.message : 'Claude Code 操作失败。';
    return {
      ...reportClaudeFailure('environment', message, error),
      error: message,
      ok: false,
      state: await runtime.getState(sessionId, status.cwd),
    };
  };

  const failedRuntimeLaunchCleanupDependencies = {
    hasSession: (sessionId: string) => workspace.hasSession(sessionId),
    stopIfGeneration: (sessionId: string, expectedGeneration: PtyGeneration) =>
      workspace.stopIfGeneration(sessionId, expectedGeneration),
  };

  const restartRuntimeTerminal: RestartRuntimeTerminal = (
    runtime,
    sessionId,
    environment,
    command,
    failureMessage,
    assertCurrent,
    ownGeneration,
    launchToken,
    withExpectedPtyReplacement,
  ): TerminalStatus => {
    assertLaunchAdmissionAllowed();
    assertRealRuntimeAllowed();
    const previousGeneration = workspace.getStatus(sessionId).ptyGeneration;
    terminalOutputBatcher.discard(sessionId, previousGeneration);
    resolvePendingPermissionModeProbes(sessionId, previousGeneration);
    const terminalStatus = withExpectedPtyReplacement
      ? withExpectedPtyReplacement(previousGeneration, () =>
          workspace.restart(sessionId, environment),
        )
      : workspace.restart(sessionId, environment);
    ownGeneration(terminalStatus.ptyGeneration);
    if (terminalStatus.phase === 'error') {
      throw new Error(terminalStatus.message ?? failureMessage);
    }
    assertCurrent();
    runtime.bindPty(sessionId, terminalStatus.ptyGeneration, launchToken);
    assertCurrent();
    if (!runtime.writeTerminal(sessionId, terminalStatus.ptyGeneration, `${command}\r`)) {
      throw new Error('新的 PowerShell 已停止，启动命令没有写入。');
    }
    return terminalStatus;
  };

  /**
   * Resume an exact Claude transcript inside a workspace tab that already exists, replacing whatever
   * ran there before. Shared by `claude:launch-with-session`, the native→terminal transfer, and the
   * terminal→native rollback so all three agree on prepare → restart → cleanup ordering. Owner
   * bookkeeping is deliberately left to the caller: the transfer paths hand their owner to
   * `commitTransfer` instead of claiming it, which the registry would reject mid-transfer.
   */
  const runClaudeResumeLaunch = async (
    sessionId: string,
    cwd: string,
    conversationId: string,
    failureMessage: string,
    assertCurrent: () => void,
    launchAuthorization?: object,
    assertPreparationCurrent: () => void = assertCurrent,
    signal?: AbortSignal,
    withExpectedPtyReplacement?: WithExpectedPtyReplacement,
  ): Promise<PtyGeneration> => {
    const runtime = requireClaudeRuntime();
    let launchToken: object | undefined;
    let ownedGeneration: PtyGeneration | undefined;
    try {
      signal?.throwIfAborted();
      assertLaunchAdmissionAllowed();
      assertPreparationCurrent();
      const prepared = await runtime.prepareLaunchWithSession(
        sessionId,
        cwd,
        conversationId,
        launchAuthorization as ClaudeLaunchAuthorization | undefined,
      );
      launchToken = prepared.token;
      signal?.throwIfAborted();
      assertLaunchAdmissionAllowed();
      assertPreparationCurrent();
      restartRuntimeTerminal(
        runtime,
        sessionId,
        prepared.environment,
        prepared.command,
        failureMessage,
        assertCurrent,
        (ptyGeneration) => {
          ownedGeneration = ptyGeneration;
        },
        prepared.token,
        withExpectedPtyReplacement,
      );
      signal?.throwIfAborted();
      assertCurrent();
      if (ownedGeneration === undefined) throw new Error('安全终端没有有效的进程代际。');
      return ownedGeneration;
    } catch (error) {
      if (launchToken || ownedGeneration !== undefined) {
        cleanupFailedRuntimeLaunch(
          failedRuntimeLaunchCleanupDependencies,
          runtime,
          sessionId,
          ownedGeneration,
          launchToken,
        );
      }
      throw error;
    }
  };

  return {
    claudeFailure,
    failedRuntimeLaunchCleanupDependencies,
    restartRuntimeTerminal,
    runClaudeResumeLaunch,
  };
};
