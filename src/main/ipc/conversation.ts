import { CHANNELS } from '../../shared/ipc/channels';
import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { PtyGeneration } from '../../shared/contracts';
import type {
  ConversationSubmitInput,
  NativeConversationLaunchRequest,
} from '../../shared/conversation/native';
import {
  selectReusableConversationSurfaceSession,
  terminalConversationHasRunningWork,
} from '../../shared/conversation/surface-switch';
import type { RuntimeProfile } from '../app/profile';
import { isValidClaudeSessionId, normalizeClaudeSessionTitle } from '../claude/session-manager';
import type { ClaudeSessionManager } from '../claude/session-manager';
import type { PreparedNativeClaudeConversation } from '../claude/runtime';
import { effectiveClaudeNetworkAccess } from '../claude/runtime-types';
import type { NativeAttachmentStore } from '../conversation/attachment-store';
import type { ConversationOwner, ConversationOwnerRegistry } from '../conversation/owner-registry';
import type { WithSessionOperation } from '../coordination/session-operation';
import { resolveDirectory } from '../infra/directory';
import { createFailureReporter } from '../infra/logger';
import type { RuntimeActivityRegistry } from '../runtime/activity-registry';
import type { WorkspaceStore } from '../stores/workspace';
import type { ResumeConversationInTerminal } from '../terminal/lifecycle';
import { sameDirectory, type TerminalWorkspace } from '../terminal/workspace';
import {
  validateConversationId,
  validateNativeControlUpdate,
  validateNativeInteractionResponse,
  validateNativeSubmitInput,
  validateProjectPath,
  validateSessionId,
} from './validation';
import type { Registry } from '../infra/registry';
import { RUNTIME_PROCESS_REGISTRY } from '../infra/service-tokens';
import type { MainGuards } from './guards';

export type NativeConversationLaunch = {
  ownerId: string;
  prepared: PreparedNativeClaudeConversation;
};

export interface ConversationIpcDependencies {
  conversationOwnerRegistry: ConversationOwnerRegistry;
  guards: Pick<
    MainGuards,
    | 'assertLaunchAdmissionAllowed'
    | 'requireClaudeRuntime'
    | 'withOfficialProviderAccess'
    | 'requireNativeConversationService'
    | 'validateSender'
  >;
  invalidateAndWaitForDevelopmentSessionOperation: (sessionId: string) => Promise<void>;
  nativeAttachmentStore: NativeAttachmentStore;
  /* Shared with quit cleanup, which releases whatever routes are still prepared. */
  nativeLaunches: Map<string, NativeConversationLaunch>;
  runClaudeResumeLaunch: ResumeConversationInTerminal;
  runtimeActivityRegistry: RuntimeActivityRegistry;
  runtimeProfile: RuntimeProfile;
  services: Registry;
  sessionManager: ClaudeSessionManager;
  terminalConversationOwners: Map<string, ConversationOwner>;
  /* Suppresses the terminal-failure reconciliation while a transfer intentionally replaces the PTY. */
  terminalTransferSessions: Set<string>;
  withDevelopmentSessionOperation: WithSessionOperation;
  workspace: TerminalWorkspace;
  workspaceStore: WorkspaceStore;
}

const reportConversationFailure = createFailureReporter('conversation');

interface ConversationIpcContext {
  nativeConversationSessions: Map<string, string>;
  resolveNativeSubmitAttachments: (
    conversationId: string,
    input: ConversationSubmitInput,
  ) => ConversationSubmitInput;
}

