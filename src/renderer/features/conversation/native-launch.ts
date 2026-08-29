import type { ClaudeLaunchMode, WorkspaceState } from '../../../shared/contracts';
import type { ConversationActions } from './actions';
import type { ConversationElements } from './elements';
import type { ConversationLaunchActionsDependencies } from './launch-dependencies';
import type { ConversationState } from './state';

export interface NativeLaunchActions {
  activateNativeConversation: (conversationId: string) => void;
  launchNativeClaude: (mode: ClaudeLaunchMode, exactConversationId?: string) => Promise<void>;
  reconcileNativeConversationBinding: (state: WorkspaceState) => void;
}

export const createNativeLaunchActions = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationLaunchActionsDependencies,
  actions: ConversationActions,
  renderNativeRecoveries: () => void,
): NativeLaunchActions => {
  const activateNativeConversation = (conversationId: string): void => {
    state.activeNativeConversationId = conversationId;
    renderNativeRecoveries();
    actions.setNativeConversationVisible(true);
    const snapshot = state.nativeConversationSnapshots.get(conversationId);
    if (snapshot) actions.renderNativeConversation(snapshot);
    elements.nativeComposerInput.focus();
  };

  const launchNativeClaude = async (
    mode: ClaudeLaunchMode,
    exactConversationId?: string,
  ): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status || state.nativeConversationStartingSessionId) return;
    let conversationId = exactConversationId;
    if (!conversationId && mode === 'continue') {
      conversationId = dependencies.getStoredConversations(status.cwd.toLowerCase())?.[0]
        ?.conversationId;
    }
    if (!conversationId && mode === 'resume') {
      dependencies.expandFolder(status.cwd.toLowerCase());
      await dependencies.loadFolderHistory(status.cwd, false);
      dependencies.renderWorkspace(dependencies.getWorkspaceState());
      dependencies.showToast('请从左侧历史对话中选择要恢复的会话。');
      return;
    }
    state.nativeConversationStartingSessionId = status.id;
    dependencies.refreshClaudeLaunchControls(status.id);
    elements.nativeSendButton.disabled = true;
    elements.nativeComposerStatus.textContent = conversationId
      ? '正在读取历史对话配置…'
      : '正在读取配置…';
    // Yield one frame so the initial phase is painted and announced before the main-process call.
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    let launchSucceeded = false;
    let launchFailureMessage = '';
    try {
      const launchPromise = window.controlPanel.startNativeConversation({
        conversationId,
        projectPath: status.cwd,
        resume: Boolean(conversationId),
        sessionId: status.id,
      });
      elements.nativeComposerStatus.textContent = conversationId
        ? '正在恢复历史对话…'
        : '正在准备 Claude Code 终端…';
      const result = await launchPromise;
      if (!result.ok) {
        launchFailureMessage = dependencies.resultFailureMessage(
          result,
          '无法启动 Claude 原生对话。',
        );
        dependencies.showToast(launchFailureMessage, 'error');
        return;
      }
      launchSucceeded = true;
      if (result.existingOwnerKind === 'terminal') {
        elements.nativeSendButton.disabled = true;
        elements.nativeComposerStatus.textContent = '该对话已在安全终端中运行';
        dependencies.showToast('该对话已经在安全终端中运行。');
        actions.setNativeConversationVisible(false);
        return;
      }
      if (result.snapshot) actions.renderNativeConversation(result.snapshot);
      state.nativeConversationBySession.set(status.id, result.conversationId);
      activateNativeConversation(result.conversationId);
      dependencies.showToast(
        result.reused ? '已切换到正在运行的对话。' : 'Claude 原生对话已就绪。',
      );
    } catch (error) {
      launchFailureMessage = error instanceof Error ? error.message : '无法启动 Claude 原生对话。';
      dependencies.showToast(launchFailureMessage, 'error');
    } finally {
      if (state.nativeConversationStartingSessionId === status.id) {
        state.nativeConversationStartingSessionId = undefined;
      }
      dependencies.refreshClaudeLaunchControls(status.id);
      const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
      if (snapshot) {
        actions.renderNativeConversation(snapshot);
      } else if (launchSucceeded) {
        elements.nativeSendButton.disabled = false;
        elements.nativeComposerStatus.textContent = 'Claude 已就绪';
      } else if (!launchSucceeded) {
        const claudeState = dependencies.getClaudeState(status.id);
        const credentialRequired =
          claudeState &&
          (claudeState.config.authMode === 'apiKey' ||
            claudeState.config.authMode === 'authToken') &&
          !claudeState.config.credentialConfigured;
        elements.nativeSendButton.disabled = true;
        elements.nativeComposerStatus.textContent = !claudeState
          ? '接入配置未就绪 · 请打开配置检查'
          : claudeState.installation.security !== 'ready'
            ? 'Claude Code 尚未就绪 · 请检查环境'
            : credentialRequired
              ? '尚未接入模型 · 请先完成配置'
              : claudeState.routeHealth?.blocking
                ? '接入配置不可用 · 请打开配置检查'
                : /NPM|claude\.exe|启动器/u.test(launchFailureMessage)
                  ? 'Claude Code 启动器不可用 · 请打开任务与下载'
                  : /配置|接入|连接|凭据|模型/u.test(launchFailureMessage)
                    ? '接入配置不可用 · 请打开配置检查'
                    : '启动失败 · 请查看错误提示后重试';
      }
    }
  };

  /**
   * Points the native panel at whatever conversation the freshly rendered tab owns, so switching tabs
   * switches runtimes in place instead of leaving a panel from another project on screen.
   *
   * Only the two settled panel states are reconciled: `setNativeConversationVisible` drives a 260 ms
   * collapse timer, and reacting during `opening`/`closing` would fight it.
   */
  const reconcileNativeConversationBinding = (workspace: WorkspaceState): void => {
    const live = new Set(workspace.sessions.map((session) => session.id));
    for (const sessionId of [...state.nativeConversationBySession.keys()]) {
      if (!live.has(sessionId)) state.nativeConversationBySession.delete(sessionId);
    }
    const panelState = elements.nativeConversation.dataset.state;
    if (panelState !== 'open' && panelState !== 'closed') return;
    const bound = workspace.activeSessionId
      ? state.nativeConversationBySession.get(workspace.activeSessionId)
      : undefined;
    if (bound) {
      if (
        bound !== state.activeNativeConversationId &&
        state.nativeConversationSnapshots.has(bound)
      ) {
        activateNativeConversation(bound);
      }
      return;
    }
    if (state.activeNativeConversationId) {
      state.activeNativeConversationId = '';
      actions.renderNativeQueuedMessage();
    }
    if (panelState === 'open') actions.setNativeConversationVisible(false);
  };

  return {
    activateNativeConversation,
    launchNativeClaude,
    reconcileNativeConversationBinding,
  };
};
