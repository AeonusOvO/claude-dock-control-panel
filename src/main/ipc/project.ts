import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type { PtyGeneration, WorkspaceResult, WorkspaceState } from '../../shared/contracts';
import { isValidClaudeSessionId, normalizeClaudeSessionTitle } from '../claude/session-manager';
import type { ClaudeConversationLifecycleCoordinator } from '../claude/conversation-lifecycle';
import type { ConversationOwner, ConversationOwnerRegistry } from '../conversation/owner-registry';
import type { SessionConfigTransactionCoordinator } from '../coordination/main-process-operation';
import {
  type ProjectDirectoryLifecycleCoordinator,
  runOwnedProjectDirectoryClosure,
} from '../coordination/project-directory-lifecycle';
import type { WithSessionOperation } from '../coordination/session-operation';
import { resolveDirectory } from '../infra/directory';
import type { Registry } from '../infra/registry';
import { CLAUDE_RUNTIME, CODEX_RUNTIME, RUNTIME_PROCESS_REGISTRY } from '../infra/service-tokens';
import type { AgentRuntimeStore } from '../runtime/store';
import type { WorkspaceStore } from '../stores/workspace';
import {
  cleanupFailedRuntimeLaunch,
  type FailedRuntimeLaunchCleanupDependencies,
  type RestartRuntimeTerminal,
} from '../terminal/lifecycle';
import {
  type DescribeWorkspace,
  sameDirectory,
  type TerminalWorkspace,
} from '../terminal/workspace';
import { validateProjectPath, validateSessionId } from './validation';
import type { MainGuards } from './guards';

export interface ProjectIpcDependencies {
  activateProject: (sessionId: string) => WorkspaceState;
  addProject: (directoryPath: string) => WorkspaceResult;
  agentRuntimeStore: AgentRuntimeStore;
  claudeConversationLifecycle: ClaudeConversationLifecycleCoordinator;
  conversationOwnerRegistry: ConversationOwnerRegistry;
  describeWorkspace: DescribeWorkspace;
  failedRuntimeLaunchCleanupDependencies: FailedRuntimeLaunchCleanupDependencies;
  failedWorkspaceResult: (error: unknown) => WorkspaceResult;
  guards: Pick<MainGuards, 'requireClaudeRuntime' | 'requireCodexRuntime' | 'validateSender'>;
  invalidateAndWaitForDevelopmentSessionOperation: (sessionId: string) => Promise<void>;
  managedConfigTransactions: SessionConfigTransactionCoordinator;
  projectDirectoryLifecycle: ProjectDirectoryLifecycleCoordinator;
  releaseTerminalConversationOwner: (sessionId: string) => void;
  restartRuntimeTerminal: RestartRuntimeTerminal;
  services: Registry;
  terminalConversationOwners: Map<string, ConversationOwner>;
  withDevelopmentSessionOperation: WithSessionOperation;
  workspace: TerminalWorkspace;
  workspaceStore: WorkspaceStore;
}

