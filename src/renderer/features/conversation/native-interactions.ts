import type {
  ConversationInteraction,
  ConversationInteractionResponse,
} from '../../../shared/conversation/native';
import type { ConversationActionsDependencies } from './dependencies';
import type { ConversationElements } from './elements';
import type { ConversationState } from './state';
import {
  appendNativeMcpFields,
  appendNativeQuestionFields,
  nativeInteractionButton,
  nativeJson,
} from './view';

export interface NativeInteractionActions {
  closeNativePlanDialog: () => void;
  renderNativeInteraction: (interaction: ConversationInteraction) => HTMLElement;
  respondToNativeInteraction: (
    interaction: ConversationInteraction,
    response: ConversationInteractionResponse,
  ) => Promise<void>;
  setNativeConversationVisible: (visible: boolean) => void;
}

export const createNativeInteractionActions = (
  elements: ConversationElements,
  state: ConversationState,
  dependencies: ConversationActionsDependencies,
): NativeInteractionActions => {
  const setNativeConversationVisible = (visible: boolean): void => {
    if (state.nativeConversationClosingTimer !== undefined) {
      window.clearTimeout(state.nativeConversationClosingTimer);
      state.nativeConversationClosingTimer = undefined;
    }
    if (visible) {
      dependencies.terminalShell.classList.add('terminal-shell--native');
      elements.nativeConversation.dataset.state = 'opening';
      elements.nativeConversation.setAttribute('aria-hidden', 'false');
      elements.nativeTerminalToggle.setAttribute('aria-pressed', 'true');
      elements.nativeTerminalToggleLabel.textContent = '返回终端';
      elements.nativeTerminalToggle.title = '返回安全终端';
      window.requestAnimationFrame(() => {
        if (elements.nativeConversation.dataset.state === 'opening')
          elements.nativeConversation.dataset.state = 'open';
      });
      return;
    }
    if (elements.nativeConversation.dataset.state === 'closed') return;
    elements.nativeConversation.dataset.state = 'closing';
    elements.nativeConversation.setAttribute('aria-hidden', 'true');
    elements.nativeTerminalToggle.setAttribute('aria-pressed', 'false');
    elements.nativeTerminalToggleLabel.textContent = '原生对话';
    elements.nativeTerminalToggle.title = '打开原生对话';
    state.nativeConversationClosingTimer = window.setTimeout(() => {
      elements.nativeConversation.dataset.state = 'closed';
      dependencies.terminalShell.classList.remove('terminal-shell--native');
      state.nativeConversationClosingTimer = undefined;
      dependencies.retryTerminalFitUntilMeasured();
    }, 260);
  };

  const respondToNativeInteraction = async (
    interaction: ConversationInteraction,
    response: ConversationInteractionResponse,
  ): Promise<void> => {
    if (!state.activeNativeConversationId) return;
    const result = await window.controlPanel.respondNativeConversation(
      state.activeNativeConversationId,
      interaction.id,
      response,
    );
    if (!result.ok) {
      dependencies.showToast(
        dependencies.resultFailureMessage(result, '没有成功提交这次选择。'),
        'error',
      );
    } else if (state.expandedNativePlan?.id === interaction.id) {
      closeNativePlanDialog();
    }
  };

  const closeNativePlanDialog = (): void => {
    if (!elements.nativePlanDialog.open) return;
    elements.nativePlanDialog.close();
    state.expandedNativePlan = undefined;
  };

  const openNativePlanDialog = (
    interaction: Extract<ConversationInteraction, { kind: 'plan' }>,
  ): void => {
    state.expandedNativePlan = interaction;
    elements.nativePlanTitle.textContent = interaction.title || '实施计划';
    elements.nativePlanContent.replaceChildren();
    void dependencies
      .getMarkdownRenderer()
      .renderInto(elements.nativePlanContent, interaction.markdown);
    if (!elements.nativePlanDialog.open) elements.nativePlanDialog.showModal();
    elements.nativePlanClose.focus({ preventScroll: true });
  };

  const renderNativeInteraction = (interaction: ConversationInteraction): HTMLElement => {
    const card = document.createElement('form');
    card.className = `native-interaction native-interaction--${interaction.kind}`;
    card.dataset.interactionId = interaction.id;
    const head = document.createElement('div');
    head.className = 'native-interaction__head';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'native-interaction__eyebrow';
    eyebrow.textContent =
      interaction.kind === 'permission'
        ? '权限确认'
        : interaction.kind === 'question'
          ? '需要你的选择'
          : interaction.kind === 'plan'
            ? '实施计划'
            : 'MCP 请求';
    const title = document.createElement('strong');
    title.textContent = interaction.title;
    head.append(eyebrow, title);
    if ('description' in interaction && interaction.description) {
      const description = document.createElement('p');
      description.textContent = interaction.description;
      head.append(description);
    }
    card.append(head);

    let collectValues: (() => Record<string, unknown>) | undefined;
    if (interaction.kind === 'permission') {
      const payload = document.createElement('pre');
      payload.className = 'native-interaction__payload';
      payload.textContent = nativeJson(interaction.input);
      card.append(payload);
    } else if (interaction.kind === 'question') {
      collectValues = appendNativeQuestionFields(card, interaction.questions);
    } else if (interaction.kind === 'plan') {
      const plan = document.createElement('div');
      plan.className = 'chat-message__markdown native-interaction__plan';
      card.append(plan);
      void dependencies.getMarkdownRenderer().renderInto(plan, interaction.markdown);
      const expand = document.createElement('button');
      expand.className = 'button button--compact native-plan-expand';
      expand.type = 'button';
      expand.textContent = '全屏检查计划';
      expand.addEventListener('click', () => openNativePlanDialog(interaction));
      card.append(expand);
    } else if (interaction.mode === 'url' && interaction.url) {
      const payload = document.createElement('pre');
      payload.className = 'native-interaction__payload';
      payload.textContent = interaction.url;
      card.append(payload);
    } else {
      collectValues = appendNativeMcpFields(card, interaction.schema);
    }

    const actions = document.createElement('div');
    actions.className = 'native-interaction__actions';
    const cancel = nativeInteractionButton('取消', false, () => {
      void respondToNativeInteraction(interaction, { action: 'cancel' });
    });
    actions.append(cancel);
    if (interaction.kind === 'permission') {
      actions.append(
        nativeInteractionButton('拒绝', false, () => {
          void respondToNativeInteraction(interaction, { action: 'deny' });
        }),
      );
      if (interaction.allowRemember) {
        actions.append(
          nativeInteractionButton('允许并记住', false, () => {
            void respondToNativeInteraction(interaction, { action: 'allow', remember: true });
          }),
        );
      }
      actions.append(
        nativeInteractionButton('允许一次', true, () => {
          void respondToNativeInteraction(interaction, { action: 'allow' });
        }),
      );
    } else if (interaction.kind === 'plan') {
      actions.append(
        nativeInteractionButton('继续规划', false, () => {
          void respondToNativeInteraction(interaction, { action: 'deny', message: '继续完善计划' });
        }),
        nativeInteractionButton('批准计划', true, () => {
          void respondToNativeInteraction(interaction, { action: 'allow' });
        }),
      );
    } else {
      const submit = nativeInteractionButton('提交', true, () => undefined);
      submit.type = 'submit';
      actions.append(submit);
    }
    card.append(actions);
    card.addEventListener('submit', (event) => {
      event.preventDefault();
      void respondToNativeInteraction(interaction, {
        action: 'submit',
        values: collectValues?.() ?? {},
      });
    });
    return card;
  };

  return {
    closeNativePlanDialog,
    renderNativeInteraction,
    respondToNativeInteraction,
    setNativeConversationVisible,
  };
};
