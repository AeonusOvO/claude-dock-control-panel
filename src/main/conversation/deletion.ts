import type { ClaudeSessionDeleteResult } from '../../shared/contracts';
import {
  type ClaudeConversationLifecycleCoordinator,
  runOwnedClaudeConversationDeletion,
} from '../claude/conversation-lifecycle';
import type { ClaudeSessionManager } from '../claude/session-manager';
import type { SessionOperationCoordinator } from '../coordination/session-operation';
import { createFailureReporter } from '../infra/logger';
import type { Registry } from '../infra/registry';
import { CODEX_RUNTIME } from '../infra/service-tokens';
import type { MainGuards } from '../ipc/guards';
import {
  sameDirectory,
  type DescribeWorkspace,
  type TerminalWorkspace,
} from '../terminal/workspace';

export interface ConversationDeletionDependencies {
  claudeConversationLifecycle: ClaudeConversationLifecycleCoordinator;
  describeWorkspace: DescribeWorkspace;
  developmentSessionOperations: SessionOperationCoordinator;
  guards: Pick<MainGuards, 'requireClaudeRuntime'>;
  services: Registry;
  sessionManager: ClaudeSessionManager;
  workspace: TerminalWorkspace;
}

export type DeleteClaudeConversation = (
  cwd: string,
  conversationId: string,
) => Promise<ClaudeSessionDeleteResult>;

const reportConversationFailure = createFailureReporter('conversation');

/**
 * Deleting a transcript outranks every resume launch: the terminal that owns the conversation is
 * closed under the same session lease the launch paths take, so a launch cannot write into a
 * transcript that is being removed.
 */
export const createDeleteClaudeConversation = ({
  claudeConversationLifecycle,
  describeWorkspace,
  developmentSessionOperations,
  guards: { requireClaudeRuntime },
  services,
  sessionManager,
  workspace,
}: ConversationDeletionDependencies): DeleteClaudeConversation =>
  async function deleteClaudeConversation(
    cwd: string,
    conversationId: string,
  ): Promise<ClaudeSessionDeleteResult> {
    const runtime = requireClaudeRuntime();
    const result = await runOwnedClaudeConversationDeletion({
      closeRuntimeSession: (sessionId) => {
        runtime.closeSession(sessionId);
        services.resolve(CODEX_RUNTIME).closeSession(sessionId);
      },
      closeWorkspaceSession: (sessionId) => {
        workspace.close(sessionId);
      },
      conversationId,
      coordinator: claudeConversationLifecycle,
      cwd,
      deleteTranscript: () => sessionManager.deleteSession(cwd, conversationId),
      isSessionInDirectory: (sessionId, targetCwd) =>
        workspace.hasSession(sessionId) &&
        sameDirectory(workspace.getStatus(sessionId).cwd, targetCwd),
      readState: describeWorkspace,
      removePreferences: () => runtime.removeConversationPreferences(conversationId),
      runWithSessionOwnership: async (sessionId, operation) => {
        if (!workspace.hasSession(sessionId)) {
          return;
        }
        try {
          await developmentSessionOperations.runLatest(sessionId, async (assertCurrent) => {
            assertCurrent();
            operation();
          });
        } catch (error) {
          if (!workspace.hasSession(sessionId)) {
            return;
          }
          throw error;
        }
      },
      sessionIdsForConversation: () => runtime.sessionIdsForConversation(cwd, conversationId),
      sessionOwnsConversation: (sessionId) =>
        runtime.sessionOwnsConversation(sessionId, cwd, conversationId),
    });
    return result.deleted
      ? { deleted: true, ok: true, state: result.state }
      : {
          ...reportConversationFailure('environment', '历史对话文件已不存在或无法删除。', {
            conversationId,
            cwd,
          }),
          deleted: false,
          error: '历史对话文件已不存在或无法删除。',
          ok: false,
          state: result.state,
        };
  };
