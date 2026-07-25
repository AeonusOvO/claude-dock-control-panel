import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type {
  OperationResult,
  TerminalPhase,
  TerminalStatus,
  WorkspaceResult,
  WorkspaceState,
} from '../shared/contracts';
import './styles.css';

interface TerminalView {
  container: HTMLDivElement;
  fitAddon: FitAddon;
  terminal: Terminal;
}

const requiredElement = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
};

const chooseDirectoryButton = requiredElement<HTMLButtonElement>('#choose-directory');
const brandLogo = requiredElement<HTMLImageElement>('#brand-logo');
const clearTerminalButton = requiredElement<HTMLButtonElement>('#clear-terminal');
const dropOverlay = requiredElement<HTMLElement>('#drop-overlay');
const dropZone = requiredElement<HTMLButtonElement>('#drop-zone');
const emptyState = requiredElement<HTMLElement>('#terminal-empty-state');
const footerStatus = requiredElement<HTMLElement>('#footer-status');
const projectCount = requiredElement<HTMLElement>('#project-count');
const projectList = requiredElement<HTMLElement>('#project-list');
const restartButton = requiredElement<HTMLButtonElement>('#restart-terminal');
const runClaudeButton = requiredElement<HTMLButtonElement>('#run-claude');
const sessionDetail = requiredElement<HTMLElement>('#session-detail');
const sessionPid = requiredElement<HTMLElement>('#session-pid');
const statusPill = requiredElement<HTMLElement>('#status-pill');
const terminalProject = requiredElement<HTMLElement>('#terminal-project');
const terminalStage = requiredElement<HTMLElement>('#terminal-stage');
const titleStatus = requiredElement<HTMLElement>('#title-status');
const toast = requiredElement<HTMLElement>('#toast');
const toggleButton = requiredElement<HTMLButtonElement>('#toggle-terminal');
const toggleLabel = requiredElement<HTMLElement>('#toggle-terminal-label');

brandLogo.src = new URL('../../assets/generated/app-icon-64.png', import.meta.url).href;

const terminalViews = new Map<string, TerminalView>();
let dragDepth = 0;
let toastTimer: number | undefined;
let workspaceState: WorkspaceState = {
  activeSessionId: '',
  sessions: [],
};

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

const terminalOptions = {
  allowProposedApi: false,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: 'bar' as const,
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
  return parts.at(-1) ?? directoryPath ?? 'PowerShell';
};

const activeStatus = (): TerminalStatus | undefined =>
  workspaceState.sessions.find((status) => status.id === workspaceState.activeSessionId);