const registerStoredConversationIpc = ({
  agentRuntimeStore,
  claudeConversationLifecycle,
  conversationOwnerRegistry,
  describeWorkspace,
  failedRuntimeLaunchCleanupDependencies,
  failedWorkspaceResult,
  guards: { requireClaudeRuntime, validateSender },
  managedConfigTransactions,
  projectDirectoryLifecycle,
  releaseTerminalConversationOwner,
  restartRuntimeTerminal,
  terminalConversationOwners,
  withDevelopmentSessionOperation,
  workspace,
  workspaceStore,
}: ProjectIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.PROJECT_OPEN_STORED_CONVERSATION,
    async (event, projectPath: unknown, conversationId: unknown): Promise<WorkspaceResult> => {
      validateSender(event);
      try {
        if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
          throw new Error('会话标识无效。');
        }
        const resolved = resolveDirectory(validateProjectPath(projectPath));
        return await projectDirectoryLifecycle.runOpen(resolved, async (ownership) => {
          const runtime = requireClaudeRuntime();
          ownership.assertCurrent();
          managedConfigTransactions.assertDevelopmentOperationAllowed(resolved);
          if (agentRuntimeStore.get(resolved) !== 'claude') {
            throw new Error('这是 Claude Code 历史会话，请先将该项目切换为 Claude Code。');
          }
          claudeConversationLifecycle.assertLaunchAllowed(resolved, 'resume', conversationId);

          const existingOwner = conversationOwnerRegistry.ownerFor({
            conversationId,
            projectPath: resolved,
            runtime: 'claude',
          });
          if (existingOwner?.ownerKind === 'terminal') {
            const existingSessionId = existingOwner.ownerId.replace(/^terminal:/, '');
            if (workspace.hasSession(existingSessionId)) {
              return {
                ok: true,
                reused: true,
                state: describeWorkspace(workspace.activate(existingSessionId)),
              };
            }
          }
          if (existingOwner) {
            throw new Error('该对话已在原生界面运行，请切换到现有对话。');
          }

          // Different UUIDs may run side by side, but the same canonical transcript has one owner.
          workspace.openConversation(resolved, `历史 ${conversationId.slice(0, 8)}`);
          const openedSessionId = workspace.getState().activeSessionId;
          if (!openedSessionId) {
            throw new Error('无法创建历史会话终端。');
          }
          const predictedGeneration =
            Number(workspace.getStatus(openedSessionId).ptyGeneration) + 1;
          const terminalOwner: ConversationOwner = {
            conversationId: conversationId.toLowerCase(),
            generation: predictedGeneration,
            ownerId: `terminal:${openedSessionId}`,
            ownerKind: 'terminal',
            phase: 'starting',
            projectPath: resolved,
            runtime: 'claude',
          };
          const ownerClaim = conversationOwnerRegistry.claim(terminalOwner);
          if (ownerClaim.status === 'conflict') {
            workspace.close(openedSessionId);
            throw new Error('该对话刚刚被另一个界面接管，已取消重复恢复。');
          }
          terminalConversationOwners.set(openedSessionId, ownerClaim.owner);
          ownership.assertCurrent();
          workspaceStore.addProject(resolved);

          await withDevelopmentSessionOperation(openedSessionId, async (assertCurrent) =>
            claudeConversationLifecycle.runResume(
              resolved,
              conversationId,
              openedSessionId,
              async (conversationOwnership) => {
                const assertOpenCurrent = (): void => {
                  ownership.assertCurrent();
                  conversationOwnership.assertCurrent();
                  assertCurrent();
                };
                let launchPrepared = false;
                let ownedGeneration: PtyGeneration | undefined;
                try {
                  const prepared = await runtime.prepareLaunchWithSession(
                    openedSessionId,
                    resolved,
                    conversationId,
                  );
                  launchPrepared = true;
                  ownedGeneration = prepared.predecessorPtyGeneration;
                  assertOpenCurrent();
                  restartRuntimeTerminal(
                    runtime,
                    openedSessionId,
                    prepared.environment,
                    prepared.command,
                    '无法为 Claude Code 启动安全终端。',
                    assertOpenCurrent,
                    (ptyGeneration) => {
                      ownedGeneration = ptyGeneration;
                    },
                  );
                } catch (error) {
                  if (launchPrepared || ownedGeneration !== undefined) {
                    cleanupFailedRuntimeLaunch(
                      failedRuntimeLaunchCleanupDependencies,
                      runtime,
                      openedSessionId,
                      ownedGeneration,
                    );
                  }
                  releaseTerminalConversationOwner(openedSessionId);
                  if (workspace.hasSession(openedSessionId)) workspace.close(openedSessionId);
                  throw error;
                }
              },
            ),
          );
          ownership.assertCurrent();
          conversationOwnerRegistry.updatePhase(
            terminalOwner,
            terminalOwner.ownerId,
            terminalOwner.generation,
            'active',
          );
          return { ok: true, state: describeWorkspace() };
        });
      } catch (error) {
        return failedWorkspaceResult(error);
      }
    },
  );
};

