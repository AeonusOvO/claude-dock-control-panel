import type {
  ClaudeConversationModelResolution,
  ConversationResumePreferences,
} from '../../shared/contracts';

export interface StartupModelConversation {
  conversationId: string;
  modelId?: string;
}

export interface StartupModelRestoreProgress {
  accountLabel?: string;
  detail: string;
  step: string;
}

export interface StartupModelRestoreDependencies {
  allowExternalRoutingWrites: boolean;
  applyConversationModel: (
    projectPath: string,
    conversation: StartupModelConversation,
    sessionId: string,
  ) => Promise<void>;
  clearNextConnection: () => void;
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
  assertActive?: () => void;
  progress?: (progress: StartupModelRestoreProgress) => void;
  signal?: AbortSignal;
  warn: (message: string, error?: unknown) => void;
}

export type StartupModelRestoreOutcome = 'cancelled' | 'failed' | 'restored' | 'skipped';

/** Restores only the model connection when the user intentionally leaves conversation loading off. */
export const restoreLastConversationModelOnly = async (
  dependencies: StartupModelRestoreDependencies,
): Promise<StartupModelRestoreOutcome> => {
  const preferences = dependencies.getPreferences();
  if (!preferences.autoLoadLastConversationModelOnStartup) {
    dependencies.clearNextConnection();
    return 'skipped';
  }
  if (!dependencies.restoreWorkspace || !dependencies.allowExternalRoutingWrites) {
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
    dependencies.assertActive?.();
    dependencies.progress?.({
      detail: '正在读取上一次会话保存的平台、账号与模型。',
      step: '读取配置',
    });
    const resolution = await dependencies.inspectConversationModel(projectPath, conversation);
    dependencies.assertActive?.();
    if (!resolution.restorable) {
      dependencies.warn('上次对话的模型接入信息不完整，保留当前接入。');
      return 'failed';
    }
    const accountLabel = resolution.conversation.accountIdentity
      ? `${resolution.conversation.providerLabel} · ${resolution.conversation.accountIdentity}`
      : /订阅账户|官方登录/u.test(resolution.conversation.accountDetail)
        ? `${resolution.conversation.providerLabel} · ${resolution.conversation.accountDetail}`
        : undefined;
    dependencies.progress?.({
      ...(accountLabel ? { accountLabel } : {}),
      detail: '正在创建隔离的接入事务；当前配置尚未发生变化。',
      step: '准备接入与网关',
    });
    temporarySessionId = dependencies.openTemporarySession(projectPath);
    if (!temporarySessionId) {
      throw new Error('无法创建自动模型恢复事务。');
    }
    dependencies.assertActive?.();
    dependencies.progress?.({
      ...(accountLabel ? { accountLabel } : {}),
      detail: '正在执行网络预检，并真实验证最近一次选择的平台和模型。',
      step: '网络预检与连接验证',
    });
    await dependencies.applyConversationModel(projectPath, conversation, temporarySessionId);
    dependencies.assertActive?.();
    dependencies.progress?.({
      ...(accountLabel ? { accountLabel } : {}),
      detail: '验证已通过，正在提交下个对话使用的接入配置。',
      step: '提交接入配置',
    });
    return 'restored';
  } catch (error) {
    if (dependencies.signal?.aborted) {
      return 'cancelled';
    }
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
