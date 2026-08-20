import type { ClaudeLaunchMode } from '../../../shared/contracts';
import type { NativeRecoveryView } from '../../../shared/conversation/native';
import type { ConversationActions } from './actions';
import type { ConversationElements } from './elements';
import type { ConversationLaunchActionsDependencies } from './launch-dependencies';
import type { ConversationState } from './state';

export interface NativeRecoveryActions {
  refreshNativeRecoveries: () => Promise<void>;
  renderNativeRecoveries: () => void;
}

export const createNativeRecoveryActions = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationLaunchActionsDependencies,
  actions: ConversationActions,
  launchNativeClaude: (mode: ClaudeLaunchMode, exactConversationId?: string) => Promise<void>,
): NativeRecoveryActions => {
  const recoveryProjectIsActive = (recovery: NativeRecoveryView): boolean =>
    recovery.projectPath.toLowerCase() === (dependencies.activeStatus()?.cwd ?? '').toLowerCase() &&
    recovery.conversationId !== state.activeNativeConversationId;

  const refreshNativeRecoveries = async (): Promise<void> => {
    try {
      state.nativeRecoveries = await window.controlPanel.listNativeRecoveries();
    } catch {
      state.nativeRecoveries = [];
    }
    renderNativeRecoveries();
  };

  const restoreRecoveryDraft = async (
    recovery: NativeRecoveryView,
    clientSubmissionId: string,
  ): Promise<void> => {
    const result = await window.controlPanel.restoreNativeDraft(
      recovery.conversationId,
      clientSubmissionId,
      recovery.projectPath,
    );
    const restoredDraft = result.draft;
    if (!result.ok || !restoredDraft) {
      dependencies.showToast(
        dependencies.resultFailureMessage(result, '无法恢复待确认文本。'),
        'error',
      );
      return;
    }
    const text = restoredDraft.blocks
      .filter(
        (block): block is Extract<(typeof restoredDraft.blocks)[number], { type: 'text' }> =>
          block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n\n');
    elements.nativeComposerInput.value = text;
    actions.resizeNativeComposer();
    elements.nativeComposerInput.dataset.recoveredDraft = 'true';
    elements.nativeComposerStatus.textContent = '已恢复为未发送草稿 · 请核对后手动发送';
    if (restoredDraft.blocks.some((block) => block.type === 'image')) {
      dependencies.showToast('原输入包含图片；为避免引用失效，请重新添加图片后再发送。');
    } else {
      dependencies.showToast(result.message ?? '草稿已恢复，尚未发送。');
    }
    elements.nativeComposerInput.focus();
  };

  const renderNativeRecoveries = (): void => {
    const recoveries = state.nativeRecoveries.filter(recoveryProjectIsActive);
    elements.nativeRecoveryStack.hidden = recoveries.length === 0;
    const cards = recoveries.map((recovery) => {
      const card = document.createElement('article');
      card.className = 'native-recovery-card';
      const copy = document.createElement('div');
      const eyebrow = document.createElement('span');
      eyebrow.textContent = '上次运行异常中断';
      const title = document.createElement('strong');
      title.textContent = recovery.launch.model
        ? `${recovery.launch.model} 对话可恢复`
        : 'Claude 对话可恢复';
      const detail = document.createElement('p');
      const unknownCount = recovery.submissions.filter(
        (submission) => submission.state === 'result-unknown',
      ).length;
      const draftCount = recovery.submissions.filter(
        (submission) => submission.state === 'interrupted-draft',
      ).length;
      detail.textContent = unknownCount
        ? `${unknownCount} 条输入的发送结果无法确认；ClaudeDock 不会自动重发。`
        : draftCount
          ? `${draftCount} 条内容尚未发送，可恢复到输入框核对。`
          : '正文仍以 Claude JSONL 为准，可精确继续原对话。';
      copy.append(eyebrow, title, detail);

      const actions = document.createElement('div');
      actions.className = 'native-recovery-card__actions';
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.className = 'button button--compact';
      resume.textContent = '继续原对话';
      resume.addEventListener('click', () => {
        void launchNativeClaude('resume', recovery.conversationId);
      });
      actions.append(resume);
      const recoverable = recovery.submissions.find((submission) =>
        ['interrupted-draft', 'result-unknown'].includes(submission.state),
      );
      if (recoverable) {
        const draft = document.createElement('button');
        draft.type = 'button';
        draft.className = 'button button--compact';
        draft.textContent = unknownCount ? '恢复待核对文本' : '恢复未发送草稿';
        draft.addEventListener('click', () => {
          void restoreRecoveryDraft(recovery, recoverable.clientSubmissionId);
        });
        actions.append(draft);
      }
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'button button--compact button--danger native-recovery-card__discard';
      discard.textContent = '丢弃记录';
      discard.addEventListener('click', () => {
        void (async () => {
          const confirmed = await dependencies.requestConfirmation({
            confirmLabel: '丢弃恢复记录',
            message: '只会删除 ClaudeDock 的恢复提示，不会删除 Claude 的 JSONL 历史正文。',
            title: '丢弃恢复记录？',
            tone: 'danger',
          });
          if (!confirmed) return;
          await window.controlPanel.discardNativeRecovery(
            recovery.conversationId,
            recovery.projectPath,
          );
          await refreshNativeRecoveries();
        })().catch(() => dependencies.showToast('无法丢弃恢复记录。', 'error'));
      });
      actions.append(discard);
      card.append(copy, actions);
      return card;
    });
    elements.nativeRecoveryStack.replaceChildren(...cards);
  };

  return {
    refreshNativeRecoveries,
    renderNativeRecoveries,
  };
};