const createTerminalView = (sessionId: string): TerminalView => {
  const container = document.createElement('div');
  container.className = 'project-terminal';
  container.dataset.sessionId = sessionId;
  terminalStage.prepend(container);

  const terminal = new Terminal(terminalOptions);
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  terminal.onData((data) => {
    const status = workspaceState.sessions.find((item) => item.id === sessionId);
    if (status?.phase === 'running') {
      window.controlPanel.writeTerminal(sessionId, data);
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

  const view = { container, fitAddon, terminal };
  terminalViews.set(sessionId, view);
  return view;
};

const ensureTerminalView = (sessionId: string): TerminalView =>
  terminalViews.get(sessionId) ?? createTerminalView(sessionId);

const fitActiveTerminal = (): void => {
  const view = terminalViews.get(workspaceState.activeSessionId);
  if (!view) {
    return;
  }

  try {
    view.fitAddon.fit();
    window.controlPanel.resizeTerminal(
      workspaceState.activeSessionId,
      view.terminal.cols,
      view.terminal.rows,
    );
  } catch {
    // A resize can race with initial layout; the ResizeObserver will retry.
  }
};

const renderActiveStatus = (status: TerminalStatus): void => {
  const copy = phaseCopy[status.phase];

  document.body.dataset.phase = status.phase;
  titleStatus.textContent = `${copy.detail} · ${workspaceState.sessions.length} 个项目`;
  statusPill.textContent = copy.pill;
  sessionDetail.textContent = status.message ?? copy.detail;
  sessionPid.textContent = status.pid ? `PID ${status.pid}` : 'PID —';
  footerStatus.textContent = copy.footer;
  toggleLabel.textContent = status.phase === 'running' ? '停止' : '启动';
  const terminalIsVisible = status.phase === 'running' || status.phase === 'starting';
  emptyState.classList.toggle('terminal-empty-state--hidden', terminalIsVisible);
  emptyState.setAttribute('aria-hidden', String(terminalIsVisible));
  terminalProject.textContent = projectNameFromPath(status.cwd);
  terminalProject.title = status.cwd;
};

const activateProject = async (sessionId: string): Promise<void> => {
  const result = await window.controlPanel.activateProject(sessionId);
  if (!result.ok) {
    showToast(result.error ?? '无法切换项目。', 'error');
    return;
  }
  renderWorkspace(result.state);
  window.setTimeout(() => {
    fitActiveTerminal();
    terminalViews.get(sessionId)?.terminal.focus();
  }, 40);
};

const closeProject = async (status: TerminalStatus): Promise<void> => {
  if (
    status.phase === 'running' &&
    !window.confirm(`关闭“${projectNameFromPath(status.cwd)}”会终止其 PowerShell 进程，是否继续？`)
  ) {
    return;
  }

  const result = await window.controlPanel.closeProject(status.id);
  if (!result.ok) {
    showToast(result.error ?? '无法关闭项目。', 'error');
    return;
  }
  renderWorkspace(result.state);
  showToast(`已关闭 ${projectNameFromPath(status.cwd)}`);
};

const renderProjectList = (): void => {
  projectList.replaceChildren();
  projectCount.textContent = `${workspaceState.sessions.length} 个会话`;

  for (const status of workspaceState.sessions) {
    const item = document.createElement('div');
    item.className = 'project-item';
    item.dataset.active = String(status.id === workspaceState.activeSessionId);
    item.dataset.phase = status.phase;
    item.dataset.sessionId = status.id;

    const selectButton = document.createElement('button');
    selectButton.className = 'project-item__select';
    selectButton.type = 'button';
    selectButton.title = status.cwd;
    selectButton.setAttribute('aria-pressed', String(status.id === workspaceState.activeSessionId));

    const indicator = document.createElement('span');
    indicator.className = 'project-item__status';
    indicator.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('span');
    copy.className = 'project-item__copy';

    const name = document.createElement('strong');
    name.textContent = projectNameFromPath(status.cwd);

    const directory = document.createElement('span');
    directory.textContent = status.cwd;

    copy.append(name, directory);
    selectButton.append(indicator, copy);
    selectButton.addEventListener('click', () => {
      void activateProject(status.id);
    });

    const closeButton = document.createElement('button');
    closeButton.className = 'project-item__close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.title = `关闭 ${projectNameFromPath(status.cwd)}`;
    closeButton.setAttribute('aria-label', `关闭项目 ${projectNameFromPath(status.cwd)}`);
    closeButton.addEventListener('click', () => {
      void closeProject(status);
    });

    item.append(selectButton, closeButton);
    projectList.append(item);
  }
};

function renderWorkspace(state: WorkspaceState): void {
  workspaceState = state;
  const validSessionIds = new Set(state.sessions.map((status) => status.id));

  for (const status of state.sessions) {
    const view = ensureTerminalView(status.id);
    view.container.classList.toggle(
      'project-terminal--active',
      status.id === state.activeSessionId,
    );
  }

  for (const [sessionId, view] of terminalViews) {
    if (!validSessionIds.has(sessionId)) {
      view.terminal.dispose();
      view.container.remove();
      terminalViews.delete(sessionId);
    }
  }

  renderProjectList();
  const status = activeStatus();
  if (status) {
    renderActiveStatus(status);
  }
  window.requestAnimationFrame(fitActiveTerminal);
}

const applyTerminalStatus = (status: TerminalStatus): void => {
  const sessionIndex = workspaceState.sessions.findIndex((session) => session.id === status.id);
  if (sessionIndex === -1) {
    return;
  }

  const sessions = [...workspaceState.sessions];
  sessions[sessionIndex] = status;
  renderWorkspace({ ...workspaceState, sessions });
};

const handleOperation = (result: OperationResult, successMessage?: string): boolean => {
  applyTerminalStatus(result.status);
  if (!result.ok) {
    showToast(result.error ?? '操作失败，请重试。', 'error');
    return false;
  }
  if (successMessage) {
    showToast(successMessage);
  }
  return true;
};

const handleWorkspaceResult = (result: WorkspaceResult, projectPath: string): boolean => {
  renderWorkspace(result.state);
  if (!result.ok) {
    showToast(result.error ?? '添加项目失败，请重试。', 'error');
    return false;
  }
  const name = projectNameFromPath(projectPath);
  showToast(result.reused ? `${name} 已经打开，已切换到该项目` : `已添加并启动 ${name}`);
  return true;
};

const addProject = async (directoryPath: string): Promise<void> => {
  dropZone.disabled = true;
  chooseDirectoryButton.disabled = true;
  dropZone.classList.add('drop-zone--busy');

  try {
    const result = await window.controlPanel.addProject(directoryPath);
    if (handleWorkspaceResult(result, directoryPath)) {
      window.setTimeout(() => {
        fitActiveTerminal();
        terminalViews.get(result.state.activeSessionId)?.terminal.focus();
      }, 60);
    }
  } finally {
    dropZone.disabled = false;
    chooseDirectoryButton.disabled = false;
    dropZone.classList.remove('drop-zone--busy');
  }
};

const openDirectoryPicker = async (): Promise<void> => {
  try {
    const choice = await window.controlPanel.chooseDirectory();
    if (!choice.canceled) {
      await addProject(choice.path);
    }
  } catch {
    showToast('无法打开文件夹选择器。', 'error');
  }
};

window.controlPanel.onTerminalData((sessionId, data) => {
  terminalViews.get(sessionId)?.terminal.write(data);
});
window.controlPanel.onWorkspaceState(renderWorkspace);

chooseDirectoryButton.addEventListener('click', () => {
  void openDirectoryPicker();
});
dropZone.addEventListener('click', () => {
  void openDirectoryPicker();
});
restartButton.addEventListener('click', async () => {
  const status = activeStatus();
  if (!status) {
    return;
  }
  const result = await window.controlPanel.restartTerminal(status.id);
  terminalViews.get(status.id)?.terminal.clear();
  handleOperation(result, result.ok ? 'PowerShell 已重启' : undefined);
});
toggleButton.addEventListener('click', async () => {
  const status = activeStatus();
  if (!status) {
    return;
  }

  if (status.phase === 'running') {
    handleOperation(await window.controlPanel.stopTerminal(status.id), 'PowerShell 已停止');
  } else {
    handleOperation(await window.controlPanel.startTerminal(status.id), 'PowerShell 已启动');
    window.setTimeout(fitActiveTerminal, 60);
  }
});
runClaudeButton.addEventListener('click', async () => {
  let status = activeStatus();
  if (!status) {
    return;
  }

  if (status.phase !== 'running') {
    const result = await window.controlPanel.startTerminal(status.id);
    if (!handleOperation(result)) {
      return;
    }
    status = result.status;
  }

  terminalViews.get(status.id)?.terminal.focus();
  window.controlPanel.writeTerminal(status.id, 'claude\r');
  showToast(`已在 ${projectNameFromPath(status.cwd)} 运行 Claude Code`);
});
clearTerminalButton.addEventListener('click', () => {
  const view = terminalViews.get(workspaceState.activeSessionId);
  view?.terminal.clear();
  view?.terminal.focus();
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
    void addProject(directoryPath);
  } catch {
    showToast('无法读取拖入项目的路径。', 'error');
  }
});

const resizeObserver = new ResizeObserver(() => {
  window.requestAnimationFrame(fitActiveTerminal);
});
resizeObserver.observe(terminalStage);

window.addEventListener('beforeunload', () => {
  resizeObserver.disconnect();
  for (const view of terminalViews.values()) {
    view.terminal.dispose();
  }
});

void (async () => {
  renderWorkspace(await window.controlPanel.getWorkspace());
  const status = activeStatus();
  if (!status) {
    return;
  }

  const result = await window.controlPanel.startTerminal(status.id);
  handleOperation(result);
  window.setTimeout(() => {
    fitActiveTerminal();
    terminalViews.get(status.id)?.terminal.focus();
  }, 80);
})();