const registerConversationStartIpc = (
  {
    conversationOwnerRegistry,
    guards: {
      assertLaunchAdmissionAllowed,
      requireClaudeRuntime,
      requireNativeConversationService,
      validateSender,
      withOfficialProviderAccess,
    },
    nativeLaunches,
    runtimeProfile,
  }: ConversationIpcDependencies,
  { nativeConversationSessions }: ConversationIpcContext,
): void => {
  ipcMain.handle(CHANNELS.NATIVE_CONVERSATION_START, async (event, value: unknown) => {
    validateSender(event);
    assertLaunchAdmissionAllowed();
    if (!value || typeof value !== 'object') throw new Error('原生对话启动参数无效。');
    const request = value as Partial<NativeConversationLaunchRequest>;
    const projectPath = resolveDirectory(validateProjectPath(request.projectPath));
    const conversationId = request.conversationId
      ? validateConversationId(request.conversationId)
      : randomUUID();
    if (
      request.model !== undefined &&
      (typeof request.model !== 'string' || request.model.length > 200)
    ) {
      throw new Error('原生对话模型标识无效。');
    }
    if (
      request.permissionMode !== undefined &&
      !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(
        request.permissionMode,
      )
    ) {
      throw new Error('原生对话权限模式无效。');
    }
    const service = requireNativeConversationService();
    const boundSessionId =
      request.sessionId === undefined ? undefined : validateSessionId(request.sessionId);
    if (boundSessionId) nativeConversationSessions.set(conversationId, boundSessionId);
    const existing = conversationOwnerRegistry.ownerFor({
      conversationId,
      projectPath,
      runtime: 'claude',
    });
    if (existing) {
      return service.start({
        conversationId,
        model: request.model,
        permissionMode: request.permissionMode,
        projectPath,
        resume: request.resume,
      });
    }

    let launch: NativeConversationLaunch | undefined;
    const nativeOwnerId = `native-route:${conversationId}`;
    const runtime =
      runtimeProfile.adapterMode === 'production' ? requireClaudeRuntime() : undefined;
    const nativeAuthorization = runtime
      ? boundSessionId
        ? runtime.captureNativeConversationAuthorization(projectPath, boundSessionId)
        : request.resume
          ? runtime.captureNativeConversationAuthorization(projectPath)
          : runtime.captureNextNativeConversationAuthorization(nativeOwnerId, projectPath)
      : undefined;
    const startNativeConversation = async () => {
      assertLaunchAdmissionAllowed();
      if (runtime) {
        const prepared = await runtime.prepareNativeConversation(
          nativeOwnerId,
          projectPath,
          request.model,
          nativeAuthorization,
        );
        try {
          assertLaunchAdmissionAllowed();
          launch = { ownerId: nativeOwnerId, prepared };
          nativeLaunches.set(conversationId, launch);
        } catch (error) {
          runtime.releaseNativeConversation(nativeOwnerId);
          throw error;
        }
      }
      try {
        assertLaunchAdmissionAllowed();
        const allowBypassPermissions =
          launch?.prepared.allowBypassPermissions ?? runtimeProfile.adapterMode === 'fake';
        if (request.permissionMode === 'bypassPermissions' && !allowBypassPermissions) {
          throw new Error('当前项目关闭了「完全允许」预置；请在工作台开启后重新启动会话。');
        }
        const result = await service.start({
          allowBypassPermissions,
          conversationId,
          launch: launch
            ? {
                cliVersion: launch.prepared.cliVersion,
                configFingerprintSource: { runtime: launch.prepared.configFingerprint },
                endpointIdentity: launch.prepared.endpointIdentity,
                model: launch.prepared.model,
              }
            : { configFingerprintSource: { adapter: 'isolated-fake' } },
          model: launch?.prepared.model ?? request.model,
          runtimeModel: launch?.prepared.runtimeModel,
          settingsEnvironment: launch?.prepared.settingsEnvironment,
          permissionMode: request.permissionMode,
          projectPath,
          resume: request.resume,
        });
        if (result.ok && runtime && launch) {
          runtime.recordNativeConversationBinding(
            conversationId,
            launch.prepared.conversationBinding,
            launch.prepared.model,
          );
        }
        if (!result.ok && launch) {
          runtime?.releaseNativeConversation(launch.ownerId);
          nativeLaunches.delete(conversationId);
        }
        return result;
      } catch (error) {
        if (launch) {
          runtime?.releaseNativeConversation(launch.ownerId);
          nativeLaunches.delete(conversationId);
        }
        throw error;
      }
    };
    const networkAccess = nativeAuthorization
      ? effectiveClaudeNetworkAccess(
          nativeAuthorization.authorization.networkAccess,
          nativeAuthorization.authorization.officialNetworkProvider,
        )
      : undefined;
    try {
      return await (networkAccess
        ? withOfficialProviderAccess(
            { action: 'cli-launch', cwd: projectPath, ...networkAccess },
            startNativeConversation,
          )
        : startNativeConversation());
    } catch (error) {
      if (runtime && !boundSessionId && !request.resume) {
        runtime.releaseNativeConversation(nativeOwnerId);
      }
      throw error;
    }
  });
};

