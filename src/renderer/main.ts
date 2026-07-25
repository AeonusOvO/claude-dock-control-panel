import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type {
  ClaudeConnectionTestResult,
  ClaudeGatewayCandidate,
  ClaudeGatewayDiagnostics,
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
import { parseClaudeCurl, type ClaudeCurlAnalysis } from '../shared/claude-curl';
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
const analyzeCurlButton = requiredElement<HTMLButtonElement>('#analyze-curl');
const applyCurlDirectButton = requiredElement<HTMLButtonElement>('#apply-curl-direct');
const authModeHelp = requiredElement<HTMLElement>('#auth-mode-help');
const authModeLabel = requiredElement<HTMLElement>('#auth-mode-label');
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
const configurationHints = requiredElement<HTMLElement>('#configuration-hints');
const connectionTestResult = requiredElement<HTMLElement>('#connection-test-result');
const connectionTestStages = requiredElement<HTMLElement>('#connection-test-stages');
const connectionTestSummary = requiredElement<HTMLElement>('#connection-test-summary');
const connectionTestTitle = requiredElement<HTMLElement>('#connection-test-title');
const commandArgument = requiredElement<HTMLInputElement>('#command-argument');
const contextPercentage = requiredElement<HTMLElement>('#context-percentage');
const contextProgress = requiredElement<HTMLElement>('.context-progress');
const contextProgressBar = requiredElement<HTMLElement>('#context-progress-bar');
const contextSize = requiredElement<HTMLElement>('#context-size');
const contextUsed = requiredElement<HTMLElement>('#context-used');
const credentialField = requiredElement<HTMLElement>('#credential-field');
const credentialLabel = requiredElement<HTMLElement>('#credential-label');
const credentialStatus = requiredElement<HTMLElement>('#credential-status');
const curlAnalysis = requiredElement<HTMLElement>('#curl-analysis');
const curlAnalysisAuth = requiredElement<HTMLElement>('#curl-analysis-auth');
const curlAnalysisDetail = requiredElement<HTMLElement>('#curl-analysis-detail');
const curlAnalysisEndpoint = requiredElement<HTMLElement>('#curl-analysis-endpoint');
const curlAnalysisModel = requiredElement<HTMLElement>('#curl-analysis-model');
const curlAnalysisTitle = requiredElement<HTMLElement>('#curl-analysis-title');
const curlInput = requiredElement<HTMLTextAreaElement>('#curl-input');
const curlNextStep = requiredElement<HTMLElement>('#curl-next-step');
const curlProtocolBadge = requiredElement<HTMLElement>('#curl-protocol-badge');
const dropOverlay = requiredElement<HTMLElement>('#drop-overlay');
const dropZone = requiredElement<HTMLButtonElement>('#drop-zone');
const emptyState = requiredElement<HTMLElement>('#terminal-empty-state');
const footerStatus = requiredElement<HTMLElement>('#footer-status');
const gatewayCandidates = requiredElement<HTMLElement>('#gateway-candidates');
const gatewayCheckedAt = requiredElement<HTMLElement>('#gateway-checked-at');
const gatewayDiagnosticsSummary = requiredElement<HTMLElement>('#gateway-diagnostics-summary');
const launchContinueButton = requiredElement<HTMLButtonElement>('#launch-continue');
const launchNewButton = requiredElement<HTMLButtonElement>('#launch-new');
const launchResumeButton = requiredElement<HTMLButtonElement>('#launch-resume');
const metricCost = requiredElement<HTMLElement>('#metric-cost');
const metricDuration = requiredElement<HTMLElement>('#metric-duration');
const metricInput = requiredElement<HTMLElement>('#metric-input');
const metricModel = requiredElement<HTMLElement>('#metric-model');
const metricOutput = requiredElement<HTMLElement>('#metric-output');
const metricSession = requiredElement<HTMLElement>('#metric-session');
const modelHelp = requiredElement<HTMLElement>('#model-help');
const openDetectedRouterButton = requiredElement<HTMLButtonElement>('#open-detected-router');
const projectCount = requiredElement<HTMLElement>('#project-count');
const projectList = requiredElement<HTMLElement>('#project-list');
const restartButton = requiredElement<HTMLButtonElement>('#restart-terminal');
const refreshGatewaysButton = requiredElement<HTMLButtonElement>('#refresh-gateways');
const runClaudeButton = requiredElement<HTMLButtonElement>('#run-claude');
const sessionDetail = requiredElement<HTMLElement>('#session-detail');
const sessionPid = requiredElement<HTMLElement>('#session-pid');
const statusPill = requiredElement<HTMLElement>('#status-pill');
const terminalProject = requiredElement<HTMLElement>('#terminal-project');
const terminalStage = requiredElement<HTMLElement>('#terminal-stage');
const titleStatus = requiredElement<HTMLElement>('#title-status');
const toast = requiredElement<HTMLElement>('#toast');
const testClaudeConnectionButton = requiredElement<HTMLButtonElement>('#test-claude-connection');
const toggleButton = requiredElement<HTMLButtonElement>('#toggle-terminal');
const toggleLabel = requiredElement<HTMLElement>('#toggle-terminal-label');
const workbenchClose = requiredElement<HTMLButtonElement>('#workbench-close');
const workbenchScrim = requiredElement<HTMLButtonElement>('#workbench-scrim');
const workbenchTrigger = requiredElement<HTMLButtonElement>('#workbench-trigger');
const useDetectedRouterButton = requiredElement<HTMLButtonElement>('#use-detected-router');
const baseUrlHelp = requiredElement<HTMLElement>('#base-url-help');

brandLogo.src = new URL('../../assets/generated/app-icon-64.png', import.meta.url).href;

const terminalViews = new Map<string, TerminalView>();
const claudeStates = new Map<string, ClaudeProjectState>();
let dragDepth = 0;
let claudeRequestGeneration = 0;
let configFormSessionId = '';
let gatewayDiagnostics: ClaudeGatewayDiagnostics | undefined;
let gatewayRefreshInProgress = false;
let gatewayRefreshTimer: number | undefined;
let lastClaudeSessionId = '';
let lastCurlAnalysis: ClaudeCurlAnalysis | undefined;
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
    baseUrlHelp.textContent = 'Anthropic 官方接入使用固定端点，无需填写地址。';
    modelHelp.textContent = 'default 表示由 Claude Code 选择当前官方默认模型。';
    authModeHelp.textContent = '已有 Claude 登录不会把登录令牌交给 ClaudeDock。';
    credentialLabel.textContent = 'Anthropic API Key';
  } else if (preset === 'deepseek') {
    setAuthOptions([{ label: 'API Key（X-Api-Key）', value: 'apiKey' }], 'apiKey');
    if (!preserveValues) {
      claudeBaseUrl.value = 'https://api.deepseek.com/anthropic';
      claudeModel.value = 'deepseek-v4-pro';
    }
    baseUrlHelp.textContent =
      'DeepSeek 官方已提供 Anthropic 格式；Claude Code 会访问 /anthropic/v1/messages。';
    modelHelp.textContent =
      '可填写 DeepSeek 官方当前提供的模型 ID；不支持的名字可能被服务端自动映射。';
    authModeHelp.textContent = 'DeepSeek 官方 Anthropic 接口使用 x-api-key。';
    credentialLabel.textContent = 'DeepSeek API Key';
  } else {
    setAuthOptions(
      [
        { label: 'API Key（X-Api-Key）', value: 'apiKey' },
        { label: 'Bearer Token（Authorization）', value: 'authToken' },
        { label: '无需认证（仅建议本机网关）', value: 'none' },
      ],
      preserveValues
        ? (claudeAuthMode.value as SaveClaudeConfigInput['authMode'])
        : preset === 'gateway'
          ? 'authToken'
          : 'apiKey',
    );
    if (!preserveValues && claudeModel.value === 'default') {
      claudeModel.value = '';
    }
    baseUrlHelp.textContent =
      preset === 'gateway'
        ? '填转换器真正的模型接口，例如 Router 的 http://127.0.0.1:3456；不要填 3458 管理页。'
        : '接口必须提供 Anthropic /v1/messages；不要直接填 /v1/chat/completions。';
    modelHelp.textContent =
      preset === 'gateway'
        ? '填写 Router 路由中暴露给 Claude Code 的模型 ID。'
        : '必须与最终接口可用的模型 ID 完全一致。';
    authModeHelp.textContent =
      preset === 'gateway'
        ? '这里是 ClaudeDock 到本地 Router 的访问密钥，不是服务商的上游密钥。'
        : '服务商写 Authorization / Bearer 就选 Bearer；写 x-api-key 就选 API Key。';
    credentialLabel.textContent =
      preset === 'gateway' ? 'Router 访问密钥（不是上游密钥）' : '接口访问凭据';
  }
  authModeLabel.textContent = isOfficial ? '官方认证方式' : 'Claude Code 到最终接口的认证方式';
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
        ? 'DeepSeek 官方直连'
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

