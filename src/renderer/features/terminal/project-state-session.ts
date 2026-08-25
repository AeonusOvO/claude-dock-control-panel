import { projectNameFromPath, resultFailureMessage } from '../../platform/format';
import type { OperationResult, TerminalPhase, TerminalStatus } from '../../../shared/contracts';
import type { TerminalProjectStateDeps } from './project-state-dependencies';
import { renderRuntimePickerControls } from './project-state-runtime';
import {
  claudeWorkbench,
  emptyState,
  emptyStateHint,
  emptyStateTitle,
  footerStatus,
  runtimeActivityTrigger,
  terminalProject,
  titleStatus,
  workbenchScope,
  workbenchTabs,
  workbenchTitle,
  workbenchTrigger,
  workbenchTriggerLabel,
} from './project-state-dom';

export const phaseCopy: Record<TerminalPhase, { detail: string; footer: string; pill: string }> = {
  error: {
    detail: '终端连接发生错误',
    footer: '需要处理',
    pill: '错误',
  },
  running: {
    detail: 'PowerShell 已就绪',
    footer: '后台运行中',
    pill: '运行中',
  },
  starting: {
    detail: '正在准备 PowerShell',
    footer: '正在连接',
    pill: '启动中',
  },
  stopped: {
    detail: '终端会话已停止',
    footer: '后台待命',
    pill: '已停止',
  },
};

export interface TerminalSessionActions {
  applyTerminalStatus: (status: TerminalStatus) => void;
  handleOperation: (result: OperationResult, successMessage?: string) => boolean;
  renderActiveStatus: (status: TerminalStatus) => void;
  renderNoActiveSession: () => void;
}

export const createTerminalSessionActions = (
  deps: TerminalProjectStateDeps,
): TerminalSessionActions => {
  const {
    getWorkspaceState,
    showToast,
    setWorkbenchOpen,
    setRuntimeSummaryOpen,
    terminalFeature,
    projectsFeature,
    claudeLaunchAttempts,
  } = deps;

  const renderActiveStatus = (status: TerminalStatus): void => {
    const copy = phaseCopy[status.phase];
    const openFolders = getWorkspaceState().projects.filter((project) => project.open).length;

    document.body.dataset.phase = status.phase;
    titleStatus.textContent = `${copy.detail} · ${openFolders} 个项目 / ${getWorkspaceState().sessions.length} 个对话`;
    footerStatus.textContent = copy.footer;
    const terminalIsVisible = status.phase === 'running' || status.phase === 'starting';
    emptyStateTitle.textContent = '终端尚未运行';
    emptyStateHint.textContent = '点击左侧“启动”创建终端会话';
    emptyState.classList.toggle('terminal-empty-state--hidden', terminalIsVisible);
    emptyState.setAttribute('aria-hidden', String(terminalIsVisible));
    const displayedTitle = projectsFeature.displayedConversationTitle(status);
    const scopedTitle = `${projectNameFromPath(status.cwd)} · ${displayedTitle}`;
    const typing = String(projectsFeature.isTitleAnimating(status.id));
    terminalProject.textContent = scopedTitle;
    terminalProject.dataset.titleTyping = typing;
    terminalProject.title = status.cwd;
    workbenchScope.textContent = scopedTitle;
    workbenchScope.dataset.titleTyping = typing;
    renderRuntimePickerControls(deps, status.id);
    terminalFeature.renderControlStatus(status);
    const launchBusy = claudeLaunchAttempts.isBusy(status.id);
    terminalFeature.setComposerEnabled(status.phase === 'running' && !launchBusy);
    const terminal = terminalFeature.getTerminalView(status.id)?.terminal;
    if (terminal) {
      terminal.options.disableStdin = launchBusy;
    }
    if (status.phase === 'error') terminalFeature.showTerminalDiagnostic(status);
  };

  /**
   * With no conversation open there is nothing to describe — this is the real startup state now that
   * the app no longer invents a session in the home folder. The panel invites the user to pick a
   * project instead of reporting on one they never opened.
   */
  const renderNoActiveSession = (): void => {
    const rememberedCount = getWorkspaceState().projects.length;

    document.body.dataset.phase = 'stopped';
    titleStatus.textContent =
      rememberedCount > 0 ? `未打开对话 · ${rememberedCount} 个最近项目` : '未打开任何项目';
    footerStatus.textContent = '等待打开项目';
    emptyStateTitle.textContent = rememberedCount > 0 ? '选择一个项目继续' : '还没有项目';
    emptyStateHint.textContent =
      rememberedCount > 0
        ? '在左侧点击最近打开的项目，或添加新的项目文件夹'
        : '点击左侧“添加项目”选择一个文件夹';
    emptyState.classList.remove('terminal-empty-state--hidden');
    emptyState.setAttribute('aria-hidden', 'false');
    terminalProject.textContent = '未打开项目';
    terminalProject.title = '';
    terminalProject.dataset.titleTyping = 'false';
    workbenchScope.textContent = '未打开项目';
    workbenchScope.dataset.titleTyping = 'false';
    workbenchTabs.hidden = false;
    workbenchTitle.textContent = 'Claude 工作台';
    workbenchTriggerLabel.textContent = 'Claude 工作台';
    workbenchTrigger.title = 'Claude 工作台';
    claudeWorkbench.setAttribute('aria-label', 'Claude 可视化工作台');
    setWorkbenchOpen(false);
    renderRuntimePickerControls(deps);
    document.body.dataset.agentRuntime = 'claude';
    terminalFeature.renderControlStatus();
    terminalFeature.setComposerEnabled(false);
    runtimeActivityTrigger.hidden = false;
    setRuntimeSummaryOpen(false);
  };

  const applyTerminalStatus = (status: TerminalStatus): void => {
    const sessionIndex = getWorkspaceState().sessions.findIndex(
      (session) => session.id === status.id,
    );
    if (sessionIndex === -1) {
      return;
    }

    const sessions = [...getWorkspaceState().sessions];
    sessions[sessionIndex] = status;
    projectsFeature.renderWorkspace({ ...getWorkspaceState(), sessions });
  };

  const handleOperation = (result: OperationResult, successMessage?: string): boolean => {
    if (result.status) {
      applyTerminalStatus(result.status);
    }
    if (!result.ok) {
      showToast(resultFailureMessage(result, '操作失败，请重试。'), 'error');
      return false;
    }
    if (successMessage) {
      showToast(successMessage);
    }
    return true;
  };

  return {
    applyTerminalStatus,
    handleOperation,
    renderActiveStatus,
    renderNoActiveSession,
  };
};
