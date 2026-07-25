import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { OperationResult, TerminalPhase, TerminalStatus } from '../shared/contracts';
import './styles.css';

const requiredElement = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
};

const chooseDirectoryButton = requiredElement<HTMLButtonElement>('#choose-directory');
const clearTerminalButton = requiredElement<HTMLButtonElement>('#clear-terminal');
const currentPathElement = requiredElement<HTMLElement>('#current-path');
const currentPathContainer = requiredElement<HTMLElement>('.current-path');
const dropOverlay = requiredElement<HTMLElement>('#drop-overlay');
const dropZone = requiredElement<HTMLButtonElement>('#drop-zone');
const emptyState = requiredElement<HTMLElement>('#terminal-empty-state');
const footerStatus = requiredElement<HTMLElement>('#footer-status');
const restartButton = requiredElement<HTMLButtonElement>('#restart-terminal');
const runClaudeButton = requiredElement<HTMLButtonElement>('#run-claude');
const sessionDetail = requiredElement<HTMLElement>('#session-detail');
const sessionPid = requiredElement<HTMLElement>('#session-pid');
const statusPill = requiredElement<HTMLElement>('#status-pill');
const terminalContainer = requiredElement<HTMLElement>('#terminal');
const terminalProject = requiredElement<HTMLElement>('#terminal-project');
const titleStatus = requiredElement<HTMLElement>('#title-status');
const toast = requiredElement<HTMLElement>('#toast');
const toggleButton = requiredElement<HTMLButtonElement>('#toggle-terminal');
const toggleLabel = requiredElement<HTMLElement>('#toggle-terminal-label');

const terminal = new Terminal({
  allowProposedApi: false,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: 'bar',
  fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
  fontSize: 14,
  letterSpacing: 0.2,
  lineHeight: 1.28,
  scrollback: 10_000,
  theme: {
    background: '#050708',
    black: '#12171b',
    blue: '#66b8ff',
    brightBlack: '#67747d',
    brightBlue: '#8dcdff',
    brightCyan: '#8deaff',
    brightGreen: '#78efbc',
    brightMagenta: '#dcb9ff',
    brightRed: '#ff8792',
    brightWhite: '#ffffff',
    brightYellow: '#ffe38a',
    cursor: '#68dcff',
    cursorAccent: '#081016',
    cyan: '#64d8ff',
    foreground: '#e4edf1',
    green: '#51e6a6',
    magenta: '#c997ff',
    red: '#ff6b7a',
    selectionBackground: '#294653',
    white: '#d9e3e8',
    yellow: '#ffd66b',
  },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalContainer);

let currentStatus: TerminalStatus = {
  cwd: '',
  phase: 'stopped',
  shell: 'Windows PowerShell',
};
let dragDepth = 0;
let toastTimer: number | undefined;

const phaseCopy: Record<TerminalPhase, { detail: string; footer: string; pill: string }> = {
  error: {
    detail: '终端连接发生错误',
    footer: '需要处理',
    pill: '错误',
  },
  running: {
    detail: 'ConPTY 会话已连接',
    footer: '后台运行中',
    pill: '运行中',
  },
  starting: {
    detail: '正在创建 ConPTY 会话',
    footer: '正在连接',
    pill: '启动中',
  },
  stopped: {
    detail: 'PowerShell 会话已停止',
    footer: '后台待命',
    pill: '已停止',
  },
};

const showToast = (message: string, tone: 'error' | 'success' = 'success'): void => {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('toast--visible');
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('toast--visible');
  }, 3200);
};

const projectNameFromPath = (directoryPath: string): string => {
  const parts = directoryPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? 'PowerShell';
};

const renderStatus = (status: TerminalStatus): void => {
  currentStatus = status;
  const copy = phaseCopy[status.phase];

  document.body.dataset.phase = status.phase;
  titleStatus.textContent = copy.detail;
  statusPill.textContent = copy.pill;
  sessionDetail.textContent = status.message ?? copy.detail;
  sessionPid.textContent = status.pid ? `PID ${status.pid}` : 'PID —';
  footerStatus.textContent = copy.footer;
  toggleLabel.textContent = status.phase === 'running' ? '停止' : '启动';
  emptyState.classList.toggle('terminal-empty-state--hidden', status.phase !== 'stopped');

  if (status.cwd) {
    currentPathElement.textContent = status.cwd;
    currentPathContainer.title = status.cwd;
    terminalProject.textContent = projectNameFromPath(status.cwd);
  }
};

