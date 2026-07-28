import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type {
  ClaudeConnectionAdvice,
  ClaudeConnectionAdviceAction,
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionTestResult,
  ClaudeGatewayCandidate,
  ClaudeGatewayDiagnostics,
  ClaudeLaunchMode,
  ClaudeModelOption,
  ClaudeModelOptions,
  ClaudePermissionMode,
  ClaudePluginCatalog,
  ClaudePluginMarketplaceView,
  ClaudePluginOperationResult,
  ClaudePluginView,
  ClaudePreset,
  ClaudeProjectState,
  ClaudeRelaunchInput,
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
  ClaudeRouterProviderView,
  ClaudeSessionMetadata,
  SoftwareUpdateState,
  SaveClaudeRouterProviderInput,
  SaveClaudeConfigInput,
  OperationResult,
  TerminalPhase,
  TerminalStatus,
  WorkspaceProjectView,
  WorkspaceResult,
  WorkspaceState,
} from '../shared/contracts';
import { parseClaudeCurl, type ClaudeCurlAnalysis } from '../shared/claude-curl';
import { parseClaudePermissionMode } from '../shared/claude-permission-mode';
import {
  CLAUDE_PROVIDER_GROUPS,
  CLAUDE_PROVIDERS,
  findClaudeProvider,
  providerForPreset,
  type ClaudeProviderGroupId,
  type ClaudeProviderId,
} from '../shared/claude-providers';
import {
  diagnoseClaudeConnection,
  type ClaudeConnectionRemedyAction,
} from '../shared/claude-connection-remedy';
import {
  createComposerHistory,
  rememberSubmission,
  resetBrowsing,
  stepBack,
  stepForward,
  type ComposerHistoryState,
} from '../shared/composer-history';
import { buildTerminalSubmission, SUBMIT_DELAY_MS } from '../shared/composer-input';
import { localizePluginCopy } from '../shared/plugin-localization';
import {
  DEFAULT_TERMINAL_THEME,
  isTerminalThemeId,
  SHELL_CSS_VARIABLES,
  TERMINAL_THEMES,
  type TerminalThemeId,
} from '../shared/terminal-themes';
import { deriveUpdateActionState } from '../shared/update-actions';
import './styles.css';

interface TerminalView {
  /** Latest PTY-output revision fully applied to xterm's screen buffer. */
  appliedOutputRevision: number;
  container: HTMLDivElement;
  fitAddon: FitAddon;
  /** Latest PTY-output revision accepted into this view's renderer-side queue. */
  outputRevision: number;
  /** Output arriving between two frames, flushed as one `write` so heavy output stays smooth. */
  pending: string[];
  pendingLength: number;
  /** `requestAnimationFrame` handle for the queued flush, `0` when nothing is scheduled. */
  pendingFrame: number;
  /** Main-process probes waiting for all output that preceded their request to reach xterm. */
  permissionModeProbes: Array<{ probeId: number; requiredRevision: number }>;
  /** Last complete badge passively reported after xterm reconstructed a PTY screen delta. */
  observedPermissionMode?: ClaudePermissionMode;
  terminal: Terminal;
}

type AdvancedDraftControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface AdvancedDraftControlState {
  checked?: boolean;
  control: AdvancedDraftControl;
  value: string;
}

interface AdvancedConnectionSnapshot {
  authMode: SaveClaudeConfigInput['authMode'];
  baseUrl: string;
  controls: AdvancedDraftControlState[];
  credential: string;
  model: string;
  modelFast: string;
  providerId?: ClaudeProviderId;
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
const importCurlRouterButton = requiredElement<HTMLButtonElement>('#import-curl-router');
const authModeHelp = requiredElement<HTMLElement>('#auth-mode-help');
const authModeLabel = requiredElement<HTMLElement>('#auth-mode-label');
const claudeAuthMode = requiredElement<HTMLSelectElement>('#claude-auth-mode');
const claudeBaseUrl = requiredElement<HTMLInputElement>('#claude-base-url');
const claudeConfigForm = requiredElement<HTMLFormElement>('#claude-config-form');
const claudeCredential = requiredElement<HTMLInputElement>('#claude-credential');
const claudeInstallSource = requiredElement<HTMLSelectElement>('#claude-install-source');
const claudeInstallationDetail = requiredElement<HTMLElement>('#claude-installation-detail');
const claudeInstallationTitle = requiredElement<HTMLElement>('#claude-installation-title');
const claudeLiveIndicator = requiredElement<HTMLElement>('#claude-live-indicator');
const claudeModel = requiredElement<HTMLInputElement>('#claude-model');
const claudeModelFast = requiredElement<HTMLInputElement>('#claude-model-fast');
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
const connectionRemedy = requiredElement<HTMLElement>('#connection-remedy');
const connectionRemedyTitle = requiredElement<HTMLElement>('#connection-remedy-title');
const connectionRemedyCause = requiredElement<HTMLElement>('#connection-remedy-cause');
const connectionRemedyFix = requiredElement<HTMLElement>('#connection-remedy-fix');
const connectionRemedyActions = requiredElement<HTMLElement>('#connection-remedy-actions');
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
const dropZone = chooseDirectoryButton;
const emptyState = requiredElement<HTMLElement>('#terminal-empty-state');
const emptyStateTitle = requiredElement<HTMLElement>('#empty-state-title');
const emptyStateHint = requiredElement<HTMLElement>('#empty-state-hint');
const footerConnection = requiredElement<HTMLButtonElement>('#footer-connection');
const footerConnectionLabel = requiredElement<HTMLElement>('#footer-connection-label');
const footerContextLabel = requiredElement<HTMLElement>('#footer-context-label');
const footerContextRing = requiredElement<HTMLElement>('#footer-context-ring');
const footerModel = requiredElement<HTMLButtonElement>('#footer-model');
const footerModelMenu = requiredElement<HTMLElement>('#footer-model-menu');
const footerMode = requiredElement<HTMLButtonElement>('#footer-mode');
const footerModeMenu = requiredElement<HTMLElement>('#footer-mode-menu');
const footerStatus = requiredElement<HTMLElement>('#footer-status');
const gatewayCandidates = requiredElement<HTMLElement>('#gateway-candidates');
const gatewayCheckedAt = requiredElement<HTMLElement>('#gateway-checked-at');
const gatewayDiagnosticsSummary = requiredElement<HTMLElement>('#gateway-diagnostics-summary');
const gatewayDiscoverySection = requiredElement<HTMLElement>('#gateway-discovery');
const launchContinueButton = requiredElement<HTMLButtonElement>('#launch-continue');
const launchNewButton = requiredElement<HTMLButtonElement>('#launch-new');
const launchResumeButton = requiredElement<HTMLButtonElement>('#launch-resume');
const allowBypassPermissions = requiredElement<HTMLInputElement>('#allow-bypass-permissions');
const metricCost = requiredElement<HTMLElement>('#metric-cost');
const metricDuration = requiredElement<HTMLElement>('#metric-duration');
const metricInput = requiredElement<HTMLElement>('#metric-input');
const metricModel = requiredElement<HTMLElement>('#metric-model');
const metricOutput = requiredElement<HTMLElement>('#metric-output');
const metricSession = requiredElement<HTMLElement>('#metric-session');
const modelHelp = requiredElement<HTMLElement>('#model-help');
const environmentSetup = requiredElement<HTMLElement>('#environment-setup');
const providerGroups = requiredElement<HTMLElement>('#connection-provider-groups');
const providerPicker = requiredElement<HTMLElement>('#connection-provider-picker');
const providerSetup = requiredElement<HTMLElement>('#connection-provider-setup');
const providerTitle = requiredElement<HTMLElement>('#connection-provider-title');
const providerDescription = requiredElement<HTMLElement>('#connection-provider-description');
const providerCaveat = requiredElement<HTMLElement>('#connection-provider-caveat');
const providerSpecialSetup = requiredElement<HTMLElement>('#connection-provider-special');
const openProviderConsoleButton = requiredElement<HTMLButtonElement>('#open-provider-console');
const openProviderDocsButton = requiredElement<HTMLButtonElement>('#open-provider-docs');
const connectionAdvancedContent = requiredElement<HTMLElement>('#connection-advanced-content');
const connectionAdvancedDialog = requiredElement<HTMLDialogElement>('#connection-advanced-dialog');
const openConnectionAdvancedButton = requiredElement<HTMLButtonElement>(
  '#open-connection-advanced',
);
const closeConnectionAdvancedButton = requiredElement<HTMLButtonElement>(
  '#close-connection-advanced',
);
const cancelConnectionAdvancedButton = requiredElement<HTMLButtonElement>(
  '#cancel-connection-advanced',
);
const completeConnectionAdvancedButton = requiredElement<HTMLButtonElement>(
  '#complete-connection-advanced',
);
const curlOnboarding = requiredElement<HTMLElement>('#curl-onboarding');
const converterHelp = requiredElement<HTMLElement>('#converter-help');
const addRouterProviderButton = requiredElement<HTMLButtonElement>('#add-router-provider');
const cancelRouterProviderButton = requiredElement<HTMLButtonElement>('#cancel-router-provider');
const claudeInstallActions = requiredElement<HTMLElement>('#claude-install-actions');
const installRouterButton = requiredElement<HTMLButtonElement>('#install-router');
const installUpdateClaudeButton = requiredElement<HTMLButtonElement>('#install-update-claude');
const openDetectedRouterButton = requiredElement<HTMLButtonElement>('#open-detected-router');
const openRouterManagementButton = requiredElement<HTMLButtonElement>('#open-router-management');
const panelResizer = requiredElement<HTMLElement>('#panel-resizer');
const projectCount = requiredElement<HTMLElement>('#project-count');
const projectList = requiredElement<HTMLElement>('#project-list');
const repairRouterFromProjectButton = requiredElement<HTMLButtonElement>(
  '#repair-router-from-project',
);
const restartButton = requiredElement<HTMLButtonElement>('#restart-terminal');
const refreshGatewaysButton = requiredElement<HTMLButtonElement>('#refresh-gateways');
const routeHealth = requiredElement<HTMLElement>('#route-health');
const routeHealthAction = requiredElement<HTMLButtonElement>('#route-health-action');
const routeHealthBadge = requiredElement<HTMLElement>('#route-health-badge');
const routeHealthDetail = requiredElement<HTMLElement>('#route-health-detail');
const routeHealthTitle = requiredElement<HTMLElement>('#route-health-title');
const runClaudeButton = requiredElement<HTMLButtonElement>('#run-claude');
const routerProviderApiKey = requiredElement<HTMLInputElement>('#router-provider-api-key');
const routerProviderBaseUrl = requiredElement<HTMLInputElement>('#router-provider-base-url');
const routerProviderForm = requiredElement<HTMLFormElement>('#router-provider-form');
const routerProviderFormTitle = requiredElement<HTMLElement>('#router-provider-form-title');
const routerProviderId = requiredElement<HTMLInputElement>('#router-provider-id');
const routerProviderList = requiredElement<HTMLElement>('#router-provider-list');
const routerProviderModels = requiredElement<HTMLTextAreaElement>('#router-provider-models');
const routerProviderName = requiredElement<HTMLInputElement>('#router-provider-name');
const routerProviderPreferred = requiredElement<HTMLInputElement>('#router-provider-preferred');
const routerProviderProtocol = requiredElement<HTMLSelectElement>('#router-provider-protocol');
const routerProviderUseProject = requiredElement<HTMLInputElement>('#router-provider-use-project');
const routerInstallSource = requiredElement<HTMLSelectElement>('#router-install-source');
const routerInstallSourceField = requiredElement<HTMLElement>('#router-install-source-field');
const routerRemediation = requiredElement<HTMLElement>('#router-remediation');
const routerRemediationDetail = requiredElement<HTMLElement>('#router-remediation-detail');
const routerRemediationTitle = requiredElement<HTMLElement>('#router-remediation-title');
const routerStatus = requiredElement<HTMLElement>('#router-status');
const routerStatusDetail = requiredElement<HTMLElement>('#router-status-detail');
const routerStatusTitle = requiredElement<HTMLElement>('#router-status-title');
const routerSwapHint = requiredElement<HTMLElement>('#router-swap-hint');
const routerVersion = requiredElement<HTMLElement>('#router-version');
const uninstallRouterButton = requiredElement<HTMLButtonElement>('#uninstall-router');
const saveRouterProviderButton = requiredElement<HTMLButtonElement>('#save-router-provider');
const configureRouterProviderButton = requiredElement<HTMLButtonElement>(
  '#configure-router-provider',
);
const sessionDetail = requiredElement<HTMLElement>('#session-detail');
const sessionPid = requiredElement<HTMLElement>('#session-pid');
const statusPill = requiredElement<HTMLElement>('#status-pill');
const startRouterButton = requiredElement<HTMLButtonElement>('#start-router');
const stopRouterButton = requiredElement<HTMLButtonElement>('#stop-router');
const terminalProject = requiredElement<HTMLElement>('#terminal-project');
const terminalContextMenu = requiredElement<HTMLElement>('#terminal-context-menu');
const terminalThemeSelect = requiredElement<HTMLSelectElement>('#terminal-theme');
const terminalStage = requiredElement<HTMLElement>('#terminal-stage');
const composerForm = requiredElement<HTMLFormElement>('#terminal-composer');
const composerInput = requiredElement<HTMLTextAreaElement>('#composer-input');
const composerSendButton = requiredElement<HTMLButtonElement>('#composer-send');
const titleStatus = requiredElement<HTMLElement>('#title-status');
const toast = requiredElement<HTMLElement>('#toast');
const testClaudeConnectionButton = requiredElement<HTMLButtonElement>('#test-claude-connection');
const toggleButton = requiredElement<HTMLButtonElement>('#toggle-terminal');
const toggleLabel = requiredElement<HTMLElement>('#toggle-terminal-label');
const workbenchClose = requiredElement<HTMLButtonElement>('#workbench-close');
const workbenchScrim = requiredElement<HTMLButtonElement>('#workbench-scrim');
const workbenchTrigger = requiredElement<HTMLButtonElement>('#workbench-trigger');
const workbenchShortcuts = requiredElement<HTMLButtonElement>('#workbench-shortcuts');
const drawerResizer = requiredElement<HTMLElement>('#drawer-resizer');
const useDetectedRouterButton = requiredElement<HTMLButtonElement>('#use-detected-router');
const baseUrlHelp = requiredElement<HTMLElement>('#base-url-help');
const smartGuidance = requiredElement<HTMLElement>('#smart-guidance');
const smartGuidanceTitle = requiredElement<HTMLElement>('#smart-guidance-title');
const smartGuidanceDetail = requiredElement<HTMLElement>('#smart-guidance-detail');
const smartGuidanceActions = requiredElement<HTMLElement>('#smart-guidance-actions');
const activityRail = requiredElement<HTMLElement>('#activity-rail');
const workspace = requiredElement<HTMLElement>('#workspace');
const controlPanel = requiredElement<HTMLElement>('#control-panel');
const connectionRailDot = requiredElement<HTMLElement>('#connection-rail-dot');
const connectionAdvice = requiredElement<HTMLElement>('#connection-advice');
const connectionAdviceTitle = requiredElement<HTMLElement>('#connection-advice-title');
const connectionAdviceDetail = requiredElement<HTMLElement>('#connection-advice-detail');
const connectionAdviceActions = requiredElement<HTMLElement>('#connection-advice-actions');
const routerManager = requiredElement<HTMLElement>('#router-manager');
const routerActions = requiredElement<HTMLElement>('#router-actions');
const workbenchScope = requiredElement<HTMLElement>('#workbench-scope');
const pluginSearch = requiredElement<HTMLInputElement>('#plugin-search');
const refreshUpdatesButton = requiredElement<HTMLButtonElement>('#refresh-updates');
const updateAllPluginsButton = requiredElement<HTMLButtonElement>('#update-all-plugins');
const pluginUpdateActions = requiredElement<HTMLElement>('#plugin-update-actions');
const pluginStatus = requiredElement<HTMLElement>('#plugin-status');
const pluginRailDot = requiredElement<HTMLElement>('#plugin-rail-dot');
const pluginInstalledCount = requiredElement<HTMLElement>('#plugin-installed-count');
const pluginAvailableCount = requiredElement<HTMLElement>('#plugin-available-count');
const pluginInstalledList = requiredElement<HTMLElement>('#plugin-installed-list');
const pluginAvailableList = requiredElement<HTMLElement>('#plugin-available-list');
const pluginMarketplaceList = requiredElement<HTMLElement>('#plugin-marketplace-list');
const pluginMarketplaceForm = requiredElement<HTMLFormElement>('#plugin-marketplace-form');
const pluginMarketplaceSource = requiredElement<HTMLInputElement>('#plugin-marketplace-source');
const addPluginMarketplaceButton = requiredElement<HTMLButtonElement>('#add-plugin-marketplace');
const claudeUpdateDetail = requiredElement<HTMLElement>('#claude-update-detail');
const claudeUpdateVersion = requiredElement<HTMLElement>('#claude-update-version');
const softwareUpdateCheckedAt = requiredElement<HTMLElement>('#software-update-checked-at');
const conversationContextMenu = requiredElement<HTMLElement>('#conversation-context-menu');
const conversationRenameDialog = requiredElement<HTMLDialogElement>('#conversation-rename-dialog');
const conversationRenameDialogTitle = requiredElement<HTMLElement>(
  '#conversation-rename-dialog-title',
);
const conversationRenameCancel = requiredElement<HTMLButtonElement>('#conversation-rename-cancel');
const conversationRenameInput = requiredElement<HTMLInputElement>('#conversation-rename-input');
const connectionHistoryList = requiredElement<HTMLElement>('#connection-history-list');
const connectionHistoryEmpty = requiredElement<HTMLElement>('#connection-history-empty');
const connectionHistoryCount = requiredElement<HTMLElement>('#connection-history-count');
const historyContextMenu = requiredElement<HTMLElement>('#history-context-menu');
const saveClaudeConfigButton = requiredElement<HTMLButtonElement>('#save-claude-config');

const connectionGlossary = requiredElement<HTMLElement>('.connection-glossary');

connectionAdvancedContent.append(
  connectionAdvice,
  gatewayDiscoverySection,
  curlOnboarding,
  routerManager,
  converterHelp,
  connectionGlossary,
);
claudePreset.replaceChildren(
  ...CLAUDE_PROVIDERS.map((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    return option;
  }),
);

brandLogo.src = new URL('../../assets/generated/app-icon-64.png', import.meta.url).href;

const terminalViews = new Map<string, TerminalView>();
const claudeStates = new Map<string, ClaudeProjectState>();
/** Conversation history per project folder, keyed by the lower-cased folder path. */
const storedConversations = new Map<string, ClaudeSessionMetadata[]>();
const expandedFolders = new Set<string>();
const collapsedProviderGroups = new Set<ClaudeProviderGroupId>();
const historyLoadsInFlight = new Set<string>();
let dragDepth = 0;
let claudeRequestGeneration = 0;
let configFormSessionId = '';
let connectionTestInProgress = false;
let connectionEnvironmentReady = false;
let selectedProviderId: ClaudeProviderId | undefined;
let advancedConnectionSnapshot: AdvancedConnectionSnapshot | undefined;
let selectedRailTab: string | undefined = 'projects';
let gatewayDiagnostics: ClaudeGatewayDiagnostics | undefined;
let gatewayRefreshInProgress = false;
let gatewayRefreshTimer: number | undefined;
let lastClaudeSessionId = '';
let lastCurlAnalysis: ClaudeCurlAnalysis | undefined;
let launchInProgress = false;
const routeHealthNotifications = new Map<string, string>();
let routerManagementState: ClaudeRouterManagementState | undefined;
let routerOperationInProgress = false;
/** Set after a successful purge so the “pick a new source” hint only appears when it applies. */
let routerPurgeCompleted = false;
let routerRefreshInProgress = false;
let toastTimer: number | undefined;
let connectionAdviceState: ClaudeConnectionAdvice | undefined;
/** Set while a status-bar switch is in flight, so a second click cannot stack terminal writes. */
let modeSwitchInProgress = false;
let modelSwitchInProgress = false;
const guardedButtons = new WeakSet<HTMLButtonElement>();

const runGuarded = async <T>(
  button: HTMLButtonElement,
  busyLabel: string,
  operation: () => Promise<T>,
): Promise<T | undefined> => {
  if (guardedButtons.has(button)) {
    return undefined;
  }
  guardedButtons.add(button);
  const originalDisabled = button.disabled;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (busyLabel) {
    button.textContent = busyLabel;
  }
  try {
    return await operation();
  } finally {
    guardedButtons.delete(button);
    button.disabled = originalDisabled;
    button.setAttribute('aria-busy', 'false');
    button.textContent = originalLabel;
  }
};
let adviceRefreshInProgress = false;
let connectionHistoryEntries: ClaudeConnectionHistoryEntry[] = [];
let connectionHistoryTargetId = '';
let connectionHistoryMutationInProgress = false;
let pluginCatalog: ClaudePluginCatalog | undefined;
let pluginLoadPromise: Promise<void> | undefined;
let pluginMutationInProgress = false;
let softwareUpdates: SoftwareUpdateState | undefined;
let softwareUpdateInProgress = false;
let softwareUpdatePromise: Promise<void> | undefined;
let updateRefreshInProgress = false;
let pendingComposerFocusSessionId = '';
let conversationContextTarget:
  | { kind: 'history'; projectPath: string; session: ClaudeSessionMetadata }
  | { kind: 'running'; status: TerminalStatus }
  | undefined;
let workspaceState: WorkspaceState = {
  activeSessionId: '',
  projects: [],
  sessions: [],
};

const phaseCopy: Record<TerminalPhase, { detail: string; footer: string; pill: string }> = {
  error: {
    detail: '终端连接发生错误',
    footer: '需要处理',
    pill: '错误',
  },
  running: {
    detail: '伪终端会话已连接',
    footer: '后台运行中',
    pill: '运行中',
  },
  starting: {
    detail: '正在创建伪终端会话',
    footer: '正在连接',
    pill: '启动中',
  },
  stopped: {
    detail: '终端会话已停止',
    footer: '后台待命',
    pill: '已停止',
  },
};

const storedTerminalTheme = localStorage.getItem('claudedock.terminalTheme');
let activeTerminalTheme: TerminalThemeId = isTerminalThemeId(storedTerminalTheme)
  ? storedTerminalTheme
  : DEFAULT_TERMINAL_THEME;
terminalThemeSelect.value = activeTerminalTheme;

const terminalOptions = {
  allowProposedApi: true,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: 'bar' as const,
  fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
  fontSize: 14,
  letterSpacing: 0,
  lineHeight: 1.28,
  minimumContrastRatio: 1,
  scrollback: 10_000,
  theme: { ...TERMINAL_THEMES[activeTerminalTheme].palette },
};

const showToast = (message: string, tone: 'error' | 'success' = 'success'): void => {
  window.clearTimeout(toastTimer);
  toast.textContent =
    tone === 'error' && !/[\u3400-\u9fff]/u.test(message)
      ? '操作失败；请查看终端输出或日志了解详情。'
      : message;
  toast.dataset.tone = tone;
  toast.classList.add('toast--visible');
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('toast--visible');
  }, 3200);
};

