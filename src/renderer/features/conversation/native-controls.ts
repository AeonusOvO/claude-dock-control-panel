import type { ConversationControlUpdate } from '../../../shared/conversation/native';
import type { ConversationSnapshot } from '../../../shared/conversation/native';
import type { ConversationActionsDependencies } from './dependencies';
import type { ConversationState } from './state';
import {
  nativeEffortLabel,
  nativeFastDetail,
  nativePermissionDescription,
  nativePermissionLabel,
  type ConversationView,
} from './view';

export interface NativeControlActions {
  openNativeEffortMenu: () => void;
  openNativeModeMenu: () => void;
  openNativeModelMenu: () => void;
  openNativeSpeedMenu: () => void;
  updateNativeControls: (
    update: Omit<ConversationControlUpdate, 'expectedCapabilityRevision'>,
  ) => Promise<void>;
}

export const createNativeControlActions = (
  state: ConversationState,
  dependencies: ConversationActionsDependencies,
  view: ConversationView,
  renderNativeConversation: (snapshot: ConversationSnapshot) => void,
): NativeControlActions => {
  const updateNativeControls = async (
    update: Omit<ConversationControlUpdate, 'expectedCapabilityRevision'>,
  ): Promise<void> => {
    const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
    if (!snapshot?.capabilities || state.nativeControlsUpdating) return;
    const conversationId = state.activeNativeConversationId;
    state.nativeControlsUpdating = true;
    view.renderNativeFooter(snapshot);
    try {
      const result = await window.controlPanel.updateNativeConversationControls(conversationId, {
        ...update,
        expectedCapabilityRevision: snapshot.capabilities.revision,
      });
      if (!result.ok) {
        dependencies.showToast(
          dependencies.resultFailureMessage(result, '无法更新模型控制项。'),
          'error',
        );
        return;
      }
      // `ModelCapabilityProfile` lists which permission modes exist, not which one is active, so the
      // dispatched value is the only record of what ClaudeDock actually asked for.
      if (update.permissionMode)
        state.nativePermissionModes.set(conversationId, update.permissionMode);
      if (result.snapshot) renderNativeConversation(result.snapshot);
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '无法更新模型控制项。',
        'error',
      );
    } finally {
      state.nativeControlsUpdating = false;
      const latest = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
      if (latest) view.renderNativeFooter(latest);
    }
  };

  const switchNativeModel = async (modelId: string): Promise<void> => {
    const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
    const capability = snapshot?.capabilities;
    const target = capability?.models?.find((model) => model.id === modelId);
    if (!capability || !target) return;
    const currentEffort = capability.effort.requested ?? capability.effort.applied;
    const nextEffort =
      currentEffort && target.effortOptions.includes(currentEffort)
        ? currentEffort
        : target.effortOptions.includes('high')
          ? 'high'
          : target.effortOptions[0];
    const fastActive =
      capability.fast.state === 'requested' || capability.fast.state === 'confirmed';
    if (nextEffort !== currentEffort || (fastActive && !target.supportsFast)) {
      dependencies.showToast(
        `新模型不支持当前全部选项；将改为 ${nativeEffortLabel(nextEffort ?? 'auto')}${fastActive && !target.supportsFast ? '，并关闭 Fast' : ''}。`,
      );
    }
    await updateNativeControls({
      effort: nextEffort,
      fast: fastActive && target.supportsFast,
      model: target.id,
    });
  };

  const openNativeModelMenu = (): void => {
    const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
    const capability = snapshot?.capabilities;
    const models = capability?.models ?? [];
    dependencies.footerModelMenu.replaceChildren(
      ...models.map((model) =>
        dependencies.buildFooterRadioMenuItem(
          model.label,
          `${model.supportsFast ? '支持 Fast' : '不支持 Fast'} · ${model.attachments.image ? '支持图片' : (model.attachments.reason ?? '不支持图片')}`,
          model.id === capability?.model,
          () => switchNativeModel(model.id),
          state.nativeControlsUpdating || model.id === capability?.model,
          dependencies.footerModel,
        ),
      ),
    );
    if (models.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'footer-menu__hint';
      hint.textContent = capability
        ? '当前接入只暴露了一个模型。'
        : '原生会话尚未上报可用能力，请稍候。';
      dependencies.footerModelMenu.append(hint);
    }
    dependencies.openFooterMenu(dependencies.footerModelMenu, dependencies.footerModel);
  };

  const openNativeSpeedMenu = (): void => {
    const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
    const fast = snapshot?.capabilities?.fast;
    const active = fast?.state === 'requested' || fast?.state === 'confirmed';
    dependencies.footerSpeedMenu.replaceChildren(
      dependencies.buildFooterRadioMenuItem(
        '标准速度',
        '默认档位；不向上游请求 Fast。',
        Boolean(fast) && !active,
        () => updateNativeControls({ fast: false }),
        state.nativeControlsUpdating || !fast || fast.state === 'unavailable' || !active,
        dependencies.footerSpeed,
      ),
      dependencies.buildFooterRadioMenuItem(
        'Fast',
        fast ? nativeFastDetail(fast) : '原生会话尚未上报可用能力，请稍候。',
        active,
        () => updateNativeControls({ fast: true }),
        state.nativeControlsUpdating || !fast || fast.state === 'unavailable' || active,
        dependencies.footerSpeed,
      ),
    );
    if (fast) {
      const hint = document.createElement('p');
      hint.className = 'footer-menu__hint';
      hint.textContent = nativeFastDetail(fast);
      dependencies.footerSpeedMenu.append(hint);
    }
    dependencies.openFooterMenu(dependencies.footerSpeedMenu, dependencies.footerSpeed);
  };

  const openNativeModeMenu = (): void => {
    const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
    const capability = snapshot?.capabilities;
    const current = snapshot ? view.nativeActivePermissionMode(snapshot) : undefined;
    dependencies.footerModeMenu.replaceChildren(
      ...(capability?.permissionModes ?? []).map((mode) =>
        dependencies.buildFooterRadioMenuItem(
          nativePermissionLabel(mode),
          nativePermissionDescription(mode),
          mode === current,
          () => updateNativeControls({ permissionMode: mode }),
          state.nativeControlsUpdating || mode === current,
          dependencies.footerMode,
        ),
      ),
    );
    if (!capability || capability.permissionModes.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'footer-menu__hint';
      hint.textContent = '原生会话尚未上报可用能力，请稍候。';
      dependencies.footerModeMenu.append(hint);
    }
    dependencies.openFooterMenu(dependencies.footerModeMenu, dependencies.footerMode);
  };

  const openNativeEffortMenu = (): void => {
    const snapshot = state.nativeConversationSnapshots.get(state.activeNativeConversationId);
    const capability = snapshot?.capabilities;
    const current = capability?.effort.requested ?? capability?.effort.applied;
    dependencies.footerEffortMenu.replaceChildren(
      ...(capability?.effort.options ?? []).map((effort) =>
        dependencies.buildFooterRadioMenuItem(
          nativeEffortLabel(effort),
          effort === 'ultracode'
            ? '工作流编排；实际思考档位为 X-High，仅作用于当前会话。'
            : '当前模型声明支持的思考档位。',
          effort === current,
          () => updateNativeControls({ effort }),
          state.nativeControlsUpdating || effort === current,
          dependencies.footerEffort,
        ),
      ),
    );
    if (!capability || capability.effort.options.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'footer-menu__hint';
      hint.textContent = '原生会话尚未上报可用能力，请稍候。';
      dependencies.footerEffortMenu.append(hint);
    } else if (
      capability.effort.requested &&
      capability.effort.applied &&
      capability.effort.requested !== capability.effort.applied
    ) {
      const hint = document.createElement('p');
      hint.className = 'footer-menu__hint';
      hint.textContent = `已请求 ${nativeEffortLabel(capability.effort.requested)}，Claude Code 实际运行在 ${nativeEffortLabel(capability.effort.applied)}。`;
      dependencies.footerEffortMenu.append(hint);
    }
    dependencies.openFooterMenu(dependencies.footerEffortMenu, dependencies.footerEffort);
  };

  return {
    openNativeEffortMenu,
    openNativeModeMenu,
    openNativeModelMenu,
    openNativeSpeedMenu,
    updateNativeControls,
  };
};
