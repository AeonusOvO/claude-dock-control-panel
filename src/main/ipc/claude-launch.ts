import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type {
  ClaudeLaunchOutcome,
  ClaudeOperationResult,
  ClaudeProjectState,
  NetworkPreflightResult,
  PtyGeneration,
} from '../../shared/contracts';
import { registerClaudeCommandIpc } from '../claude/command-ipc';
import type {
  ClaudeRuntime,
  PreparedLaunchExecution,
  ProviderAuthorizedOperation,
  RelaunchExecution,
  ResumeSessionExecution,
} from '../claude/launch-execution-types';
import type { ClaudeLaunchIpcDependencies } from '../claude/launch-ipc-dependencies';
import { registerClaudeLaunchDecisionIpc } from '../claude/launch-decision-ipc';
import type { PreparedClaudeConfigSave } from '../claude/runtime';
import type { ClaudeLaunchAuthorization } from '../claude/runtime-types';
import { isValidClaudeSessionId } from '../claude/session-manager';
import type { ConversationOwner } from '../conversation/owner-registry';
import {
  type ClaudeLaunchDecisionBaseline,
  type ClaudeLaunchDescriptor,
  LaunchPreflightDecisionStaleError,
  launchPauseDiagnosticsFromResult,
} from '../coordination/launch-preflight-decision';
import type { SessionOperationStamp } from '../coordination/session-operation';
import { ProviderAccessBlockedError } from '../network/provider-access-guard';
import { cleanupFailedRuntimeLaunch } from '../terminal/lifecycle';
import {
  validateClaudeLaunchMode,
  validateClaudeRelaunchInput,
  validateSessionId,
} from './validation';

export type { ClaudeLaunchIpcDependencies } from '../claude/launch-ipc-dependencies';

const seedLaunchPreflightEvidence = (
  runtime: ClaudeRuntime,
  sessionId: string,
  ptyGeneration: PtyGeneration,
  result: NetworkPreflightResult | undefined,
): void => {
  if (!result || result.action !== 'cli-launch' || result.status === 'testing') return;
  runtime.seedActiveLaunchPreflightEvidence?.(sessionId, ptyGeneration, {
    checkedAt: result.checkedAt ?? result.startedAt,
    provider: result.provider,
    status:
      result.status === 'allowed'
        ? 'allowed'
        : result.status === 'blocked'
          ? 'blocked'
          : 'degraded',
  });
};

/** Shared prepare → exact-token PTY handoff → state path for initial and continued launches. */
export const executePreparedLaunch = async ({
  assertCurrent,
  assertPreparationCurrent,
  authorization,
  cleanup,
  cwd,
  mode,
  preflightResult,
  restartRuntimeTerminal,
  runtime,
  sessionId,
  signal,
  withExpectedPtyReplacement,
}: PreparedLaunchExecution): Promise<ClaudeOperationResult> => {
  let launchToken: object | undefined;
  let ownedGeneration: PtyGeneration | undefined;
  try {
    signal.throwIfAborted();
    assertPreparationCurrent();
    runtime.assertLaunchAuthorizationCurrent(cwd, authorization);
    const prepared = await runtime.prepareLaunch(sessionId, cwd, mode, undefined, authorization);
    launchToken = prepared.token;
    signal.throwIfAborted();
    assertPreparationCurrent();
    runtime.assertLaunchAuthorizationCurrent(cwd, authorization);
    restartRuntimeTerminal(
      runtime,
      sessionId,
      prepared.environment,
      prepared.command,
      '无法为 Claude Code 启动安全终端。',
      assertCurrent,
      (ptyGeneration) => {
        ownedGeneration = ptyGeneration;
      },
      prepared.token,
      withExpectedPtyReplacement,
    );
    signal.throwIfAborted();
    assertCurrent();
    if (ownedGeneration !== undefined) {
      seedLaunchPreflightEvidence(runtime, sessionId, ownedGeneration, preflightResult);
    }
    const state = await runtime.getState(sessionId, cwd);
    signal.throwIfAborted();
    assertCurrent();
    return { ok: true, state };
  } catch (error) {
    if (launchToken || ownedGeneration !== undefined) {
      cleanupFailedRuntimeLaunch(cleanup, runtime, sessionId, ownedGeneration, launchToken);
    }
    throw error;
  }
};