const registerConversationControlIpc = (
  {
    guards: {
      requireClaudeRuntime,
      requireNativeConversationService,
      validateSender,
      withOfficialProviderAccess,
    },
    nativeAttachmentStore,
    nativeLaunches,
    runtimeProfile,
    sessionManager,
  }: ConversationIpcDependencies,
  { nativeConversationSessions, resolveNativeSubmitAttachments }: ConversationIpcContext,
): void => {
  ipcMain.handle(CHANNELS.NATIVE_CONVERSATION_GET, (event, conversationId: unknown) => {
    validateSender(event);
    return requireNativeConversationService().getSnapshot(validateConversationId(conversationId));
  });
  ipcMain.handle(
    CHANNELS.NATIVE_CONVERSATION_SUBMIT,
    async (event, conversationId: unknown, input: unknown) => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      const service = requireNativeConversationService();
      const projectPath = service.projectPathForActiveConversation(validatedConversationId);
      const validatedInput = resolveNativeSubmitAttachments(
        validatedConversationId,
        validateNativeSubmitInput(input),
      );
      const submitTurn = () =>
        service.submitAndWaitForTurn(validatedConversationId, validatedInput);
      if (runtimeProfile.adapterMode !== 'production') return submitTurn();

      const launch = nativeLaunches.get(validatedConversationId);
      if (!launch) {
        throw new Error('原生对话的主进程接入授权已经失效，请重新打开该对话。');
      }
      const networkAccess = effectiveClaudeNetworkAccess(
        launch.prepared.networkAccess,
        launch.prepared.officialNetworkProvider,
        launch.prepared.officialNetworkTarget,
      );
      return networkAccess
        ? withOfficialProviderAccess(
            {
              action: 'first-request',
              cwd: projectPath,
              ...networkAccess,
            },
            submitTurn,
          )
        : submitTurn();
    },
  );
  ipcMain.handle(
    CHANNELS.NATIVE_CONVERSATION_RESPOND,
    (event, conversationId: unknown, interactionId: unknown, response: unknown) => {
      validateSender(event);
      if (typeof interactionId !== 'string' || !interactionId || interactionId.length > 300) {
        throw new Error('原生交互标识无效。');
      }
      return requireNativeConversationService().respond(
        validateConversationId(conversationId),
        interactionId,
        validateNativeInteractionResponse(response),
      );
    },
  );
  ipcMain.handle(CHANNELS.NATIVE_CONVERSATION_INTERRUPT, (event, conversationId: unknown) => {
    validateSender(event);
    return requireNativeConversationService().interrupt(validateConversationId(conversationId));
  });
  ipcMain.handle(
    CHANNELS.NATIVE_CONVERSATION_STOP_TASK,
    (event, conversationId: unknown, taskId: unknown) => {
      validateSender(event);
      if (typeof taskId !== 'string' || !taskId || taskId.length > 300) {
        throw new Error('后台任务标识无效。');
      }
      return requireNativeConversationService().stopTask(
        validateConversationId(conversationId),
        taskId,
      );
    },
  );
  ipcMain.handle(
    CHANNELS.NATIVE_CONVERSATION_UPDATE_CONTROLS,
    (event, conversationId: unknown, update: unknown) => {
      validateSender(event);
      const service = requireNativeConversationService();
      const validatedConversationId = validateConversationId(conversationId);
      const validatedUpdate = validateNativeControlUpdate(update);
      if (validatedUpdate.permissionMode === 'bypassPermissions') {
        const snapshot = service.getSnapshot(validatedConversationId);
        if (!snapshot || !requireClaudeRuntime().allowsBypassPermissions(snapshot.projectPath)) {
          throw new Error('当前项目关闭了「完全允许」预置；请在工作台开启后重新启动会话。');
        }
      }
      return service.updateControls(validatedConversationId, validatedUpdate);
    },
  );
  ipcMain.handle(CHANNELS.NATIVE_CONVERSATION_CLOSE, async (event, conversationId: unknown) => {
    validateSender(event);
    const validatedConversationId = validateConversationId(conversationId);
    const result = await requireNativeConversationService().close(validatedConversationId);
    if (result.ok) {
      nativeConversationSessions.delete(validatedConversationId);
      await nativeAttachmentStore.releaseConversation(validatedConversationId);
    }
    return result;
  });
  ipcMain.handle(
    CHANNELS.NATIVE_CONVERSATION_RENAME,
    (event, conversationId: unknown, title: unknown): boolean => {
      validateSender(event);
      const validatedConversationId = validateConversationId(conversationId);
      if (typeof title !== 'string') throw new Error('对话名称格式无效。');
      const snapshot = requireNativeConversationService().getSnapshot(validatedConversationId);
      if (!snapshot) throw new Error('原生对话不存在或已结束。');
      return sessionManager.renameSession(
        snapshot.projectPath,
        validatedConversationId,
        normalizeClaudeSessionTitle(title),
      );
    },
  );
};

