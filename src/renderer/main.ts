import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type {
  ClaudeLaunchMode,
  ClaudePreset,
  ClaudeProjectState,
  SaveClaudeConfigInput,
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
const claudeAuthMode = requiredElement<HTMLSelectElement>('#claude-auth-mode');
const claudeBaseUrl = requiredElement<HTMLInputElement>('#claude-base-url');
const claudeConfigForm = requiredElement<HTMLFormElement>('#claude-config-form');
const claudeCredential = requiredElement<HTMLInputElement>('#claude-credential');
const claudeInstallationDetail = requiredElement<HTMLElement>('#claude-installation-detail');
const claudeInstallationTitle = requiredElement<HTMLElement>('#claude-installation-title');
const claudeLiveIndicator = requiredElement<HTMLElement>('#claude-live-indicator');
const claudeModel = requiredElement<HTMLInputElement>('#claude-model');
const claudePreset = requiredElement<HTMLSelectElement>('#claude-preset');
const claudeRouteEndpoint = requiredElement<HTMLElement>('#claude-route-endpoint');
const claudeRouteModel = requiredElement<HTMLElement>('#claude-route-model');
const claudeRouteName = requiredElement<HTMLElement>('#claude-route-name');
const claudeRuntimeWarning = requiredElement<HTMLElement>('#claude-runtime-warning');
const claudeSecurityBanner = requiredElement<HTMLElement>('#claude-security-banner');
const claudeWorkbench = requiredElement<HTMLElement>('#claude-workbench');
const brandLogo = requiredElement<HTMLImageElement>('#brand-logo');
const baseUrlField = requiredElement<HTMLElement>('#base-url-field');
const clearTerminalButton = requiredElement<HTMLButtonElement>('#clear-terminal');
const clearCredentialButton = requiredElement<HTMLButtonElement>('#clear-credential');
const commandArgument = requiredElement<HTMLInputElement>('#command-argument');
const contextPercentage = requiredElement<HTMLElement>('#context-percentage');
const contextProgress = requiredElement<HTMLElement>('.context-progress');
const contextProgressBar = requiredElement<HTMLElement>('#context-progress-bar');
const contextSize = requiredElement<HTMLElement>('#context-size');
const contextUsed = requiredElement<HTMLElement>('#context-used');
const credentialField = requiredElement<HTMLElement>('#credential-field');
const credentialStatus = requiredElement<HTMLElement>('#credential-status');
const dropOverlay = requiredElement<HTMLElement>('#drop-overlay');
const dropZone = requiredElement<HTMLButtonElement>('#drop-zone');
const emptyState = requiredElement<HTMLElement>('#terminal-empty-state');
const footerStatus = requiredElement<HTMLElement>('#footer-status');
const launchContinueButton = requiredElement<HTMLButtonElement>('#launch-continue');
const launchNewButton = requiredElement<HTMLButtonElement>('#launch-new');
const launchResumeButton = requiredElement<HTMLButtonElement>('#launch-resume');
const metricCost = requiredElement<HTMLElement>('#metric-cost');
const metricDuration = requiredElement<HTMLElement>('#metric-duration');
const metricInput = requiredElement<HTMLElement>('#metric-input');
const metricModel = requiredElement<HTMLElement>('#metric-model');
const metricOutput = requiredElement<HTMLElement>('#metric-output');
const metricSession = requiredElement<HTMLElement>('#metric-session');
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
const workbenchClose = requiredElement<HTMLButtonElement>('#workbench-close');
const workbenchScrim = requiredElement<HTMLButtonElement>('#workbench-scrim');
const workbenchTrigger = requiredElement<HTMLButtonElement>('#workbench-trigger');

brandLogo.src = new URL('../../assets/generated/app-icon-64.png', import.meta.url).href;

const terminalViews = new Map<string, TerminalView>();
const claudeStates = new Map<string, ClaudeProjectState>();
let dragDepth = 0;
let claudeRequestGeneration = 0;
let configFormSessionId = '';
let lastClaudeSessionId = '';
let launchInProgress = false;
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

const formatTokenCount = (value: number | undefined): string => {
  if (value === undefined) {
    return '—';
  }
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: value >= 1000 ? 'compact' : 'standard',
  }).format(value);
};

