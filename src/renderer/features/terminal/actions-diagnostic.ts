import type { TerminalStatus } from '../../../shared/contracts';
import type { TerminalActionsDependencies } from './actions-dependencies';
import type { TerminalElements } from './elements';
import type { TerminalState } from './state';
import type { TerminalViews } from './terminal-views';

export interface TerminalDiagnosticActions {
  showTerminalDiagnostic: (status: TerminalStatus) => void;
}

export const createTerminalDiagnosticActions = (
  state: TerminalState,
  elements: TerminalElements,
  dependencies: TerminalActionsDependencies,
  views: TerminalViews,
): TerminalDiagnosticActions => {
  const setTerminalDiagnosticOpen = (open: boolean): void => {
    if (state.terminalDiagnosticCloseTimer !== undefined) {
      window.clearTimeout(state.terminalDiagnosticCloseTimer);
      state.terminalDiagnosticCloseTimer = undefined;
    }
    if (open) {
      elements.terminalDiagnostic.hidden = false;
      elements.terminalDiagnosticScrim.hidden = false;
      elements.terminalDiagnostic.dataset.state = 'opening';
      elements.terminalDiagnosticScrim.dataset.state = 'opening';
      elements.terminalDiagnostic.setAttribute('aria-hidden', 'false');
      window.requestAnimationFrame(() => {
        elements.terminalDiagnostic.dataset.state = 'open';
        elements.terminalDiagnosticScrim.dataset.state = 'open';
      });
      elements.terminalDiagnosticRetry.focus({ preventScroll: true });
      return;
    }
    if (elements.terminalDiagnostic.hidden) return;
    elements.terminalDiagnostic.dataset.state = 'closing';
    elements.terminalDiagnosticScrim.dataset.state = 'closing';
    elements.terminalDiagnostic.setAttribute('aria-hidden', 'true');
    state.terminalDiagnosticCloseTimer = window.setTimeout(() => {
      elements.terminalDiagnostic.hidden = true;
      elements.terminalDiagnosticScrim.hidden = true;
      elements.terminalDiagnostic.dataset.state = 'closed';
      elements.terminalDiagnosticScrim.dataset.state = 'closed';
      state.terminalDiagnosticCloseTimer = undefined;
    }, 220);
  };

  const showTerminalDiagnostic = (status: TerminalStatus): void => {
    const key = `${status.id}:${status.ptyGeneration}`;
    if (state.shownTerminalDiagnostics.has(key)) return;
    state.shownTerminalDiagnostics.add(key);
    state.terminalDiagnosticStatus = status;
    elements.terminalDiagnosticMessage.textContent = status.message ?? '项目终端启动失败。';
    elements.terminalDiagnosticResult.hidden = true;
    elements.terminalDiagnosticResult.replaceChildren();
    setTerminalDiagnosticOpen(true);
  };

  elements.terminalDiagnosticScrim.addEventListener('click', () =>
    setTerminalDiagnosticOpen(false),
  );
  elements.terminalDiagnosticRun.addEventListener('click', () => {
    const status = state.terminalDiagnosticStatus;
    if (!status) return;
    const diagnosis = (
      {
        CWD_UNAVAILABLE: ['项目目录', '不可访问', '检查磁盘连接，或重新添加项目目录。'],
        NATIVE_BACKEND_UNAVAILABLE: [
          '终端组件',
          '加载失败',
          '先重试；若仍失败，请重新安装当前 ClaudeDock 版本。',
        ],
        POWERSHELL_UNAVAILABLE: [
          'PowerShell',
          '不可用',
          '确认 Windows PowerShell 可启动后再重新连接。',
        ],
        PTY_START_FAILED: ['终端启动', '未完成', '关闭占用项目目录的程序后重试。'],
      } as const
    )[status.diagnosticCode ?? 'PTY_START_FAILED'];
    const title = document.createElement('strong');
    title.textContent = `${diagnosis[0]} · ${diagnosis[1]}`;
    const detail = document.createElement('p');
    detail.textContent = diagnosis[2];
    elements.terminalDiagnosticResult.replaceChildren(title, detail);
    elements.terminalDiagnosticResult.hidden = false;
  });
  elements.terminalDiagnosticCopy.addEventListener('click', () => {
    const status = state.terminalDiagnosticStatus;
    if (!status) return;
    const report = [
      'ClaudeDock 终端诊断',
      `类别: ${status.diagnosticCode ?? 'PTY_START_FAILED'}`,
      `项目: ${dependencies.projectNameFromPath(status.cwd)}`,
      `会话代次: ${status.ptyGeneration}`,
      `Windows build: ${dependencies.getWindowsBuildNumber() ?? 'unknown'}`,
    ].join('\n');
    void window.controlPanel
      .writeClipboardText(report)
      .then(() => dependencies.showToast('已复制脱敏诊断信息。'))
      .catch(() => dependencies.showToast('无法复制诊断信息。', 'error'));
  });
  elements.terminalDiagnosticRetry.addEventListener('click', () => {
    const status = state.terminalDiagnosticStatus;
    if (!status) return;
    elements.terminalDiagnosticRetry.disabled = true;
    void window.controlPanel
      .restartTerminal(status.id, status.ptyGeneration)
      .then((result) => {
        if (!dependencies.handleOperation(result, result.ok ? '项目终端已重新连接' : undefined))
          return;
        setTerminalDiagnosticOpen(false);
        views.retryTerminalFitUntilMeasured();
      })
      .finally(() => {
        elements.terminalDiagnosticRetry.disabled = false;
      });
  });

  return {
    showTerminalDiagnostic,
  };
};