const applyTerminalTheme = (themeId: TerminalThemeId, announce = true): void => {
  activeTerminalTheme = themeId;
  terminalThemeSelect.value = themeId;
  localStorage.setItem('claudedock.terminalTheme', themeId);
  const definition = TERMINAL_THEMES[themeId];
  // The shell steps are written onto the root element so every `var(--…)` in styles.css follows the
  // theme; without this the terminal recolours but the frame around it stays graphite.
  for (const [field, property] of Object.entries(SHELL_CSS_VARIABLES)) {
    document.documentElement.style.setProperty(
      property,
      definition.shell[field as keyof typeof definition.shell],
    );
  }
  document.documentElement.dataset.theme = themeId;
  for (const view of terminalViews.values()) {
    view.terminal.options.theme = { ...definition.palette };
  }
  // The native titlebar and window background live outside the document and need the main process.
  void window.controlPanel.setAppTheme(themeId).catch(() => {
    // A repaint failure is cosmetic only; the CSS side has already switched.
  });
  if (announce) {
    showToast(`主题已切换为“${definition.label}”`);
  }
};

applyTerminalTheme(activeTerminalTheme, false);

const projectNameFromPath = (directoryPath: string): string => {
  const parts = directoryPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? directoryPath ?? '项目终端';
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

const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) {
    return '刚刚';
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  if (days < 30) {
    return `${days} 天前`;
  }

  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    year: timestamp < now - 365 * 86_400_000 ? 'numeric' : undefined,
  });
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

const syncConnectionInteractivity = (): void => {
  providerPicker.setAttribute('aria-disabled', String(!connectionEnvironmentReady));
  for (const button of providerGroups.querySelectorAll<HTMLButtonElement>('.provider-card')) {
    button.disabled = !connectionEnvironmentReady || connectionTestInProgress;
  }
  for (const control of claudeConfigForm.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >('button, input, select')) {
    control.disabled = !connectionEnvironmentReady || connectionTestInProgress;
  }
  if (connectionEnvironmentReady && !connectionTestInProgress) {
    const config = claudeStates.get(workspaceState.activeSessionId)?.config;
    clearCredentialButton.disabled = !config?.credentialConfigured;
  }
};

const moveProviderTools = (providerId?: ClaudeProviderId): void => {
  connectionAdvancedContent.append(
    connectionAdvice,
    gatewayDiscoverySection,
    curlOnboarding,
    routerManager,
    converterHelp,
    connectionGlossary,
  );
  if (providerId === 'curl') {
    providerSpecialSetup.append(curlOnboarding);
    return;
  }
  if (providerId === 'gateway') {
    providerSpecialSetup.append(gatewayDiscoverySection, routerManager);
  }
};

const clearProviderSelection = (clearDraft = true): void => {
  selectedProviderId = undefined;
  claudePreset.value = '';
  providerSetup.hidden = true;
  claudeConfigForm.hidden = true;
  connectionTestResult.hidden = true;
  connectionRemedy.hidden = true;
  if (clearDraft) {
    claudeCredential.value = '';
  }
  moveProviderTools();
  renderProviderPicker();
  syncConnectionInteractivity();
};

function renderProviderPicker(): void {
  providerGroups.replaceChildren();
  const configuredPreset = claudeStates.get(workspaceState.activeSessionId)?.config.preset;
  for (const group of CLAUDE_PROVIDER_GROUPS) {
    const providers = CLAUDE_PROVIDERS.filter((provider) => provider.group === group.id);
    const collapsed = collapsedProviderGroups.has(group.id);
    const section = document.createElement('section');
    section.className = 'provider-group';
    section.dataset.collapsed = String(collapsed);

    const toggle = document.createElement('button');
    toggle.className = 'provider-group__toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', `provider-group-${group.id}`);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const heading = document.createElement('span');
    heading.className = 'provider-group__title';
    heading.textContent = group.label;
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'provider-group__arrow');
    arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('aria-hidden', 'true');
    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrowPath.setAttribute('d', 'm9 5 7 7-7 7');
    arrow.append(arrowPath);
    toggle.append(heading, arrow);

    const content = document.createElement('div');
    content.className = 'provider-group__content';
    content.id = `provider-group-${group.id}`;
    content.inert = collapsed;
    content.setAttribute('aria-hidden', String(collapsed));
    const grid = document.createElement('div');
    grid.className = 'provider-card-grid';
    for (const provider of providers) {
      const card = document.createElement('button');
      card.className = 'provider-card';
      card.type = 'button';
      card.dataset.providerId = provider.id;
      card.classList.toggle('provider-card--selected', provider.id === selectedProviderId);
      card.setAttribute('aria-pressed', String(provider.id === selectedProviderId));
      card.disabled = !connectionEnvironmentReady || connectionTestInProgress;

      const title = document.createElement('strong');
      title.textContent = provider.label;
      const detail = document.createElement('span');
      detail.textContent = provider.description;
      card.append(title, detail);
      if (provider.id === configuredPreset) {
        const badge = document.createElement('small');
        badge.textContent = '当前配置';
        card.append(badge);
      }
      card.addEventListener('click', () => {
        if (!connectionEnvironmentReady) {
          showToast('请先安装或更新 Claude Code。', 'error');
          return;
        }
        if (selectedProviderId === provider.id) {
          clearProviderSelection();
          showToast('已取消服务商选择');
          return;
        }
        applyPresetUi(provider.id, false);
        claudeCredential.value = '';
        connectionTestResult.hidden = true;
        connectionRemedy.hidden = true;
        renderProviderPicker();
      });
      grid.append(card);
    }
    content.append(grid);
    toggle.addEventListener('click', () => {
      const nextCollapsed = !collapsedProviderGroups.has(group.id);
      if (nextCollapsed) {
        collapsedProviderGroups.add(group.id);
      } else {
        collapsedProviderGroups.delete(group.id);
      }
      section.dataset.collapsed = String(nextCollapsed);
      toggle.setAttribute('aria-expanded', String(!nextCollapsed));
      content.inert = nextCollapsed;
      content.setAttribute('aria-hidden', String(nextCollapsed));
    });
    section.append(toggle, content);
    providerGroups.append(section);
  }
}

const applyPresetUi = (preset: ClaudePreset, preserveValues: boolean): void => {
  const provider = findClaudeProvider(preset) ?? findClaudeProvider('custom');
  if (!provider) {
    return;
  }
  selectedProviderId = provider.id;
  claudePreset.value = provider.id;
  claudeConfigForm.hidden = false;
  const isOfficialLogin = provider.id === 'anthropic';
  const isAdvanced =
    provider.id === 'custom' || provider.id === 'gateway' || provider.id === 'curl';
  baseUrlField.hidden = !provider.editableBaseUrl;

  if (isAdvanced) {
    setAuthOptions(
      [
        { label: '接口密钥（X-Api-Key）', value: 'apiKey' },
        { label: '持有者令牌（Authorization / Bearer）', value: 'authToken' },
        { label: '无需认证（仅建议本机网关）', value: 'none' },
      ],
      preserveValues
        ? (claudeAuthMode.value as SaveClaudeConfigInput['authMode'])
        : provider.authMode,
    );
  } else {
    const authLabel =
      provider.authMode === 'existing'
        ? '使用 Claude Code 现有登录'
        : provider.authMode === 'apiKey'
          ? '接口密钥（X-Api-Key）'
          : provider.authMode === 'authToken'
            ? '持有者令牌（Authorization / Bearer）'
            : '无需认证';
    setAuthOptions([{ label: authLabel, value: provider.authMode }], provider.authMode);
  }

  if (!preserveValues) {
    claudeBaseUrl.value = provider.baseUrl;
    claudeModel.value = provider.model;
    claudeModelFast.value = provider.modelFast ?? provider.model;
  }
  baseUrlHelp.textContent =
    provider.id === 'gateway'
      ? '填写路由器真正的模型接口；默认 3456 是模型接口，3458 是管理页。'
      : '接口必须提供 Anthropic /v1/messages，且不能直接使用 OpenAI /chat/completions。';
  modelHelp.textContent = `主模型会同时用于默认、Opus 与 Sonnet 路由；当前推荐 ${provider.model}。`;
  authModeHelp.textContent =
    provider.authMode === 'existing'
      ? 'ClaudeDock 不读取或复用 Claude Code 的登录令牌。'
      : provider.authMode === 'apiKey'
        ? '该服务商使用 x-api-key 请求头。'
        : '该服务商使用 Authorization: Bearer 请求头。';
  authModeLabel.textContent = isOfficialLogin ? '官方认证方式' : 'Claude Code 到接口的认证方式';
  credentialLabel.textContent =
    provider.id === 'gateway' ? '路由器访问密钥（不是上游密钥）' : `${provider.label} 凭据`;
  claudeCredential.placeholder = provider.keyHint ?? '留空则保留已保存的凭据';
  credentialField.hidden =
    provider.authMode === 'existing' || provider.authMode === 'none' || provider.id === 'ollama';

  providerSetup.hidden = false;
  providerTitle.textContent = provider.label;
  providerDescription.textContent = provider.description;
  providerCaveat.hidden = !provider.caveat;
  providerCaveat.textContent = provider.caveat ?? '';
  openProviderConsoleButton.hidden = !provider.consoleUrl;
  openProviderConsoleButton.dataset.externalUrl = provider.consoleUrl ?? '';
  openProviderDocsButton.hidden = !provider.docsUrl;
  openProviderDocsButton.dataset.externalUrl = provider.docsUrl ?? '';
  moveProviderTools(provider.id);
  renderProviderPicker();
  syncConnectionInteractivity();
};

const populateClaudeConfigForm = (state: ClaudeProjectState): void => {
  const { config } = state;
  if (!claudePreset.querySelector(`option[value="${config.preset}"]`)) {
    const option = document.createElement('option');
    option.value = config.preset;
    option.textContent = findClaudeProvider(config.preset)?.label ?? config.preset;
    claudePreset.append(option);
  }
  claudePreset.value = config.preset;
  applyPresetUi(config.preset, true);
  claudeBaseUrl.value = config.baseUrl;
  claudeModel.value = config.model;
  claudeModelFast.value = config.modelFast ?? config.model;
  claudeAuthMode.value = config.authMode;
  credentialField.hidden = config.authMode === 'existing' || config.authMode === 'none';
  if (config.preset === 'ollama') {
    credentialField.hidden = true;
  }
  claudeCredential.value = '';
  credentialStatus.textContent = config.credentialConfigured
    ? '已使用 Windows 安全存储加密保存；留空将继续使用'
    : '当前项目未保存凭据';
  clearCredentialButton.disabled = !config.credentialConfigured;
  configFormSessionId = state.sessionId;
  renderProviderPicker();
};

const captureAdvancedConnectionSnapshot = (): AdvancedConnectionSnapshot => ({
  authMode: claudeAuthMode.value as SaveClaudeConfigInput['authMode'],
  baseUrl: claudeBaseUrl.value,
  controls: [
    ...connectionAdvancedContent.querySelectorAll<AdvancedDraftControl>('input, select, textarea'),
  ].map((control) => ({
    checked: control instanceof HTMLInputElement ? control.checked : undefined,
    control,
    value: control.value,
  })),
  credential: claudeCredential.value,
  model: claudeModel.value,
  modelFast: claudeModelFast.value,
  providerId: selectedProviderId,
});

const restoreAdvancedConnectionSnapshot = (snapshot: AdvancedConnectionSnapshot): void => {
  if (snapshot.providerId) {
    applyPresetUi(snapshot.providerId, true);
  } else {
    clearProviderSelection(false);
  }
  claudeBaseUrl.value = snapshot.baseUrl;
  claudeModel.value = snapshot.model;
  claudeModelFast.value = snapshot.modelFast;
  claudeAuthMode.value = snapshot.authMode;
  claudeCredential.value = snapshot.credential;
  credentialField.hidden =
    snapshot.authMode === 'existing' ||
    snapshot.authMode === 'none' ||
    snapshot.providerId === 'ollama';
  for (const state of snapshot.controls) {
    state.control.value = state.value;
    if (state.control instanceof HTMLInputElement && state.checked !== undefined) {
      state.control.checked = state.checked;
    }
  }
  renderProviderPicker();
  syncConnectionInteractivity();
};

/**
 * Every permission mode Claude Code supports, in the order the Shift+Tab cycle visits them.
 * `dontAsk` is last because it never joins the cycle: it can only be set when the session starts,
 * so choosing it relaunches the conversation.
 */
const PERMISSION_MODE_CATALOG: ReadonlyArray<{
  detail: string;
  id: ClaudePermissionMode;
  label: string;
  needsRelaunch: boolean;
}> = [
  {
    detail: '每次动作都先征求同意。',
    id: 'default',
    label: '手动确认',
    needsRelaunch: false,
  },
  {
    detail: '文件编辑自动通过，其余仍需确认。',
    id: 'acceptEdits',
    label: '自动接受编辑',
    needsRelaunch: false,
  },
  {
    detail: '只读不改，先出方案再动手。',
    id: 'plan',
    label: '计划模式',
    needsRelaunch: false,
  },
  {
    detail: '无视风险直接执行；需要在工作台预置后才能切入。',
    id: 'bypassPermissions',
    label: '完全允许',
    needsRelaunch: false,
  },
  {
    detail: '由 Claude Code 自行判断，能否使用取决于账号与模型。',
    id: 'auto',
    label: '自动选择',
    needsRelaunch: false,
  },
  {
    detail: '只放行已预先批准的动作；不在快捷键循环内，选择后会重启会话。',
    id: 'dontAsk',
    label: '仅预批准',
    needsRelaunch: true,
  },
];

const permissionModeLabel = (mode?: ClaudePermissionMode): string =>
  PERMISSION_MODE_CATALOG.find((entry) => entry.id === mode)?.label ?? '—';

