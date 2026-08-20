import type { ClaudePermissionMode } from '../../../shared/contracts';
import { footerMode } from './elements';
import { footerState } from './state';
import type { FooterSwitchesDeps } from './switches-dependencies';

export interface FooterSwitchesModeActions {
  switchPermissionMode: (mode: ClaudePermissionMode) => Promise<void>;
}

export const createFooterSwitchesModeActions = (
  deps: FooterSwitchesDeps,
): FooterSwitchesModeActions => {
  const {
    activeStatus,
    beginTerminalMask,
    loadClaudeState,
    relaunchClaudeSession,
    renderClaudeState,
    requestConfirmation,
    resultFailureMessage,
    showToast,
  } = deps;

  const switchPermissionMode = async (mode: ClaudePermissionMode): Promise<void> => {
    const status = activeStatus();
    if (!status || footerState.modeSwitchInProgress) {
      return;
    }
    if (mode === 'dontAsk' || mode === 'bypassPermissions') {
      const confirmed = await requestConfirmation({
        confirmLabel: mode === 'bypassPermissions' ? '确认完全允许' : '确认仅预批准',
        message:
          mode === 'bypassPermissions'
            ? '"完全允许"会跳过 Claude 的权限确认。仅在你信任当前项目及其指令时启用。'
            : '"仅预批准"会重启并恢复当前会话，未预先批准的工具请求将直接被拒绝。确认继续吗？',
        title: mode === 'bypassPermissions' ? '确认高风险权限模式' : '确认严格权限模式',
        tone: 'danger',
      });
      if (!confirmed) {
        return;
      }
    }
    if (mode === 'dontAsk') {
      await relaunchClaudeSession('「仅预批准」只能在会话启动时设定。', {
        permissionMode: mode,
      });
      return;
    }

    footerState.modeSwitchInProgress = true;
    footerMode.disabled = true;
    const endMask = beginTerminalMask(status.id, '正在切换权限模式');
    try {
      const result = await window.controlPanel.setClaudePermissionMode(status.id, mode);
      renderClaudeState(result.state);
      if (!result.ok) {
        showToast(resultFailureMessage(result, '无法切换权限模式。'), 'error');
      }
    } catch {
      showToast('切换权限模式时发生异常。', 'error');
    } finally {
      endMask();
      footerState.modeSwitchInProgress = false;
      void loadClaudeState(status.id);
    }
  };

  return {
    switchPermissionMode,
  };
};