/** Executes one exact relaunch descriptor without retaining credential-bearing captures. */
export const executeClaudeRelaunch = async ({
  assertCurrent,
  assertOriginalConfigurationCurrent,
  authorizeLaunchProvider,
  authorizeNestedProvider,
  cleanup,
  cwd,
  input,
  restartRuntimeTerminal,
  runClaudeProjectConfigTransaction,
  runtime,
  sessionId,
  signal,
  withExpectedPtyReplacement,
  workspacePtyGeneration,
}: RelaunchExecution): Promise<ClaudeOperationResult> => {
  let launchPreflightResult: NetworkPreflightResult | undefined;
  let launchToken: object | undefined;
  let ownedGeneration: PtyGeneration | undefined;
  const compactCurrentConversation = async (): Promise<void> => {
    await runtime.compactBeforeRelaunch(sessionId, cwd, input.compactFirst, assertCurrent, signal);
    signal.throwIfAborted();
    assertCurrent();
  };
  const compactLiveConversation = async (): Promise<void> => {
    signal.throwIfAborted();
    if (!input.compactFirst || !runtime.isActive(sessionId)) {
      await compactCurrentConversation();
      return;
    }
    const liveProvider = runtime.officialNetworkProviderForActivePty(
      sessionId,
      workspacePtyGeneration,
    );
    await authorizeNestedProvider(
      liveProvider,
      async () => {
        assertCurrent();
        return compactCurrentConversation();
      },
      signal,
    );
  };
  const launchReplacement = async (
    authorization: ClaudeLaunchAuthorization,
  ): Promise<ClaudeProjectState> => {
    signal.throwIfAborted();
    assertCurrent();
    runtime.assertLaunchAuthorizationCurrent(cwd, authorization);
    const prepared = await runtime.prepareLaunch(
      sessionId,
      cwd,
      'continue',
      input.permissionMode,
      authorization,
    );
    launchToken = prepared.token;
    signal.throwIfAborted();
    assertCurrent();
    runtime.assertLaunchAuthorizationCurrent(cwd, authorization);
    restartRuntimeTerminal(
      runtime,
      sessionId,
      prepared.environment,
      prepared.command,
      '无法为 Claude Code 启动安全终端。',
      assertCurrent,
      (ptyGeneration) => {
        ownedGeneration = ptyGeneration;
      },
      prepared.token,
      withExpectedPtyReplacement,
    );
    signal.throwIfAborted();
    assertCurrent();
    if (ownedGeneration !== undefined) {
      seedLaunchPreflightEvidence(runtime, sessionId, ownedGeneration, launchPreflightResult);
    }
    const state = await runtime.getState(sessionId, cwd);
    signal.throwIfAborted();
    assertCurrent();
    return state;
  };
  const cleanupOnFailure = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (launchToken || ownedGeneration !== undefined) {
        cleanupFailedRuntimeLaunch(cleanup, runtime, sessionId, ownedGeneration, launchToken);
      }
      throw error;
    }
  };

  const entryId = input.entryId;
  if (!entryId) {
    assertOriginalConfigurationCurrent();
    const authorization = runtime.captureLaunchAuthorization(cwd);
    const relaunchCurrent = (
      preflightResult?: NetworkPreflightResult,
    ): Promise<ClaudeProjectState> => {
      signal.throwIfAborted();
      launchPreflightResult = preflightResult;
      return cleanupOnFailure(async () => {
        signal.throwIfAborted();
        assertCurrent();
        assertOriginalConfigurationCurrent();
        runtime.assertLaunchAuthorizationCurrent(cwd, authorization);
        await compactLiveConversation();
        signal.throwIfAborted();
        assertOriginalConfigurationCurrent();
        runtime.assertLaunchAuthorizationCurrent(cwd, authorization);
        return launchReplacement(authorization);
      });
    };
    const state = await authorizeLaunchProvider(
      authorization.officialNetworkProvider,
      relaunchCurrent,
      signal,
    );
    signal.throwIfAborted();
    assertCurrent();
    return { ok: true, state };
  }

  assertOriginalConfigurationCurrent();
  const historyAuthorization = runtime.captureConnectionHistoryAuthorization(cwd, entryId);
  const switchAndRelaunch = (
    preflightResult?: NetworkPreflightResult,
  ): Promise<ClaudeProjectState> => {
    signal.throwIfAborted();
    launchPreflightResult = preflightResult;
    return cleanupOnFailure(() => {
      signal.throwIfAborted();
      assertCurrent();
      assertOriginalConfigurationCurrent();
      return runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
        assertCurrent,
        commit: (prepared) => runtime.commitPreparedConfig(cwd, prepared),
        complete: async (prepared) => {
          signal.throwIfAborted();
          assertCurrent();
          const launchAuthorization = runtime.captureLaunchAuthorization(cwd);
          if (
            launchAuthorization.officialNetworkProvider !==
            historyAuthorization.officialNetworkProvider
          ) {
            throw new Error('历史接入保存结果与已授权提供方不一致，请重试。');
          }
          await runtime.completePreparedConfigSave(sessionId, cwd, prepared);
          signal.throwIfAborted();
          assertCurrent();
          runtime.assertLaunchAuthorizationCurrent(cwd, launchAuthorization);
          return launchReplacement(launchAuthorization);
        },
        cwd,
        prepare: async () => {
          signal.throwIfAborted();
          assertCurrent();
          assertOriginalConfigurationCurrent();
          runtime.assertConnectionHistoryAuthorizationCurrent(cwd, historyAuthorization);
          await compactLiveConversation();
          signal.throwIfAborted();
          assertCurrent();
          assertOriginalConfigurationCurrent();
          runtime.assertConnectionHistoryAuthorizationCurrent(cwd, historyAuthorization);
          return runtime.prepareAuthorizedConnectionHistory(
            cwd,
            historyAuthorization,
            assertCurrent,
          );
        },
        runtime,
        sessionId,
      });
    });
  };
  const state = await authorizeLaunchProvider(
    historyAuthorization.officialNetworkProvider,
    switchAndRelaunch,
    signal,
  );
  signal.throwIfAborted();
  assertCurrent();
  return { ok: true, state };
};

