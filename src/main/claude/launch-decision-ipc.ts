/* eslint-disable max-lines-per-function -- The exact decision reservation, one-shot authorization, and continuation handoff form one atomic IPC transaction. */
import { ipcMain } from 'electron';
import type {
  ClaudeLaunchPreflightDecisionOutcome,
  ClaudeOperationResult,
  NetworkPreflightResult,
  NetworkProviderId,
} from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';
import {
  type ClaudeLaunchDecisionBaseline,
  LaunchPreflightDecisionStaleError,
  launchPauseDiagnosticsFromResult,
} from '../coordination/launch-preflight-decision';
import type { SessionOperationStamp } from '../coordination/session-operation';
import {
  ProviderAccessBlockedError,
  ProviderAccessBypassStaleError,
} from '../network/provider-access-guard';
import { validateClaudeLaunchPreflightDecisionInput } from '../ipc/validation';
import type {
  PreparedLaunchExecution,
  RelaunchExecution,
  ResumeSessionExecution,
} from './launch-execution-types';
import type { ClaudeLaunchIpcDependencies } from './launch-ipc-dependencies';

type ProviderAuthorizedOperation = <T>(
  provider: NetworkProviderId | undefined,
  operation: (result?: NetworkPreflightResult) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

export interface ClaudeLaunchDecisionExecutions {
  readonly executeClaudeRelaunch: (input: RelaunchExecution) => Promise<ClaudeOperationResult>;
  readonly executeClaudeSessionResume: (
    input: ResumeSessionExecution,
  ) => Promise<ClaudeOperationResult>;
  readonly executePreparedLaunch: (
    input: PreparedLaunchExecution,
  ) => Promise<ClaudeOperationResult>;
}

export const registerClaudeLaunchDecisionIpc = (
  {
    agentRuntimeStore,
    claudeConversationLifecycle,
    claudeFailure,
    conversationOwnerRegistry,
    developmentSessionOperations,
    failedRuntimeLaunchCleanupDependencies,
    guards: {
      assertLaunchAdmissionAllowed,
      requireClaudeRuntime,
      requireProviderAccessGuard,
      validateSender,
      withOfficialProviderAccess,
    },
    launchPreflightDecisions,
    restartRuntimeTerminal,
    runClaudeProjectConfigTransaction,
    runClaudeResumeLaunch,
    terminalConversationOwners,
    withDevelopmentSessionOperationIfStampCurrent,
    workspace,
  }: ClaudeLaunchIpcDependencies,
  {
    executeClaudeRelaunch,
    executeClaudeSessionResume,
    executePreparedLaunch,
  }: ClaudeLaunchDecisionExecutions,
): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE,
    async (event, input: unknown): Promise<ClaudeLaunchPreflightDecisionOutcome> => {
      validateSender(event);
      const { choice, decisionId } = validateClaudeLaunchPreflightDecisionInput(input);
      if (choice !== 'cancel') assertLaunchAdmissionAllowed();
      const reserved = launchPreflightDecisions.reserve(decisionId, choice);
      if (reserved.status !== 'reserved') return { status: reserved.status };
      const reservation = reserved.reservation;
      if (choice === 'cancel') {
        launchPreflightDecisions.consume(reservation);
        return { status: 'cancelled' };
      }
      if (choice === 'recheck') {
        launchPreflightDecisions.consume(reservation);
      }

      const descriptor = reservation.descriptor;
      const runtime = requireClaudeRuntime();
      const providerAccess = requireProviderAccessGuard();
      let continuationEntered = false;
      let continuationSignal: AbortSignal | undefined;
      let continuationStamp: SessionOperationStamp | undefined;

      const expectedOfficialNetworkProvider = (): NetworkProviderId | undefined =>
        descriptor.kind === 'relaunch' && descriptor.input.entryId !== undefined
          ? reservation.baseline.history?.officialNetworkProvider
          : reservation.baseline.configuration.officialNetworkProvider;
      const captureContinuationBaseline = (): ClaudeLaunchDecisionBaseline => {
        assertLaunchAdmissionAllowed();
        if (!continuationStamp) throw new LaunchPreflightDecisionStaleError();
        launchPreflightDecisions.assertIntentCurrent(reservation.intent);
        developmentSessionOperations.assertStampCurrent(continuationStamp);
        const currentStatus = workspace.getStatus(descriptor.sessionId);
        if (
          currentStatus.cwd !== descriptor.cwd ||
          currentStatus.ptyGeneration !== reservation.baseline.workspacePtyGeneration ||
          agentRuntimeStore.get(descriptor.cwd) !== 'claude'
        ) {
          throw new LaunchPreflightDecisionStaleError();
        }
        runtime.assertLaunchConfigurationBaselineCurrent(
          descriptor.cwd,
          reservation.baseline.configuration,
        );
        runtime.assertRuntimeLaunchBaselineCurrent(
          descriptor.sessionId,
          descriptor.cwd,
          reservation.baseline.runtime,
        );
        if (reservation.baseline.history) {
          runtime.assertConnectionHistoryBaselineCurrent(
            descriptor.cwd,
            reservation.baseline.history,
          );
        }
        return Object.freeze({
          configuration: runtime.captureLaunchConfigurationBaseline(descriptor.cwd),
          ...(descriptor.kind === 'relaunch' && descriptor.input.entryId !== undefined
            ? {
                history: runtime.captureConnectionHistoryBaseline(
                  descriptor.cwd,
                  descriptor.input.entryId,
                ),
              }
            : {}),
          operation: continuationStamp,
          runtime: runtime.captureRuntimeLaunchBaseline(descriptor.sessionId, descriptor.cwd),
          workspacePtyGeneration: currentStatus.ptyGeneration,
        });
      };

      try {
        const result = await withDevelopmentSessionOperationIfStampCurrent(
          reservation.baseline.operation,
          async (assertCurrent, signal) => {
            continuationSignal = signal;
            signal.throwIfAborted();
            continuationStamp = developmentSessionOperations.captureStamp(descriptor.sessionId);
            const assertContinuationCurrent = (): void => {
              signal.throwIfAborted();
              assertLaunchAdmissionAllowed();
              assertCurrent();
              launchPreflightDecisions.assertIntentCurrent(reservation.intent);
              developmentSessionOperations.assertStampCurrent(
                continuationStamp as SessionOperationStamp,
              );
              const currentStatus = workspace.getStatus(descriptor.sessionId);
              if (
                currentStatus.cwd !== descriptor.cwd ||
                agentRuntimeStore.get(descriptor.cwd) !== 'claude'
              ) {
                throw new LaunchPreflightDecisionStaleError();
              }
            };
            const assertPreparationCurrent = (): void => {
              assertContinuationCurrent();
              const currentStatus = workspace.getStatus(descriptor.sessionId);
              if (currentStatus.ptyGeneration !== reservation.baseline.workspacePtyGeneration) {
                throw new LaunchPreflightDecisionStaleError();
              }
              runtime.assertLaunchConfigurationBaselineCurrent(
                descriptor.cwd,
                reservation.baseline.configuration,
              );
              runtime.assertRuntimeLaunchBaselineCurrent(
                descriptor.sessionId,
                descriptor.cwd,
                reservation.baseline.runtime,
              );
              if (reservation.baseline.history) {
                runtime.assertConnectionHistoryBaselineCurrent(
                  descriptor.cwd,
                  reservation.baseline.history,
                );
              }
            };
            const capturedAtLaunchBoundary =
              reservation.blocked.provider === expectedOfficialNetworkProvider();
            const authorizeCapturedProvider: ProviderAuthorizedOperation = (
              provider,
              operation,
              operationSignal = signal,
            ) => {
              operationSignal.throwIfAborted();
              assertPreparationCurrent();
              if (provider !== reservation.blocked.provider) {
                throw new LaunchPreflightDecisionStaleError();
              }
              if (choice === 'recheck') {
                return providerAccess.recheck(
                  reservation.blocked,
                  async (result) => {
                    operationSignal.throwIfAborted();
                    assertPreparationCurrent();
                    continuationEntered = true;
                    return operation(result);
                  },
                  operationSignal,
                );
              }
              return providerAccess.bypass(
                reservation.blocked,
                () => {
                  operationSignal.throwIfAborted();
                  assertPreparationCurrent();
                  launchPreflightDecisions.consume(reservation);
                  continuationEntered = true;
                },
                () => {
                  operationSignal.throwIfAborted();
                  return operation();
                },
                operationSignal,
              );
            };
            const authorizeNestedProvider: ProviderAuthorizedOperation = (
              provider,
              operation,
              operationSignal = signal,
            ) => {
              operationSignal.throwIfAborted();
              assertPreparationCurrent();
              if (!capturedAtLaunchBoundary) {
                if (descriptor.kind !== 'relaunch') {
                  throw new LaunchPreflightDecisionStaleError();
                }
                return authorizeCapturedProvider(provider, operation, operationSignal);
              }
              return provider
                ? withOfficialProviderAccess(
                    { action: 'cli-launch', cwd: descriptor.cwd, provider },
                    operation,
                    operationSignal,
                  )
                : operation();
            };
            const authorizeLaunchProvider: ProviderAuthorizedOperation = (
              provider,
              operation,
              operationSignal = signal,
            ) => {
              operationSignal.throwIfAborted();
              assertPreparationCurrent();
              if (provider !== expectedOfficialNetworkProvider()) {
                throw new LaunchPreflightDecisionStaleError();
              }
              if (capturedAtLaunchBoundary) {
                return authorizeCapturedProvider(provider, operation, operationSignal);
              }
              return provider
                ? withOfficialProviderAccess(
                    { action: 'cli-launch', cwd: descriptor.cwd, provider },
                    operation,
                    operationSignal,
                  )
                : operation();
            };

            if (descriptor.kind === 'launch') {
              const executeLaunch = async (
                assertConversationCurrent: () => void = () => undefined,
              ): Promise<ClaudeOperationResult> => {
                const assertLaunchCurrent = (): void => {
                  assertConversationCurrent();
                  assertContinuationCurrent();
                };
                const assertLaunchPreparationCurrent = (): void => {
                  assertConversationCurrent();
                  assertPreparationCurrent();
                };
                assertLaunchPreparationCurrent();
                const authorization = runtime.captureLaunchAuthorization(descriptor.cwd);
                if (
                  authorization.officialNetworkProvider !==
                  reservation.baseline.configuration.officialNetworkProvider
                ) {
                  throw new LaunchPreflightDecisionStaleError();
                }
                return authorizeLaunchProvider(
                  authorization.officialNetworkProvider,
                  (preflightResult) =>
                    executePreparedLaunch({
                      assertCurrent: assertLaunchCurrent,
                      assertPreparationCurrent: assertLaunchPreparationCurrent,
                      authorization,
                      cleanup: failedRuntimeLaunchCleanupDependencies,
                      cwd: descriptor.cwd,
                      mode: descriptor.mode,
                      ...(preflightResult ? { preflightResult } : {}),
                      restartRuntimeTerminal,
                      runtime,
                      sessionId: descriptor.sessionId,
                      signal,
                      withExpectedPtyReplacement: (predecessor, restart) =>
                        launchPreflightDecisions.withExpectedPtyReplacement(
                          reservation.intent,
                          predecessor,
                          restart,
                        ),
                    }),
                  signal,
                );
              };
              return descriptor.mode === 'new'
                ? executeLaunch()
                : claudeConversationLifecycle.runResume(
                    descriptor.cwd,
                    undefined,
                    descriptor.sessionId,
                    async (conversationOwnership) =>
                      executeLaunch(() => conversationOwnership.assertCurrent()),
                  );
            }

            if (descriptor.kind === 'relaunch') {
              return executeClaudeRelaunch({
                assertCurrent: assertContinuationCurrent,
                assertOriginalConfigurationCurrent: assertPreparationCurrent,
                authorizeLaunchProvider,
                authorizeNestedProvider,
                cleanup: failedRuntimeLaunchCleanupDependencies,
                cwd: descriptor.cwd,
                input: descriptor.input,
                restartRuntimeTerminal,
                runClaudeProjectConfigTransaction,
                runtime,
                sessionId: descriptor.sessionId,
                signal,
                withExpectedPtyReplacement: (predecessor, restart) =>
                  launchPreflightDecisions.withExpectedPtyReplacement(
                    reservation.intent,
                    predecessor,
                    restart,
                  ),
                workspacePtyGeneration: reservation.baseline.workspacePtyGeneration,
              });
            }

            return executeClaudeSessionResume({
              assertCurrent: assertContinuationCurrent,
              assertPreparationCurrent,
              authorizeLaunchProvider,
              claudeConversationLifecycle,
              cleanup: failedRuntimeLaunchCleanupDependencies,
              conversationId: descriptor.conversationId,
              conversationOwnerRegistry,
              cwd: descriptor.cwd,
              expectedOfficialNetworkProvider:
                reservation.baseline.configuration.officialNetworkProvider,
              runClaudeResumeLaunch,
              runtime,
              sessionId: descriptor.sessionId,
              signal,
              terminalConversationOwners,
              withExpectedPtyReplacement: (predecessor, restart) =>
                launchPreflightDecisions.withExpectedPtyReplacement(
                  reservation.intent,
                  predecessor,
                  restart,
                ),
              workspace,
            });
          },
        );
        if (!continuationStamp) throw new LaunchPreflightDecisionStaleError();
        launchPreflightDecisions.assertIntentCurrent(reservation.intent);
        developmentSessionOperations.assertStampCurrent(continuationStamp);
        return { result, status: 'completed' };
      } catch (error) {
        if (continuationSignal?.aborted) {
          launchPreflightDecisions.stale(reservation);
          return { status: 'stale' };
        }
        if (error instanceof ProviderAccessBlockedError && !continuationEntered) {
          try {
            const baseline = captureContinuationBaseline();
            runtime.assertLaunchConfigurationBaselineCurrent(
              descriptor.cwd,
              reservation.baseline.configuration,
            );
            runtime.assertRuntimeLaunchBaselineCurrent(
              descriptor.sessionId,
              descriptor.cwd,
              reservation.baseline.runtime,
            );
            if (reservation.baseline.history) {
              runtime.assertConnectionHistoryBaselineCurrent(
                descriptor.cwd,
                reservation.baseline.history,
              );
            }
            const paused = launchPreflightDecisions.pauseAfterRecheck(
              reservation,
              error.capture,
              launchPauseDiagnosticsFromResult(error.result),
              baseline,
            );
            return { ...paused, status: 'paused' };
          } catch {
            launchPreflightDecisions.stale(reservation);
            return { status: 'stale' };
          }
        }
        if (
          !continuationEntered ||
          error instanceof LaunchPreflightDecisionStaleError ||
          error instanceof ProviderAccessBypassStaleError
        ) {
          launchPreflightDecisions.stale(reservation);
          return { status: 'stale' };
        }
        return {
          result: await claudeFailure(descriptor.sessionId, error),
          status: 'completed',
        };
      }
    },
  );
};