const hideFooterMenus = (): void => {
  for (const [menu, trigger] of [
    [footerModelMenu, footerModel],
    [footerModeMenu, footerMode],
  ] as const) {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
};

/**
 * Anchors a footer menu above its button. The footer sits at the very bottom, so the menu always
 * opens upward; both axes are still clamped so a narrow window cannot push it off-screen.
 */
const openFooterMenu = (menu: HTMLElement, trigger: HTMLButtonElement): void => {
  hideFooterMenus();
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(triggerRect.left, window.innerWidth - menuRect.width - 8))}px`;
  menu.style.top = `${Math.max(8, triggerRect.top - menuRect.height - 8)}px`;
  menu.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
};

const buildFooterMenuItem = (
  label: string,
  detail: string,
  selected: boolean,
  onChoose: () => void,
  disabled = false,
): HTMLButtonElement => {
  const item = document.createElement('button');
  item.type = 'button';
  item.role = 'menuitem';
  item.disabled = disabled;
  item.dataset.selected = String(selected);
  const title = document.createElement('strong');
  title.textContent = label;
  const hint = document.createElement('small');
  hint.textContent = detail;
  item.append(title, hint);
  item.addEventListener('click', () => {
    hideFooterMenus();
    onChoose();
  });
  return item;
};

const openAdvancedConnectionDialog = (): void => {
  if (connectionAdvancedDialog.open) {
    return;
  }
  advancedConnectionSnapshot = captureAdvancedConnectionSnapshot();
  connectionAdvancedDialog.showModal();
};

const closeAdvancedConnectionDialog = (complete: boolean): void => {
  if (!connectionAdvancedDialog.open) {
    return;
  }
  if (!complete && advancedConnectionSnapshot) {
    restoreAdvancedConnectionSnapshot(advancedConnectionSnapshot);
  }
  advancedConnectionSnapshot = undefined;
  connectionAdvancedDialog.close(complete ? 'complete' : 'cancel');
  openConnectionAdvancedButton.focus();
};

const renderClaudeState = (state: ClaudeProjectState): void => {
  claudeStates.set(state.sessionId, state);
  if (state.permissionMode === undefined) {
    const view = terminalViews.get(state.sessionId);
    if (view) {
      view.observedPermissionMode = undefined;
    }
  }
  if (state.sessionId !== workspaceState.activeSessionId) {
    return;
  }

  const { config, installation, metrics } = state;
  const installationReady = installation.security === 'ready';
  connectionEnvironmentReady = installationReady;
  environmentSetup.hidden = installationReady;
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
    findClaudeProvider(config.preset)?.label ??
    (config.provider === 'anthropic' ? 'Anthropic 官方' : 'Anthropic 兼容网关');
  claudeRouteModel.textContent = config.model === 'default' ? '默认' : config.model;
  claudeRouteEndpoint.textContent =
    config.provider === 'anthropic'
      ? config.authMode === 'existing'
        ? '使用官方登录与默认端点'
        : '使用官方接口密钥与默认端点'
      : config.baseUrl;

  const health = state.routeHealth;
  routeHealth.hidden = !health;
  if (health) {
    routeHealth.dataset.tone = health.tone;
    routeHealthBadge.textContent =
      health.source === 'runtime'
        ? '真实会话'
        : health.source === 'router'
          ? '路由器状态'
          : '连接测试';
    routeHealthTitle.textContent = health.headline;
    routeHealthDetail.textContent = health.detail;
    routeHealthAction.hidden = health.tone === 'success';
    const notificationKey = `${health.source}:${health.tone}:${health.checkedAt}`;
    if (
      health.tone === 'error' &&
      routeHealthNotifications.get(state.sessionId) !== notificationKey
    ) {
      routeHealthNotifications.set(state.sessionId, notificationKey);
      if (!launchInProgress) {
        showToast(health.headline, 'error');
      }
    }
  }
  runClaudeButton.dataset.routeHealth = health?.tone ?? 'unknown';
  const launchBlocked = !installationReady || Boolean(health?.blocking);
  runClaudeButton.disabled = launchInProgress || launchBlocked;
  runClaudeButton.title = !installationReady
    ? installation.message
    : health?.blocking
      ? health.detail
      : '使用当前已验证配置新建独立 Claude 会话';
  // Rendered before the tone branch so a running test always wins: the footer must show progress
  // the instant the button is clicked, whatever the last recorded route health was.
  if (connectionTestInProgress) {
    footerConnection.dataset.tone = 'pending';
    footerConnection.disabled = true;
    footerConnection.setAttribute('aria-busy', 'true');
    footerConnectionLabel.textContent = '正在检测连接';
  } else {
    footerConnection.disabled = false;
    footerConnection.setAttribute('aria-busy', 'false');
    footerConnection.dataset.tone = health?.tone ?? (installationReady ? 'warning' : 'error');
    footerConnectionLabel.textContent = health
      ? health.tone === 'success'
        ? '连接正常'
        : health.tone === 'warning'
          ? '连接需确认'
          : '连接异常'
      : installationReady
        ? '连接待测试'
        : '环境未就绪';
  }

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
  footerContextRing.style.setProperty('--context-progress', `${percentage ?? 0}%`);
  footerContextRing.dataset.level = contextProgress.dataset.level;
  footerContextLabel.textContent =
    percentage === undefined ? '上下文 —' : `上下文 ${percentage.toFixed(0)}%`;
  footerModel.textContent = `模型 ${metrics?.modelDisplayName ?? metrics?.modelId ?? '—'}`;
  footerModel.disabled = modelSwitchInProgress;
  footerModel.title = state.active ? '点击切换模型' : '启动 Claude Code 后可切换模型';
  footerMode.textContent = `模式 ${permissionModeLabel(state.permissionMode)}`;
  footerMode.dataset.mode = state.permissionMode ?? 'unknown';
  footerMode.disabled = modeSwitchInProgress;
  footerMode.title = state.active
    ? '点击切换权限模式，或在终端按 Shift+Tab'
    : '启动 Claude Code 后可切换权限模式';
  allowBypassPermissions.checked = state.allowBypassPermissions;

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
    button.disabled = launchInProgress || launchBlocked;
  }

  if (configFormSessionId !== state.sessionId) {
    populateClaudeConfigForm(state);
  }
  renderProviderPicker();
  syncConnectionInteractivity();
  if (routerManagementState) {
    renderRouterRemediation(routerManagementState);
  }
  updateSmartGuidance();
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

/**
 * Resumes a stored Claude conversation in its own terminal, so a project folder can keep several
 * historical conversations running side by side instead of restarting the active one.
 */
async function resumeStoredConversation(
  projectPath: string,
  session: ClaudeSessionMetadata,
): Promise<void> {
  if (launchInProgress) {
    return;
  }
  launchInProgress = true;
  try {
    const result = await window.controlPanel.openStoredConversation(
      projectPath,
      session.conversationId,
    );
    renderWorkspace(result.state);
    if (!result.ok) {
      showToast(result.error ?? '无法恢复这个历史会话。', 'error');
      return;
    }
    const label = session.sessionName || session.sessionId.slice(0, 8);
    showToast(`已在新对话中恢复 ${label}`);
    scheduleActiveTerminalFit();
    requestComposerFocus(result.state.activeSessionId);
  } catch {
    showToast('无法恢复这个历史会话。', 'error');
  } finally {
    launchInProgress = false;
  }
}

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
  claudeModelFast.value = claudeModel.value;
  claudeAuthMode.value = candidate.authRequired ? 'authToken' : 'none';
  claudeCredential.value = '';
  credentialField.hidden = claudeAuthMode.value === 'none';
  connectionTestResult.hidden = true;
  showToast(
    candidate.authRequired
      ? `已选用 ${candidate.label}；请填写路由器自己的访问密钥`
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
        const status = activeStatus();
        if (candidate.kind === 'claude-code-router' && status) {
          void runRouterOperation(
            (sessionId) => window.controlPanel.openClaudeRouterManagement(sessionId),
            '正在打开…',
            manageButton,
          );
        } else {
          void openExternal(candidate.managementUrl ?? '');
        }
      });
      actions.append(manageButton);
    }
    if (candidate.kind === 'claude-code-router') {
      // Swapping gateways starts here, where the user actually sees what is installed.
      const purgeButton = document.createElement('button');
      purgeButton.type = 'button';
      purgeButton.textContent = '彻底清除这个路由器';
      purgeButton.addEventListener('click', () => {
        purgeRouter(purgeButton);
      });
      actions.append(purgeButton);
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

const routerProtocolLabel = (protocol: ClaudeRouterProviderView['protocol']): string =>
  protocol === 'anthropic_messages'
    ? 'Anthropic 消息协议'
    : protocol === 'openai_responses'
      ? 'OpenAI 响应协议'
      : 'OpenAI 对话补全协议';

const routerInstallationKindLabel = (
  kind: ClaudeRouterManagementState['installationKind'],
): string =>
  kind === 'desktop' ? '桌面版' : kind === 'npm' ? '命令行版' : kind === 'mixed' ? '混合' : '未知';

const routerProviderInput = (
  provider: ClaudeRouterProviderView,
  useForCurrentProject: boolean,
): SaveClaudeRouterProviderInput => ({
  baseUrl: provider.baseUrl,
  credentialAction: 'keep',
  id: provider.id,
  makePreferred: true,
  models: provider.models,
  name: provider.name,
  protocol: provider.protocol,
  useForCurrentProject,
});

const handleRouterResult = (result: ClaudeRouterOperationResult): boolean => {
  renderRouterManagement(result.routerState);
  if (result.projectState) {
    renderClaudeState(result.projectState);
    populateClaudeConfigForm(result.projectState);
  }
  showToast(result.message, result.ok ? 'success' : 'error');
  return result.ok;
};

const runRouterProviderSave = async (input: SaveClaudeRouterProviderInput): Promise<boolean> => {
  const status = activeStatus();
  if (!status || routerOperationInProgress) {
    return false;
  }
  routerOperationInProgress = true;
  renderRouterManagement(
    routerManagementState ?? {
      canUninstall: false,
      checkedAt: Date.now(),
      endpoint: 'http://127.0.0.1:3456',
      gatewayState: 'unknown',
      installed: false,
      installationKind: 'unknown',
      manageable: false,
      managementAvailable: false,
      message: '正在保存路由器服务提供方…',
      providers: [],
      serviceRunning: false,
    },
  );
  try {
    const result = await window.controlPanel.saveClaudeRouterProvider(status.id, input);
    const ok = handleRouterResult(result);
    if (ok) {
      routerProviderForm.hidden = true;
      routerProviderApiKey.value = '';
      void loadGatewayDiagnostics();
    }
    return ok;
  } catch {
    showToast('保存路由器服务提供方时发生异常。', 'error');
    return false;
  } finally {
    routerOperationInProgress = false;
    if (routerManagementState) {
      renderRouterManagement(routerManagementState);
    }
  }
};

const openRouterProviderForm = (provider?: ClaudeRouterProviderView): void => {
  routerProviderId.value = provider?.id ?? '';
  routerProviderName.value = provider?.name ?? '';
  routerProviderBaseUrl.value = provider?.baseUrl ?? '';
  routerProviderProtocol.value = provider?.protocol ?? 'openai_chat_completions';
  routerProviderModels.value = provider?.models.join('\n') ?? '';
  routerProviderApiKey.value = '';
  routerProviderPreferred.checked = provider?.preferred ?? true;
  routerProviderUseProject.checked = true;
  routerProviderFormTitle.textContent = provider ? `编辑 ${provider.name}` : '添加服务提供方';
  routerProviderForm.hidden = false;
  routerProviderForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  routerProviderName.focus();
};

const projectUsesDefaultRouter = (baseUrl: string): boolean => {
  try {
    const parsed = new URL(baseUrl);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return (
      parsed.protocol === 'http:' &&
      ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname.toLowerCase()) &&
      port === 3456
    );
  } catch {
    return false;
  }
};

const projectUsesHttpsGateway = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).protocol === 'https:';
  } catch {
    return false;
  }
};

const renderRouterRemediation = (state: ClaudeRouterManagementState): void => {
  const projectState = claudeStates.get(workspaceState.activeSessionId);
  const config = projectState?.config;
  const runtimeMismatch = state.runtimeMismatch === true;
  const noProviders = state.managementAvailable && state.providers.length === 0;
  const providerError =
    state.managementAvailable && state.providers.length > 0 && state.gatewayState === 'error';
  routerRemediation.hidden = !runtimeMismatch && !noProviders && !providerError;
  if (routerRemediation.hidden) {
    return;
  }
  configureRouterProviderButton.hidden = runtimeMismatch;
  if (runtimeMismatch) {
    repairRouterFromProjectButton.hidden = true;
    routerRemediationTitle.textContent = '解决办法：切换到 CCR 配套的 Node.js';
    routerRemediationDetail.textContent =
      'CCR 数据库没有损坏；它只是被 Electron 内置 Node.js 错误启动。点击上方“修复运行环境并重启”，ClaudeDock 会停止这个错误进程，再用 CCR 安装时的系统 Node.js 重启。服务提供方、密钥和 Codex 配置都不会被修改。';
    return;
  }
  configureRouterProviderButton.hidden = false;

  const projectUsesRouter = Boolean(
    config?.provider === 'gateway' && projectUsesDefaultRouter(config.baseUrl),
  );
  const projectHasRemoteDirect = Boolean(
    config?.provider === 'gateway' &&
    config.baseUrl &&
    projectUsesHttpsGateway(config.baseUrl) &&
    !projectUsesDefaultRouter(config.baseUrl),
  );
  const canRepairFromProject = Boolean(
    noProviders &&
    projectHasRemoteDirect &&
    config?.authMode === 'apiKey' &&
    config.credentialConfigured,
  );

  repairRouterFromProjectButton.hidden = !canRepairFromProject;
  repairRouterFromProjectButton.disabled = routerOperationInProgress;
  configureRouterProviderButton.disabled = routerOperationInProgress;
  if (noProviders) {
    routerRemediationTitle.textContent = '解决办法：先创建第一个服务提供方';
    configureRouterProviderButton.textContent = '手动添加第一个服务提供方';
    if (canRepairFromProject && config) {
      routerRemediationDetail.textContent = `可将当前项目已加密保存的 ${config.baseUrl} 接入信息导入为 Anthropic 消息协议服务提供方，随后启动 3456 并应用路由器配置。`;
    } else if (projectUsesRouter) {
      routerRemediationDetail.textContent =
        '当前项目依赖 3456，因此必须先添加服务提供方。点击下方按钮，依次填写上游协议、接口地址、模型标识和上游密钥；保存后再启动路由器。';
    } else if (projectHasRemoteDirect) {
      routerRemediationDetail.textContent =
        '已保存兼容接口，但当前认证方式无法安全自动导入。请手动添加服务提供方，保存后再启动路由器。';
    } else {
      routerRemediationDetail.textContent =
        '没有可自动导入的网关配置。点击下方按钮，依次填写上游协议、接口地址、模型标识和上游密钥；保存后再启动路由器。';
    }
    return;
  }

  repairRouterFromProjectButton.hidden = true;
  routerRemediationTitle.textContent = '解决办法：检查已有服务提供方';
  routerRemediationDetail.textContent =
    '路由器已有服务提供方，但 3456 仍未启动。请检查首选服务提供方的接口、模型和上游密钥，保存后再次点击“启动路由器”。';
  configureRouterProviderButton.textContent = '检查服务提供方';
};

const syncUpdateActionVisibility = (): void => {
  const actions = deriveUpdateActionState(softwareUpdates, pluginCatalog);
  const claudeActionVisible = actions.claudeCode !== 'hidden';
  const routerActionVisible = actions.router !== 'hidden';

  claudeInstallActions.hidden = !claudeActionVisible;
  installUpdateClaudeButton.hidden = !claudeActionVisible;
  installUpdateClaudeButton.textContent = actions.claudeCode === 'update' ? '一键更新' : '一键安装';

  routerInstallSourceField.hidden = !routerActionVisible;
  installRouterButton.hidden = !routerActionVisible;
  installRouterButton.textContent = actions.router === 'update' ? '一键更新' : '一键安装';

  pluginUpdateActions.hidden = !actions.plugins;
  updateAllPluginsButton.hidden = !actions.plugins;

  const refreshLabel =
    actions.totalAvailable > 0
      ? `检查软件与插件更新，当前发现 ${actions.totalAvailable} 项可更新`
      : '检查软件与插件更新';
  refreshUpdatesButton.dataset.update = String(actions.totalAvailable > 0);
  refreshUpdatesButton.title = refreshLabel;
  refreshUpdatesButton.setAttribute('aria-label', refreshLabel);
};

const applyRouterRelevance = (): void => {
  const advice = connectionAdviceState;
  routerManager.dataset.relevance = 'active';
  routerActions.dataset.relevance = 'active';
  const updateAvailable =
    softwareUpdates?.claudeCode.updateAvailable || softwareUpdates?.router.updateAvailable;
  connectionRailDot.hidden = (!advice || advice.tone === 'success') && !updateAvailable;
  connectionRailDot.dataset.tone = updateAvailable ? 'warning' : (advice?.tone ?? 'info');
  connectionRailDot.title = updateAvailable
    ? [
        softwareUpdates?.claudeCode.updateAvailable &&
          `Claude Code ${softwareUpdates.claudeCode.latestVersion ?? ''}`,
        softwareUpdates?.router.updateAvailable &&
          `路由器 ${softwareUpdates.router.latestVersion ?? ''}`,
      ]
        .filter(Boolean)
        .join('、')
    : (advice?.title ?? '');
};

const adviceActionLabel: Record<ClaudeConnectionAdviceAction, string> = {
  'import-curl': '粘贴中转站 cURL',
  'install-router': '安装路由器',
  'open-router-management': '打开路由器管理页',
  'save-config': '去填写接入配置',
  'start-router': '启动路由器',
  'stop-router': '停止空闲路由器',
  'switch-to-direct': '改用兼容接口',
  'switch-to-router': '改为经过路由器',
  'test-connection': '做一次真实连接测试',
};

const focusConnectionForm = (): void => {
  selectRailTab('connection');
  claudeConfigForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const runAdviceAction = (action: ClaudeConnectionAdviceAction, button: HTMLButtonElement): void => {
  switch (action) {
    case 'install-router': {
      void runRouterOperation(
        (sessionId) => window.controlPanel.installClaudeRouter(sessionId),
        '正在下载并校验…',
        button,
      );
      return;
    }
    case 'start-router': {
      void runRouterOperation(
        (sessionId) => window.controlPanel.startClaudeRouter(sessionId),
        '正在启动…',
        button,
      );
      return;
    }
    case 'stop-router': {
      void runRouterOperation(
        (sessionId) => window.controlPanel.stopClaudeRouter(sessionId),
        '正在停止…',
        button,
      );
      return;
    }
    case 'open-router-management': {
      void runRouterOperation(
        (sessionId) => window.controlPanel.openClaudeRouterManagement(sessionId),
        '正在打开…',
        button,
      );
      return;
    }
    case 'import-curl': {
      selectRailTab('connection');
      curlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      curlInput.focus();
      return;
    }
    case 'save-config': {
      focusConnectionForm();
      claudeCredential.focus();
      return;
    }
    case 'switch-to-direct': {
      claudePreset.value = 'custom';
      applyPresetUi('custom', true);
      claudeBaseUrl.value = '';
      focusConnectionForm();
      claudeBaseUrl.focus();
      showToast('已切到直连模式；填入中转站地址后保存即可');
      return;
    }
    case 'switch-to-router': {
      claudePreset.value = 'gateway';
      applyPresetUi('gateway', true);
      claudeBaseUrl.value = 'http://127.0.0.1:3456';
      focusConnectionForm();
      showToast('已填入本机路由器地址；确认模型后保存');
      return;
    }
    case 'test-connection': {
      selectRailTab('connection');
      void runConnectionTest(false);
    }
  }
};

const renderConnectionAdvice = (advice: ClaudeConnectionAdvice): void => {
  connectionAdviceState = advice;
  connectionAdvice.dataset.tone = advice.tone;
  connectionAdviceTitle.textContent = advice.title;
  connectionAdviceDetail.textContent = advice.detail;
  connectionAdviceActions.replaceChildren();

  for (const [index, action] of advice.actions.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button button--${index === 0 ? 'primary' : 'secondary'} button--small`;
    button.textContent = adviceActionLabel[action];
    button.addEventListener('click', () => {
      runAdviceAction(action, button);
    });
    connectionAdviceActions.append(button);
  }
  applyRouterRelevance();
};

const loadConnectionAdvice = async (): Promise<void> => {
  const status = activeStatus();
  if (!status || adviceRefreshInProgress) {
    return;
  }
  adviceRefreshInProgress = true;
  try {
    renderConnectionAdvice(await window.controlPanel.getClaudeConnectionAdvice(status.id));
  } catch {
    connectionAdvice.dataset.tone = 'warning';
    connectionAdviceTitle.textContent = '暂时无法判断接入方式';
    connectionAdviceDetail.textContent = '仍可手动检查下面的路由器与接入配置。';
  } finally {
    adviceRefreshInProgress = false;
  }
};

function renderRouterManagement(state: ClaudeRouterManagementState): void {
  routerManagementState = state;
  const displayState = state.installed ? state.gatewayState : 'not-installed';
  routerStatus.dataset.state = displayState;
  routerStatusTitle.textContent = !state.installed
    ? '尚未安装 Claude Code 路由器'
    : state.gatewayState === 'running'
      ? '路由器网关正在运行'
      : state.serviceRunning
        ? '路由器管理服务已运行'
        : '路由器已安装但未运行';
  routerStatusDetail.textContent = state.message;
  routerVersion.textContent = state.version ? `v${state.version}` : '版本待识别';
  renderRouterRemediation(state);
  applyRouterRelevance();

  installRouterButton.disabled = routerOperationInProgress;
  syncUpdateActionVisibility();
  uninstallRouterButton.disabled = routerOperationInProgress || !state.canUninstall;
  uninstallRouterButton.title = state.canUninstall
    ? `彻底卸载当前${routerInstallationKindLabel(state.installationKind)}安装并删除全部配置数据`
    : '未检测到需要清除的路由器程序或配置';
  // Only offer the swap guidance once the purge actually left a clean slate.
  routerSwapHint.hidden = state.installed || !routerPurgeCompleted;
  startRouterButton.textContent = state.runtimeMismatch ? '修复运行环境并重启' : '启动路由器';
  startRouterButton.disabled =
    routerOperationInProgress ||
    !state.installed ||
    !state.manageable ||
    (!state.runtimeMismatch && state.providers.length === 0) ||
    state.gatewayState === 'running' ||
    state.gatewayState === 'starting';
  stopRouterButton.disabled =
    routerOperationInProgress || !state.serviceRunning || state.gatewayState !== 'running';
  openRouterManagementButton.disabled =
    routerOperationInProgress || !state.installed || !state.manageable;
  addRouterProviderButton.disabled = routerOperationInProgress || !state.managementAvailable;
  saveRouterProviderButton.disabled = routerOperationInProgress;
  if (lastCurlAnalysis?.protocol === 'openai') {
    importCurlRouterButton.hidden =
      !lastCurlAnalysis.model ||
      !lastCurlAnalysis.credentialDetected ||
      !state.installed ||
      !state.manageable;
  }

  routerProviderList.replaceChildren();
  if (!state.managementAvailable) {
    const empty = document.createElement('div');
    empty.className = 'router-provider-empty';
    const copy = document.createElement('span');
    copy.textContent = state.installed
      ? '启动路由器后即可在这里增删、编辑网关服务提供方。'
      : '完成路由器安装后，点击“启动路由器”即可管理网关。';
    empty.append(copy);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'button button--secondary button--small';
    action.textContent = state.installed ? '启动路由器以管理网关' : '安装路由器';
    action.disabled = routerOperationInProgress;
    action.addEventListener('click', () => {
      void runRouterOperation(
        (sessionId) =>
          state.installed
            ? window.controlPanel.startClaudeRouter(sessionId)
            : window.controlPanel.installClaudeRouterFromSource(
                sessionId,
                routerInstallSource.value as 'github' | 'npm' | 'npmmirror',
              ),
        state.installed ? '正在启动…' : '正在安装…',
        action,
      );
    });
    empty.append(action);
    routerProviderList.append(empty);
    updateSmartGuidance();
    return;
  }
  if (state.providers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'router-provider-empty';
    const copy = document.createElement('span');
    copy.textContent = '还没有服务提供方；可手动添加，或粘贴 OpenAI cURL 后一键导入。';
    empty.append(copy);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'button button--secondary button--small';
    action.textContent = '添加第一个服务提供方';
    action.disabled = routerOperationInProgress;
    action.addEventListener('click', () => {
      openRouterProviderForm();
    });
    empty.append(action);
    routerProviderList.append(empty);
    updateSmartGuidance();
    return;
  }

  for (const provider of state.providers) {
    const card = document.createElement('article');
    card.className = 'router-provider-card';
    const headline = document.createElement('div');
    headline.className = 'router-provider-card__headline';
    const title = document.createElement('strong');
    title.textContent = provider.name;
    const badge = document.createElement('span');
    badge.textContent = provider.preferred ? '首选' : routerProtocolLabel(provider.protocol);
    headline.append(title, badge);

    const endpoint = document.createElement('code');
    endpoint.textContent = provider.baseUrl;
    const meta = document.createElement('span');
    meta.textContent = `${routerProtocolLabel(provider.protocol)} · ${
      provider.credentialConfigured ? '已保存上游密钥' : '未保存上游密钥'
    }`;
    const models = document.createElement('small');
    models.textContent = `模型：${provider.models.join('、') || '未配置'}`;

    const actions = document.createElement('div');
    actions.className = 'router-provider-card__actions';
    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.textContent = '用于当前项目';
    useButton.disabled =
      provider.models.length === 0 ||
      !/^[A-Za-z0-9._-]+$/.test(provider.name) ||
      provider.models.some((model) => !/^[A-Za-z0-9._/-]+$/.test(model));
    useButton.addEventListener('click', () => {
      void runRouterProviderSave(routerProviderInput(provider, true));
    });
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.textContent = '编辑';
    editButton.addEventListener('click', () => {
      openRouterProviderForm(provider);
    });
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', async () => {
      const status = activeStatus();
      if (
        !status ||
        routerOperationInProgress ||
        !window.confirm(`从路由器删除服务提供方“${provider.name}”？`)
      ) {
        return;
      }
      routerOperationInProgress = true;
      try {
        handleRouterResult(
          await window.controlPanel.deleteClaudeRouterProvider(status.id, provider.id),
        );
        void loadGatewayDiagnostics();
      } catch {
        showToast('删除路由器服务提供方时发生异常。', 'error');
      } finally {
        routerOperationInProgress = false;
        if (routerManagementState) {
          renderRouterManagement(routerManagementState);
        }
      }
    });
    actions.append(useButton, editButton, deleteButton);
    card.append(headline, endpoint, meta, models, actions);
    routerProviderList.append(card);
  }
  updateSmartGuidance();
}