const registerConversationTransferIpc = (
  {
    guards: {
      assertLaunchAdmissionAllowed,
      requireClaudeRuntime,
      requireNativeConversationService,
      validateSender,
      withOfficialProviderAccess,
    },
    nativeLaunches,
    runClaudeResumeLaunch,
    runtimeProfile,
    terminalConversationOwners,
    terminalTransferSessions,
    withDevelopmentSessionOperation,
    workspace,
    workspaceStore,
  }: ConversationIpcDependencies,
  { nativeConversationSessions }: ConversationIpcContext,
): void => {
  ipcMain.handle(
    CHANNELS.NATIVE_CONVERSATION_TRANSFER_TO_TERMINAL,
    async (event, conversationId: unknown, draft: unknown, allowInterrupt: unknown) => {
      validateSender(event);
      assertLaunchAdmissionAllowed();
      const validatedConversationId = validateConversationId(conversationId);
      const validatedDraft = draft === undefined ? undefined : validateNativeSubmitInput(draft);
      if (typeof allowInterrupt !== 'boolean') {
        throw new Error('原生对话切换确认参数无效。');
      }
      let transferredOwner: ConversationOwner | undefined;
      let transferredSessionId: string | undefined;
      const service = requireNativeConversationService();
      try {
        const result = await service.transferToTerminal(
          validatedConversationId,
          validatedDraft,
          async (identity) => {
            assertLaunchAdmissionAllowed();
            const usableTab = (candidate: string | undefined): string | undefined => {
              if (!candidate || !workspace.hasSession(candidate)) return undefined;
              return sameDirectory(workspace.getStatus(candidate).cwd, identity.projectPath) &&
                workspace.getDevelopmentRuntime(candidate) === 'claude'
                ? candidate
                : undefined;
            };
            // Prefer the tab this native conversation was displayed over, then the tab the user is
            // looking at. `openConversation` is unconditionally additive, so calling it here is
            // exactly what produced the duplicated sidebar row and the orphaned original.
            const reusableSessionId = selectReusableConversationSurfaceSession(
              [
                nativeConversationSessions.get(identity.conversationId),
                workspace.getState().activeSessionId,
              ],
              (candidate) => usableTab(candidate) !== undefined,
            );
            let targetSessionId = reusableSessionId;
            if (!targetSessionId) {
              workspace.openProject(identity.projectPath, 'claude');
              targetSessionId = workspace.getState().activeSessionId;
              if (!targetSessionId) throw new Error('无法打开该项目的安全终端。');
            }
            transferredSessionId = targetSessionId;
            terminalTransferSessions.add(targetSessionId);
            workspaceStore.addProject(identity.projectPath);
            let ownedGeneration: PtyGeneration | undefined;
            const launchSessionId = targetSessionId;
            await withDevelopmentSessionOperation(launchSessionId, async (assertCurrent) => {
              ownedGeneration = await runClaudeResumeLaunch(
                launchSessionId,
                identity.projectPath,
                identity.conversationId,
                '无法为 Claude Code 启动安全终端。',
                assertCurrent,
              );
            });
            if (ownedGeneration === undefined) throw new Error('安全终端没有有效的进程代际。');
            transferredOwner = {
              conversationId: identity.conversationId,
              generation: Number(ownedGeneration),
              ownerId: `terminal:${targetSessionId}`,
              ownerKind: 'terminal',
              phase: 'active',
              projectPath: identity.projectPath,
              runtime: 'claude',
            };
            return { owner: transferredOwner, terminalSessionId: targetSessionId };
          },
          allowInterrupt,
          async (identity, operation) => {
            if (runtimeProfile.adapterMode !== 'production') return operation();
            const runtime = requireClaudeRuntime();
            const networkAccess =
              typeof runtime.networkAccess === 'function'
                ? runtime.networkAccess(identity.projectPath)
                : effectiveClaudeNetworkAccess(
                    undefined,
                    runtime.officialNetworkProvider(identity.projectPath),
                  );
            return networkAccess
              ? withOfficialProviderAccess(
                  {
                    action: 'cli-launch',
                    cwd: identity.projectPath,
                    ...networkAccess,
                  },
                  operation,
                )
              : operation();
          },
        );
        if (result.ok && transferredOwner && transferredSessionId) {
          terminalConversationOwners.set(transferredSessionId, transferredOwner);
          nativeConversationSessions.set(validatedConversationId, transferredSessionId);
          const launch = nativeLaunches.get(validatedConversationId);
          if (launch) {
            requireClaudeRuntime().releaseNativeConversation(launch.ownerId);
            nativeLaunches.delete(validatedConversationId);
          }
        }
        return result;
      } finally {
        if (transferredSessionId) terminalTransferSessions.delete(transferredSessionId);
      }
    },
  );
};