/** Reacquires transcript and terminal ownership around one exact session-resume launch. */
export const executeClaudeSessionResume = async ({
  assertCurrent,
  assertPreparationCurrent,
  authorizeLaunchProvider,
  claudeConversationLifecycle,
  cleanup,
  conversationId,
  conversationOwnerRegistry,
  cwd,
  expectedOfficialNetworkProvider,
  runClaudeResumeLaunch,
  runtime,
  sessionId,
  signal,
  terminalConversationOwners,
  withExpectedPtyReplacement,
  workspace,
}: ResumeSessionExecution): Promise<ClaudeOperationResult> => {
  signal.throwIfAborted();
  assertPreparationCurrent();
  const existingOwner = conversationOwnerRegistry.ownerFor({
    conversationId,
    projectPath: cwd,
    runtime: 'claude',
  });
  if (existingOwner) {
    if (existingOwner.ownerId === `terminal:${sessionId}`) {
      const state = await runtime.getState(sessionId, cwd);
      signal.throwIfAborted();
      assertCurrent();
      return { ok: true, state };
    }
    throw new Error(
      existingOwner.ownerKind === 'native'
        ? '该对话已在原生界面运行。'
        : '该对话已在另一个高级终端运行。',
    );
  }

  const authorization = runtime.captureLaunchAuthorization(cwd);
  if (authorization.officialNetworkProvider !== expectedOfficialNetworkProvider) {
    throw new LaunchPreflightDecisionStaleError();
  }
  const resumeWithOwnership = async (
    preflightResult?: NetworkPreflightResult,
  ): Promise<ClaudeOperationResult> => {
    signal.throwIfAborted();
    assertPreparationCurrent();
    runtime.assertLaunchAuthorizationCurrent(cwd, authorization);
    const currentStatus = workspace.getStatus(sessionId);
    const terminalOwner: ConversationOwner = {
      conversationId: conversationId.toLowerCase(),
      generation: Number(currentStatus.ptyGeneration) + 1,
      ownerId: `terminal:${sessionId}`,
      ownerKind: 'terminal',
      phase: 'starting',
      projectPath: cwd,
      runtime: 'claude',
    };
    signal.throwIfAborted();
    assertPreparationCurrent();
    const ownerClaim = conversationOwnerRegistry.claim(terminalOwner);
    if (ownerClaim.status === 'conflict') {
      throw new Error('该对话刚刚被其他界面接管。');
    }
    const claimedOwner = ownerClaim.owner;
    terminalConversationOwners.set(sessionId, claimedOwner);
    const releaseClaimedOwner = (): void => {
      if (terminalConversationOwners.get(sessionId) !== claimedOwner) return;
      conversationOwnerRegistry.release(
        claimedOwner,
        claimedOwner.ownerId,
        claimedOwner.generation,
      );
      terminalConversationOwners.delete(sessionId);
    };
    let ownedGeneration: PtyGeneration | undefined;
    try {
      return await claudeConversationLifecycle.runResume(
        cwd,
        conversationId,
        sessionId,
        async (conversationOwnership) => {
          const assertResumeCurrent = (): void => {
            signal.throwIfAborted();
            conversationOwnership.assertCurrent();
            assertCurrent();
          };
          const assertResumePreparationCurrent = (): void => {
            signal.throwIfAborted();
            conversationOwnership.assertCurrent();
            assertPreparationCurrent();
            runtime.assertLaunchAuthorizationCurrent(cwd, authorization);
          };
          const resumedGeneration = await runClaudeResumeLaunch(
            sessionId,
            cwd,
            conversationId,
            '无法为 Claude Code 启动安全终端。',
            assertResumeCurrent,
            authorization,
            assertResumePreparationCurrent,
            signal,
            withExpectedPtyReplacement,
          );
          ownedGeneration = resumedGeneration;
          assertResumeCurrent();
          seedLaunchPreflightEvidence(runtime, sessionId, resumedGeneration, preflightResult);
          const state = await runtime.getState(sessionId, cwd);
          assertResumeCurrent();
          if (Number(resumedGeneration) !== claimedOwner.generation) {
            throw new Error('恢复会话绑定了意外的终端代际，本次启动已取消。');
          }
          if (
            !conversationOwnerRegistry.updatePhase(
              claimedOwner,
              claimedOwner.ownerId,
              claimedOwner.generation,
              'active',
            )
          ) {
            throw new Error('对话所有权在启动完成前已更新，本次恢复已取消。');
          }
          return { ok: true, state };
        },
      );
    } catch (error) {
      if (ownedGeneration !== undefined) {
        cleanupFailedRuntimeLaunch(cleanup, runtime, sessionId, ownedGeneration);
      }
      releaseClaimedOwner();
      throw error;
    }
  };

  return authorizeLaunchProvider(
    authorization.officialNetworkProvider,
    resumeWithOwnership,
    signal,
  );
};