const formatDuration = (milliseconds: number | undefined): string => {
  if (milliseconds === undefined) {
    return '—';
  }
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes} 分`;
  }
  return `${Math.floor(totalMinutes / 60)} 时 ${totalMinutes % 60} 分`;
};

const setAuthOptions = (
  options: Array<{ label: string; value: SaveClaudeConfigInput['authMode'] }>,
  selected?: SaveClaudeConfigInput['authMode'],
): void => {
  claudeAuthMode.replaceChildren();
  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    claudeAuthMode.append(element);
  }
  if (selected && options.some((option) => option.value === selected)) {
    claudeAuthMode.value = selected;
  }
};

const applyPresetUi = (preset: ClaudePreset, preserveValues: boolean): void => {
  const isOfficial = preset === 'anthropic';
  baseUrlField.hidden = isOfficial;
  if (isOfficial) {
    setAuthOptions(
      [
        { label: '使用 Claude Code 现有登录', value: 'existing' },
        { label: 'API Key（X-Api-Key）', value: 'apiKey' },
      ],
      preserveValues ? (claudeAuthMode.value as SaveClaudeConfigInput['authMode']) : 'existing',
    );
    if (!preserveValues) {
      claudeBaseUrl.value = '';
      claudeModel.value = 'default';
    }
  } else {
    setAuthOptions(
      [
        { label: 'API Key（X-Api-Key）', value: 'apiKey' },
        { label: 'Bearer Token（Authorization）', value: 'authToken' },
        { label: '无需认证（仅建议本机网关）', value: 'none' },
      ],
      preserveValues
        ? (claudeAuthMode.value as SaveClaudeConfigInput['authMode'])
        : preset === 'deepseek'
          ? 'apiKey'
          : 'apiKey',
    );
    if (!preserveValues && preset === 'deepseek') {
      claudeBaseUrl.value = 'http://127.0.0.1:4000';
      claudeModel.value = 'deepseek-chat';
    } else if (!preserveValues && claudeModel.value === 'default') {
      claudeModel.value = '';
    }
  }
  credentialField.hidden = claudeAuthMode.value === 'existing' || claudeAuthMode.value === 'none';
};

const populateClaudeConfigForm = (state: ClaudeProjectState): void => {
  const { config } = state;
  claudePreset.value = config.preset;
  applyPresetUi(config.preset, false);
  claudeBaseUrl.value = config.baseUrl;
  claudeModel.value = config.model;
  claudeAuthMode.value = config.authMode;
  credentialField.hidden = config.authMode === 'existing' || config.authMode === 'none';
  claudeCredential.value = '';
  credentialStatus.textContent = config.credentialConfigured
    ? '已使用 Windows 安全存储加密保存；留空将继续使用'
    : '当前项目未保存凭据';
  clearCredentialButton.disabled = !config.credentialConfigured;
  configFormSessionId = state.sessionId;
};

const renderClaudeState = (state: ClaudeProjectState): void => {
  claudeStates.set(state.sessionId, state);
  if (state.sessionId !== workspaceState.activeSessionId) {
    return;
  }

  const { config, installation, metrics } = state;
  const installationReady = installation.security === 'ready';
  claudeSecurityBanner.dataset.tone = installationReady
    ? 'ready'
    : installation.security === 'unknown'
      ? 'checking'
      : 'blocked';
  claudeInstallationTitle.textContent = installationReady
    ? `安全版本 · ${installation.version ?? '已识别'}`
    : installation.installed
      ? '需要更新 Claude Code'
      : '未找到 Claude Code';
  claudeInstallationDetail.textContent = installation.message;

  claudeRouteName.textContent =
    config.provider === 'anthropic'
      ? 'Anthropic 官方'
      : config.preset === 'deepseek'
        ? 'DeepSeek · 兼容网关'
        : 'Anthropic 兼容网关';
  claudeRouteModel.textContent = config.model;
  claudeRouteEndpoint.textContent =
    config.provider === 'anthropic'
      ? config.authMode === 'existing'
        ? '使用官方登录与默认端点'
        : '使用官方 API Key 与默认端点'
      : config.baseUrl;

  claudeLiveIndicator.dataset.active = String(state.active);
  claudeLiveIndicator.textContent = state.active ? '实时同步' : '未运行';
  const used = metrics?.contextWindowUsed;
  const size = metrics?.contextWindowSize;
  const percentage =
    used !== undefined && size ? Math.min(100, Math.max(0, (used / size) * 100)) : undefined;
  contextPercentage.textContent =
    percentage === undefined ? '等待首个响应' : `${percentage.toFixed(1)}%`;
  contextProgressBar.style.width = `${percentage ?? 0}%`;
  contextProgress.setAttribute('aria-valuenow', String(Math.round(percentage ?? 0)));
  contextProgress.dataset.level =
    percentage !== undefined && percentage >= 85
      ? 'danger'
      : percentage !== undefined && percentage >= 65
        ? 'warning'
        : 'normal';
  contextUsed.textContent = `${formatTokenCount(used)} 已用`;
  contextSize.textContent = `窗口 ${formatTokenCount(size)}`;

  metricInput.textContent = formatTokenCount(metrics?.inputTokens);
  metricOutput.textContent = formatTokenCount(metrics?.outputTokens);
  metricCost.textContent =
    metrics?.sessionCostUsd === undefined ? '—' : `$${metrics.sessionCostUsd.toFixed(4)}`;
  metricDuration.textContent = formatDuration(metrics?.sessionDurationMs);
  metricModel.textContent = metrics?.modelDisplayName ?? metrics?.modelId ?? '等待状态行';
  metricModel.title = metrics?.modelId ?? '';
  metricSession.textContent = metrics?.sessionName ?? metrics?.sessionId ?? '新会话尚未创建';
  metricSession.title = metrics?.sessionId ?? '';

  claudeRuntimeWarning.hidden = !state.warning;
  claudeRuntimeWarning.textContent = state.warning ?? '';
  for (const button of [launchNewButton, launchContinueButton, launchResumeButton]) {
    button.disabled = launchInProgress || !installationReady;
  }

  if (configFormSessionId !== state.sessionId) {
    populateClaudeConfigForm(state);
  }
};

const loadClaudeState = async (sessionId: string): Promise<void> => {
  const generation = ++claudeRequestGeneration;
  try {
    const state = await window.controlPanel.getClaudeProjectState(sessionId);
    if (generation === claudeRequestGeneration) {
      renderClaudeState(state);
    }
  } catch {
    if (generation === claudeRequestGeneration) {
      showToast('无法读取 Claude 工作台状态。', 'error');
    }
  }
};

const setWorkbenchOpen = (open: boolean): void => {
  claudeWorkbench.classList.toggle('claude-workbench--open', open);
  claudeWorkbench.setAttribute('aria-hidden', String(!open));
  workbenchScrim.classList.toggle('workbench-scrim--visible', open);
  workbenchTrigger.setAttribute('aria-expanded', String(open));
  if (open && workspaceState.activeSessionId) {
    void loadClaudeState(workspaceState.activeSessionId);
  }
};

const selectWorkbenchPage = (page: string): void => {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-workbench-tab]')) {
    tab.classList.toggle('workbench-tab--active', tab.dataset.workbenchTab === page);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-workbench-page]')) {
    panel.classList.toggle('workbench-page--active', panel.dataset.workbenchPage === page);
  }
};

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
  for (const sessionId of claudeStates.keys()) {
    if (!validSessionIds.has(sessionId)) {
      claudeStates.delete(sessionId);
    }
  }

  renderProjectList();
  const status = activeStatus();
  if (status) {
    renderActiveStatus(status);
  }
  if (state.activeSessionId !== lastClaudeSessionId) {
    lastClaudeSessionId = state.activeSessionId;
    configFormSessionId = '';
    const knownClaudeState = claudeStates.get(state.activeSessionId);
    if (knownClaudeState) {
      renderClaudeState(knownClaudeState);
    } else if (state.activeSessionId) {
      void loadClaudeState(state.activeSessionId);
    }
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

const launchClaude = async (mode: ClaudeLaunchMode): Promise<void> => {
  const status = activeStatus();
  if (!status || launchInProgress) {
    return;
  }

  launchInProgress = true;
  const existingState = claudeStates.get(status.id);
  if (existingState) {
    renderClaudeState(existingState);
  }
  try {
    terminalViews.get(status.id)?.terminal.clear();
    const result = await window.controlPanel.launchClaude(status.id, mode);
    renderClaudeState(result.state);
    if (!result.ok) {
      showToast(result.error ?? '无法启动 Claude Code。', 'error');
      return;
    }
    showToast(
      mode === 'new'
        ? `已在 ${projectNameFromPath(status.cwd)} 启动新会话`
        : mode === 'continue'
          ? '正在续接当前项目最近的会话'
          : '已打开当前项目的历史会话选择器',
    );
    terminalViews.get(status.id)?.terminal.focus();
  } catch {
    showToast('无法启动 Claude Code。', 'error');
  } finally {
    launchInProgress = false;
    const latest = claudeStates.get(status.id);
    if (latest) {
      renderClaudeState(latest);
    }
  }
};

const currentConfigInput = (
  credentialAction: SaveClaudeConfigInput['credentialAction'],
): SaveClaudeConfigInput => {
  const preset = claudePreset.value as ClaudePreset;
  return {
    authMode: claudeAuthMode.value as SaveClaudeConfigInput['authMode'],
    baseUrl: claudeBaseUrl.value,
    credential: claudeCredential.value,
    credentialAction,
    model: claudeModel.value,
    preset,
    provider: preset === 'anthropic' ? 'anthropic' : 'gateway',
  };
};

const saveClaudeConfig = async (
  credentialAction: SaveClaudeConfigInput['credentialAction'],
): Promise<void> => {
  const status = activeStatus();
  if (!status) {
    return;
  }
  const submitButton = requiredElement<HTMLButtonElement>('#save-claude-config');
  submitButton.disabled = true;
  try {
    const action =
      credentialAction === 'keep' && claudeCredential.value.trim() ? 'replace' : credentialAction;
    const result = await window.controlPanel.saveClaudeConfig(
      status.id,
      currentConfigInput(action),
    );
    renderClaudeState(result.state);
    if (!result.ok) {
      showToast(result.error ?? '无法保存接入配置。', 'error');
      return;
    }
    populateClaudeConfigForm(result.state);
    showToast('当前项目的模型与 API 接入已保存');
  } catch {
    showToast('无法保存接入配置。', 'error');
  } finally {
    submitButton.disabled = false;
  }
};

window.controlPanel.onTerminalData((sessionId, data) => {
  terminalViews.get(sessionId)?.terminal.write(data);
});
window.controlPanel.onClaudeState(renderClaudeState);
window.controlPanel.onWorkspaceState(renderWorkspace);

chooseDirectoryButton.addEventListener('click', () => {
  void openDirectoryPicker();
});
dropZone.addEventListener('click', () => {
  void openDirectoryPicker();
});
runClaudeButton.addEventListener('click', () => {
  setWorkbenchOpen(true);
  selectWorkbenchPage('session');
});
workbenchTrigger.addEventListener('click', () => {
  setWorkbenchOpen(!claudeWorkbench.classList.contains('claude-workbench--open'));
});
workbenchClose.addEventListener('click', () => {
  setWorkbenchOpen(false);
});
workbenchScrim.addEventListener('click', () => {
  setWorkbenchOpen(false);
});
for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-workbench-tab]')) {
  tab.addEventListener('click', () => {
    selectWorkbenchPage(tab.dataset.workbenchTab ?? 'session');
  });
}
launchNewButton.addEventListener('click', () => {
  void launchClaude('new');
});
launchContinueButton.addEventListener('click', () => {
  void launchClaude('continue');
});
launchResumeButton.addEventListener('click', () => {
  void launchClaude('resume');
});
claudePreset.addEventListener('change', () => {
  applyPresetUi(claudePreset.value as ClaudePreset, false);
});
claudeAuthMode.addEventListener('change', () => {
  credentialField.hidden = claudeAuthMode.value === 'existing' || claudeAuthMode.value === 'none';
});
claudeConfigForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveClaudeConfig('keep');
});
clearCredentialButton.addEventListener('click', () => {
  if (window.confirm('清除当前项目已加密保存的 API 凭据？')) {
    void saveClaudeConfig('clear');
  }
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-claude-command]')) {
  button.addEventListener('click', async () => {
    const status = activeStatus();
    const command = button.dataset.claudeCommand;
    if (!status || !command) {
      return;
    }
    if (
      command === '/clear' &&
      !window.confirm('/clear 会结束当前上下文并开启新会话，是否继续？')
    ) {
      return;
    }
    const argument = button.dataset.usesArgument
      ? commandArgument.value
      : button.dataset.defaultArgument;
    const result = await window.controlPanel.runClaudeCommand(status.id, command, argument);
    renderClaudeState(result.state);
    if (!result.ok) {
      showToast(result.error ?? '无法执行 Claude 命令。', 'error');
      return;
    }
    showToast(`已执行 ${command}`);
    terminalViews.get(status.id)?.terminal.focus();
  });
}
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