const handleOperation = (result: OperationResult, successMessage?: string): boolean => {
  renderStatus(result.status);
  if (!result.ok) {
    showToast(result.error ?? '操作失败，请重试。', 'error');
    return false;
  }
  if (successMessage) {
    showToast(successMessage);
  }
  return true;
};

const fitTerminal = (): void => {
  try {
    fitAddon.fit();
    window.controlPanel.resizeTerminal(terminal.cols, terminal.rows);
  } catch {
    // A resize can race with initial layout; the ResizeObserver will retry.
  }
};

const switchProject = async (directoryPath: string): Promise<void> => {
  dropZone.disabled = true;
  dropZone.classList.add('drop-zone--busy');
  const result = await window.controlPanel.changeDirectory(directoryPath);
  dropZone.disabled = false;
  dropZone.classList.remove('drop-zone--busy');

  if (
    handleOperation(
      result,
      result.ok ? `已定位到 ${projectNameFromPath(directoryPath)}` : undefined,
    )
  ) {
    terminal.clear();
    window.setTimeout(fitTerminal, 60);
  }
};

const openDirectoryPicker = async (): Promise<void> => {
  try {
    const choice = await window.controlPanel.chooseDirectory();
    if (!choice.canceled) {
      await switchProject(choice.path);
    }
  } catch {
    showToast('无法打开文件夹选择器。', 'error');
  }
};

terminal.onData((data) => {
  if (currentStatus.phase === 'running') {
    window.controlPanel.writeTerminal(data);
  }
});

terminal.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown') {
    return true;
  }

  if (event.ctrlKey && !event.shiftKey && event.code === 'KeyL') {
    terminal.clear();
    return false;
  }

  return true;
});

window.controlPanel.onTerminalData((data) => {
  terminal.write(data);
});
window.controlPanel.onTerminalStatus(renderStatus);

chooseDirectoryButton.addEventListener('click', () => {
  void openDirectoryPicker();
});
dropZone.addEventListener('click', () => {
  void openDirectoryPicker();
});
restartButton.addEventListener('click', async () => {
  const result = await window.controlPanel.restartTerminal(currentStatus.cwd || undefined);
  terminal.clear();
  handleOperation(result, result.ok ? 'PowerShell 已重启' : undefined);
});
toggleButton.addEventListener('click', async () => {
  if (currentStatus.phase === 'running') {
    handleOperation(await window.controlPanel.stopTerminal(), 'PowerShell 已停止');
  } else {
    handleOperation(
      await window.controlPanel.startTerminal(currentStatus.cwd || undefined),
      'PowerShell 已启动',
    );
    window.setTimeout(fitTerminal, 60);
  }
});
runClaudeButton.addEventListener('click', async () => {
  if (currentStatus.phase !== 'running') {
    const result = await window.controlPanel.startTerminal(currentStatus.cwd || undefined);
    if (!handleOperation(result)) {
      return;
    }
  }
  terminal.focus();
  window.controlPanel.writeTerminal('claude\r');
  showToast('已在当前项目运行 Claude Code');
});
clearTerminalButton.addEventListener('click', () => {
  terminal.clear();
  terminal.focus();
});

document.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.classList.add('drop-overlay--visible');
});
document.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
});
document.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropOverlay.classList.remove('drop-overlay--visible');
  }
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('drop-overlay--visible');

  const file = event.dataTransfer?.files[0];
  if (!file) {
    showToast('没有检测到文件夹。', 'error');
    return;
  }

  try {
    const directoryPath = window.controlPanel.getDroppedPath(file);
    if (!directoryPath) {
      showToast('无法读取拖入项目的路径。', 'error');
      return;
    }
    void switchProject(directoryPath);
  } catch {
    showToast('无法读取拖入项目的路径。', 'error');
  }
});

const resizeObserver = new ResizeObserver(() => {
  window.requestAnimationFrame(fitTerminal);
});
resizeObserver.observe(terminalContainer);

window.addEventListener('beforeunload', () => {
  resizeObserver.disconnect();
});

void (async () => {
  renderStatus(await window.controlPanel.getStatus());
  const result = await window.controlPanel.startTerminal(currentStatus.cwd || undefined);
  handleOperation(result);
  window.setTimeout(() => {
    fitTerminal();
    terminal.focus();
  }, 80);
})();