const registerClaudeRelaunchIpc = ({
  agentRuntimeStore,
  claudeFailure,
  developmentSessionOperations,
  failedRuntimeLaunchCleanupDependencies,
  guards: {
    assertLaunchAdmissionAllowed,
    requireClaudeRuntime,
    validateSender,
    withOfficialProviderAccess,
  },
  launchPreflightDecisions,
  restartRuntimeTerminal,
  runClaudeProjectConfigTransaction,
  withLaunchDecisionSessionOperation,
  workspace,
}: ClaudeLaunchIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_RELAUNCH,
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeLaunchOutcome> => {
      validateSender(event);
      assertLaunchAdmissionAllowed();
      const validatedSessionId = validateSessionId(sessionId);
      const validatedInput = validateClaudeRelaunchInput(input);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      const intent = launchPreflightDecisions.beginLaunch(validatedSessionId);
      const descriptor: ClaudeLaunchDescriptor = Object.freeze({
        cwd: status.cwd,
        input: validatedInput,
        kind: 'relaunch',
        sessionId: validatedSessionId,
      });
      let baseline: ClaudeLaunchDecisionBaseline | undefined;

      const captureBaseline = (operation: SessionOperationStamp): ClaudeLaunchDecisionBaseline =>
        Object.freeze({
          configuration: runtime.captureLaunchConfigurationBaseline(status.cwd),
          ...(validatedInput.entryId === undefined
            ? {}
            : {
                history: runtime.captureConnectionHistoryBaseline(
                  status.cwd,
                  validatedInput.entryId,
                ),
              }),
          operation,
          runtime: runtime.captureRuntimeLaunchBaseline(validatedSessionId, status.cwd),
          workspacePtyGeneration: status.ptyGeneration,
        });
      const assertBaselineCurrent = (candidate: ClaudeLaunchDecisionBaseline): void => {
        assertLaunchAdmissionAllowed();
        launchPreflightDecisions.assertIntentCurrent(intent);
        developmentSessionOperations.assertStampCurrent(candidate.operation);
        const currentStatus = workspace.getStatus(validatedSessionId);
        if (
          currentStatus.cwd !== status.cwd ||
          currentStatus.ptyGeneration !== candidate.workspacePtyGeneration ||
          agentRuntimeStore.get(status.cwd) !== 'claude'
        ) {
          throw new LaunchPreflightDecisionStaleError();
        }
        runtime.assertLaunchConfigurationBaselineCurrent(status.cwd, candidate.configuration);
        runtime.assertRuntimeLaunchBaselineCurrent(
          validatedSessionId,
          status.cwd,
          candidate.runtime,
        );
        if (candidate.history) {
          runtime.assertConnectionHistoryBaselineCurrent(status.cwd, candidate.history);
        }
      };
      const authorizeProvider: ProviderAuthorizedOperation = (provider, operation, signal) => {
        signal?.throwIfAborted();
        return provider
          ? withOfficialProviderAccess(
              { action: 'cli-launch', cwd: status.cwd, provider },
              operation,
              signal,
            )
          : operation();
      };

      try {
        const result = await withLaunchDecisionSessionOperation(
          validatedSessionId,
          async (assertCurrent, signal) => {
            signal.throwIfAborted();
            const operationStamp = developmentSessionOperations.captureStamp(validatedSessionId);
            baseline = captureBaseline(operationStamp);
            const assertRelaunchCurrent = (): void => {
              assertLaunchAdmissionAllowed();
              assertCurrent();
              launchPreflightDecisions.assertIntentCurrent(intent);
              developmentSessionOperations.assertStampCurrent(operationStamp);
              const currentStatus = workspace.getStatus(validatedSessionId);
              if (
                currentStatus.cwd !== status.cwd ||
                agentRuntimeStore.get(status.cwd) !== 'claude'
              ) {
                throw new LaunchPreflightDecisionStaleError();
              }
            };
            const assertOriginalConfigurationCurrent = (): void => {
              assertRelaunchCurrent();
              assertBaselineCurrent(baseline as ClaudeLaunchDecisionBaseline);
            };
            return executeClaudeRelaunch({
              assertCurrent: assertRelaunchCurrent,
              assertOriginalConfigurationCurrent,
              authorizeLaunchProvider: authorizeProvider,
              authorizeNestedProvider: authorizeProvider,
              cleanup: failedRuntimeLaunchCleanupDependencies,
              cwd: status.cwd,
              input: validatedInput,
              restartRuntimeTerminal,
              runClaudeProjectConfigTransaction,
              runtime,
              sessionId: validatedSessionId,
              signal,
              withExpectedPtyReplacement: (predecessor, restart) =>
                launchPreflightDecisions.withExpectedPtyReplacement(intent, predecessor, restart),
              workspacePtyGeneration: status.ptyGeneration,
            });
          },
        );
        return { result, status: 'completed' };
      } catch (error) {
        if (error instanceof ProviderAccessBlockedError && baseline) {
          try {
            assertBaselineCurrent(baseline);
            const paused = launchPreflightDecisions.pause(
              intent,
              descriptor,
              error.capture,
              launchPauseDiagnosticsFromResult(error.result),
              baseline,
            );
            return { ...paused, status: 'paused' };
          } catch (staleError) {
            return {
              result: await claudeFailure(validatedSessionId, staleError),
              status: 'completed',
            };
          }
        }
        return {
          result: await claudeFailure(validatedSessionId, error),
          status: 'completed',
        };
      }
    },
  );
};