const registerConversationAdoptionIpc = (
  {
    guards: {
      assertLaunchAdmissionAllowed,
      requireClaudeRuntime,
      requireNativeConversationService,
      validateSender,
      withOfficialProviderAccess,
    },
    invalidateAndWaitForDevelopmentSessionOperation,
    nativeLaunches,
    runClaudeResumeLaunch,
    runtimeActivityRegistry,
    runtimeProfile,
    services,
    terminalConversationOwners,
    terminalTransferSessions,
    withDevelopmentSessionOperation,
    workspace,
  }: ConversationIpcDependencies,
  { nativeConversationSessions }: ConversationIpcContext,
): void => {
  ipcMain.handle(
    CHANNELS.NATIVE_CONVERSATION_ADOPT_TERMINAL,
    async (event, sessionId: unknown, allowInterrupt: unknown) => {
      validateSender(event);
      assertLaunchAdmissionAllowed();
      const validatedSessionId = validateSessionId(sessionId);
      if (typeof allowInterrupt !== 'boolean') {
        throw new Error('安全终端切换确认参数无效。');
      }
      if (!workspace.hasSession(validatedSessionId)) {
        return {
          ...reportConversationFailure('user-input', '该终端标签已经关闭。', {
            sessionId: validatedSessionId,
          }),
          ok: false,
        };
      }
      const status = workspace.getStatus(validatedSessionId);
      const projectPath = status.cwd;
      // The registry owner is the same truth `prepareModelSpeedRelaunch` relies on: it only exists
      // once Claude Code has reported its transcript UUID on the status line. Without it an "adopt"
      // would fork a brand-new conversation instead of continuing the one on screen.
      const terminalOwner = terminalConversationOwners.get(validatedSessionId);
      if (!terminalOwner || !isValidClaudeSessionId(terminalOwner.conversationId)) {
        return {
          ...reportConversationFailure(
            'user-input',
            '当前对话尚未上报可恢复的会话标识，请稍候再切换到原生对话。',
            { sessionId: validatedSessionId },
          ),
          ok: false,
        };
      }
      const runtime = requireClaudeRuntime();
      const nativeAuthorization = runtime.captureNativeConversationAuthorization(
        projectPath,
        validatedSessionId,
      );
      const terminalHasRunningWork = (): boolean => {
        if (!workspace.hasSession(validatedSessionId)) return false;
        const currentStatus = workspace.getStatus(validatedSessionId);
        const activity = runtimeActivityRegistry.get(validatedSessionId);
        return activity.ptyGeneration === currentStatus.ptyGeneration
          ? terminalConversationHasRunningWork(activity)
          : runtime.isActive(validatedSessionId);
      };
      const requiresConfirmation = () => ({
        ...reportConversationFailure('user-input', '安全终端仍有正在运行的回复或后台任务。', {
          sessionId: validatedSessionId,
        }),
        ok: false as const,
        requiresConfirmation: true,
      });
      if (!allowInterrupt && terminalHasRunningWork()) {
        return requiresConfirmation();
      }
      const conversationId = terminalOwner.conversationId.toLowerCase();
      const service = requireNativeConversationService();

      let launch: NativeConversationLaunch | undefined;
      const releasePreparedLaunch = (): void => {
        if (!launch) return;
        runtime.releaseNativeConversation(launch.ownerId);
        nativeLaunches.delete(conversationId);
        launch = undefined;
      };
      const adoptFromTerminal = async () => {
        assertLaunchAdmissionAllowed();
        if (runtimeProfile.adapterMode === 'production') {
          const ownerId = `native-route:${conversationId}`;
          const prepared = await runtime.prepareNativeConversation(
            ownerId,
            projectPath,
            undefined,
            nativeAuthorization,
          );
          launch = { ownerId, prepared };
          try {
            assertLaunchAdmissionAllowed();
            nativeLaunches.set(conversationId, launch);
          } catch (error) {
            releasePreparedLaunch();
            throw error;
          }
        }
        // Network preflight and SDK preparation can take long enough for a formerly idle terminal to
        // start work. Recheck at the destructive boundary, after preparation but before stopping PTY.
        if (!workspace.hasSession(validatedSessionId)) {
          releasePreparedLaunch();
          return {
            ...reportConversationFailure('user-input', '该终端标签已经关闭。', {
              sessionId: validatedSessionId,
            }),
            ok: false,
          };
        }
        if (!allowInterrupt && terminalHasRunningWork()) {
          releasePreparedLaunch();
          return requiresConfirmation();
        }
        try {
          assertLaunchAdmissionAllowed();
        } catch (error) {
          releasePreparedLaunch();
          throw error;
        }

        terminalTransferSessions.add(validatedSessionId);
        try {
          const result = await service.adoptFromTerminal(
            {
              allowBypassPermissions:
                launch?.prepared.allowBypassPermissions ?? runtimeProfile.adapterMode === 'fake',
              conversationId,
              launch: launch
                ? {
                    cliVersion: launch.prepared.cliVersion,
                    configFingerprintSource: { runtime: launch.prepared.configFingerprint },
                    endpointIdentity: launch.prepared.endpointIdentity,
                    model: launch.prepared.model,
                  }
                : { configFingerprintSource: { adapter: 'isolated-fake' } },
              model: launch?.prepared.model,
              projectPath,
              runtimeModel: launch?.prepared.runtimeModel,
              settingsEnvironment: launch?.prepared.settingsEnvironment,
            },
            // Stop the Claude process inside the tab, but keep the tab. Leaving it running would put
            // two writers on one JSONL; closing it would destroy the tab the user is switching within.
            async () => {
              await invalidateAndWaitForDevelopmentSessionOperation(validatedSessionId).catch(
                () => undefined,
              );
              await services
                .resolve(RUNTIME_PROCESS_REGISTRY)
                .terminateSession(validatedSessionId)
                .catch(() => undefined);
              if (!workspace.hasSession(validatedSessionId)) return;
              const current = workspace.getStatus(validatedSessionId);
              workspace.stop(validatedSessionId);
              requireClaudeRuntime().setInactive(validatedSessionId, current.ptyGeneration);
            },
            async () => {
              await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
                await runClaudeResumeLaunch(
                  validatedSessionId,
                  projectPath,
                  conversationId,
                  '无法恢复安全终端。',
                  assertCurrent,
                );
              });
            },
          );
          if (result.ok) {
            terminalConversationOwners.delete(validatedSessionId);
            nativeConversationSessions.set(conversationId, validatedSessionId);
          } else {
            releasePreparedLaunch();
          }
          return result;
        } catch (error) {
          releasePreparedLaunch();
          throw error;
        } finally {
          terminalTransferSessions.delete(validatedSessionId);
        }
      };
      const networkAccess =
        runtimeProfile.adapterMode !== 'production'
          ? undefined
          : effectiveClaudeNetworkAccess(
              nativeAuthorization.authorization.networkAccess,
              nativeAuthorization.authorization.officialNetworkProvider,
            );
      return networkAccess
        ? withOfficialProviderAccess(
            { action: 'cli-launch', cwd: projectPath, ...networkAccess },
            adoptFromTerminal,
          )
        : adoptFromTerminal();
    },
  );
};

