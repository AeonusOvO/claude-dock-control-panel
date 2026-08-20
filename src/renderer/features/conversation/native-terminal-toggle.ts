import type { ClaudeLaunchMode } from '../../../shared/contracts';
import {
  nativeConversationHasRunningWork,
  runConfirmableConversationSurfaceSwitch,
  terminalConversationHasRunningWork,
} from '../../../shared/conversation/surface-switch';
import type { ConversationSubmitInput } from '../../../shared/conversation/native';
import type { ConversationActions } from './actions';
import type { ConversationElements } from './elements';
import type { ConversationLaunchActionsDependencies } from './launch-dependencies';
import type { ConversationState } from './state';

export interface NativeTerminalToggleActions {
  bindNativeTerminalToggle: () => () => void;
}

export const createNativeTerminalToggleActions = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationLaunchActionsDependencies,
  actions: ConversationActions,
  launchNativeClaude: (mode: ClaudeLaunchMode, exactConversationId?: string) => Promise<void>,
  activateNativeConversation: (conversationId: string) => void,
  refreshNativeRecoveries: () => Promise<void>,
): NativeTerminalToggleActions => {
  const confirmNativeInterruptSwitch = async (): Promise<boolean> =>
    dependencies.requestConfirmation({
      confirmLabel: '中断并切换',
      message:
        '当前回复或后台任务会被中断，已生成的内容会保留在对话记录中；切换后可以继续同一段对话。',
      title: '中断正在运行的任务并切换？',
      tone: 'danger',
    });

  const adoptTerminalConversationIntoNative = async (): Promise<void> => {
    const status = dependencies.activeStatus();
    if (!status) return;
    const claudeState = dependencies.getClaudeState(status.id);
    // No live Claude Code process means there is nothing to take over; start a native conversation.
    if (!claudeState?.active) {
      await launchNativeClaude('new');
      return;
    }
    const locallyBusy = terminalConversationHasRunningWork(
      dependencies.getRuntimeActivity(status.id),
    );
    let switchStarted = false;
    try {
      const attempt = await runConfirmableConversationSurfaceSwitch(
        locallyBusy,
        confirmNativeInterruptSwitch,
        (allowInterrupt) => {
          if (!switchStarted) {
            switchStarted = true;
            elements.nativeTerminalToggle.disabled = true;
            elements.nativeTerminalToggle.setAttribute('aria-busy', 'true');
          }
          return window.controlPanel.adoptTerminalConversation(status.id, allowInterrupt);
        },
      );
      if (attempt.cancelled) return;
      const result = attempt.result;
      if (!result.ok || !result.conversationId) {
        dependencies.showToast(
          dependencies.resultFailureMessage(result, '无法接管当前终端对话。'),
          'error',
        );
        return;
      }
      state.nativeConversationBySession.set(status.id, result.conversationId);
      if (result.snapshot) actions.renderNativeConversation(result.snapshot);
      activateNativeConversation(result.conversationId);
      await refreshNativeRecoveries();
      dependencies.showToast(result.message ?? '已切换到原生对话，继续同一段会话。');
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '无法接管当前终端对话。',
        'error',
      );
    } finally {
      if (switchStarted) {
        elements.nativeTerminalToggle.disabled = false;
        elements.nativeTerminalToggle.setAttribute('aria-busy', 'false');
      }
    }
  };

  const handleNativeTerminalToggleClick = (): void => {
    const panelState = elements.nativeConversation.dataset.state;
    const nativeConversationIsVisible = panelState === 'opening' || panelState === 'open';
    if (nativeConversationIsVisible) {
      if (!state.activeNativeConversationId) {
        actions.setNativeConversationVisible(false);
        return;
      }
      void (async () => {
        const conversationId = state.activeNativeConversationId;
        const snapshot = state.nativeConversationSnapshots.get(conversationId);
        const locallyBusy = nativeConversationHasRunningWork(snapshot);
        let switchStarted = false;
        let draft: ConversationSubmitInput | undefined;
        try {
          const attempt = await runConfirmableConversationSurfaceSwitch(
            locallyBusy,
            confirmNativeInterruptSwitch,
            (allowInterrupt) => {
              if (!switchStarted) {
                // Queued content is folded back into the composer so the existing encrypted draft
                // path is the single mechanism that carries unsent text across the switch.
                actions.drainNativeQueuedMessageToComposer(conversationId);
                const text = elements.nativeComposerInput.value;
                const hasDraft = Boolean(text.trim() || state.pendingNativeAttachments.length > 0);
                draft = hasDraft
                  ? {
                      blocks: [
                        ...(text.trim() ? [{ text, type: 'text' as const }] : []),
                        ...state.pendingNativeAttachments.map((attachment) => ({
                          attachment: {
                            id: attachment.attachmentId,
                            mediaType: attachment.mediaType,
                            name: attachment.fileName,
                            size: attachment.sizeBytes,
                          },
                          type: 'image' as const,
                        })),
                      ],
                      clientSubmissionId: crypto.randomUUID(),
                    }
                  : undefined;
                switchStarted = true;
                elements.nativeTerminalToggle.disabled = true;
                elements.nativeTerminalToggle.setAttribute('aria-busy', 'true');
                elements.nativeComposerStatus.textContent = '正在安全返回终端…';
              }
              return window.controlPanel.transferNativeConversationToTerminal(
                conversationId,
                draft,
                allowInterrupt,
              );
            },
          );
          if (attempt.cancelled) {
            const current = state.nativeConversationSnapshots.get(conversationId);
            if (switchStarted && current) actions.renderNativeConversation(current);
            return;
          }
          const result = attempt.result;
          if (!result.ok) {
            dependencies.showToast(
              dependencies.resultFailureMessage(result, '安全终端启动失败，已保留原生对话。'),
              'error',
            );
            const current = state.nativeConversationSnapshots.get(conversationId);
            if (current) actions.renderNativeConversation(current);
            return;
          }
          elements.nativeComposerInput.value = '';
          delete elements.nativeComposerInput.dataset.recoveredDraft;
          state.pendingNativeAttachments.splice(0);
          actions.renderPendingNativeAttachments();
          actions.resizeNativeComposer();
          state.nativeQueuedMessages.delete(conversationId);
          state.nativeQueuedAutoFlush.delete(conversationId);
          // The tab now belongs to the terminal runtime; dropping the binding is what stops
          // `reconcileNativeConversationBinding` from re-opening the panel on the next render.
          for (const [sessionId, boundId] of [...state.nativeConversationBySession.entries()]) {
            if (boundId === conversationId) state.nativeConversationBySession.delete(sessionId);
          }
          state.activeNativeConversationId = '';
          actions.renderNativeQueuedMessage();
          actions.setNativeConversationVisible(false);
          // The transfer reuses the tab the conversation was already displayed over, so this only
          // re-selects when the main process had to fall back to another tab for the project.
          if (
            result.terminalSessionId &&
            result.terminalSessionId !== dependencies.getActiveSessionId()
          ) {
            const activated = await window.controlPanel.activateProject(result.terminalSessionId);
            if (activated.ok) dependencies.renderWorkspace(activated.state);
          }
          await refreshNativeRecoveries();
          dependencies.focusActiveTerminal();
          dependencies.showToast(result.message ?? '已返回安全终端。');
        } catch (error) {
          dependencies.showToast(
            error instanceof Error ? error.message : '无法返回安全终端。',
            'error',
          );
        } finally {
          if (switchStarted) {
            elements.nativeTerminalToggle.disabled = false;
            elements.nativeTerminalToggle.setAttribute('aria-busy', 'false');
          }
        }
      })();
      return;
    }
    if (state.activeNativeConversationId) {
      actions.setNativeConversationVisible(true);
      elements.nativeComposerInput.focus();
      return;
    }
    void adoptTerminalConversationIntoNative();
  };

  const bindNativeTerminalToggle = (): (() => void) => {
    elements.nativeTerminalToggle.addEventListener('click', handleNativeTerminalToggleClick);
    return () =>
      elements.nativeTerminalToggle.removeEventListener('click', handleNativeTerminalToggleClick);
  };

  return {
    bindNativeTerminalToggle,
  };
};
