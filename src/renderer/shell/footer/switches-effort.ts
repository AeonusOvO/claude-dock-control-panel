import {
  CLAUDE_EFFORT_OPTIONS,
  isClaudeEffortSafeAfterThinkingDisabledError,
} from '../../../shared/claude/effort';
import type { ClaudeEffortRequest } from '../../../shared/contracts';
import { footerEffort, footerEffortMenu } from './elements';
import type { FooterMenus } from './menus';
import { footerState } from './state';
import type { FooterSwitchesDeps } from './switches-dependencies';

export interface FooterSwitchesEffortActions {
  switchEffortLevel: (effort: ClaudeEffortRequest) => Promise<void>;
  openEffortMenu: () => void;
}

export const createFooterSwitchesEffortActions = (
  deps: FooterSwitchesDeps,
  menus: FooterMenus,
): FooterSwitchesEffortActions => {
  const {
    activeStatus,
    beginTerminalMask,
    claudeStates,
    hasActiveConversation,
    loadClaudeState,
    openNativeEffortMenu,
    renderClaudeState,
    resultFailureMessage,
    showToast,
  } = deps;
  const { buildFooterMenuItem, openFooterMenu } = menus;

  /**
   * `/effort` lands inside the running conversation, so every level — including the session-only
   * `max` and `ultracode` — applies without a relaunch.
   */
  const switchEffortLevel = async (effort: ClaudeEffortRequest): Promise<void> => {
    const status = activeStatus();
    if (!status || footerState.effortSwitchInProgress) {
      return;
    }

    footerState.effortSwitchInProgress = true;
    footerEffort.disabled = true;
    footerEffort.setAttribute('aria-busy', 'true');
    const endMask = beginTerminalMask(status.id, '正在调整思考程度');
    try {
      const result = await window.controlPanel.setClaudeEffortLevel(status.id, effort);
      renderClaudeState(result.state);
      if (!result.ok) {
        showToast(resultFailureMessage(result, '无法调整思考程度。'), 'error');
      }
    } catch {
      showToast('调整思考程度时发生异常。', 'error');
    } finally {
      endMask();
      footerState.effortSwitchInProgress = false;
      footerEffort.disabled = false;
      footerEffort.setAttribute('aria-busy', 'false');
      const knownState = claudeStates.get(status.id);
      if (knownState) {
        renderClaudeState(knownState, true, false);
      }
      void loadClaudeState(status.id);
    }
  };

  const openEffortMenu = (): void => {
    if (hasActiveConversation()) {
      openNativeEffortMenu();
      return;
    }
    const status = activeStatus();
    if (!status) {
      return;
    }

    const state = claudeStates.get(status.id);
    const running = state?.active ?? false;
    const compatibility = state?.effortCompatibility;
    // Ultra is a workflow preset whose applied X-High value must not erase the requested identity.
    const current =
      state?.effortRequest === 'ultracode'
        ? 'ultracode'
        : compatibility?.recovery === 'recovered'
          ? (state?.effortRequest ?? state?.metrics?.effortLevel)
          : (state?.metrics?.effortLevel ?? state?.effortRequest);
    footerEffortMenu.replaceChildren(
      ...CLAUDE_EFFORT_OPTIONS.map((option) =>
        buildFooterMenuItem(
          option.label,
          compatibility && !isClaudeEffortSafeAfterThinkingDisabledError(option.id)
            ? `${option.detail} 当前会话已检测到 thinking 兼容错误，此档位暂不可用。`
            : option.detail,
          option.id === current,
          () => switchEffortLevel(option.id),
          !running ||
            Boolean(compatibility && !isClaudeEffortSafeAfterThinkingDisabledError(option.id)),
          footerEffort,
        ),
      ),
    );
    if (!running) {
      const hint = document.createElement('p');
      hint.className = 'footer-menu__hint';
      hint.textContent = '请先在工作台启动 Claude Code 会话。';
      footerEffortMenu.append(hint);
    } else if (compatibility) {
      const hint = document.createElement('p');
      hint.className = 'footer-menu__hint';
      hint.textContent =
        compatibility.recovery === 'pending'
          ? '检测到高档思考与 thinking 关闭冲突，正在自动切换到"均衡"…'
          : compatibility.recovery === 'recovered'
            ? '已临时切到"均衡"；请重试刚才的搜索，成功后会自动恢复原思考档位。'
            : '自动切换失败；请手动选择"均衡"或更低档位后重试。';
      footerEffortMenu.append(hint);
    } else if (state?.metrics?.effortLevel === undefined) {
      const hint = document.createElement('p');
      hint.className = 'footer-menu__hint';
      hint.textContent = '当前模型没有上报思考档位，可能不支持该参数；选择后仍会按所选档位下发。';
      footerEffortMenu.append(hint);
    }
    openFooterMenu(footerEffortMenu, footerEffort);
  };

  return {
    switchEffortLevel,
    openEffortMenu,
  };
};