const registerConversationRecoveryIpc = ({
  guards: { requireNativeConversationService, validateSender },
}: ConversationIpcDependencies): void => {
  ipcMain.handle(CHANNELS.NATIVE_CONVERSATION_LIST_RECOVERIES, (event) => {
    validateSender(event);
    return requireNativeConversationService()
      .listRecoveries()
      .filter((recovery) => !recovery.clean);
  });
  ipcMain.handle(
    CHANNELS.NATIVE_CONVERSATION_RESTORE_DRAFT,
    (event, conversationId: unknown, clientSubmissionId: unknown, projectPath: unknown) => {
      validateSender(event);
      if (
        typeof clientSubmissionId !== 'string' ||
        !clientSubmissionId ||
        clientSubmissionId.length > 200
      ) {
        throw new Error('恢复草稿标识无效。');
      }
      return requireNativeConversationService().restoreDraft(
        validateConversationId(conversationId),
        clientSubmissionId,
        validateProjectPath(projectPath),
      );
    },
  );
  ipcMain.handle(
    CHANNELS.NATIVE_CONVERSATION_DISCARD_RECOVERY,
    (event, conversationId: unknown, projectPath: unknown) => {
      validateSender(event);
      return requireNativeConversationService().discardRecovery(
        validateConversationId(conversationId),
        validateProjectPath(projectPath),
      );
    },
  );
};

export const registerConversationIpc = (dependencies: ConversationIpcDependencies): void => {
  const { nativeAttachmentStore } = dependencies;
  /**
   * Conversation UUID → the workspace tab it is displayed over. Recorded authoritatively here so
   * runtime switches happen in place on that tab instead of the renderer guessing, and so a native
   * conversation that came from a terminal knows which tab to hand itself back to.
   */
  const nativeConversationSessions = new Map<string, string>();

  const resolveNativeSubmitAttachments = (
    conversationId: string,
    input: ConversationSubmitInput,
  ): ConversationSubmitInput => ({
    ...input,
    blocks: input.blocks.map((block) =>
      block.type === 'text'
        ? block
        : {
            attachment: nativeAttachmentStore.resolve(conversationId, block.attachment.id),
            type: 'image' as const,
          },
    ),
  });
  const context: ConversationIpcContext = {
    nativeConversationSessions,
    resolveNativeSubmitAttachments,
  };
  registerConversationStartIpc(dependencies, context);
  registerConversationControlIpc(dependencies, context);
  registerConversationTransferIpc(dependencies, context);
  registerConversationAdoptionIpc(dependencies, context);
  registerConversationRecoveryIpc(dependencies);
};
