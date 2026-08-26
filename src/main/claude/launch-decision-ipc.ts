/* eslint-disable max-lines-per-function -- The exact decision reservation, one-shot authorization, and continuation handoff form one atomic IPC transaction. */
import { ipcMain } from 'electron';
import type {
  ClaudeLaunchPreflightDecisionOutcome,
  ClaudeOperationResult,
  NetworkPreflightResult,
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
import {
  type ClaudeNetworkAccess,
  effectiveClaudeNetworkAccess,
  sameClaudeNetworkAccess,
} from './runtime-types';
import type { ClaudeLaunchIpcDependencies } from './launch-ipc-dependencies';

type ProviderAuthorizedOperation = <T>(
  networkAccess: Readonly<ClaudeNetworkAccess> | undefined,
  operation: (result?: NetworkPreflightResult) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

const baselineNetworkAccess = (baseline: {
  readonly networkAccess?: Readonly<ClaudeNetworkAccess>;
  readonly officialNetworkProvider?: ClaudeNetworkAccess['provider'];
}): Readonly<ClaudeNetworkAccess> | undefined =>
  effectiveClaudeNetworkAccess(baseline.networkAccess, baseline.officialNetworkProvider);

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

      const expectedNetworkAccess = (): Readonly<ClaudeNetworkAccess> | undefined =>
        descriptor.kind === 'relaunch' && descriptor.input.entryId !== undefined
          ? reservation.baseline.history
            ? baselineNetworkAccess(reservation.baseline.history)
            : undefined
          : baselineNetworkAccess(reservation.baseline.configuration);
      const blockedNetworkAccess: Readonly<ClaudeNetworkAccess> = Object.freeze({
        provider: reservation.blocked.provider,
        ...(reservation.blocked.target === undefined ? {} : { target: reservation.blocked.target }),
      });
      const captureContinuationBaseline = (): ClaudeLaunchDecisionBaseline => {
        assertLaunchAdmissionAllowed();
        if (!continuationStamp) throw new LaunchPreflightDecisionStaleError();
        launchPreflightDecisions.assertIntentCurrent(reservation.intent);
        developmentSessionOperations.assertStampCurrent(continuationStamp);
        const currentStatus = workspace.getStatus(descriptor.sessionId);
        if (
          currentStatus.cwd !== descriptor.cwd ||
          currentStatus.ptyGeneration !== reservation.baseline.workspacePtyGeneration ||
          workspace.getDevelopmentRuntime(descriptor.sessionId) !== 'claude'
        ) {
          throw new LaunchPreflightDecisionStaleError();
        }
        runtime.assertLaunchConfigurationBaselineCurrent(
          descriptor.cwd,
          reservation.baseline.configuration,
          descriptor.sessionId,
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
          configuration: runtime.captureLaunchConfigurationBaseline(
            descriptor.cwd,
            descriptor.sessionId,
          ),
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
                workspace.getDevelopmentRuntime(descriptor.sessionId) !== 'claude'
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
                descriptor.sessionId,
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
            const capturedAtLaunchBoundary = sameClaudeNetworkAccess(
              blockedNetworkAccess,
              expectedNetworkAccess(),
            );
            const authorizeCapturedProvider: ProviderAuthorizedOperation = (
              networkAccess,
              operation,
              operationSignal = signal,
            ) => {
              operationSignal.throwIfAborted();
              assertPreparationCurrent();
              if (!sameClaudeNetworkAccess(networkAccess, blockedNetworkAccess)) {
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
              networkAccess,
              operation,
              operationSignal = signal,
            ) => {
              operationSignal.throwIfAborted();
              assertPreparationCurrent();
              if (!capturedAtLaunchBoundary) {
                if (descriptor.kind !== 'relaunch') {
                  throw new LaunchPreflightDecisionStaleError();
                }
                return authorizeCapturedProvider(networkAccess, operation, operationSignal);
              }
              return networkAccess
                ? withOfficialProviderAccess(
                    { action: 'cli-launch', cwd: descriptor.cwd, ...networkAccess },
                    operation,
                    operationSignal,
                  )
                : operation();
            };
            const authorizeLaunchProvider: ProviderAuthorizedOperation = (
              networkAccess,
              operation,
              operationSignal = signal,
            ) => {
              operationSignal.throwIfAborted();
              assertPreparationCurrent();
              if (!sameClaudeNetworkAccess(networkAccess, expectedNetworkAccess())) {
                throw new LaunchPreflightDecisionStaleError();
              }
              if (capturedAtLaunchBoundary) {
                return authorizeCapturedProvider(networkAccess, operation, operationSignal);
              }
              return networkAccess
                ? withOfficialProviderAccess(
                    { action: 'cli-launch', cwd: descriptor.cwd, ...networkAccess },
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
                const authorization = runtime.captureLaunchAuthorization(
                  descriptor.cwd,
                  descriptor.sessionId,
                );
                const networkAccess = baselineNetworkAccess(authorization);
                if (
                  !sameClaudeNetworkAccess(
                    networkAccess,
                    baselineNetworkAccess(reservation.baseline.configuration),
                  )
                ) {
                  throw new LaunchPreflightDecisionStaleError();
                }
                return authorizeLaunchProvider(
                  networkAccess,
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
              expectedNetworkAccess: baselineNetworkAccess(reservation.baseline.configuration),
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
              descriptor.sessionId,
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