const openExternal = async (url: string): Promise<void> => {
  if (!(await window.controlPanel.openExternal(url))) {
    showToast('无法打开该帮助或管理地址。', 'error');
  }
};

const applyGatewayCandidate = (candidate: ClaudeGatewayCandidate): void => {
  claudePreset.value = 'gateway';
  applyPresetUi('gateway', false);
  claudeBaseUrl.value = candidate.apiBaseUrl;
  claudeModel.value =
    lastCurlAnalysis?.model || (claudeModel.value === 'default' ? '' : claudeModel.value);
  claudeAuthMode.value = candidate.authRequired ? 'authToken' : 'none';
  claudeCredential.value = '';
  credentialField.hidden = claudeAuthMode.value === 'none';
  connectionTestResult.hidden = true;
  showToast(
    candidate.authRequired
      ? `已选用 ${candidate.label}；请填写 Router 自己的访问密钥`
      : `已选用 ${candidate.label}；下一步执行真实连接测试`,
  );
  claudeConfigForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const renderGatewayDiagnostics = (diagnostics: ClaudeGatewayDiagnostics): void => {
  gatewayDiagnostics = diagnostics;
  gatewayDiagnosticsSummary.textContent = diagnostics.message;
  gatewayCheckedAt.textContent = `上次检测 ${new Date(diagnostics.checkedAt).toLocaleTimeString(
    'zh-CN',
    { hour: '2-digit', minute: '2-digit', second: '2-digit' },
  )}`;
  gatewayCandidates.replaceChildren();

  if (diagnostics.candidates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'gateway-empty';
    empty.textContent = '没有发现 CCR、LiteLLM 或当前项目保存的本机服务。';
    gatewayCandidates.append(empty);
  }

  for (const candidate of diagnostics.candidates) {
    const card = document.createElement('article');
    card.className = 'gateway-candidate';
    card.dataset.status = candidate.status;

    const headline = document.createElement('div');
    headline.className = 'gateway-candidate__headline';
    const title = document.createElement('strong');
    title.textContent = candidate.label;
    const status = document.createElement('span');
    status.textContent =
      candidate.status === 'ready'
        ? '模型接口已运行'
        : candidate.status === 'partial'
          ? '需要处理'
          : '未运行';
    headline.append(title, status);

    const endpoint = document.createElement('code');
    endpoint.textContent = candidate.apiBaseUrl;
    const detail = document.createElement('p');
    detail.textContent = candidate.detail;
    const detected = document.createElement('small');
    detected.textContent = `依据：${candidate.detectedBy.join('、')}`;

    const actions = document.createElement('div');
    actions.className = 'gateway-candidate__actions';
    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.textContent = '选用这个接口';
    useButton.disabled = candidate.status === 'offline';
    useButton.addEventListener('click', () => {
      applyGatewayCandidate(candidate);
    });
    actions.append(useButton);
    if (candidate.managementUrl) {
      const manageButton = document.createElement('button');
      manageButton.type = 'button';
      manageButton.textContent = '打开管理页';
      manageButton.addEventListener('click', () => {
        void openExternal(candidate.managementUrl ?? '');
      });
      actions.append(manageButton);
    }

    card.append(headline, endpoint, detail, detected, actions);
    gatewayCandidates.append(card);
  }

  configurationHints.replaceChildren();
  configurationHints.hidden = diagnostics.configurationHints.length === 0;
  if (diagnostics.configurationHints.length > 0) {
    const heading = document.createElement('strong');
    heading.textContent = '还发现了外部 Claude 配置（只读）';
    configurationHints.append(heading);
    for (const hint of diagnostics.configurationHints) {
      const item = document.createElement('span');
      item.textContent = `${hint.label}：${hint.baseUrl ?? '未设置基址'} · ${
        hint.authConfigured ? '已配置凭据' : '未发现凭据'
      }`;
      configurationHints.append(item);
    }
  }
};

const loadGatewayDiagnostics = async (): Promise<void> => {
  const status = activeStatus();
  if (!status || gatewayRefreshInProgress) {
    return;
  }
  gatewayRefreshInProgress = true;
  refreshGatewaysButton.disabled = true;
  try {
    renderGatewayDiagnostics(await window.controlPanel.getClaudeGatewayDiagnostics(status.id));
  } catch {
    gatewayDiagnosticsSummary.textContent = '自动检测失败；仍可手动填写接入配置。';
  } finally {
    gatewayRefreshInProgress = false;
    refreshGatewaysButton.disabled = false;
  }
};

const preferredRouter = (): ClaudeGatewayCandidate | undefined =>
  gatewayDiagnostics?.candidates.find(
    (candidate) => candidate.kind === 'claude-code-router' && candidate.status === 'ready',
  );

const analyzeCurlInput = (): void => {
  try {
    const analysis = parseClaudeCurl(curlInput.value);
    lastCurlAnalysis = analysis;
    curlAnalysis.hidden = false;
    curlAnalysis.dataset.protocol = analysis.protocol;
    curlProtocolBadge.textContent =
      analysis.protocol === 'anthropic'
        ? 'Anthropic 格式'
        : analysis.protocol === 'openai'
          ? 'OpenAI 格式'
          : '协议待确认';
    curlAnalysisTitle.textContent =
      analysis.protocol === 'anthropic'
        ? '可以直接接入 Claude Code'
        : analysis.protocol === 'openai'
          ? '不能直接接入，需要转换器'
          : '请向服务商确认 /v1/messages';
    curlAnalysisDetail.textContent = analysis.explanation;
    curlAnalysisEndpoint.textContent = analysis.endpoint;
    curlAnalysisModel.textContent = analysis.model || '没有识别到模型名';
    curlAnalysisAuth.textContent =
      analysis.authMode === 'authToken'
        ? `Bearer（Authorization）${analysis.credentialDetected ? ' · 已识别密钥但不显示' : ''}`
        : analysis.authMode === 'apiKey'
          ? `API Key（x-api-key）${analysis.credentialDetected ? ' · 已识别密钥但不显示' : ''}`
          : '没有识别到认证头';
    curlNextStep.replaceChildren();

    const router = preferredRouter();
    applyCurlDirectButton.hidden = analysis.protocol !== 'anthropic';
    useDetectedRouterButton.hidden = analysis.protocol !== 'openai' || !router;
    openDetectedRouterButton.hidden = analysis.protocol !== 'openai' || !router?.managementUrl;

    const nextTitle = document.createElement('strong');
    const nextDetail = document.createElement('span');
    if (analysis.protocol === 'anthropic') {
      nextTitle.textContent = '下一步：自动填入并执行真实测试';
      nextDetail.textContent = '确认测试通过后再保存；保存时密钥才会进入 Windows 安全存储。';
    } else if (analysis.protocol === 'openai') {
      nextTitle.textContent = router
        ? '下一步：先在 Router 管理页添加这个上游'
        : '下一步：先安装并启动本地转换器';
      nextDetail.textContent = router
        ? `Provider 选择 OpenAI Compatible，接口填 ${analysis.endpoint}，模型填 ${
            analysis.model || '服务商提供的模型名'
          }；上游密钥只填在 Router 中。然后回到这里选用 3456。`
        : '推荐从下方打开 Claude Code Router 图形版安装页。配置完成后，重新检测会自动发现 3456。';
    } else {
      nextTitle.textContent = '下一步：向服务商确认协议';
      nextDetail.textContent = '需要明确询问：“是否提供 Anthropic Messages /v1/messages 接口？”';
    }
    curlNextStep.append(nextTitle, nextDetail);
  } catch (error) {
    lastCurlAnalysis = undefined;
    curlAnalysis.hidden = true;
    showToast(error instanceof Error ? error.message : '无法识别这段 cURL。', 'error');
  }
};

const applyDirectCurlAnalysis = (): void => {
  const analysis = lastCurlAnalysis;
  if (!analysis || analysis.protocol !== 'anthropic') {
    return;
  }
  claudePreset.value = 'custom';
  applyPresetUi('custom', false);
  claudeBaseUrl.value = analysis.baseUrl;
  claudeModel.value = analysis.model;
  claudeAuthMode.value = analysis.authMode;
  claudeCredential.value = analysis.credential ?? '';
  credentialField.hidden = analysis.authMode === 'none';
  connectionTestResult.hidden = true;
  claudeConfigForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('已填入直连接口；请先进行真实连接测试');
};

const renderConnectionTest = (result: ClaudeConnectionTestResult): void => {
  connectionTestResult.hidden = false;
  connectionTestResult.dataset.tone = result.tone;
  connectionTestTitle.textContent =
    result.tone === 'success'
      ? '连接测试通过'
      : result.tone === 'warning'
        ? '部分通过，还需处理'
        : '连接测试未通过';
  connectionTestSummary.textContent = `${result.message}${
    result.latencyMs === undefined ? '' : ` · ${result.latencyMs} ms`
  }`;
  connectionTestStages.replaceChildren();
  for (const resultStage of result.stages) {
    const item = document.createElement('div');
    item.dataset.status = resultStage.status;
    const icon = document.createElement('span');
    icon.textContent =
      resultStage.status === 'passed'
        ? '✓'
        : resultStage.status === 'failed'
          ? '×'
          : resultStage.status === 'warning'
            ? '!'
            : '–';
    const copy = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = resultStage.label;
    const detail = document.createElement('span');
    detail.textContent = resultStage.detail;
    copy.append(label, detail);
    item.append(icon, copy);
    connectionTestStages.append(item);
  }
};

const runConnectionTest = async (): Promise<void> => {
  const status = activeStatus();
  if (!status) {
    return;
  }
  testClaudeConnectionButton.disabled = true;
  testClaudeConnectionButton.textContent = '正在发送 1-token 测试…';
  try {
    renderConnectionTest(
      await window.controlPanel.testClaudeConnection(status.id, currentConfigInput('keep')),
    );
  } catch {
    showToast('连接测试发生异常。', 'error');
  } finally {
    testClaudeConnectionButton.disabled = false;
    testClaudeConnectionButton.textContent = '真实测试端点、密钥和模型';
  }
};

const setWorkbenchOpen = (open: boolean): void => {
  claudeWorkbench.classList.toggle('claude-workbench--open', open);
  claudeWorkbench.setAttribute('aria-hidden', String(!open));
  workbenchScrim.classList.toggle('workbench-scrim--visible', open);
  workbenchTrigger.setAttribute('aria-expanded', String(open));
  if (open && workspaceState.activeSessionId) {
    void loadClaudeState(workspaceState.activeSessionId);
    void loadGatewayDiagnostics();
    if (gatewayRefreshTimer === undefined) {
      gatewayRefreshTimer = window.setInterval(() => {
        void loadGatewayDiagnostics();
      }, 6_000);
    }
  } else if (gatewayRefreshTimer !== undefined) {
    window.clearInterval(gatewayRefreshTimer);
    gatewayRefreshTimer = undefined;
  }
};

const selectWorkbenchPage = (page: string): void => {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-workbench-tab]')) {
    tab.classList.toggle('workbench-tab--active', tab.dataset.workbenchTab === page);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-workbench-page]')) {
    panel.classList.toggle('workbench-page--active', panel.dataset.workbenchPage === page);
  }
  if (page === 'connection') {
    void loadGatewayDiagnostics();
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
    gatewayDiagnostics = undefined;
    lastCurlAnalysis = undefined;
    curlInput.value = '';
    curlAnalysis.hidden = true;
    connectionTestResult.hidden = true;
    gatewayCandidates.replaceChildren();
    gatewayDiagnosticsSummary.textContent = '正在检查常见本地端口、命令和 Claude 设置…';
    gatewayCheckedAt.textContent = '等待首次检测';
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
  connectionTestResult.hidden = true;
});
claudeAuthMode.addEventListener('change', () => {
  credentialField.hidden = claudeAuthMode.value === 'existing' || claudeAuthMode.value === 'none';
  connectionTestResult.hidden = true;
});
analyzeCurlButton.addEventListener('click', analyzeCurlInput);
applyCurlDirectButton.addEventListener('click', applyDirectCurlAnalysis);
useDetectedRouterButton.addEventListener('click', () => {
  const router = preferredRouter();
  if (router) {
    applyGatewayCandidate(router);
  }
});
openDetectedRouterButton.addEventListener('click', () => {
  const managementUrl = preferredRouter()?.managementUrl;
  if (managementUrl) {
    void openExternal(managementUrl);
  }
});
refreshGatewaysButton.addEventListener('click', () => {
  void loadGatewayDiagnostics();
});
testClaudeConnectionButton.addEventListener('click', () => {
  void runConnectionTest();
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-external-url]')) {
  button.addEventListener('click', () => {
    const url = button.dataset.externalUrl;
    if (url) {
      void openExternal(url);
    }
  });
}
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
  if (gatewayRefreshTimer !== undefined) {
    window.clearInterval(gatewayRefreshTimer);
  }
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