export const registerProjectIpc = (dependencies: ProjectIpcDependencies): void => {
  const {
    activateProject,
    addProject,
    agentRuntimeStore,
    describeWorkspace,
    failedWorkspaceResult,
    guards: { requireClaudeRuntime, requireCodexRuntime, validateSender },
    invalidateAndWaitForDevelopmentSessionOperation,
    projectDirectoryLifecycle,
    services,
    workspace,
    workspaceStore,
  } = dependencies;
  ipcMain.handle(CHANNELS.WORKSPACE_GET_STATE, (event) => {
    validateSender(event);
    return describeWorkspace();
  });
  ipcMain.handle(CHANNELS.PROJECT_ADD, (event, directoryPath: unknown) => {
    validateSender(event);
    if (typeof directoryPath !== 'string') {
      return failedWorkspaceResult(new Error('文件夹路径格式无效。'));
    }
    return addProject(directoryPath);
  });
  ipcMain.handle(CHANNELS.PROJECT_ACTIVATE, (event, sessionId: unknown) => {
    validateSender(event);
    try {
      return {
        ok: true,
        state: activateProject(validateSessionId(sessionId)),
      } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle(CHANNELS.PROJECT_CLOSE, async (event, sessionId: unknown) => {
    validateSender(event);
    try {
      const validatedSessionId = validateSessionId(sessionId);
      await invalidateAndWaitForDevelopmentSessionOperation(validatedSessionId);
      await services.resolve(RUNTIME_PROCESS_REGISTRY).terminateSession(validatedSessionId);
      requireClaudeRuntime().closeSession(validatedSessionId);
      requireCodexRuntime().closeSession(validatedSessionId);
      // The folder stays remembered: closing one conversation is not "forget this project".
      const state = workspace.close(validatedSessionId);
      const active = state.sessions.find((session) => session.id === state.activeSessionId);
      if (active) {
        workspaceStore.updateLastActive(active.cwd);
      }
      return {
        ok: true,
        state: describeWorkspace(state),
      } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle(CHANNELS.PROJECT_OPEN_CONVERSATION, (event, projectPath: unknown) => {
    validateSender(event);
    try {
      const resolved = resolveDirectory(validateProjectPath(projectPath));
      return projectDirectoryLifecycle.runOpenSync(resolved, (ownership) => {
        ownership.assertCurrent();
        const state = workspace.openConversation(resolved);
        ownership.assertCurrent();
        workspaceStore.addProject(resolved);
        return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
      });
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle(CHANNELS.PROJECT_CLOSE_FOLDER, async (event, projectPath: unknown) => {
    validateSender(event);
    try {
      const target = validateProjectPath(projectPath);
      const state = await runOwnedProjectDirectoryClosure({
        beforeCloseSession: (sessionId) =>
          services.resolve(RUNTIME_PROCESS_REGISTRY).terminateSession(sessionId),
        captureSessionIds: () => workspace.sessionIdsForDirectory(target),
        closeRuntimeSession: (sessionId) => {
          services.resolve(CLAUDE_RUNTIME).closeSession(sessionId);
          services.resolve(CODEX_RUNTIME).closeSession(sessionId);
        },
        closeWorkspaceSession: (sessionId) => {
          workspace.close(sessionId);
        },
        coordinator: projectDirectoryLifecycle,
        cwd: target,
        invalidateAndWait: invalidateAndWaitForDevelopmentSessionOperation,
        isSessionInDirectory: (sessionId, cwd) =>
          workspace.hasSession(sessionId) && sameDirectory(workspace.getStatus(sessionId).cwd, cwd),
        kind: 'close',
        readState: () => workspace.getState(),
      });
      return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle(CHANNELS.PROJECT_FORGET, async (event, projectPath: unknown) => {
    validateSender(event);
    try {
      const target = validateProjectPath(projectPath);
      const state = await runOwnedProjectDirectoryClosure({
        beforeCloseSession: (sessionId) =>
          services.resolve(RUNTIME_PROCESS_REGISTRY).terminateSession(sessionId),
        captureSessionIds: () => workspace.sessionIdsForDirectory(target),
        closeRuntimeSession: (sessionId) => {
          services.resolve(CLAUDE_RUNTIME).closeSession(sessionId);
          services.resolve(CODEX_RUNTIME).closeSession(sessionId);
        },
        closeWorkspaceSession: (sessionId) => {
          workspace.close(sessionId);
        },
        commit: () => {
          workspaceStore.removeProject(target);
          agentRuntimeStore.remove(target);
        },
        coordinator: projectDirectoryLifecycle,
        cwd: target,
        invalidateAndWait: invalidateAndWaitForDevelopmentSessionOperation,
        isSessionInDirectory: (sessionId, cwd) =>
          workspace.hasSession(sessionId) && sameDirectory(workspace.getStatus(sessionId).cwd, cwd),
        kind: 'forget',
        readState: () => workspace.getState(),
      });
      return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
    } catch (error) {
      return failedWorkspaceResult(error);
    }
  });
  ipcMain.handle(
    CHANNELS.PROJECT_RENAME_CONVERSATION,
    (event, sessionId: unknown, title: unknown) => {
      validateSender(event);
      try {
        if (typeof title !== 'string') {
          throw new Error('对话名称格式无效。');
        }
        const validatedSessionId = validateSessionId(sessionId);
        const normalizedTitle = normalizeClaudeSessionTitle(title);
        const state = workspace.renameSession(validatedSessionId, normalizedTitle);
        const status = workspace.getStatus(validatedSessionId);
        services
          .resolve(CLAUDE_RUNTIME)
          .writeTerminal(validatedSessionId, status.ptyGeneration, `/rename ${normalizedTitle}\r`);
        return { ok: true, state: describeWorkspace(state) } satisfies WorkspaceResult;
      } catch (error) {
        return failedWorkspaceResult(error);
      }
    },
  );
  registerStoredConversationIpc(dependencies);
};
