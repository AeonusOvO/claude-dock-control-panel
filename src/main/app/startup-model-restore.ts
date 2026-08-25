import type {
  ClaudeConversationModelResolution,
  ConversationResumePreferences,
} from '../../shared/contracts';

export interface StartupModelConversation {
  conversationId: string;
  modelId?: string;
}

export interface StartupModelRestoreDependencies {
  allowExternalRoutingWrites: boolean;
  applyConversationModel: (
    projectPath: string,
    conversation: StartupModelConversation,
    sessionId: string,
  ) => Promise<void>;
  closeTemporarySession: (sessionId: string) => void;
  getLastActiveProject: () => string | undefined;
  getLatestConversation: (projectPath: string) => StartupModelConversation | undefined;
  getPreferences: () => ConversationResumePreferences;
  inspectConversationModel: (
    projectPath: string,
    conversation: StartupModelConversation,
  ) => Promise<ClaudeConversationModelResolution>;
  openTemporarySession: (projectPath: string) => string | undefined;
  projectExists: (projectPath: string) => boolean;
  projectRuntime: (projectPath: string) => 'claude' | 'codex';
  restoreWorkspace: boolean;
  warn: (message: string, error?: unknown) => void;
}

export type StartupModelRestoreOutcome = 'failed' | 'restored' | 'skipped' | 'unchanged';

/** Restores only the model connection when the user intentionally leaves conversation loading off. */
export const restoreLastConversationModelOnly = async (
  dependencies: StartupModelRestoreDependencies,
): Promise<StartupModelRestoreOutcome> => {
  const preferences = dependencies.getPreferences();
  if (
    !dependencies.restoreWorkspace ||
    !dependencies.allowExternalRoutingWrites ||
    preferences.autoLoadLastConversationOnStartup ||
    !preferences.autoLoadLastConversationModelOnStartup
  ) {
    return 'skipped';
  }
  const projectPath = dependencies.getLastActiveProject();
  if (
    !projectPath ||
    !dependencies.projectExists(projectPath) ||
    dependencies.projectRuntime(projectPath) !== 'claude'
  ) {
    return 'skipped';
  }
  const conversation = dependencies.getLatestConversation(projectPath);
  if (!conversation) {
    return 'skipped';
  }
  let temporarySessionId: string | undefined;
  try {
    const resolution = await dependencies.inspectConversationModel(projectPath, conversation);
    if (!resolution.mismatch) {
      return 'unchanged';
    }
    if (!resolution.restorable) {
      dependencies.warn('上次对话的模型接入信息不完整，保留当前接入。');
      return 'failed';
    }
    temporarySessionId = dependencies.openTemporarySession(projectPath);
    if (!temporarySessionId) {
      throw new Error('无法创建自动模型恢复事务。');
    }
    await dependencies.applyConversationModel(projectPath, conversation, temporarySessionId);
    return 'restored';
  } catch (error) {
    dependencies.warn('自动加载上次对话模型失败，保留当前接入。', error);
    return 'failed';
  } finally {
    if (temporarySessionId) {
      try {
        dependencies.closeTemporarySession(temporarySessionId);
      } catch (error) {
        dependencies.warn('自动模型恢复完成，但临时终端清理失败。', error);
      }
    }
  }
};