const registerClaudeStartIpc = ({
  agentRuntimeStore,
  claudeConversationLifecycle,
  claudeFailure,
  developmentSessionOperations,
  failedRuntimeLaunchCleanupDependencies,
  guards: {
    assertLaunchAdmissionAllowed,
    requireClaudeRuntime,
    validateSender,
    withOfficialProviderAccess,
  },
  launchPreflightDecisions,
  restartRuntimeTerminal,
  withLaunchDecisionSessionOperation,
  workspace,
}: ClaudeLaunchIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_LAUNCH,
    async (event, sessionId: unknown, mode: unknown): Promise<ClaudeLaunchOutcome> => {
      validateSender(event);
      assertLaunchAdmissionAllowed();
      const validatedSessionId = validateSessionId(sessionId);
      const launchMode = validateClaudeLaunchMode(mode);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      const intent = launchPreflightDecisions.beginLaunch(validatedSessionId);
      const descriptor: ClaudeLaunchDescriptor = Object.freeze({
        cwd: status.cwd,
        kind: 'launch',
        mode: launchMode,
        sessionId: validatedSessionId,
      });
      let baseline: ClaudeLaunchDecisionBaseline | undefined;

      const captureBaseline = (operation: SessionOperationStamp): ClaudeLaunchDecisionBaseline =>
        Object.freeze({
          configuration: runtime.captureLaunchConfigurationBaseline(status.cwd),
          operation,
          runtime: runtime.captureRuntimeLaunchBaseline(validatedSessionId, status.cwd),
          workspacePtyGeneration: status.ptyGeneration,
        });
      const assertBaselineCurrent = (candidate: ClaudeLaunchDecisionBaseline): void => {
        assertLaunchAdmissionAllowed();
        launchPreflightDecisions.assertIntentCurrent(intent);
        developmentSessionOperations.assertStampCurrent(candidate.operation);
        const currentStatus = workspace.getStatus(validatedSessionId);
        if (
          currentStatus.cwd !== status.cwd ||
          currentStatus.ptyGeneration !== candidate.workspacePtyGeneration ||
          agentRuntimeStore.get(status.cwd) !== 'claude'
        ) {
          throw new LaunchPreflightDecisionStaleError();
        }
        runtime.assertLaunchConfigurationBaselineCurrent(status.cwd, candidate.configuration);
        runtime.assertRuntimeLaunchBaselineCurrent(
          validatedSessionId,
          status.cwd,
          candidate.runtime,
        );
      };

      try {
        const result = await withLaunchDecisionSessionOperation(
          validatedSessionId,
          async (assertCurrent, signal) => {
            signal.throwIfAborted();
            const operationStamp = developmentSessionOperations.captureStamp(validatedSessionId);
            baseline = captureBaseline(operationStamp);
            const executeLaunch = async (
              assertConversationCurrent: () => void = () => undefined,
            ): Promise<ClaudeOperationResult> => {
              const assertLaunchCurrent = (): void => {
                assertLaunchAdmissionAllowed();
                assertConversationCurrent();
                assertCurrent();
                launchPreflightDecisions.assertIntentCurrent(intent);
                developmentSessionOperations.assertStampCurrent(operationStamp);
              };
              assertLaunchCurrent();
              assertBaselineCurrent(baseline as ClaudeLaunchDecisionBaseline);
              const authorization = runtime.captureLaunchAuthorization(status.cwd);
              if (
                authorization.officialNetworkProvider !==
                (baseline as ClaudeLaunchDecisionBaseline).configuration.officialNetworkProvider
              ) {
                throw new LaunchPreflightDecisionStaleError();
              }
              const launch = (
                preflightResult?: NetworkPreflightResult,
              ): Promise<ClaudeOperationResult> =>
                executePreparedLaunch({
                  assertCurrent: assertLaunchCurrent,
                  assertPreparationCurrent: () => {
                    assertLaunchCurrent();
                    assertBaselineCurrent(baseline as ClaudeLaunchDecisionBaseline);
                  },
                  authorization,
                  cleanup: failedRuntimeLaunchCleanupDependencies,
                  cwd: status.cwd,
                  mode: launchMode,
                  ...(preflightResult ? { preflightResult } : {}),
                  restartRuntimeTerminal,
                  runtime,
                  sessionId: validatedSessionId,
                  signal,
                  withExpectedPtyReplacement: (predecessor, restart) =>
                    launchPreflightDecisions.withExpectedPtyReplacement(
                      intent,
                      predecessor,
                      restart,
                    ),
                });
              return authorization.officialNetworkProvider
                ? withOfficialProviderAccess(
                    {
                      action: 'cli-launch',
                      cwd: status.cwd,
                      provider: authorization.officialNetworkProvider,
                    },
                    launch,
                    signal,
                  )
                : launch();
            };

            return launchMode === 'new'
              ? executeLaunch()
              : claudeConversationLifecycle.runResume(
                  status.cwd,
                  undefined,
                  validatedSessionId,
                  async (conversationOwnership) =>
                    executeLaunch(() => conversationOwnership.assertCurrent()),
                );
          },
        );
        return { result, status: 'completed' };
      } catch (error) {
        if (error instanceof ProviderAccessBlockedError && baseline) {
          try {
            assertBaselineCurrent(baseline);
            const paused = launchPreflightDecisions.pause(
              intent,
              descriptor,
              error.capture,
              launchPauseDiagnosticsFromResult(error.result),
              baseline,
            );
            return { ...paused, status: 'paused' };
          } catch (staleError) {
            return {
              result: await claudeFailure(validatedSessionId, staleError),
              status: 'completed',
            };
          }
        }
        return {
          result: await claudeFailure(validatedSessionId, error),
          status: 'completed',
        };
      }
    },
  );
};

