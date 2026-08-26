import { CHANNELS } from '../../shared/ipc/channels';
import { existsSync } from 'node:fs';
import { ipcMain } from 'electron';
import type { ClaudeSessionDeleteResult } from '../../shared/contracts';
import {
  type ClaudeSessionManager,
  isValidClaudeSessionId,
  normalizeClaudeSessionTitle,
} from '../claude/session-manager';
import { resolveSessionConnectionConfigScope } from '../claude/runtime-connection-config';
import { createFailureReporter } from '../infra/logger';
import type { Registry } from '../infra/registry';
import { NATIVE_CONVERSATION_SERVICE } from '../infra/service-tokens';
import type { ConversationOwnerRegistry } from '../conversation/owner-registry';
import type { DescribeWorkspace, TerminalWorkspace } from '../terminal/workspace';
import type { WorkspaceStore } from '../stores/workspace';
import { validateProjectPath, validateSessionId } from './validation';
import type { MainGuards } from './guards';

export interface SessionIpcDependencies {
  conversationOwnerRegistry: ConversationOwnerRegistry;
  /* Deleting a transcript also has to unwind terminal and native ownership, which the assembly owns. */
  deleteClaudeConversation: (
    cwd: string,
    conversationId: string,
  ) => Promise<ClaudeSessionDeleteResult>;
  describeWorkspace: DescribeWorkspace;
  guards: Pick<MainGuards, 'requireClaudeRuntime' | 'validateSender'>;
  services: Registry;
  sessionManager: ClaudeSessionManager;
  workspace: TerminalWorkspace;
  workspaceStore: WorkspaceStore;
}

const reportSessionFailure = createFailureReporter('conversation');

export const registerSessionIpc = ({
  conversationOwnerRegistry,
  deleteClaudeConversation,
  describeWorkspace,
  guards: { requireClaudeRuntime, validateSender },
  services,
  sessionManager,
  workspace,
  workspaceStore,
}: SessionIpcDependencies): void => {
  ipcMain.handle(CHANNELS.WORKSPACE_GET_STORED_PROJECTS, async (event) => {
    validateSender(event);
    return workspaceStore.getProjects().filter((project) => existsSync(project.path));
  });
  ipcMain.handle(CHANNELS.WORKSPACE_REMOVE_STORED_PROJECT, async (event, projectPath: unknown) => {
    validateSender(event);
    if (typeof projectPath !== 'string') {
      throw new Error('项目路径格式无效。');
    }
    workspaceStore.removeProject(projectPath);
  });
  ipcMain.handle(CHANNELS.CLAUDE_GET_SESSIONS, async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    const active = services.resolve(NATIVE_CONVERSATION_SERVICE).activeConversationIds(status.cwd);
    for (const conversationId of conversationOwnerRegistry.activeConversationIds(
      'claude',
      status.cwd,
    )) {
      active.add(conversationId);
    }
    return (await sessionManager.getSessionsForProjectAsync(status.cwd)).filter(
      (session) => !active.has(session.conversationId.toLowerCase()),
    );
  });
  ipcMain.handle(CHANNELS.CLAUDE_GET_SESSIONS_FOR_PATH, async (event, projectPath: unknown) => {
    validateSender(event);
    const validatedProjectPath = validateProjectPath(projectPath);
    const active = services
      .resolve(NATIVE_CONVERSATION_SERVICE)
      .activeConversationIds(validatedProjectPath);
    for (const conversationId of conversationOwnerRegistry.activeConversationIds(
      'claude',
      validatedProjectPath,
    )) {
      active.add(conversationId);
    }
    return (await sessionManager.getSessionsForProjectAsync(validatedProjectPath)).filter(
      (session) => !active.has(session.conversationId.toLowerCase()),
    );
  });
  ipcMain.handle(
    CHANNELS.CLAUDE_RENAME_SESSION,
    async (event, projectPath: unknown, conversationId: unknown, title: unknown) => {
      validateSender(event);
      if (
        typeof conversationId !== 'string' ||
        !isValidClaudeSessionId(conversationId) ||
        typeof title !== 'string'
      ) {
        throw new Error('历史对话重命名参数无效。');
      }
      return sessionManager.renameSession(
        validateProjectPath(projectPath),
        conversationId,
        normalizeClaudeSessionTitle(title),
      );
    },
  );
  ipcMain.handle(CHANNELS.CLAUDE_GET_CONNECTION_ADVICE, async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    const runtime = requireClaudeRuntime();
    return runtime.getConnectionAdvice(
      resolveSessionConnectionConfigScope(runtime, validatedSessionId, status.cwd),
    );
  });
  ipcMain.handle(
    CHANNELS.CLAUDE_DELETE_SESSION,
    async (
      event,
      projectPath: unknown,
      conversationId: unknown,
    ): Promise<ClaudeSessionDeleteResult> => {
      validateSender(event);
      try {
        if (typeof conversationId !== 'string' || !isValidClaudeSessionId(conversationId)) {
          throw new Error('会话标识无效。');
        }
        return await deleteClaudeConversation(validateProjectPath(projectPath), conversationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法删除这个历史对话。';
        return {
          ...reportSessionFailure(
            message === '会话标识无效。' ? 'user-input' : 'environment',
            message,
            error,
          ),
          deleted: false,
          error: message,
          ok: false,
          state: describeWorkspace(),
        };
      }
    },
  );
};