const loadRouterManagement = async (): Promise<void> => {
  const status = activeStatus();
  if (!status || routerRefreshInProgress || routerOperationInProgress) {
    return;
  }
  routerRefreshInProgress = true;
  try {
    renderRouterManagement(await window.controlPanel.getClaudeRouterManagementState(status.id));
  } catch {
    routerStatus.dataset.state = 'error';
    routerStatusTitle.textContent = '无法读取路由器状态';
    routerStatusDetail.textContent = '仍可使用下方手动 Claude 接入配置。';
  } finally {
    routerRefreshInProgress = false;
  }
};

const runRouterOperation = async (
  action: (sessionId: string) => Promise<ClaudeRouterOperationResult>,
  busyLabel: string,
  button: HTMLButtonElement,
): Promise<void> => {
  const status = activeStatus();
  if (!status || routerOperationInProgress) {
    return;
  }
  routerOperationInProgress = true;
  await runGuarded(button, busyLabel, async () => {
    try {
      handleRouterResult(await action(status.id));
      void loadGatewayDiagnostics();
      void loadSoftwareUpdates(false);
    } catch {
      showToast('路由器操作发生异常。', 'error');
    } finally {
      routerOperationInProgress = false;
      if (routerManagementState) {
        renderRouterManagement(routerManagementState);
      }
    }
  });
};

/**
 * The purge is irreversible — CCR keeps the upstream keys inside the data directory that gets
 * deleted — so the confirmation spells out exactly what disappears before anything runs.
 */
const purgeRouter = (button: HTMLButtonElement): void => {
  if (
    !window.confirm(
      '彻底卸载路由器并清除全部数据？\n\n' +
        '将删除：路由器程序、全部服务提供方配置、保存在其中的上游密钥与用量记录。\n' +
        '不会改动：Claude Code 与 Codex 自己的配置。\n\n' +
        '删除后无法恢复；完成后可以选择新的安装来源重新安装。',
    )
  ) {
    return;
  }
  void runRouterOperation(
    async (sessionId) => {
      const result = await window.controlPanel.uninstallClaudeRouter(sessionId);
      routerPurgeCompleted = result.ok;
      return result;
    },
    '正在清除…',
    button,
  );
};

const uniqueCurlProviderName = (analysis: ClaudeCurlAnalysis): string => {
  const base =
    new URL(analysis.endpoint).hostname
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'openai-relay';
  const names = new Set((routerManagementState?.providers ?? []).map((provider) => provider.name));
  if (!names.has(base)) {
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base.slice(0, 55)}-${index}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  return `${base.slice(0, 45)}-${Date.now()}`;
};

const importCurlIntoRouter = async (): Promise<void> => {
  const analysis = lastCurlAnalysis;
  const status = activeStatus();
  if (
    !analysis ||
    analysis.protocol !== 'openai' ||
    !analysis.model ||
    !analysis.credential ||
    !status ||
    routerOperationInProgress
  ) {
    showToast('cURL 需要同时包含 OpenAI 接口、模型和新密钥。', 'error');
    return;
  }

  if (!routerManagementState?.managementAvailable) {
    const startResult = await window.controlPanel.startClaudeRouter(status.id);
    renderRouterManagement(startResult.routerState);
    if (!startResult.routerState.managementAvailable) {
      showToast(startResult.message, 'error');
      return;
    }
  }
  const existing = routerManagementState?.providers.find(
    (provider) => provider.baseUrl.replace(/\/+$/, '') === analysis.endpoint.replace(/\/+$/, ''),
  );
  const imported = await runRouterProviderSave({
    apiKey: analysis.credential,
    baseUrl: analysis.endpoint,
    credentialAction: 'replace',
    id: existing?.id,
    makePreferred: true,
    models: [analysis.model],
    name: existing?.name ?? uniqueCurlProviderName(analysis),
    protocol: 'openai_chat_completions',
    useForCurrentProject: true,
  });
  if (imported) {
    curlInput.value = '';
    lastCurlAnalysis = undefined;
    curlAnalysis.hidden = true;
    importCurlRouterButton.hidden = true;
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
        ? `持有者令牌（Authorization / Bearer）${analysis.credentialDetected ? ' · 已识别密钥但不显示' : ''}`
        : analysis.authMode === 'apiKey'
          ? `接口密钥（x-api-key）${analysis.credentialDetected ? ' · 已识别密钥但不显示' : ''}`
          : '没有识别到认证头';
    curlNextStep.replaceChildren();

    const router = preferredRouter();
    applyCurlDirectButton.hidden = analysis.protocol !== 'anthropic';
    importCurlRouterButton.hidden =
      analysis.protocol !== 'openai' ||
      !analysis.model ||
      !analysis.credentialDetected ||
      !routerManagementState?.installed ||
      !routerManagementState.manageable;
    useDetectedRouterButton.hidden = analysis.protocol !== 'openai' || !router;
    openDetectedRouterButton.hidden = analysis.protocol !== 'openai' || !router?.managementUrl;

    const nextTitle = document.createElement('strong');
    const nextDetail = document.createElement('span');
    if (analysis.protocol === 'anthropic') {
      nextTitle.textContent = '下一步：自动填入并执行真实测试';
      nextDetail.textContent = '确认测试通过后再保存；保存时密钥才会进入 Windows 安全存储。';
    } else if (analysis.protocol === 'openai') {
      nextTitle.textContent = router
        ? '下一步：先在路由器管理页添加这个上游'
        : '下一步：先安装并启动本地转换器';
      nextDetail.textContent = router
        ? `服务提供方选择 OpenAI 兼容协议，接口填 ${analysis.endpoint}，模型填 ${
            analysis.model || '服务商提供的模型名'
          }；上游密钥只填在路由器中。然后回到这里选用 3456。`
        : '推荐从下方打开 Claude Code 路由器图形版安装页。配置完成后，重新检测会自动发现 3456。';
    } else {
      nextTitle.textContent = '下一步：向服务商确认协议';
      nextDetail.textContent = '需要明确询问：“是否提供 Anthropic 消息协议的 /v1/messages 接口？”';
    }
    curlNextStep.append(nextTitle, nextDetail);
    updateSmartGuidance();
  } catch (error) {
    lastCurlAnalysis = undefined;
    curlAnalysis.hidden = true;
    importCurlRouterButton.hidden = true;
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
  claudeModelFast.value = analysis.model;
  claudeAuthMode.value = analysis.authMode;
  claudeCredential.value = analysis.credential ?? '';
  credentialField.hidden = analysis.authMode === 'none';
  connectionTestResult.hidden = true;
  claudeConfigForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('已填入直连接口；请先进行真实连接测试');
  updateSmartGuidance();
};

const updateSmartGuidance = (): void => {
  const projectState = claudeStates.get(workspaceState.activeSessionId);
  const curlResult = lastCurlAnalysis;
  const routerState = routerManagementState;

  // Guidance here is strictly about the pasted cURL. The project-level "how should this connect"
  // question is answered unconditionally by #connection-advice, so there is nothing to say yet.
  if (!curlResult) {
    smartGuidance.hidden = true;
    return;
  }

  const projectConfig = projectState?.config;
  const routerRunning = routerState?.gatewayState === 'running';
  const routerInstalled = routerState?.installed ?? false;

  // Scenario 1: Anthropic direct + Router running unused
  if (
    curlResult.protocol === 'anthropic' &&
    routerRunning &&
    projectConfig?.provider !== 'gateway'
  ) {
    smartGuidance.hidden = false;
    smartGuidance.dataset.tone = 'info';
    smartGuidanceTitle.textContent = '检测到可直连的 Anthropic 接口';
    smartGuidanceDetail.textContent =
      '路由器当前未被使用。您可以直接接入，或者停止路由器以节省系统资源。';

    smartGuidanceActions.replaceChildren();
    const stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.textContent = '停止空闲路由器';
    stopButton.className = 'button button--secondary button--small';
    stopButton.addEventListener('click', () => {
      void runRouterOperation(
        (sessionId) => window.controlPanel.stopClaudeRouter(sessionId),
        '正在停止…',
        stopButton,
      );
    });
    smartGuidanceActions.append(stopButton);
    return;
  }

  // Scenario 2: OpenAI format + Router not running
  if (curlResult.protocol === 'openai' && !routerRunning) {
    smartGuidance.hidden = false;
    smartGuidance.dataset.tone = 'warning';
    smartGuidanceTitle.textContent = 'OpenAI 格式需要转换器';
    smartGuidanceDetail.textContent = routerInstalled
      ? '检测到 OpenAI 格式接口，需要先启动路由器将其转换为 Anthropic 格式。'
      : '检测到 OpenAI 格式接口，需要安装 Claude Code 路由器转换器。';

    smartGuidanceActions.replaceChildren();
    if (routerInstalled && curlResult.model && curlResult.credentialDetected) {
      const importButton = document.createElement('button');
      importButton.type = 'button';
      importButton.textContent = '一键导入路由器';
      importButton.className = 'button button--primary button--small';
      importButton.addEventListener('click', () => {
        void importCurlIntoRouter();
      });
      smartGuidanceActions.append(importButton);
    } else if (!routerInstalled) {
      const installButton = document.createElement('button');
      installButton.type = 'button';
      installButton.textContent = '安装路由器';
      installButton.className = 'button button--primary button--small';
      installButton.addEventListener('click', () => {
        void runRouterOperation(
          (sessionId) => window.controlPanel.installClaudeRouter(sessionId),
          '正在下载…',
          installButton,
        );
      });
      smartGuidanceActions.append(installButton);
    }
    return;
  }

  // Scenario 3: Project using Router + Router stopped
  if (
    projectConfig?.provider === 'gateway' &&
    projectConfig.baseUrl.includes('127.0.0.1:3456') &&
    routerState?.gatewayState === 'stopped'
  ) {
    smartGuidance.hidden = false;
    smartGuidance.dataset.tone = 'error';
    smartGuidanceTitle.textContent = '当前项目依赖路由器';
    smartGuidanceDetail.textContent = '项目配置指向本地路由器，但网关未运行。请启动路由器。';

    smartGuidanceActions.replaceChildren();
    const startButton = document.createElement('button');
    startButton.type = 'button';
    startButton.textContent = '启动路由器';
    startButton.className = 'button button--primary button--small';
    startButton.addEventListener('click', () => {
      void runRouterOperation(
        (sessionId) => window.controlPanel.startClaudeRouter(sessionId),
        '正在启动…',
        startButton,
      );
    });
    smartGuidanceActions.append(startButton);
    return;
  }

  // No guidance needed
  smartGuidance.hidden = true;
};

const renderConnectionTest = (result: ClaudeConnectionTestResult): void => {
  connectionTestResult.hidden = false;
  connectionTestResult.dataset.tone = result.tone;
  connectionTestResult.setAttribute('aria-busy', 'false');
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

  const projectState = claudeStates.get(workspaceState.activeSessionId);
  const remedy = diagnoseClaudeConnection(result, {
    installationSecurity: projectState?.installation.security,
    provider: findClaudeProvider(selectedProviderId),
    routerInstalled: routerManagementState?.installed,
    routerRunning: routerManagementState?.gatewayState === 'running',
  });
  connectionRemedy.hidden = !remedy;
  connectionRemedyActions.replaceChildren();
  if (!remedy) {
    return;
  }
  connectionRemedyTitle.textContent = remedy.title;
  connectionRemedyCause.textContent = `原因：${remedy.cause}`;
  connectionRemedyFix.textContent = `建议：${remedy.fix}`;
  for (const action of remedy.actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      void runGuarded(button, '处理中…', () => handleConnectionRemedyAction(action));
    });
    connectionRemedyActions.append(button);
  }
};

const handleConnectionRemedyAction = async (
  action: ClaudeConnectionRemedyAction,
): Promise<void> => {
  switch (action.kind) {
    case 'open-console':
    case 'open-docs':
      if (action.url) {
        await openExternal(action.url);
      }
      break;
    case 'switch-auth-mode':
      if (
        action.authMode &&
        Array.from(claudeAuthMode.options).some((option) => option.value === action.authMode)
      ) {
        claudeAuthMode.value = action.authMode;
      } else {
        setAuthOptions(
          [
            { label: '接口密钥（X-Api-Key）', value: 'apiKey' },
            { label: '持有者令牌（Authorization / Bearer）', value: 'authToken' },
          ],
          action.authMode,
        );
      }
      credentialField.hidden = false;
      claudeCredential.focus();
      break;
    case 'use-fast-model': {
      const provider = findClaudeProvider(selectedProviderId);
      if (provider?.modelFast) {
        claudeModel.value = provider.modelFast;
        claudeModelFast.value = provider.modelFast;
      }
      break;
    }
    case 'install-claude':
      environmentSetup.hidden = false;
      environmentSetup.scrollIntoView({ behavior: 'smooth', block: 'start' });
      await runClaudeInstallUpdate();
      break;
    case 'install-router':
      selectedProviderId = 'gateway';
      applyPresetUi('gateway', false);
      await runRouterOperation(
        (sessionId) =>
          window.controlPanel.installClaudeRouterFromSource(
            sessionId,
            routerInstallSource.value as 'github' | 'npm' | 'npmmirror',
          ),
        '正在安装…',
        installRouterButton,
      );
      break;
    case 'start-router':
      await runRouterOperation(
        (sessionId) => window.controlPanel.startClaudeRouter(sessionId),
        '正在启动…',
        startRouterButton,
      );
      break;
    case 'retry':
      await runConnectionTest(false);
      break;
    case 'switch-provider':
      clearProviderSelection();
      providerPicker.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
  }
};

const renderConnectionTestPending = (): void => {
  connectionTestResult.hidden = false;
  connectionTestResult.dataset.tone = 'pending';
  connectionTestResult.setAttribute('aria-busy', 'true');
  connectionTestTitle.textContent = '后台正在测试连接';
  connectionTestSummary.textContent = '界面与 PowerShell 仍可继续使用；真实请求最多等待 15 秒。';
  connectionTestStages.replaceChildren();
};

const runConnectionTest = async (
  saveOnSuccess = true,
  configInput?: SaveClaudeConfigInput,
): Promise<void> => {
  const status = activeStatus();
  if (!status || connectionTestInProgress) {
    return;
  }
  connectionTestInProgress = true;
  renderConnectionTestPending();
  const knownState = claudeStates.get(status.id);
  if (knownState) {
    renderClaudeState(knownState);
  }
  await runGuarded(testClaudeConnectionButton, '正在发送单令牌测试…', async () => {
    syncConnectionInteractivity();
    try {
      const result = await window.controlPanel.testClaudeConnection(
        status.id,
        configInput ?? currentConfigInput('keep'),
      );
      renderConnectionTest(result);
      if (result.ok && saveOnSuccess) {
        await saveClaudeConfig('keep');
      } else {
        void loadClaudeState(status.id);
      }
    } catch {
      connectionTestResult.dataset.tone = 'error';
      connectionTestTitle.textContent = '连接测试发生异常';
      connectionTestSummary.textContent = '后台测试已结束，请稍后重试。';
      connectionTestStages.replaceChildren();
      connectionRemedy.hidden = true;
      showToast('连接测试发生异常。', 'error');
    } finally {
      connectionTestInProgress = false;
      connectionTestResult.setAttribute('aria-busy', 'false');
      syncConnectionInteractivity();
      const latestState = claudeStates.get(status.id);
      if (latestState) {
        renderClaudeState(latestState);
      }
    }
  });
};

const setWorkbenchOpen = (open: boolean): void => {
  claudeWorkbench.classList.toggle('claude-workbench--open', open);
  claudeWorkbench.setAttribute('aria-hidden', String(!open));
  workbenchScrim.classList.toggle('workbench-scrim--visible', open);
  workbenchTrigger.setAttribute('aria-expanded', String(open));
  if (open && workspaceState.activeSessionId) {
    void loadClaudeState(workspaceState.activeSessionId);
    void loadConnectionAdvice();
  }
};

/**
 * Restarts the PTY and reattaches with `--continue`. Used by both cross-endpoint model switches and
 * by 「仅预批准」, which Claude Code only accepts as a launch argument. Compaction is offered because
 * the restored history may not fit a model whose context window is narrower than the current one's.
 */
const relaunchClaudeSession = async (
  summary: string,
  input: Omit<ClaudeRelaunchInput, 'compactFirst'>,
): Promise<void> => {
  const status = activeStatus();
  if (!status || launchInProgress) {
    return;
  }
  if (
    !window.confirm(
      `${summary}\n\n这需要重启 Claude Code 会话。对话历史会通过 --continue 恢复，但终端画面会重绘。\n\n确定后会先压缩上下文再重启。`,
    )
  ) {
    return;
  }

  launchInProgress = true;
  const known = claudeStates.get(status.id);
  if (known) {
    renderClaudeState(known);
  }
  try {
    const result = await window.controlPanel.relaunchClaudeSession(status.id, {
      ...input,
      compactFirst: true,
    });
    renderClaudeState(result.state);
    showToast(
      result.ok ? '会话已重启并恢复上下文。' : (result.error ?? '重启会话失败。'),
      result.ok ? 'success' : 'error',
    );
  } catch {
    showToast('重启会话时发生异常。', 'error');
  } finally {
    launchInProgress = false;
    void loadClaudeState(status.id);
  }
};

const switchClaudeModel = async (option: ClaudeModelOption): Promise<void> => {
  const status = activeStatus();
  if (!status || modelSwitchInProgress) {
    return;
  }
  if (!option.sameEndpoint) {
    await relaunchClaudeSession(
      `切换到「${option.providerLabel} · ${option.model}」需要更换接口地址与凭据。`,
      { entryId: option.entryId },
    );
    return;
  }

  modelSwitchInProgress = true;
  footerModel.disabled = true;
  try {
    const result = await window.controlPanel.switchClaudeModel(status.id, option.id);
    renderClaudeState(result.state);
    if (!result.ok) {
      showToast(result.error ?? '无法切换模型。', 'error');
    }
  } catch {
    showToast('切换模型时发生异常。', 'error');
  } finally {
    modelSwitchInProgress = false;
    void loadClaudeState(status.id);
  }
};

