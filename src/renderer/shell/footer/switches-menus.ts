import type {
  ClaudeModelOption,
  ClaudeModelOptions,
  ClaudePermissionMode,
  ModelSpeedMode,
} from '../../../shared/contracts';
import {
  footerMode,
  footerModeMenu,
  footerModel,
  footerModelMenu,
  footerSpeed,
  footerSpeedMenu,
} from './elements';
import type { FooterMenus } from './menus';
import type { FooterSwitchesDeps } from './switches-dependencies';

export interface FooterSwitchesMenusActions {
  openModelMenu: (trigger?: HTMLButtonElement) => Promise<void>;
  openSpeedMenu: () => void;
  openModeMenu: () => void;
}

export const createFooterSwitchesMenusActions = (
  deps: FooterSwitchesDeps,
  menus: FooterMenus,
  switchClaudeModel: (option: ClaudeModelOption) => Promise<void>,
  switchClaudeModelSpeed: (mode: ModelSpeedMode) => Promise<void>,
  switchPermissionMode: (mode: ClaudePermissionMode) => Promise<void>,
): FooterSwitchesMenusActions => {
  const {
    activeStatus,
    activeDevelopmentRuntime,
    claudeSpeedOperations,
    claudeStates,
    hasActiveConversation,
    openNativeModeMenu,
    openNativeModelMenu,
    openNativeSpeedMenu,
    showToast,
  } = deps;
  const {
    buildFooterMenuItem,
    buildFooterRadioMenuItem,
    modelSpeedFastLabel,
    openFooterMenu,
    permissionModeCatalog,
  } = menus;

  const openModelMenu = async (trigger = footerModel): Promise<void> => {
    if (hasActiveConversation()) {
      openNativeModelMenu();
      return;
    }
    const status = activeStatus();
    if (!status) {
      return;
    }

    let options: ClaudeModelOptions;
    try {
      options = await window.controlPanel.getClaudeModelOptions(status.id);
    } catch {
      showToast('无法读取可切换的模型列表。', 'error');
      return;
    }

    const running = claudeStates.get(status.id)?.active ?? false;
    footerModelMenu.replaceChildren(
      ...options.options.map((option) =>
        buildFooterMenuItem(
          option.model,
          option.requiresRelaunch
            ? option.relaunchReason === 'connection'
              ? `${option.providerLabel} · 更换接入，需重启会话`
              : `${option.providerLabel} · 速度配置不同，需重启会话`
            : option.providerLabel,
          option.model === options.activeModel,
          () => switchClaudeModel(option),
          !running,
          footerModel,
        ),
      ),
    );
    if (!running) {
      const hint = document.createElement('p');
      hint.className = 'footer-menu__hint';
      hint.textContent = '请先在工作台启动 Claude Code 会话。';
      footerModelMenu.append(hint);
    }
    openFooterMenu(footerModelMenu, trigger);
  };

  const openSpeedMenu = (): void => {
    if (hasActiveConversation()) {
      openNativeSpeedMenu();
      return;
    }
    const status = activeStatus();
    const state = status ? claudeStates.get(status.id) : undefined;
    if (!status || !state || activeDevelopmentRuntime() !== 'claude') {
      return;
    }

    const fastLabel = modelSpeedFastLabel(state);
    const fastDetail = state.speed.canSelectFast
      ? state.speed.mechanism === 'claude-native-fast'
        ? 'Claude Code 原生 Fast；仅支持已验证模型，单价可能更高，资格、额度和实际加速由 Anthropic 判定。'
        : '请求 service_tier=fast；额度消耗或计价可能更高，ClaudeDock 只显示"已请求"，除非上游返回结构化确认。'
      : state.speed.detail;
    const standardAlreadyApplied =
      state.speed.preference === 'standard' && state.speed.status === 'standard';
    const fastAlreadyApplied =
      state.speed.preference === 'fast' && state.speed.status !== 'not-active';
    const speedOperationActive = claudeSpeedOperations.isActive(status.id);
    footerSpeedMenu.replaceChildren(
      buildFooterRadioMenuItem(
        '标准速度',
        '默认档位；不启用 Claude Fast，也不发送 GPT 快速服务档请求。',
        state.speed.preference === 'standard',
        () => switchClaudeModelSpeed('standard'),
        speedOperationActive || standardAlreadyApplied,
        footerSpeed,
      ),
      buildFooterRadioMenuItem(
        fastLabel,
        fastDetail,
        state.speed.preference === 'fast',
        () => switchClaudeModelSpeed('fast'),
        speedOperationActive || !state.speed.canSelectFast || fastAlreadyApplied,
        footerSpeed,
      ),
    );

    const statusHint = document.createElement('p');
    statusHint.className = 'footer-menu__hint';
    statusHint.textContent = state.speed.detail;
    footerSpeedMenu.append(statusHint);
    const lifecycleHint = document.createElement('p');
    lifecycleHint.className = 'footer-menu__hint footer-menu__hint--separated';
    lifecycleHint.textContent = state.active
      ? '切换会重启当前 PowerShell，并用当前对话 UUID 精确恢复；不会压缩上下文。'
      : '当前会话未运行；选择后只保存此接入与模型的偏好，下次新建或恢复会话时生效。';
    footerSpeedMenu.append(lifecycleHint);
    openFooterMenu(footerSpeedMenu, footerSpeed);
  };

  const openModeMenu = (): void => {
    if (hasActiveConversation()) {
      openNativeModeMenu();
      return;
    }
    const status = activeStatus();
    if (!status) {
      return;
    }

    const state = claudeStates.get(status.id);
    const running = state?.active ?? false;
    footerModeMenu.replaceChildren(
      ...permissionModeCatalog.map((entry) =>
        buildFooterMenuItem(
          entry.label,
          entry.id === 'bypassPermissions' && !state?.allowBypassPermissions
            ? '当前项目未预置此模式，请在工作台开启后重新启动会话。'
            : entry.detail,
          entry.id === state?.permissionMode,
          () => switchPermissionMode(entry.id),
          !running ||
            (entry.id === 'bypassPermissions' && !state?.allowBypassPermissions) ||
            (!entry.needsRelaunch && entry.id === state?.permissionMode),
          footerMode,
        ),
      ),
    );
    if (!running) {
      const hint = document.createElement('p');
      hint.className = 'footer-menu__hint';
      hint.textContent = '请先在工作台启动 Claude Code 会话。';
      footerModeMenu.append(hint);
    }
    openFooterMenu(footerModeMenu, footerMode);
  };

  return {
    openModelMenu,
    openSpeedMenu,
    openModeMenu,
  };
};