const registerClaudeSessionLaunchIpc = ({
  agentRuntimeStore,
  claudeConversationLifecycle,
  claudeFailure,
  conversationOwnerRegistry,
  developmentSessionOperations,
  failedRuntimeLaunchCleanupDependencies,
  guards: {
    assertLaunchAdmissionAllowed,
    requireClaudeRuntime,
    validateSender,
    withOfficialProviderAccess,
  },
  launchPreflightDecisions,
  runClaudeResumeLaunch,
  terminalConversationOwners,
  withLaunchDecisionSessionOperation,
  workspace,
}: ClaudeLaunchIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_LAUNCH_WITH_SESSION,
    async (event, sessionId: unknown, conversationId: unknown): Promise<ClaudeLaunchOutcome> => {
      validateSender(event);
      assertLaunchAdmissionAllowed();
      const validatedSessionId = validateSessionId(sessionId);
      if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
        return {
          result: await claudeFailure(validatedSessionId, new Error('会话标识无效。')),
          status: 'completed',
        };
      }
      const normalizedConversationId = conversationId.toLowerCase();
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      const intent = launchPreflightDecisions.beginLaunch(validatedSessionId);
      const descriptor: ClaudeLaunchDescriptor = Object.freeze({
        conversationId: normalizedConversationId,
        cwd: status.cwd,
        kind: 'resume-session',
        sessionId: validatedSessionId,
      });
      let baseline: ClaudeLaunchDecisionBaseline | undefined;

      const captureBaseline = (operation: SessionOperationStamp): ClaudeLaunchDecisionBaseline =>
        Object.freeze({
          configuration: runtime.captureLaunchConfigurationBaseline(status.cwd),
          operation,
          runtime: runtime.captureRuntimeLaunchBaseline(validatedSessionId, status.cwd),
          workspacePtyGeneration: status.ptyGeneration,
        });
      const assertBaselineCurrent = (candidate: ClaudeLaunchDecisionBaseline): void => {
        assertLaunchAdmissionAllowed();
        launchPreflightDecisions.assertIntentCurrent(intent);
        developmentSessionOperations.assertStampCurrent(candidate.operation);
        const currentStatus = workspace.getStatus(validatedSessionId);
        if (
          currentStatus.cwd !== status.cwd ||
          currentStatus.ptyGeneration !== candidate.workspacePtyGeneration ||
          agentRuntimeStore.get(status.cwd) !== 'claude'
        ) {
          throw new LaunchPreflightDecisionStaleError();
        }
        runtime.assertLaunchConfigurationBaselineCurrent(status.cwd, candidate.configuration);
        runtime.assertRuntimeLaunchBaselineCurrent(
          validatedSessionId,
          status.cwd,
          candidate.runtime,
        );
      };
      const authorizeProvider: ProviderAuthorizedOperation = (provider, operation, signal) => {
        signal?.throwIfAborted();
        return provider
          ? withOfficialProviderAccess(
              { action: 'cli-launch', cwd: status.cwd, provider },
              operation,
              signal,
            )
          : operation();
      };

      try {
        const result = await withLaunchDecisionSessionOperation(
          validatedSessionId,
          async (assertCurrent, signal) => {
            signal.throwIfAborted();
            const operationStamp = developmentSessionOperations.captureStamp(validatedSessionId);
            baseline = captureBaseline(operationStamp);
            const assertResumeCurrent = (): void => {
              assertLaunchAdmissionAllowed();
              assertCurrent();
              launchPreflightDecisions.assertIntentCurrent(intent);
              developmentSessionOperations.assertStampCurrent(operationStamp);
              const currentStatus = workspace.getStatus(validatedSessionId);
              if (
                currentStatus.cwd !== status.cwd ||
                agentRuntimeStore.get(status.cwd) !== 'claude'
              ) {
                throw new LaunchPreflightDecisionStaleError();
              }
            };
            return executeClaudeSessionResume({
              assertCurrent: assertResumeCurrent,
              assertPreparationCurrent: () =>
                assertBaselineCurrent(baseline as ClaudeLaunchDecisionBaseline),
              authorizeLaunchProvider: authorizeProvider,
              claudeConversationLifecycle,
              cleanup: failedRuntimeLaunchCleanupDependencies,
              conversationId: normalizedConversationId,
              conversationOwnerRegistry,
              cwd: status.cwd,
              expectedOfficialNetworkProvider: (baseline as ClaudeLaunchDecisionBaseline)
                .configuration.officialNetworkProvider,
              runClaudeResumeLaunch,
              runtime,
              sessionId: validatedSessionId,
              signal,
              terminalConversationOwners,
              withExpectedPtyReplacement: (predecessor, restart) =>
                launchPreflightDecisions.withExpectedPtyReplacement(intent, predecessor, restart),
              workspace,
            });
          },
        );
        return { result, status: 'completed' };
      } catch (error) {
        if (error instanceof ProviderAccessBlockedError && baseline) {
          try {
            assertBaselineCurrent(baseline);
            const paused = launchPreflightDecisions.pause(
              intent,
              descriptor,
              error.capture,
              launchPauseDiagnosticsFromResult(error.result),
              baseline,
            );
            return { ...paused, status: 'paused' };
          } catch (staleError) {
            return {
              result: await claudeFailure(validatedSessionId, staleError),
              status: 'completed',
            };
          }
        }
        return {
          result: await claudeFailure(validatedSessionId, error),
          status: 'completed',
        };
      }
    },
  );
};

export const registerClaudeLaunchIpc = (dependencies: ClaudeLaunchIpcDependencies): void => {
  registerClaudeRelaunchIpc(dependencies);
  registerClaudeStartIpc(dependencies);
  registerClaudeLaunchDecisionIpc(dependencies, {
    executeClaudeRelaunch,
    executeClaudeSessionResume,
    executePreparedLaunch,
  });
  registerClaudeCommandIpc(dependencies);
  registerClaudeSessionLaunchIpc(dependencies);
};