const switchPermissionMode = async (mode: ClaudePermissionMode): Promise<void> => {
  const status = activeStatus();
  if (!status || modeSwitchInProgress) {
    return;
  }
  if (mode === 'dontAsk') {
    await relaunchClaudeSession('「仅预批准」只能在会话启动时设定。', { permissionMode: mode });
    return;
  }

  modeSwitchInProgress = true;
  footerMode.disabled = true;
  try {
    const result = await window.controlPanel.setClaudePermissionMode(status.id, mode);
    renderClaudeState(result.state);
    if (!result.ok) {
      showToast(result.error ?? '无法切换权限模式。', 'error');
    }
  } catch {
    showToast('切换权限模式时发生异常。', 'error');
  } finally {
    modeSwitchInProgress = false;
    void loadClaudeState(status.id);
  }
};

const openModelMenu = async (): Promise<void> => {
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
        option.sameEndpoint ? option.providerLabel : `${option.providerLabel} · 需重启会话`,
        option.model === options.activeModel,
        () => {
          void switchClaudeModel(option);
        },
        !running,
      ),
    ),
  );
  if (!running) {
    const hint = document.createElement('p');
    hint.className = 'footer-menu__hint';
    hint.textContent = '请先在工作台启动 Claude Code 会话。';
    footerModelMenu.append(hint);
  }
  openFooterMenu(footerModelMenu, footerModel);
};

const openModeMenu = (): void => {
  const status = activeStatus();
  if (!status) {
    return;
  }

  const state = claudeStates.get(status.id);
  const running = state?.active ?? false;
  footerModeMenu.replaceChildren(
    ...PERMISSION_MODE_CATALOG.map((entry) =>
      buildFooterMenuItem(
        entry.label,
        entry.id === 'bypassPermissions' && !state?.allowBypassPermissions
          ? '当前项目未预置此模式，请在工作台开启后重新启动会话。'
          : entry.detail,
        entry.id === state?.permissionMode,
        () => {
          void switchPermissionMode(entry.id);
        },
        !running ||
          (entry.id === 'bypassPermissions' && !state?.allowBypassPermissions) ||
          (!entry.needsRelaunch && entry.id === state?.permissionMode),
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

/**
 * The connection page polls, because Router state changes underneath us (installs, crashes, the
 * user starting CCR by hand). Nothing else needs a timer, so it only runs while that tab is open.
 */
const setConnectionPolling = (enabled: boolean): void => {
  if (enabled) {
    void loadGatewayDiagnostics();
    void loadRouterManagement();
    void loadConnectionAdvice();
    void loadSoftwareUpdates(false);
    if (gatewayRefreshTimer === undefined) {
      gatewayRefreshTimer = window.setInterval(() => {
        if (connectionTestInProgress) {
          return;
        }
        void loadGatewayDiagnostics();
        void loadRouterManagement();
        void loadConnectionAdvice();
        void loadSoftwareUpdates(false);
      }, 6_000);
    }
    return;
  }
  if (gatewayRefreshTimer !== undefined) {
    window.clearInterval(gatewayRefreshTimer);
    gatewayRefreshTimer = undefined;
  }
};

const applyRailTab = (tab?: string): void => {
  selectedRailTab = tab;
  const collapsed = tab === undefined;
  workspace.classList.toggle('workspace--rail-collapsed', collapsed);
  workspace.dataset.railPanel = tab ?? 'collapsed';
  controlPanel.inert = collapsed;
  controlPanel.setAttribute('aria-hidden', String(collapsed));
  panelResizer.tabIndex = collapsed ? -1 : 0;
  for (const button of activityRail.querySelectorAll<HTMLButtonElement>('[data-rail-tab]')) {
    const selected = button.dataset.railTab === tab;
    button.classList.toggle('activity-rail__button--active', selected);
    button.setAttribute('aria-expanded', String(selected));
    button.setAttribute('aria-pressed', String(selected));
    const label = button.querySelector<HTMLElement>('span:not(.activity-rail__dot)')?.textContent;
    button.title = selected ? `${label ?? '侧栏'}（再次点击可收起侧栏）` : (label ?? '打开侧栏');
  }
  for (const page of document.querySelectorAll<HTMLElement>('[data-rail-page]')) {
    page.classList.toggle('rail-page--active', page.dataset.railPage === tab);
  }
  setConnectionPolling(tab === 'connection');
  if (tab === 'plugins') {
    void loadPluginCatalog(false);
  }
  scheduleActiveTerminalFit();
};

function selectRailTab(tab: string): void {
  applyRailTab(tab);
}

const toggleRailTab = (tab: string): void => {
  applyRailTab(selectedRailTab === tab ? undefined : tab);
};

const selectWorkbenchPage = (page: string): void => {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-workbench-tab]')) {
    tab.classList.toggle('workbench-tab--active', tab.dataset.workbenchTab === page);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-workbench-page]')) {
    panel.classList.toggle('workbench-page--active', panel.dataset.workbenchPage === page);
  }
};

const pluginKey = (plugin: ClaudePluginView): string =>
  `${plugin.marketplaceName}/${plugin.name}`.toLowerCase();

const pluginMatchesSearch = (plugin: ClaudePluginView, needle: string): boolean =>
  needle === '' ||
  (() => {
    const localized = localizePluginCopy(plugin);
    return [
      plugin.name,
      plugin.description,
      plugin.marketplaceName,
      plugin.sourceLabel,
      localized.category,
      localized.description,
    ].some((field) => field.toLowerCase().includes(needle));
  })();

const selectPluginTab = (tab: string): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-plugin-tab]')) {
    button.classList.toggle('plugin-tab--active', button.dataset.pluginTab === tab);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-plugin-panel]')) {
    panel.classList.toggle('plugin-panel--active', panel.dataset.pluginPanel === tab);
  }
};

const renderSoftwareUpdates = (state: SoftwareUpdateState): void => {
  softwareUpdates = state;
  const target = state.claudeCode;
  claudeUpdateDetail.textContent = target.message;
  claudeUpdateVersion.textContent = target.installed
    ? `v${target.currentVersion ?? '未知'}${target.updateAvailable ? ` → ${target.latestVersion}` : ''}`
    : target.latestVersion
      ? `可安装 v${target.latestVersion}`
      : '未安装';
  claudeUpdateVersion.dataset.update = String(target.updateAvailable);
  installUpdateClaudeButton.disabled = softwareUpdateInProgress;
  softwareUpdateCheckedAt.textContent = `上次检查 ${new Date(state.checkedAt).toLocaleTimeString(
    'zh-CN',
    { hour: '2-digit', minute: '2-digit' },
  )}`;
  syncUpdateActionVisibility();
  applyRouterRelevance();
};

const loadSoftwareUpdates = (refresh = false): Promise<void> => {
  if (softwareUpdatePromise) {
    return softwareUpdatePromise;
  }
  if (softwareUpdateInProgress) {
    return Promise.resolve();
  }
  softwareUpdateInProgress = true;
  softwareUpdatePromise = (async () => {
    try {
      renderSoftwareUpdates(await window.controlPanel.getSoftwareUpdates(refresh));
    } catch {
      claudeUpdateDetail.textContent = '暂时无法读取软件版本，请检查网络后重试。';
    } finally {
      softwareUpdateInProgress = false;
      softwareUpdatePromise = undefined;
      installUpdateClaudeButton.disabled = false;
      syncUpdateActionVisibility();
    }
  })();
  return softwareUpdatePromise;
};

const runClaudeInstallUpdate = async (): Promise<void> => {
  if (softwareUpdateInProgress) {
    return;
  }
  softwareUpdateInProgress = true;
  installUpdateClaudeButton.disabled = true;
  const original = installUpdateClaudeButton.textContent;
  installUpdateClaudeButton.textContent = '正在安装，请稍候…';
  try {
    const result = await window.controlPanel.installOrUpdateClaudeCode(
      claudeInstallSource.value as 'native' | 'npm' | 'npmmirror',
    );
    renderSoftwareUpdates(result.state);
    showToast(result.message, result.ok ? 'success' : 'error');
    const status = activeStatus();
    if (status) {
      void loadClaudeState(status.id);
    }
  } catch {
    showToast('Claude Code 安装或更新发生异常。', 'error');
  } finally {
    softwareUpdateInProgress = false;
    installUpdateClaudeButton.textContent = original;
    installUpdateClaudeButton.disabled = false;
    syncUpdateActionVisibility();
  }
};

const runPluginMutation = async (
  operation: () => Promise<ClaudePluginOperationResult>,
  busyLabel: string,
  button: HTMLButtonElement,
): Promise<void> => {
  if (pluginMutationInProgress) {
    return;
  }
  pluginMutationInProgress = true;
  const originalLabel = button.textContent;
  button.textContent = busyLabel;
  button.disabled = true;
  pluginStatus.textContent = `${busyLabel}这一步会调用 claude 命令行，可能需要几十秒。`;
  try {
    const result = await operation();
    renderPluginCatalog(result.catalog);
    showToast(result.message, result.ok ? 'success' : 'error');
  } catch {
    showToast('插件操作发生异常。', 'error');
  } finally {
    pluginMutationInProgress = false;
    button.textContent = originalLabel;
    button.disabled = false;
  }
};

const pluginActionButton = (
  label: string,
  variant: 'primary' | 'quiet' | 'secondary',
  busyLabel: string,
  operation: () => Promise<ClaudePluginOperationResult>,
): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button button--${variant} button--small`;
  button.textContent = label;
  button.disabled = pluginMutationInProgress;
  button.addEventListener('click', () => {
    void runPluginMutation(operation, busyLabel, button);
  });
  return button;
};

const renderPluginCard = (plugin: ClaudePluginView): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'plugin-card';
  card.dataset.enabled = String(plugin.enabled);

  const header = document.createElement('div');
  header.className = 'plugin-card__header';
  const title = document.createElement('strong');
  title.textContent = plugin.name;
  const badge = document.createElement('span');
  badge.className = 'plugin-card__badge';
  badge.textContent = plugin.updateAvailable
    ? '可更新'
    : plugin.installed
      ? plugin.enabled
        ? '已启用'
        : '已停用'
      : '未安装';
  badge.dataset.update = String(plugin.updateAvailable);
  header.append(title, badge);

  const localized = localizePluginCopy(plugin);
  const description = document.createElement('p');
  description.textContent = localized.description;

  const meta = document.createElement('div');
  meta.className = 'plugin-card__meta';
  const source = document.createElement('span');
  source.textContent = plugin.sourceLabel;
  const category = document.createElement('span');
  category.className = 'plugin-card__category';
  category.textContent = localized.category;
  meta.append(category, source);
  if (plugin.version) {
    const version = document.createElement('span');
    version.textContent = `v${plugin.version}`;
    meta.append(version);
  }
  if (plugin.latestVersion && plugin.updateAvailable) {
    const latest = document.createElement('span');
    latest.textContent = `最新 v${plugin.latestVersion}`;
    meta.append(latest);
  }
  if (plugin.scope) {
    const scope = document.createElement('span');
    scope.textContent =
      plugin.scope === 'user' ? '用户级' : plugin.scope === 'project' ? '项目级' : '本机级';
    meta.append(scope);
  }
  if (plugin.installCount !== undefined) {
    const installs = document.createElement('span');
    installs.textContent = `${formatTokenCount(plugin.installCount)} 次安装`;
    meta.append(installs);
  }

  const actions = document.createElement('div');
  actions.className = 'plugin-card__actions';
  if (plugin.installed) {
    actions.append(
      pluginActionButton(
        plugin.enabled ? '停用' : '启用',
        'secondary',
        plugin.enabled ? '正在停用…' : '正在启用…',
        () => window.controlPanel.setClaudePluginEnabled(plugin.pluginId, !plugin.enabled),
      ),
    );
    if (plugin.updateAvailable) {
      actions.append(
        pluginActionButton('更新', 'quiet', '正在更新…', () =>
          window.controlPanel.updateClaudePlugin(plugin.pluginId),
        ),
      );
    }
    const uninstall = document.createElement('button');
    uninstall.type = 'button';
    uninstall.className = 'button button--quiet button--small plugin-card__danger';
    uninstall.textContent = '卸载';
    uninstall.disabled = pluginMutationInProgress;
    uninstall.addEventListener('click', () => {
      if (!window.confirm(`卸载插件“${plugin.name}”？`)) {
        return;
      }
      void runPluginMutation(
        () => window.controlPanel.uninstallClaudePlugin(plugin.pluginId),
        '正在卸载…',
        uninstall,
      );
    });
    actions.append(uninstall);
  } else {
    actions.append(
      pluginActionButton('安装', 'primary', '正在安装…', () =>
        window.controlPanel.installClaudePlugin(plugin.pluginId),
      ),
    );
  }

  card.append(header, description, meta, actions);
  return card;
};

const renderPluginList = (
  container: HTMLElement,
  plugins: ClaudePluginView[],
  emptyMessage: string,
): void => {
  container.replaceChildren();
  if (plugins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }
  for (const plugin of plugins) {
    container.append(renderPluginCard(plugin));
  }
};

function renderPluginCatalog(catalog: ClaudePluginCatalog): void {
  pluginCatalog = catalog;
  const needle = pluginSearch.value.trim().toLowerCase();
  const installed = catalog.installed.filter((plugin) => pluginMatchesSearch(plugin, needle));
  const installedKeys = new Set(catalog.installed.map(pluginKey));
  const available = catalog.available
    .filter((plugin) => !installedKeys.has(pluginKey(plugin)))
    .filter((plugin) => pluginMatchesSearch(plugin, needle));

  pluginInstalledCount.textContent = String(installed.length);
  pluginAvailableCount.textContent = String(available.length);
  pluginRailDot.hidden = catalog.updatesAvailable === 0;
  pluginRailDot.dataset.tone = 'warning';
  pluginRailDot.title =
    catalog.updatesAvailable > 0 ? `${catalog.updatesAvailable} 个插件可更新` : '';
  pluginStatus.textContent = catalog.cliAvailable
    ? `${catalog.message}${
        catalog.updatesAvailable > 0 ? ` · ${catalog.updatesAvailable} 个可更新` : ''
      } · 上次读取 ${new Date(catalog.checkedAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      })}`
    : catalog.message;

  renderPluginList(
    pluginInstalledList,
    installed,
    needle ? '没有匹配的已安装插件。' : '还没有安装任何插件。到“可安装”里挑一个吧。',
  );
  renderPluginList(
    pluginAvailableList,
    available,
    needle
      ? '没有匹配的可安装插件。'
      : '当前插件市场里没有更多可安装的插件；可以在下面添加新的市场。',
  );

  pluginMarketplaceList.replaceChildren();
  if (catalog.marketplaces.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = '还没有添加插件市场。添加后即可浏览它提供的插件。';
    pluginMarketplaceList.append(empty);
  }
  for (const marketplace of catalog.marketplaces) {
    pluginMarketplaceList.append(renderMarketplaceCard(marketplace));
  }
  addPluginMarketplaceButton.disabled = pluginMutationInProgress || !catalog.cliAvailable;
  updateAllPluginsButton.disabled =
    pluginMutationInProgress || !catalog.cliAvailable || catalog.updatesAvailable === 0;
  syncUpdateActionVisibility();
}

const renderMarketplaceCard = (marketplace: ClaudePluginMarketplaceView): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'plugin-card plugin-card--marketplace';

  const header = document.createElement('div');
  header.className = 'plugin-card__header';
  const title = document.createElement('strong');
  title.textContent = marketplace.name;
  header.append(title);

  const source = document.createElement('code');
  source.textContent = marketplace.repo ?? marketplace.source;

  const actions = document.createElement('div');
  actions.className = 'plugin-card__actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button button--quiet button--small plugin-card__danger';
  remove.textContent = '移除市场';
  remove.disabled = pluginMutationInProgress;
  remove.addEventListener('click', () => {
    if (!window.confirm(`移除插件市场“${marketplace.name}”？来自它的插件将不再可见。`)) {
      return;
    }
    void runPluginMutation(
      () => window.controlPanel.removeClaudePluginMarketplace(marketplace.name),
      '正在移除…',
      remove,
    );
  });
  actions.append(remove);

  card.append(header, source, actions);
  return card;
};

function loadPluginCatalog(refresh: boolean): Promise<void> {
  if (pluginLoadPromise) {
    return pluginLoadPromise;
  }
  if (pluginMutationInProgress) {
    return Promise.resolve();
  }
  pluginLoadPromise = (async () => {
    updateAllPluginsButton.disabled = true;
    if (refresh || !pluginCatalog) {
      pluginStatus.textContent = '正在读取插件列表…';
    }
    try {
      renderPluginCatalog(await window.controlPanel.getClaudePlugins(refresh));
    } catch {
      pluginStatus.textContent = '无法读取插件列表；请确认已安装 Claude Code 命令行。';
    } finally {
      pluginLoadPromise = undefined;
      updateAllPluginsButton.disabled =
        !pluginCatalog?.cliAvailable || pluginCatalog.updatesAvailable === 0;
      syncUpdateActionVisibility();
    }
  })();
  return pluginLoadPromise;
}

const refreshPluginUpdates = async (): Promise<boolean> => {
  if (pluginLoadPromise) {
    await pluginLoadPromise;
  }
  if (pluginMutationInProgress) {
    return false;
  }

  pluginMutationInProgress = true;
  pluginStatus.textContent = '正在刷新插件市场并检查更新…';
  if (pluginCatalog) {
    renderPluginCatalog(pluginCatalog);
  }
  try {
    const result = await window.controlPanel.refreshClaudePluginMarketplaces();
    renderPluginCatalog(result.catalog);
    if (!result.ok) {
      pluginStatus.textContent = result.message;
    }
    return result.ok;
  } catch {
    pluginStatus.textContent = '无法刷新插件市场；请确认网络与 Claude Code 命令行可用。';
    return false;
  } finally {
    pluginMutationInProgress = false;
    if (pluginCatalog) {
      renderPluginCatalog(pluginCatalog);
    }
  }
};

const refreshAvailableUpdates = async (manual: boolean): Promise<void> => {
  if (updateRefreshInProgress) {
    return;
  }
  updateRefreshInProgress = true;
  refreshUpdatesButton.disabled = true;
  refreshUpdatesButton.classList.add('titlebar__refresh--busy');
  refreshUpdatesButton.setAttribute('aria-busy', 'true');

  try {
    const [, pluginsOk] = await Promise.all([
      loadSoftwareUpdates(manual),
      // Plugin update flags are only trustworthy after the local marketplace checkout is refreshed.
      // This remains a background CLI task on first load and only becomes user-visible through the
      // titlebar busy state.
      refreshPluginUpdates(),
    ]);
    syncUpdateActionVisibility();
    if (manual) {
      const actions = deriveUpdateActionState(softwareUpdates, pluginCatalog);
      if (!pluginsOk) {
        showToast('软件检查已完成，但插件市场暂时无法刷新。', 'error');
      } else if (actions.totalAvailable > 0) {
        showToast(`检查完成，发现 ${actions.totalAvailable} 项可更新。`);
      } else {
        showToast('检查完成，当前没有发现可用更新。');
      }
    }
  } finally {
    updateRefreshInProgress = false;
    refreshUpdatesButton.disabled = false;
    refreshUpdatesButton.classList.remove('titlebar__refresh--busy');
    refreshUpdatesButton.setAttribute('aria-busy', 'false');
  }
};

const pasteIntoActiveTerminal = async (): Promise<void> => {
  const status = activeStatus();
  if (!status || status.phase !== 'running') {
    return;
  }
  const text = await window.controlPanel.readClipboardText();
  if (text) {
    window.controlPanel.writeTerminal(status.id, text.replace(/\r?\n/g, '\r'));
  }
  terminalViews.get(status.id)?.terminal.focus();
};

const copyActiveTerminalSelection = async (): Promise<void> => {
  const terminal = terminalViews.get(workspaceState.activeSessionId)?.terminal;
  if (terminal?.hasSelection()) {
    await window.controlPanel.writeClipboardText(terminal.getSelection());
  }
  terminal?.focus();
};

const hideTerminalContextMenu = (): void => {
  terminalContextMenu.hidden = true;
};

const hideConversationContextMenu = (): void => {
  conversationContextMenu.hidden = true;
  conversationContextTarget = undefined;
};

const requestConversationTitle = (
  currentTitle: string,
  historical: boolean,
): Promise<string | null> =>
  new Promise((resolve) => {
    conversationRenameDialogTitle.textContent = historical ? '重命名历史对话' : '重命名运行中对话';
    conversationRenameInput.value = currentTitle;
    conversationRenameDialog.returnValue = 'cancel';
    conversationRenameDialog.addEventListener(
      'close',
      () => {
        if (conversationRenameDialog.returnValue !== 'confirm') {
          resolve(null);
          return;
        }
        const title = conversationRenameInput.value.trim();
        resolve(title && title !== currentTitle ? title : null);
      },
      { once: true },
    );
    conversationRenameDialog.showModal();
    window.setTimeout(() => {
      conversationRenameInput.focus();
      conversationRenameInput.select();
    });
  });

const showConversationContextMenu = (
  event: MouseEvent,
  target:
    | { kind: 'history'; projectPath: string; session: ClaudeSessionMetadata }
    | { kind: 'running'; status: TerminalStatus },
): void => {
  event.preventDefault();
  hideTerminalContextMenu();
  conversationContextTarget = target;
  conversationContextMenu.hidden = false;
  const menuRect = conversationContextMenu.getBoundingClientRect();
  conversationContextMenu.style.left = `${Math.max(
    8,
    Math.min(event.clientX, window.innerWidth - menuRect.width - 8),
  )}px`;
  conversationContextMenu.style.top = `${Math.max(
    8,
    Math.min(event.clientY, window.innerHeight - menuRect.height - 8),
  )}px`;
  conversationContextMenu.querySelector<HTMLButtonElement>('button')?.focus();
};

const showTerminalContextMenu = (event: MouseEvent): void => {
  event.preventDefault();
  hideConversationContextMenu();
  const terminal = terminalViews.get(workspaceState.activeSessionId)?.terminal;
  const copy = terminalContextMenu.querySelector<HTMLButtonElement>(
    '[data-terminal-context-action="copy"]',
  );
  if (copy) {
    copy.disabled = !terminal?.hasSelection();
  }
  terminalContextMenu.hidden = false;
  const menuRect = terminalContextMenu.getBoundingClientRect();
  terminalContextMenu.style.left = `${Math.max(
    8,
    Math.min(event.clientX, window.innerWidth - menuRect.width - 8),
  )}px`;
  terminalContextMenu.style.top = `${Math.max(
    56,
    Math.min(event.clientY, window.innerHeight - menuRect.height - 8),
  )}px`;
  terminalContextMenu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
};

const createTerminalView = (sessionId: string, active: boolean): TerminalView => {
  const container = document.createElement('div');
  container.className = active ? 'project-terminal project-terminal--active' : 'project-terminal';
  container.dataset.sessionId = sessionId;
  terminalStage.prepend(container);

  const terminal = new Terminal(terminalOptions);
  const fitAddon = new FitAddon();
  const unicode11Addon = new Unicode11Addon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(unicode11Addon);
  terminal.unicode.activeVersion = '11';
  terminal.open(container);

  /*
   * The GPU renderer is what removes the visible lag on large output. It is attached after `open()`
   * (it needs a canvas) and disposed on context loss so the DOM renderer takes over instead of the
   * terminal going blank — a lost WebGL context is normal after a driver reset or GPU switch.
   */
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
    });
    terminal.loadAddon(webglAddon);
  } catch {
    // No WebGL (remote session, blocklisted driver): the default DOM renderer still works.
  }

  terminal.onData((data) => {
    window.controlPanel.writeTerminal(sessionId, data);
  });

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.isComposing || event.keyCode === 229) {
      return true;
    }
    if (event.type !== 'keydown') {
      return true;
    }

    if (event.ctrlKey && !event.shiftKey && event.code === 'KeyL') {
      terminal.clear();
      return false;
    }
    if (event.ctrlKey && !event.shiftKey && event.code === 'KeyA') {
      // Without this, Ctrl+A reaches PSReadLine as "move to line start" and never selects output.
      terminal.selectAll();
      return false;
    }
    if (event.ctrlKey && !event.shiftKey && event.code === 'KeyC' && terminal.hasSelection()) {
      void window.controlPanel.writeClipboardText(terminal.getSelection());
      return false;
    }
    if (event.ctrlKey && !event.shiftKey && event.code === 'KeyV') {
      void pasteIntoActiveTerminal();
      return false;
    }
    if (event.shiftKey && !event.ctrlKey && event.code === 'Enter') {
      window.controlPanel.writeTerminal(sessionId, '\x0a');
      return false;
    }

    return true;
  });
  container.addEventListener('contextmenu', showTerminalContextMenu);

  const view: TerminalView = {
    appliedOutputRevision: 0,
    container,
    fitAddon,
    outputRevision: 0,
    pending: [],
    pendingFrame: 0,
    pendingLength: 0,
    permissionModeProbes: [],
    terminal,
  };
  terminalViews.set(sessionId, view);
  return view;
};

/** Caps the queue so a runaway process cannot grow the buffer without bound. */
const MAX_PENDING_OUTPUT = 512 * 1024;

/**
 * xterm has already applied cursor moves and retained unchanged cells, so its current screen
 * contains the complete mode badge even when the PTY emitted only a repaint delta. Read every row
 * in the active screen: custom prompt layouts can place the badge more than eight rows from the
 * bottom, and the screen is small enough that a full scan is negligible.
 */
const readTerminalPermissionMode = (view: TerminalView): ClaudePermissionMode | undefined => {
  const buffer = view.terminal.buffer.active;
  const lines: string[] = [];
  const end = Math.min(buffer.length, buffer.baseY + view.terminal.rows);
  for (let row = buffer.baseY; row < end; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }
  return parseClaudePermissionMode(lines.join('\n'));
};

const reportTerminalPermissionMode = (sessionId: string, view: TerminalView): void => {
  const mode = readTerminalPermissionMode(view);
  if (!mode || mode === view.observedPermissionMode) {
    return;
  }
  view.observedPermissionMode = mode;
  window.controlPanel.observeClaudePermissionMode(sessionId, mode);
};

const answerReadyPermissionModeProbes = (sessionId: string, view: TerminalView): void => {
  const ready = view.permissionModeProbes.filter(
    (probe) => probe.requiredRevision <= view.appliedOutputRevision,
  );
  if (ready.length === 0) {
    return;
  }
  view.permissionModeProbes = view.permissionModeProbes.filter(
    (probe) => probe.requiredRevision > view.appliedOutputRevision,
  );
  const mode = readTerminalPermissionMode(view);
  for (const { probeId } of ready) {
    window.controlPanel.reportClaudePermissionModeProbe(sessionId, probeId, mode);
  }
};

const rejectPermissionModeProbes = (sessionId: string, view: TerminalView): void => {
  for (const { probeId } of view.permissionModeProbes) {
    window.controlPanel.reportClaudePermissionModeProbe(sessionId, probeId);
  }
  view.permissionModeProbes.length = 0;
};

/**
 * Output is queued and written once per frame. Writing every IPC chunk separately made xterm reflow
 * dozens of times between paints, which is what the input stutter actually was.
 */
const queueTerminalOutput = (sessionId: string, data: string): void => {
  const view = terminalViews.get(sessionId);
  if (!view) {
    return;
  }

  view.outputRevision += 1;
  view.pending.push(data);
  view.pendingLength += data.length;
  if (view.pendingLength > MAX_PENDING_OUTPUT) {
    // Dropping the oldest queued output keeps the newest visible; xterm's scrollback would have
    // discarded it moments later anyway.
    while (view.pending.length > 1 && view.pendingLength > MAX_PENDING_OUTPUT) {
      view.pendingLength -= view.pending.shift()?.length ?? 0;
    }
  }
  if (view.pendingFrame !== 0) {
    return;
  }
  view.pendingFrame = requestAnimationFrame(() => {
    view.pendingFrame = 0;
    const chunk = view.pending.join('');
    const revision = view.outputRevision;
    view.pending.length = 0;
    view.pendingLength = 0;
    view.terminal.write(chunk, () => {
      view.appliedOutputRevision = Math.max(view.appliedOutputRevision, revision);
      reportTerminalPermissionMode(sessionId, view);
      answerReadyPermissionModeProbes(sessionId, view);
    });
  });
};

const ensureTerminalView = (sessionId: string, active: boolean): TerminalView =>
  terminalViews.get(sessionId) ?? createTerminalView(sessionId, active);

const fitActiveTerminal = (): boolean => {
  const view = terminalViews.get(workspaceState.activeSessionId);
  const bounds = view?.container.getBoundingClientRect();
  if (
    !view ||
    !view.container.isConnected ||
    !view.container.classList.contains('project-terminal--active') ||
    !bounds ||
    bounds.width < 1 ||
    bounds.height < 1
  ) {
    return false;
  }

  try {
    view.fitAddon.fit();
    window.controlPanel.resizeTerminal(
      workspaceState.activeSessionId,
      view.terminal.cols,
      view.terminal.rows,
    );
    return true;
  } catch {
    // A resize can race with initial layout; the bounded frame scheduler will retry.
    return false;
  }
};

/*
 * xterm must measure character cells after its active container is visible. A single fixed timeout
 * is unreliable on a cold start, after a GPU reset, or when the window comes back from the tray.
 * Re-fitting over a few paint frames lets CSS layout and xterm's own observers settle without
 * leaving an unbounded timer running.
 */
let terminalFitGeneration = 0;
const scheduleActiveTerminalFit = (): void => {
  const expectedSessionId = workspaceState.activeSessionId;
  const generation = ++terminalFitGeneration;
  let attemptsRemaining = 4;

  const fitOnNextFrame = (): void => {
    if (
      generation !== terminalFitGeneration ||
      workspaceState.activeSessionId !== expectedSessionId ||
      !expectedSessionId
    ) {
      return;
    }

    fitActiveTerminal();
    attemptsRemaining -= 1;
    if (attemptsRemaining > 0) {
      window.requestAnimationFrame(fitOnNextFrame);
    }
  };

  window.requestAnimationFrame(fitOnNextFrame);
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const setPanelWidth = (value: number): void => {
  const narrow = window.innerWidth <= 900;
  const minimum = narrow ? 240 : 270;
  const width = clamp(
    value,
    minimum,
    Math.max(minimum, Math.min(560, window.innerWidth - (narrow ? 360 : 520))),
  );
  document.documentElement.style.setProperty('--rail-w', `${width}px`);
  localStorage.setItem('claudedock.panelWidth', String(width));
  scheduleActiveTerminalFit();
};

const setDrawerWidth = (value: number): void => {
  const minimum = window.innerWidth <= 900 ? 320 : 360;
  const width = clamp(value, minimum, Math.max(minimum, Math.min(760, window.innerWidth - 140)));
  document.documentElement.style.setProperty('--drawer-w', `${width}px`);
  localStorage.setItem('claudedock.drawerWidth', String(width));
  scheduleActiveTerminalFit();
};

const activeResizeCleanups = new Set<() => void>();

const cancelActiveResizes = (): void => {
  for (const cleanup of [...activeResizeCleanups]) {
    cleanup();
  }
};

const installResizer = (
  handle: HTMLElement,
  current: () => number,
  apply: (value: number) => void,
  direction: 1 | -1,
): void => {
  handle.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) {
      return;
    }

    // Only one captured resize may exist. This also clears a capture whose pointerup was lost.
    cancelActiveResizes();
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = current();
    const pointerId = event.pointerId;
    let finished = false;
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      apply(startWidth + (moveEvent.clientX - startX) * direction);
    };
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      handle.removeEventListener('lostpointercapture', finish);
      activeResizeCleanups.delete(finish);
      try {
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
      } catch {
        // The OS may already have revoked capture while the window was being hidden.
      } finally {
        if (activeResizeCleanups.size === 0) {
          document.body.classList.remove('is-resizing');
        }
        scheduleActiveTerminalFit();
      }
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    activeResizeCleanups.add(finish);
    document.body.classList.add('is-resizing');
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      finish();
    }
  });
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 12 : -12;
    apply(current() + delta * direction);
  });
};

const storedPanelWidth = Number(localStorage.getItem('claudedock.panelWidth'));
const storedDrawerWidth = Number(localStorage.getItem('claudedock.drawerWidth'));
if (Number.isFinite(storedPanelWidth) && storedPanelWidth > 0) {
  setPanelWidth(storedPanelWidth);
}
if (Number.isFinite(storedDrawerWidth) && storedDrawerWidth > 0) {
  setDrawerWidth(storedDrawerWidth);
}
installResizer(
  panelResizer,
  () => document.querySelector<HTMLElement>('.control-panel')?.offsetWidth ?? 320,
  setPanelWidth,
  1,
);
installResizer(
  drawerResizer,
  () => claudeWorkbench.getBoundingClientRect().width,
  setDrawerWidth,
  -1,
);
window.addEventListener('resize', () => {
  setPanelWidth(document.querySelector<HTMLElement>('.control-panel')?.offsetWidth ?? 320);
  setDrawerWidth(claudeWorkbench.getBoundingClientRect().width || 468);
});

/*
 * The composer. Everything a chat box gives for free — Ctrl+A, Shift+arrow selection, drag-select,
 * Ctrl+Z, IME composition, mouse caret placement — is native `<textarea>` behaviour, so this code
 * only handles submitting, history and sizing. No key handler re-implements text editing.
 */
const COMPOSER_HISTORY_KEY = 'claudedock.composerHistory';

const loadComposerHistory = (): ComposerHistoryState => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COMPOSER_HISTORY_KEY) ?? '[]');
    return createComposerHistory(
      Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [],
    );
  } catch {
    return createComposerHistory();
  }
};

let composerHistory = loadComposerHistory();

const persistComposerHistory = (): void => {
  try {
    localStorage.setItem(COMPOSER_HISTORY_KEY, JSON.stringify(composerHistory.entries));
  } catch {
    // A full or unavailable localStorage must not break sending.
  }
};

/** Grows the textarea with its content up to `--composer-max`, then scrolls. */
const resizeComposer = (): void => {
  composerInput.style.height = 'auto';
  const maxHeight = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--composer-max'),
  );
  const height = Number.isFinite(maxHeight)
    ? Math.min(composerInput.scrollHeight, maxHeight)
    : composerInput.scrollHeight;
  composerInput.style.height = `${height}px`;
  // The workbench drawer is absolutely positioned against the shell, so it needs the live height.
  document.documentElement.style.setProperty(
    '--composer-h',
    `${Math.round(composerForm.getBoundingClientRect().height)}px`,
  );
};

/* The keyboard hints live in the placeholder, so they vanish the moment the user starts typing. */
const COMPOSER_PLACEHOLDER = '输入提示词　·　Enter 发送　·　Shift+Enter 换行　·　↑↓ 翻阅历史';

const setComposerEnabled = (enabled: boolean): void => {
  composerInput.disabled = !enabled;
  composerSendButton.disabled = !enabled;
  composerInput.placeholder = enabled ? COMPOSER_PLACEHOLDER : '终端未运行；先启动对话后再输入';
};

const focusComposer = (): boolean => {
  if (composerInput.disabled) {
    return false;
  }
  composerInput.focus({ preventScroll: true });
  return document.activeElement === composerInput;
};

/*
 * Opening a project can resolve before its final `running` status has reached the renderer. Keep
 * the intent to focus, then fulfil it only after the matching active session is actually writable.
 */
const flushPendingComposerFocus = (): void => {
  const status = activeStatus();
  if (
    !pendingComposerFocusSessionId ||
    status?.id !== pendingComposerFocusSessionId ||
    status.phase !== 'running' ||
    composerInput.disabled
  ) {
    return;
  }

  const expectedSessionId = pendingComposerFocusSessionId;
  window.requestAnimationFrame(() => {
    const latestStatus = activeStatus();
    if (
      latestStatus?.id === expectedSessionId &&
      latestStatus.phase === 'running' &&
      focusComposer()
    ) {
      pendingComposerFocusSessionId = '';
    }
  });
};

const requestComposerFocus = (sessionId = workspaceState.activeSessionId): void => {
  if (!sessionId) {
    return;
  }
  pendingComposerFocusSessionId = sessionId;
  flushPendingComposerFocus();
};

/**
 * The iMessage-style send: a bubble holding what was typed lifts out of the composer and fades into
 * the terminal. It is a throwaway element positioned over the textarea, so it never affects layout,
 * and it is skipped entirely when the user has asked for reduced motion.
 */
const playSendAnimation = (text: string): void => {
  const trimmed = text.trim();
  if (!trimmed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  const rect = composerInput.getBoundingClientRect();
  const bubble = document.createElement('div');
  bubble.className = 'composer-send-bubble';
  // A very long prompt would make an unreadable bubble; the first lines carry the meaning.
  bubble.textContent = trimmed.length > 220 ? `${trimmed.slice(0, 220)}…` : trimmed;
  bubble.style.left = `${rect.left}px`;
  bubble.style.top = `${rect.top}px`;
  bubble.style.width = `${rect.width}px`;
  bubble.style.maxHeight = `${rect.height}px`;
  document.body.append(bubble);

  bubble.addEventListener(
    'animationend',
    () => {
      bubble.remove();
    },
    { once: true },
  );
  // A dropped animationend (background tab, compositor hiccup) must not leak the node.
  window.setTimeout(() => {
    bubble.remove();
  }, 700);
};

const submitComposer = (): void => {
  const status = activeStatus();
  if (!status || status.phase !== 'running') {
    showToast('终端还没有运行，无法发送。', 'error');
    return;
  }

  const text = composerInput.value;
  let submission: ReturnType<typeof buildTerminalSubmission>;
  try {
    submission = buildTerminalSubmission(text);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '内容过长，无法发送。', 'error');
    return;
  }

  /*
   * Body and return go as two writes: Claude Code's TUI reads one big chunk as a paste and eats a
   * trailing return, leaving the prompt sitting unsent in its input box. See `composer-input.ts`.
   */
  if (submission.body) {
    window.controlPanel.writeTerminal(status.id, submission.body);
    window.setTimeout(() => {
      // The session can be closed or stopped during the gap between the two writes.
      if (activeStatus()?.id === status.id && activeStatus()?.phase === 'running') {
        window.controlPanel.writeTerminal(status.id, submission.submit);
      }
    }, SUBMIT_DELAY_MS);
  } else {
    window.controlPanel.writeTerminal(status.id, submission.submit);
  }

  playSendAnimation(text);
  composerHistory = rememberSubmission(composerHistory, text);
  persistComposerHistory();
  composerInput.value = '';
  resizeComposer();
};

/** ↑/↓ only browse history when the caret is at the very start / end, so editing still works. */
const walkComposerHistory = (direction: 'back' | 'forward'): boolean => {
  const { selectionEnd, selectionStart, value } = composerInput;
  if (selectionStart !== selectionEnd) {
    return false;
  }
  if (direction === 'back' && selectionStart !== 0) {
    return false;
  }
  if (direction === 'forward' && selectionEnd !== value.length) {
    return false;
  }

  const step =
    direction === 'back' ? stepBack(composerHistory, value) : stepForward(composerHistory);
  composerHistory = step.state;
  if (step.text === undefined) {
    return false;
  }
  composerInput.value = step.text;
  composerInput.setSelectionRange(step.text.length, step.text.length);
  resizeComposer();
  return true;
};

composerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitComposer();
});

composerInput.addEventListener('keydown', (event) => {
  // Never intercept while an IME candidate window is open, or Chinese input breaks apart.
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    submitComposer();
    return;
  }
  if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.altKey) {
    if (walkComposerHistory(event.key === 'ArrowUp' ? 'back' : 'forward')) {
      event.preventDefault();
    }
    return;
  }
  if (event.key === 'Escape' && composerInput.value.length > 0) {
    event.preventDefault();
    composerInput.value = '';
    composerHistory = resetBrowsing(composerHistory);
    resizeComposer();
    return;
  }
  // Shift+Tab would otherwise move focus out of the composer. Forwarding the same CBT sequence
  // xterm sends makes the shortcut work no matter which of the two inputs has focus; the status bar
  // catches up when the main process reads the repainted badge.
  if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.altKey) {
    const status = activeStatus();
    if (status) {
      event.preventDefault();
      window.controlPanel.writeTerminal(status.id, '\x1b[Z');
    }
  }
});

composerInput.addEventListener('input', () => {
  composerHistory = resetBrowsing(composerHistory);
  resizeComposer();
});

const renderActiveStatus = (status: TerminalStatus): void => {
  const copy = phaseCopy[status.phase];
  const openFolders = workspaceState.projects.filter((project) => project.open).length;

  document.body.dataset.phase = status.phase;
  titleStatus.textContent = `${copy.detail} · ${openFolders} 个项目 / ${workspaceState.sessions.length} 个对话`;
  statusPill.textContent = copy.pill;
  sessionDetail.textContent = status.message ?? copy.detail;
  sessionPid.textContent = status.pid ? `进程号 ${status.pid}` : '进程号 —';
  footerStatus.textContent = copy.footer;
  toggleLabel.textContent = status.phase === 'running' ? '停止' : '启动';
  const terminalIsVisible = status.phase === 'running' || status.phase === 'starting';
  emptyStateTitle.textContent = '终端尚未运行';
  emptyStateHint.textContent = '点击左侧“启动”创建终端会话';
  emptyState.classList.toggle('terminal-empty-state--hidden', terminalIsVisible);
  emptyState.setAttribute('aria-hidden', String(terminalIsVisible));
  terminalProject.textContent = `${projectNameFromPath(status.cwd)} · ${status.title}`;
  terminalProject.title = status.cwd;
  workbenchScope.textContent = `${projectNameFromPath(status.cwd)} · ${status.title}`;
  setComposerEnabled(status.phase === 'running');
};

/**
 * With no conversation open there is nothing to describe — this is the real startup state now that
 * the app no longer invents a session in the home folder. The panel invites the user to pick a
 * project instead of reporting on one they never opened.
 */
const renderNoActiveSession = (): void => {
  const rememberedCount = workspaceState.projects.length;

  document.body.dataset.phase = 'stopped';
  titleStatus.textContent =
    rememberedCount > 0 ? `未打开对话 · ${rememberedCount} 个最近项目` : '未打开任何项目';
  statusPill.textContent = '未打开';
  sessionDetail.textContent = '尚未打开项目对话';
  sessionPid.textContent = '进程号 —';
  footerStatus.textContent = '等待打开项目';
  toggleLabel.textContent = '启动';
  emptyStateTitle.textContent = rememberedCount > 0 ? '选择一个项目继续' : '还没有项目';
  emptyStateHint.textContent =
    rememberedCount > 0
      ? '在左侧点击最近打开的项目，或添加新的项目文件夹'
      : '点击左侧“添加项目”选择一个文件夹';
  emptyState.classList.remove('terminal-empty-state--hidden');
  emptyState.setAttribute('aria-hidden', 'false');
  terminalProject.textContent = '未打开项目';
  terminalProject.title = '';
  workbenchScope.textContent = '未打开项目';
  setComposerEnabled(false);
};

const activateProject = async (sessionId: string): Promise<void> => {
  const result = await window.controlPanel.activateProject(sessionId);
  if (!result.ok) {
    showToast(result.error ?? '无法切换对话。', 'error');
    return;
  }
  renderWorkspace(result.state);
  scheduleActiveTerminalFit();
  requestComposerFocus(result.state.activeSessionId);
};

const closeProject = async (status: TerminalStatus): Promise<void> => {
  if (
    status.phase === 'running' &&
    !window.confirm(`关闭“${status.title}”会终止它的终端进程，是否继续？`)
  ) {
    return;
  }

  const result = await window.controlPanel.closeProject(status.id);
  if (!result.ok) {
    showToast(result.error ?? '无法关闭这个对话。', 'error');
    return;
  }
  renderWorkspace(result.state);
  showToast(`已关闭 ${status.title}`);
};

const openConversation = async (projectPath: string): Promise<void> => {
  const result = await window.controlPanel.openConversation(projectPath);
  renderWorkspace(result.state);
  if (!result.ok) {
    showToast(result.error ?? '无法新建对话。', 'error');
    return;
  }
  showToast(`已在 ${projectNameFromPath(projectPath)} 新开一个对话`);
  scheduleActiveTerminalFit();
  requestComposerFocus(result.state.activeSessionId);
};

const renameConversation = async (status: TerminalStatus): Promise<void> => {
  const nextTitle = await requestConversationTitle(status.title, false);
  if (!nextTitle) {
    return;
  }
  const result = await window.controlPanel.renameConversation(status.id, nextTitle);
  renderWorkspace(result.state);
  if (!result.ok) {
    showToast(result.error ?? '无法重命名这个对话。', 'error');
    return;
  }
  showToast(`对话已重命名为“${nextTitle}”`);
};

const closeProjectFolder = async (project: WorkspaceProjectView): Promise<void> => {
  if (
    project.sessionIds.length > 0 &&
    !window.confirm(`关闭“${project.name}”的全部 ${project.sessionIds.length} 个对话？`)
  ) {
    return;
  }
  const result = await window.controlPanel.closeProjectFolder(project.path);
  renderWorkspace(result.state);
  if (!result.ok) {
    showToast(result.error ?? '无法关闭这个项目。', 'error');
    return;
  }
  showToast(`已关闭 ${project.name}，项目仍然会被记住`);
};

const forgetProject = async (project: WorkspaceProjectView): Promise<void> => {
  if (!window.confirm(`把“${project.name}”从列表中移除？磁盘上的文件不会被删除。`)) {
    return;
  }
  const result = await window.controlPanel.forgetProject(project.path);
  renderWorkspace(result.state);
  if (!result.ok) {
    showToast(result.error ?? '无法移除这个项目。', 'error');
    return;
  }
  expandedFolders.delete(project.path.toLowerCase());
  showToast(`已从列表中移除 ${project.name}`);
};

/** Loads a folder's Claude conversation history without requiring a live terminal for it. */
async function loadFolderHistory(projectPath: string, force = false): Promise<void> {
  const key = projectPath.toLowerCase();
  if (historyLoadsInFlight.has(key) || (!force && storedConversations.has(key))) {
    return;
  }
  historyLoadsInFlight.add(key);
  try {
    storedConversations.set(key, await window.controlPanel.getClaudeSessionsForPath(projectPath));
    renderProjectList();
  } catch {
    storedConversations.set(key, []);
  } finally {
    historyLoadsInFlight.delete(key);
  }
}

const renameStoredConversation = async (
  projectPath: string,
  session: ClaudeSessionMetadata,
): Promise<void> => {
  const currentTitle = session.sessionName || session.sessionId.slice(0, 8);
  const nextTitle = await requestConversationTitle(currentTitle, true);
  if (!nextTitle) {
    return;
  }
  try {
    const renamed = await window.controlPanel.renameClaudeSession(
      projectPath,
      session.sessionId,
      nextTitle,
    );
    if (!renamed) {
      showToast('无法重命名这个历史对话。', 'error');
      return;
    }
    await loadFolderHistory(projectPath, true);
    showToast(`历史对话已重命名为“${nextTitle}”`);
  } catch {
    showToast('无法重命名这个历史对话。', 'error');
  }
};

const renderConversationRow = (status: TerminalStatus): HTMLElement => {
  const row = document.createElement('div');
  row.className = 'conversation-item';
  row.dataset.active = String(status.id === workspaceState.activeSessionId);
  row.dataset.phase = status.phase;
  row.dataset.sessionId = status.id;

  const selectButton = document.createElement('button');
  selectButton.className = 'conversation-item__select';
  selectButton.type = 'button';
  selectButton.title = `${status.title} · ${status.cwd}`;
  selectButton.setAttribute('aria-pressed', String(status.id === workspaceState.activeSessionId));

  const indicator = document.createElement('span');
  indicator.className = 'conversation-item__status';
  indicator.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'conversation-item__label';
  label.textContent = status.title;

  const phaseText = document.createElement('span');
  phaseText.className = 'conversation-item__phase';
  phaseText.textContent = phaseCopy[status.phase].pill;

  selectButton.append(indicator, label, phaseText);
  selectButton.addEventListener('click', () => {
    void activateProject(status.id);
  });

  const renameButton = document.createElement('button');
  renameButton.className = 'conversation-item__action';
  renameButton.type = 'button';
  renameButton.textContent = '✎';
  renameButton.title = `重命名 ${status.title}`;
  renameButton.setAttribute('aria-label', `重命名对话 ${status.title}`);
  renameButton.addEventListener('click', () => {
    void renameConversation(status);
  });
  row.addEventListener('contextmenu', (event) => {
    showConversationContextMenu(event, { kind: 'running', status });
  });

  const closeButton = document.createElement('button');
  closeButton.className = 'conversation-item__action conversation-item__action--close';
  closeButton.type = 'button';
  closeButton.textContent = '×';
  closeButton.title = `关闭 ${status.title}`;
  closeButton.setAttribute('aria-label', `关闭对话 ${status.title}`);
  closeButton.addEventListener('click', () => {
    void closeProject(status);
  });

  row.append(selectButton, renameButton, closeButton);
  return row;
};

const renderHistoryRow = (projectPath: string, session: ClaudeSessionMetadata): HTMLElement => {
  const row = document.createElement('button');
  row.className = 'history-item';
  row.type = 'button';
  row.title = `左键恢复，右键重命名：${session.sessionId}`;

  const icon = document.createElement('span');
  icon.className = 'history-item__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '⏱';

  const label = document.createElement('span');
  label.className = 'history-item__label';
  label.textContent = session.sessionName || session.sessionId.slice(0, 8);

  const time = document.createElement('span');
  time.className = 'history-item__time';
  time.textContent = formatRelativeTime(session.lastActiveAt);

  row.append(icon, label, time);
  row.addEventListener('click', () => {
    void resumeStoredConversation(projectPath, session);
  });
  row.addEventListener('contextmenu', (event) => {
    showConversationContextMenu(event, { kind: 'history', projectPath, session });
  });
  return row;
};

const renderProjectFolder = (project: WorkspaceProjectView): HTMLElement => {
  const key = project.path.toLowerCase();
  const sessions = workspaceState.sessions.filter((session) =>
    project.sessionIds.includes(session.id),
  );
  const containsActive = project.sessionIds.includes(workspaceState.activeSessionId);
  const expanded = expandedFolders.has(key) || containsActive;

  const folder = document.createElement('section');
  folder.className = 'project-folder';
  folder.dataset.open = String(project.open);
  folder.dataset.expanded = String(expanded);
  folder.dataset.missing = String(project.missing);
  folder.dataset.active = String(containsActive);

  const header = document.createElement('div');
  header.className = 'project-folder__header';

  const disclosure = document.createElement('button');
  disclosure.className = 'project-folder__disclosure';
  disclosure.type = 'button';
  disclosure.setAttribute('aria-expanded', String(expanded));
  disclosure.title = project.path;

  const chevron = document.createElement('span');
  chevron.className = 'project-folder__chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▸';

  const copy = document.createElement('span');
  copy.className = 'project-folder__copy';
  const name = document.createElement('strong');
  name.textContent = project.name;
  const detail = document.createElement('span');
  detail.textContent = project.missing
    ? '文件夹已不存在'
    : project.open
      ? `${sessions.length} 个对话进行中`
      : project.lastActiveAt
        ? `上次使用 ${formatRelativeTime(project.lastActiveAt)}`
        : '已记住，未打开';
  copy.append(name, detail);

  disclosure.append(chevron, copy);
  disclosure.addEventListener('click', () => {
    if (expanded) {
      expandedFolders.delete(key);
    } else {
      expandedFolders.add(key);
      if (!project.missing) {
        void loadFolderHistory(project.path);
      }
    }
    renderProjectList();
  });

  const actions = document.createElement('div');
  actions.className = 'project-folder__actions';

  const newConversation = document.createElement('button');
  newConversation.className = 'project-folder__action';
  newConversation.type = 'button';
  newConversation.textContent = '+';
  newConversation.title = `在 ${project.name} 里新开一个对话`;
  newConversation.setAttribute('aria-label', `在 ${project.name} 里新开一个对话`);
  newConversation.disabled = project.missing;
  newConversation.addEventListener('click', () => {
    expandedFolders.add(key);
    void openConversation(project.path);
  });
  actions.append(newConversation);

  const removeButton = document.createElement('button');
  removeButton.className = 'project-folder__action project-folder__action--close';
  removeButton.type = 'button';
  removeButton.textContent = '×';
  removeButton.title = project.open
    ? `关闭 ${project.name} 的所有对话`
    : `从列表中移除 ${project.name}`;
  removeButton.setAttribute('aria-label', removeButton.title);
  removeButton.addEventListener('click', () => {
    void (project.open ? closeProjectFolder(project) : forgetProject(project));
  });
  actions.append(removeButton);

  header.append(disclosure, actions);
  folder.append(header);

  if (!expanded) {
    return folder;
  }

  const body = document.createElement('div');
  body.className = 'project-folder__body';

  for (const session of sessions) {
    body.append(renderConversationRow(session));
  }

  if (sessions.length === 0) {
    const reopen = document.createElement('button');
    reopen.className = 'project-folder__reopen';
    reopen.type = 'button';
    reopen.textContent = project.missing ? '文件夹已不存在，可从列表中移除' : '打开一个新对话';
    reopen.disabled = project.missing;
    reopen.addEventListener('click', () => {
      void openConversation(project.path);
    });
    body.append(reopen);
  }

  const history = storedConversations.get(key);
  if (history === undefined && !project.missing) {
    void loadFolderHistory(project.path);
    const loading = document.createElement('span');
    loading.className = 'project-folder__hint';
    loading.textContent = '正在读取历史对话…';
    body.append(loading);
  } else if (history && history.length > 0) {
    const heading = document.createElement('span');
    heading.className = 'project-folder__hint';
    heading.textContent = `历史对话（点击可在新对话中恢复，共 ${history.length} 个）`;
    body.append(heading);
    for (const session of history.slice(0, 6)) {
      body.append(renderHistoryRow(project.path, session));
    }
  }

  folder.append(body);
  return folder;
};

function renderProjectList(): void {
  projectList.replaceChildren();
  const openFolders = workspaceState.projects.filter((project) => project.open).length;
  projectCount.textContent = `${openFolders} 个项目 · ${workspaceState.sessions.length} 个对话`;

  for (const project of workspaceState.projects) {
    projectList.append(renderProjectFolder(project));
  }
}

function renderWorkspace(state: WorkspaceState): void {
  workspaceState = state;
  const validSessionIds = new Set(state.sessions.map((status) => status.id));
  if (
    pendingComposerFocusSessionId &&
    (pendingComposerFocusSessionId !== state.activeSessionId ||
      !validSessionIds.has(pendingComposerFocusSessionId))
  ) {
    pendingComposerFocusSessionId = '';
  }

  for (const status of state.sessions) {
    const active = status.id === state.activeSessionId;
    const view = ensureTerminalView(status.id, active);
    view.container.classList.toggle('project-terminal--active', active);
  }

  for (const [sessionId, view] of terminalViews) {
    if (!validSessionIds.has(sessionId)) {
      if (view.pendingFrame !== 0) {
        cancelAnimationFrame(view.pendingFrame);
      }
      rejectPermissionModeProbes(sessionId, view);
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
  } else {
    renderNoActiveSession();
  }
  flushPendingComposerFocus();
  if (state.activeSessionId !== lastClaudeSessionId) {
    lastClaudeSessionId = state.activeSessionId;
    configFormSessionId = '';
    connectionEnvironmentReady = false;
    advancedConnectionSnapshot = undefined;
    if (connectionAdvancedDialog.open) {
      connectionAdvancedDialog.close('project-changed');
    }
    clearProviderSelection();
    gatewayDiagnostics = undefined;
    lastCurlAnalysis = undefined;
    curlInput.value = '';
    curlAnalysis.hidden = true;
    importCurlRouterButton.hidden = true;
    connectionTestResult.hidden = true;
    routerProviderForm.hidden = true;
    routerProviderApiKey.value = '';
    gatewayCandidates.replaceChildren();
    gatewayDiagnosticsSummary.textContent = '正在检查常见本地端口、命令和 Claude 设置…';
    gatewayCheckedAt.textContent = '等待首次检测';
    const knownClaudeState = claudeStates.get(state.activeSessionId);
    if (knownClaudeState) {
      renderClaudeState(knownClaudeState);
    } else if (state.activeSessionId) {
      void loadClaudeState(state.activeSessionId);
    }
    if (state.activeSessionId) {
      void loadRouterManagement();
      void loadConnectionAdvice();
      void loadConnectionHistory();
    } else {
      connectionHistoryEntries = [];
      renderConnectionHistory();
    }
  }
  scheduleActiveTerminalFit();
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
  if (result.status) {
    applyTerminalStatus(result.status);
  }
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
      scheduleActiveTerminalFit();
      requestComposerFocus(result.state.activeSessionId);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    showToast(detail || '添加项目失败，请重试。', 'error');
  } finally {
    dropZone.disabled = false;
    chooseDirectoryButton.disabled = false;
    dropZone.classList.remove('drop-zone--busy');
  }
};

const openDirectoryPicker = async (): Promise<void> => {
  try {
    const choice = await window.controlPanel.chooseDirectory();
    if (choice.canceled) {
      if (choice.error) {
        showToast(choice.error, 'error');
      }
      return;
    }
    await addProject(choice.path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    showToast(detail || '无法调用系统文件夹选择器。', 'error');
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
    // `resume` opens Claude's own arrow-key picker, which needs the raw keystrokes.
    if (mode === 'resume') {
      terminalViews.get(status.id)?.terminal.focus();
    } else {
      requestComposerFocus(status.id);
    }
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
    modelFast: claudeModelFast.value,
    preset,
    provider: providerForPreset(preset),
  };
};

const saveClaudeConfig = async (
  credentialAction: SaveClaudeConfigInput['credentialAction'],
): Promise<boolean> => {
  const status = activeStatus();
  if (!status) {
    return false;
  }
  return (
    (await runGuarded(saveClaudeConfigButton, '正在保存…', async () => {
      try {
        const action =
          credentialAction === 'keep' && claudeCredential.value.trim()
            ? 'replace'
            : credentialAction;
        const result = await window.controlPanel.saveClaudeConfig(
          status.id,
          currentConfigInput(action),
        );
        renderClaudeState(result.state);
        if (!result.ok) {
          showToast(result.error ?? '无法保存接入配置。', 'error');
          return false;
        }
        populateClaudeConfigForm(result.state);
        showToast('当前项目的模型与接口接入已保存');
        void loadConnectionHistory();
        return true;
      } catch {
        showToast('无法保存接入配置。', 'error');
        return false;
      }
    })) ?? false
  );
};

const presetLabel = (preset: ClaudePreset): string =>
  findClaudeProvider(preset)?.label ?? '自定义 Anthropic 服务';

const GATEWAY_STATE_LABELS: Record<ClaudeConnectionHistoryEntry['gatewayState'], string> = {
  error: '网关出错',
  running: '网关运行中',
  starting: '网关启动中',
  stopped: '网关未运行',
  unknown: '网关状态未知',
};

const formatHistoryTimestamp = (savedAt: number): string =>
  new Date(savedAt).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  });

const historyAuthModeLabel = (authMode: ClaudeConnectionHistoryEntry['authMode']): string => {
  switch (authMode) {
    case 'apiKey':
      return 'API Key';
    case 'authToken':
      return 'Bearer';
    case 'existing':
      return '现有登录';
    case 'none':
      return '无认证';
  }
};

const renderConnectionHistory = (): void => {
  connectionHistoryList.replaceChildren();
  connectionHistoryEmpty.hidden = connectionHistoryEntries.length > 0;
  connectionHistoryCount.textContent =
    connectionHistoryEntries.length > 0
      ? `${connectionHistoryEntries.length} 条历史配置 · 点击恢复全部参数`
      : '记录曾填写的接口、网关和模型参数，点击即可一键恢复。';

  for (const entry of connectionHistoryEntries) {
    const item = document.createElement('li');
    item.className = 'connection-history__item';
    item.dataset.historyId = entry.id;

    const restore = document.createElement('button');
    restore.className = 'connection-history__restore';
    restore.type = 'button';
    restore.title = '恢复这条接入配置';

    const title = document.createElement('strong');
    title.textContent = presetLabel(entry.preset);
    const parameters = document.createElement('span');
    parameters.className = 'connection-history__parameters';
    const appendParameter = (labelText: string, valueText: string): void => {
      const parameter = document.createElement('span');
      parameter.className = 'connection-history__parameter';
      const label = document.createElement('span');
      label.textContent = labelText;
      const value = document.createElement('code');
      value.textContent = valueText;
      parameter.append(label, value);
      parameters.append(parameter);
    };
    appendParameter('接口 / 网关', entry.baseUrl || 'Anthropic 官方端点');
    if (entry.gatewayEndpoint && entry.gatewayEndpoint !== entry.baseUrl) {
      appendParameter('检测网关', entry.gatewayEndpoint);
    }
    appendParameter('主模型', entry.model || '默认模型');
    appendParameter('快速模型', entry.modelFast || entry.model || '跟随主模型');
    const meta = document.createElement('span');
    meta.className = 'connection-history__meta';
    meta.textContent = [
      formatHistoryTimestamp(entry.savedAt),
      historyAuthModeLabel(entry.authMode),
      entry.credentialConfigured ? '含凭据' : '无凭据',
      GATEWAY_STATE_LABELS[entry.gatewayState],
    ].join(' · ');
    restore.append(title, parameters, meta);

    const remove = document.createElement('button');
    remove.className = 'connection-history__delete';
    remove.type = 'button';
    remove.title = '删除这条记录';
    remove.setAttribute('aria-label', '删除这条接入记录');
    remove.textContent = '×';

    item.append(restore, remove);
    connectionHistoryList.append(item);
  }
};

const loadConnectionHistory = async (): Promise<void> => {
  const status = activeStatus();
  if (!status) {
    connectionHistoryEntries = [];
    renderConnectionHistory();
    return;
  }
  try {
    connectionHistoryEntries = await window.controlPanel.getClaudeConnectionHistory(status.id);
  } catch {
    connectionHistoryEntries = [];
  }
  renderConnectionHistory();
};

const hideHistoryContextMenu = (): void => {
  historyContextMenu.hidden = true;
  connectionHistoryTargetId = '';
};

const applyConnectionHistory = async (entryId: string): Promise<void> => {
  const status = activeStatus();
  if (!status || connectionHistoryMutationInProgress) {
    return;
  }
  connectionHistoryMutationInProgress = true;
  try {
    const result = await window.controlPanel.applyClaudeConnectionHistory(status.id, entryId);
    connectionHistoryEntries = result.entries;
    renderConnectionHistory();
    if (!result.ok) {
      showToast(result.error ?? '无法恢复这条接入记录。', 'error');
      return;
    }
    if (result.state) {
      renderClaudeState(result.state);
      populateClaudeConfigForm(result.state);
    }
    showToast('已恢复这条接入配置');
  } catch {
    showToast('无法恢复这条接入记录。', 'error');
  } finally {
    connectionHistoryMutationInProgress = false;
  }
};

const deleteConnectionHistory = async (entryId: string): Promise<void> => {
  const status = activeStatus();
  if (!status || connectionHistoryMutationInProgress) {
    return;
  }
  connectionHistoryMutationInProgress = true;
  try {
    const result = await window.controlPanel.deleteClaudeConnectionHistory(status.id, entryId);
    connectionHistoryEntries = result.entries;
    renderConnectionHistory();
    if (!result.ok) {
      showToast(result.error ?? '无法删除这条接入记录。', 'error');
      return;
    }
    showToast('已删除这条接入记录');
  } catch {
    showToast('无法删除这条接入记录。', 'error');
  } finally {
    connectionHistoryMutationInProgress = false;
  }
};

window.controlPanel.onTerminalData((sessionId, data) => {
  queueTerminalOutput(sessionId, data);
});
window.controlPanel.onClaudePermissionModeProbe((sessionId, probeId) => {
  const view = terminalViews.get(sessionId);
  if (!view) {
    window.controlPanel.reportClaudePermissionModeProbe(sessionId, probeId);
    return;
  }
  if (view.appliedOutputRevision >= view.outputRevision) {
    window.controlPanel.reportClaudePermissionModeProbe(
      sessionId,
      probeId,
      readTerminalPermissionMode(view),
    );
    return;
  }
  view.permissionModeProbes.push({ probeId, requiredRevision: view.outputRevision });
});
/*
 * The PTY clamps the size it was asked for. xterm has to follow, because PSReadLine repaints its
 * edit buffer with absolute cursor moves — a one-row disagreement puts that repaint on the wrong
 * line and leaves the previous screen visible underneath it.
 */
window.controlPanel.onTerminalSize((sessionId, cols, rows) => {
  const view = terminalViews.get(sessionId);
  if (!view || (view.terminal.cols === cols && view.terminal.rows === rows)) {
    return;
  }
  try {
    view.terminal.resize(cols, rows);
  } catch {
    // A resize can race with the terminal being disposed.
  }
});
window.controlPanel.onClaudeState(renderClaudeState);
window.controlPanel.onWorkspaceState(renderWorkspace);

chooseDirectoryButton.addEventListener('click', () => {
  void openDirectoryPicker();
});
runClaudeButton.addEventListener('click', () => {
  void launchClaude('new');
});
routeHealthAction.addEventListener('click', () => {
  setWorkbenchOpen(false);
  selectRailTab('connection');
});
for (const button of activityRail.querySelectorAll<HTMLButtonElement>('[data-rail-tab]')) {
  button.addEventListener('click', () => {
    toggleRailTab(button.dataset.railTab ?? 'projects');
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-plugin-tab]')) {
  button.addEventListener('click', () => {
    selectPluginTab(button.dataset.pluginTab ?? 'installed');
  });
}
refreshUpdatesButton.addEventListener('click', () => {
  void refreshAvailableUpdates(true);
});
updateAllPluginsButton.addEventListener('click', () => {
  void runPluginMutation(
    () => window.controlPanel.updateAllClaudePlugins(),
    '正在更新…',
    updateAllPluginsButton,
  );
});
pluginSearch.addEventListener('input', () => {
  if (pluginCatalog) {
    renderPluginCatalog(pluginCatalog);
  }
});
pluginMarketplaceForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const source = pluginMarketplaceSource.value.trim();
  if (!source) {
    showToast('请先填写插件市场地址。', 'error');
    return;
  }
  void runPluginMutation(
    () => window.controlPanel.addClaudePluginMarketplace(source),
    '正在添加…',
    addPluginMarketplaceButton,
  ).then(() => {
    pluginMarketplaceSource.value = '';
  });
});
workbenchTrigger.addEventListener('click', () => {
  setWorkbenchOpen(!claudeWorkbench.classList.contains('claude-workbench--open'));
});
workbenchShortcuts.addEventListener('click', () => {
  setWorkbenchOpen(true);
  selectWorkbenchPage('shortcuts');
});
terminalThemeSelect.addEventListener('change', () => {
  const themeId = terminalThemeSelect.value;
  if (isTerminalThemeId(themeId)) {
    applyTerminalTheme(themeId);
  }
});
conversationRenameCancel.addEventListener('click', () => {
  conversationRenameDialog.close('cancel');
});
openConnectionAdvancedButton.addEventListener('click', openAdvancedConnectionDialog);
completeConnectionAdvancedButton.addEventListener('click', () => {
  closeAdvancedConnectionDialog(true);
});
cancelConnectionAdvancedButton.addEventListener('click', () => {
  closeAdvancedConnectionDialog(false);
});
closeConnectionAdvancedButton.addEventListener('click', () => {
  closeAdvancedConnectionDialog(false);
});
connectionAdvancedDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeAdvancedConnectionDialog(false);
});
footerConnection.addEventListener('click', () => {
  if (connectionTestInProgress) {
    return;
  }
  const status = activeStatus();
  const state = status ? claudeStates.get(status.id) : undefined;
  if (!state) {
    showToast('无法读取当前接入配置。', 'error');
    return;
  }
  const { config } = state;
  void runConnectionTest(false, {
    authMode: config.authMode,
    baseUrl: config.baseUrl,
    credentialAction: 'keep',
    model: config.model,
    modelFast: config.modelFast,
    preset: config.preset,
    provider: config.provider,
  });
});
footerModel.addEventListener('click', () => {
  if (footerModelMenu.hidden) {
    void openModelMenu();
  } else {
    hideFooterMenus();
  }
});
footerMode.addEventListener('click', () => {
  if (footerModeMenu.hidden) {
    openModeMenu();
  } else {
    hideFooterMenus();
  }
});
allowBypassPermissions.addEventListener('change', () => {
  const status = activeStatus();
  if (!status) {
    return;
  }
  void window.controlPanel
    .setClaudeAllowBypassPermissions(status.id, allowBypassPermissions.checked)
    .then((result) => {
      renderClaudeState(result.state);
      if (!result.ok) {
        showToast(result.error ?? '无法保存放权设置。', 'error');
      }
    })
    .catch(() => {
      showToast('无法保存放权设置。', 'error');
    });
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
  connectionRemedy.hidden = true;
});
claudeAuthMode.addEventListener('change', () => {
  credentialField.hidden = claudeAuthMode.value === 'existing' || claudeAuthMode.value === 'none';
  connectionTestResult.hidden = true;
  connectionRemedy.hidden = true;
});
analyzeCurlButton.addEventListener('click', analyzeCurlInput);
applyCurlDirectButton.addEventListener('click', applyDirectCurlAnalysis);
importCurlRouterButton.addEventListener('click', () => {
  void importCurlIntoRouter();
});
useDetectedRouterButton.addEventListener('click', () => {
  const router = preferredRouter();
  if (router) {
    applyGatewayCandidate(router);
  }
});
openDetectedRouterButton.addEventListener('click', () => {
  void runRouterOperation(
    (sessionId) => window.controlPanel.openClaudeRouterManagement(sessionId),
    '正在打开…',
    openDetectedRouterButton,
  );
});
refreshGatewaysButton.addEventListener('click', () => {
  void runGuarded(refreshGatewaysButton, '正在检测…', async () => {
    await Promise.all([
      loadGatewayDiagnostics(),
      loadRouterManagement(),
      loadConnectionAdvice(),
      loadSoftwareUpdates(true),
    ]);
  });
});
installRouterButton.addEventListener('click', () => {
  routerPurgeCompleted = false;
  void runRouterOperation(
    (sessionId) =>
      window.controlPanel.installClaudeRouterFromSource(
        sessionId,
        routerInstallSource.value as 'github' | 'npm' | 'npmmirror',
      ),
    routerInstallSource.value === 'github' ? '正在下载并校验…' : '正在安装…',
    installRouterButton,
  );
});
uninstallRouterButton.addEventListener('click', () => {
  purgeRouter(uninstallRouterButton);
});
installUpdateClaudeButton.addEventListener('click', () => {
  void runClaudeInstallUpdate();
});
startRouterButton.addEventListener('click', () => {
  void runRouterOperation(
    (sessionId) => window.controlPanel.startClaudeRouter(sessionId),
    '正在启动…',
    startRouterButton,
  );
});
stopRouterButton.addEventListener('click', () => {
  void runRouterOperation(
    (sessionId) => window.controlPanel.stopClaudeRouter(sessionId),
    '正在停止…',
    stopRouterButton,
  );
});
openRouterManagementButton.addEventListener('click', () => {
  void runRouterOperation(
    (sessionId) => window.controlPanel.openClaudeRouterManagement(sessionId),
    '正在打开…',
    openRouterManagementButton,
  );
});
repairRouterFromProjectButton.addEventListener('click', () => {
  void runRouterOperation(
    (sessionId) => window.controlPanel.repairClaudeRouterFromProject(sessionId),
    '正在创建服务提供方并启动…',
    repairRouterFromProjectButton,
  );
});
configureRouterProviderButton.addEventListener('click', () => {
  const provider =
    routerManagementState?.providers.find((candidate) => candidate.preferred) ??
    routerManagementState?.providers[0];
  openRouterProviderForm(provider);
  if (provider) {
    return;
  }
  const config = claudeStates.get(workspaceState.activeSessionId)?.config;
  if (
    !config ||
    config.provider !== 'gateway' ||
    !projectUsesHttpsGateway(config.baseUrl) ||
    projectUsesDefaultRouter(config.baseUrl)
  ) {
    return;
  }
  const endpoint = new URL(config.baseUrl);
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = /\/v1\/messages$/i.test(pathname)
    ? pathname
    : `${pathname}/v1/messages`.replace(/\/{2,}/g, '/');
  const providerSuffix =
    endpoint.hostname
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 65) || 'current-project';
  routerProviderName.value = `claudedock-${providerSuffix}`;
  routerProviderProtocol.value = 'anthropic_messages';
  routerProviderBaseUrl.value = endpoint.toString();
  routerProviderModels.value = config.model;
});
addRouterProviderButton.addEventListener('click', () => {
  openRouterProviderForm();
});
cancelRouterProviderButton.addEventListener('click', () => {
  routerProviderForm.hidden = true;
  routerProviderApiKey.value = '';
});
routerProviderForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const apiKey = routerProviderApiKey.value.trim();
  void runRouterProviderSave({
    apiKey: apiKey || undefined,
    baseUrl: routerProviderBaseUrl.value,
    credentialAction: routerProviderId.value && !apiKey ? 'keep' : 'replace',
    id: routerProviderId.value || undefined,
    makePreferred: routerProviderPreferred.checked,
    models: routerProviderModels.value.split(/\r?\n/),
    name: routerProviderName.value,
    protocol: routerProviderProtocol.value as SaveClaudeRouterProviderInput['protocol'],
    useForCurrentProject: routerProviderUseProject.checked,
  });
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-external-url]')) {
  button.addEventListener('click', () => {
    const url = button.dataset.externalUrl;
    if (url) {
      void runGuarded(button, '正在打开…', () => openExternal(url));
    }
  });
}
for (const button of [openProviderConsoleButton, openProviderDocsButton]) {
  button.addEventListener('click', () => {
    const url = button.dataset.externalUrl;
    if (url) {
      void runGuarded(button, '正在打开…', () => openExternal(url));
    }
  });
}
claudeConfigForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void runConnectionTest(true);
});
saveClaudeConfigButton.addEventListener('click', () => {
  void saveClaudeConfig('keep');
});
clearCredentialButton.addEventListener('click', () => {
  if (window.confirm('清除当前项目已加密保存的接口凭据？')) {
    void saveClaudeConfig('clear');
  }
});
for (const field of [claudeBaseUrl, claudeModel, claudeModelFast, claudeCredential]) {
  field.addEventListener('input', () => {
    connectionTestResult.hidden = true;
    connectionRemedy.hidden = true;
  });
}
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
    focusComposer();
  });
}
restartButton.addEventListener('click', async () => {
  const status = activeStatus();
  if (!status) {
    return;
  }
  const result = await window.controlPanel.restartTerminal(status.id);
  terminalViews.get(status.id)?.terminal.clear();
  if (handleOperation(result, result.ok ? '终端已重启' : undefined)) {
    scheduleActiveTerminalFit();
    requestComposerFocus(status.id);
  }
});
toggleButton.addEventListener('click', async () => {
  const status = activeStatus();
  if (!status) {
    return;
  }

  if (status.phase === 'running') {
    handleOperation(await window.controlPanel.stopTerminal(status.id), '终端已停止');
  } else {
    const result = await window.controlPanel.startTerminal(status.id);
    if (handleOperation(result, '终端已启动')) {
      scheduleActiveTerminalFit();
      requestComposerFocus(status.id);
    }
  }
});
clearTerminalButton.addEventListener('click', () => {
  const view = terminalViews.get(workspaceState.activeSessionId);
  view?.terminal.clear();
  view?.terminal.focus();
});
for (const button of terminalContextMenu.querySelectorAll<HTMLButtonElement>(
  '[data-terminal-context-action]',
)) {
  button.addEventListener('click', () => {
    const terminal = terminalViews.get(workspaceState.activeSessionId)?.terminal;
    switch (button.dataset.terminalContextAction) {
      case 'copy':
        void copyActiveTerminalSelection();
        break;
      case 'paste':
        void pasteIntoActiveTerminal();
        break;
      case 'select-all':
        terminal?.selectAll();
        terminal?.focus();
        break;
      case 'clear':
        terminal?.clear();
        terminal?.focus();
        break;
    }
    hideTerminalContextMenu();
  });
}
conversationContextMenu
  .querySelector<HTMLButtonElement>('[data-conversation-context-action="rename"]')
  ?.addEventListener('click', () => {
    const target = conversationContextTarget;
    hideConversationContextMenu();
    if (!target) {
      return;
    }
    if (target.kind === 'running') {
      void renameConversation(target.status);
      return;
    }
    void renameStoredConversation(target.projectPath, target.session);
  });
/*
 * One delegated listener for the whole list: entries are re-rendered on every save and delete, so
 * per-row listeners would have to be re-attached each time.
 */
connectionHistoryList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const item = target.closest<HTMLElement>('[data-history-id]');
  const entryId = item?.dataset.historyId;
  if (!entryId) {
    return;
  }
  if (target.closest('.connection-history__delete')) {
    void deleteConnectionHistory(entryId);
    return;
  }
  if (target.closest('.connection-history__restore')) {
    void applyConnectionHistory(entryId);
  }
});
connectionHistoryList.addEventListener('contextmenu', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[data-history-id]');
  const entryId = item?.dataset.historyId;
  if (!entryId) {
    return;
  }
  event.preventDefault();
  hideTerminalContextMenu();
  hideConversationContextMenu();
  connectionHistoryTargetId = entryId;
  historyContextMenu.hidden = false;
  const menuRect = historyContextMenu.getBoundingClientRect();
  historyContextMenu.style.left = `${Math.max(
    8,
    Math.min(event.clientX, window.innerWidth - menuRect.width - 8),
  )}px`;
  historyContextMenu.style.top = `${Math.max(
    8,
    Math.min(event.clientY, window.innerHeight - menuRect.height - 8),
  )}px`;
  historyContextMenu.querySelector<HTMLButtonElement>('button')?.focus();
});
for (const button of historyContextMenu.querySelectorAll<HTMLButtonElement>(
  '[data-history-context-action]',
)) {
  button.addEventListener('click', () => {
    const entryId = connectionHistoryTargetId;
    const action = button.dataset.historyContextAction;
    hideHistoryContextMenu();
    if (!entryId) {
      return;
    }
    if (action === 'apply') {
      void applyConnectionHistory(entryId);
    } else if (action === 'delete') {
      void deleteConnectionHistory(entryId);
    }
  });
}
document.addEventListener('pointerdown', (event) => {
  if (!terminalContextMenu.contains(event.target as Node)) {
    hideTerminalContextMenu();
  }
  if (!conversationContextMenu.contains(event.target as Node)) {
    hideConversationContextMenu();
  }
  if (!historyContextMenu.contains(event.target as Node)) {
    hideHistoryContextMenu();
  }
  if (
    !footerModelMenu.contains(event.target as Node) &&
    !footerModeMenu.contains(event.target as Node) &&
    !footerModel.contains(event.target as Node) &&
    !footerMode.contains(event.target as Node)
  ) {
    hideFooterMenus();
  }
});
window.addEventListener('blur', () => {
  cancelActiveResizes();
  hideTerminalContextMenu();
  hideConversationContextMenu();
  hideHistoryContextMenu();
  hideFooterMenus();
});
window.addEventListener('focus', () => {
  // Tray restoration is a fresh layout/focus boundary even when Chromium missed the earlier blur.
  cancelActiveResizes();
  scheduleActiveTerminalFit();
  flushPendingComposerFocus();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    scheduleActiveTerminalFit();
    flushPendingComposerFocus();
  } else {
    cancelActiveResizes();
  }
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
  scheduleActiveTerminalFit();
});
resizeObserver.observe(terminalStage);

window.addEventListener('beforeunload', () => {
  cancelActiveResizes();
  terminalFitGeneration += 1;
  resizeObserver.disconnect();
  if (gatewayRefreshTimer !== undefined) {
    window.clearInterval(gatewayRefreshTimer);
  }
  for (const [sessionId, view] of terminalViews) {
    if (view.pendingFrame !== 0) {
      cancelAnimationFrame(view.pendingFrame);
    }
    rejectPermissionModeProbes(sessionId, view);
    view.terminal.dispose();
  }
});

void (async () => {
  renderWorkspace(await window.controlPanel.getWorkspace());
  // Let first paint and workspace hydration complete, then check all update sources without
  // blocking terminal startup or requiring the user to open the connection/plugins pages.
  window.setTimeout(() => {
    void refreshAvailableUpdates(false);
  }, 0);
  const status = activeStatus();
  // No session means no project has been opened yet: leave the empty state up rather than
  // spawning a terminal the user did not ask for.
  if (!status) {
    return;
  }

  if (status.phase !== 'running' && status.phase !== 'starting') {
    handleOperation(await window.controlPanel.startTerminal(status.id));
  }
  void loadConnectionHistory();
  scheduleActiveTerminalFit();
  requestComposerFocus(status.id);
})();
