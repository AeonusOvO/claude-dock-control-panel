import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
/*
 * Every theme's UI and display face ships self-hosted, because a theme switch is meant to change
 * typography as visibly as it changes colour. Claude pairs Hanken Grotesk with the Newsreader
 * serif (the closest free stand-ins for Anthropic's Styrene/Tiempos); Telegram uses Roboto, the
 * face its own desktop client uses; the dark themes keep Inter so they read as tooling.
 */
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/roboto';
import '@fontsource-variable/inter';
import 'katex/dist/katex.css';
import katex from 'katex';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import type {
  ApplicationUpdaterState,
  AppQuitRequest,
  AppSettingsView,
  BusyLease,
  ArtifactNetworkLogEntry,
  ArtifactNetworkState,
  ClaudeConnectionAdvice,
  ClaudeConnectionAdviceAction,
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionTestResult,
  ClaudeEffortRequest,
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
  RouterKernelOperationResult,
  RouterKernelState,
  RouterOperationProgress,
  ClaudeSessionMetadata,
  ChatConfigView,
  ChatAttachmentImportResult,
  ChatAttachmentView,
  ChatContentBlock,
  ChatConversationSummary,
  ChatMessage,
  ChatStreamEvent,
  ChatTokenUsage,
  CodexLaunchMode,
  CodexLoginMethod,
  CodexProjectState,
  DevelopmentRuntime,
  DevelopmentRuntimeState,
  DownloadTaskView,
  McpCatalog,
  McpCatalogEntry,
  McpScope,
  McpServerView,
  FooterResourcePreference,
  ManagedChatGptContextWindowMode,
  ManagedChatGptGatewayState,
  ModelSpeedMode,
  ManagedChatGptSetupProgress,
  NetworkPreflightResult,
  NetworkProviderId,
  SoftwareUpdateState,
  SaveClaudeRouterProviderInput,
  SaveClaudeConfigInput,
  SaveChatConfigInput,
  OperationResult,
  ApplicationProxyCandidate,
  ApplicationProxyState,
  ApplicationProxyView,
  SaveApplicationProxyInput,
  RuntimeActivitySnapshot,
  RuntimeTaskView,
  ClaudePermissionRequestView,
  ClaudePermissionDecision,
  PtyGeneration,
  TerminalPhase,
  TerminalStatus,
  WorkspaceProjectView,
  WorkspaceResult,
  WorkspaceState,
} from '../shared/contracts';
import { claudeStateOwnershipIsCurrent } from '../shared/claude-state-ownership';
import { estimateChatUsage } from '../shared/chat-usage';
import {
  CLAUDE_COMMAND_CATALOG,
  CODEX_COMMAND_CATALOG,
  type CliCommandDefinition,
} from '../shared/cli-command-catalog';
import { parseClaudeCurl, type ClaudeCurlAnalysis } from '../shared/claude-curl';
import {
  completeConnectionEndpoint,
  normalizeConnectionBaseUrl,
  type ConfigurableEndpointProtocol,
} from '../shared/connection-endpoint';
import {
  CLAUDE_EFFORT_OPTIONS,
  claudeEffortLabel,
  isClaudeEffortSafeAfterThinkingDisabledError,
} from '../shared/claude-effort';
import { parseClaudePermissionMode } from '../shared/claude-permission-mode';
import {
  CLAUDE_PROVIDER_GROUPS,
  CLAUDE_PROVIDERS,
  collapsedClaudeProviderGroups,
  findClaudeProvider,
  providerForPreset,
  type ClaudeProviderGroupId,
  type ClaudeProviderId,
} from '../shared/claude-providers';
import { ROUTER_CAPABILITIES } from '../shared/router-capabilities';
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
import { buildTerminalSubmission, writeTerminalSubmission } from '../shared/composer-input';
import { localizePluginCopy } from '../shared/plugin-localization';
import {
  DEFAULT_TERMINAL_THEME,
  isTerminalThemeId,
  SHELL_CSS_VARIABLES,
  TERMINAL_THEMES,
  type TerminalThemeId,
} from '../shared/terminal-themes';
import { deriveUpdateActionState } from '../shared/update-actions';
import { ArtifactController } from './artifact';
import {
  ClaudeLaunchAttemptRegistry,
  orchestrateClaudeLaunchAttempt,
  type ClaudeLaunchAttemptToken,
  type ClaudeLaunchResultDisposition,
} from './claude-launch-attempt';
import { orchestrateSessionOperation, SessionGenerationRegistry } from './session-generation';
import { FolderHistoryLoadCoordinator } from './folder-history-load';
import { TerminalOutputPump } from './terminal-output-pump';
import {
  closeOpenSelect,
  enhanceAllSelects,
  enhanceSelect,
  installPressRipples,
  installSelectDismissHandlers,
  setEnhancedSelectValue,
} from './components';
import {
  createKatexMathRenderer,
  createMarkdownRenderer,
  type MarkdownDomRenderer,
  type MarkdownStreamRenderer,
} from './markdown';
import './styles.css';

/*
 * The component kit is installed at module scope, before anything touches `window.controlPanel`, so
 * a native `<select>` is never painted by the OS — not even for the frame the bridge takes to come
 * up, and not if some later initialisation throws. Options populated afterwards are picked up by the
 * per-select MutationObserver.
 */
enhanceAllSelects();
installSelectDismissHandlers();
installPressRipples();

interface TerminalView {
  container: HTMLDivElement;
  fitAddon: FitAddon;
  /** Lossless, one-write-in-flight output owner for this exact PTY generation. */
  outputPump: TerminalOutputPump;
  /** Main-process probes waiting for all output that preceded their request to reach xterm. */
  permissionModeProbes: Array<{
    probeId: number;
    ptyGeneration: PtyGeneration;
    requiredRevision: number;
  }>;
  /** The exact PTY generation this xterm instance and all of its asynchronous work own. */
  readonly ptyGeneration: PtyGeneration;
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

interface ApplicationProxyDraftSnapshot {
  enabled: boolean;
  host: string;
  port: string;
  protocol: 'http' | 'socks5';
  scope: {
    application: boolean;
    cli: boolean;
    conversation: boolean;
  };
  username: string;
}

interface AdvancedConnectionSnapshot {
  authMode: SaveClaudeConfigInput['authMode'];
  baseUrl: string;
  controls: AdvancedDraftControlState[];
  credential: string;
  model: string;
  modelFast: string;
  protocol: ConfigurableEndpointProtocol;
  providerId?: ClaudeProviderId;
  routerProviderId?: string;
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
const authModeField = requiredElement<HTMLElement>('#auth-mode-field');
const claudeAuthMode = requiredElement<HTMLSelectElement>('#claude-auth-mode');
const claudeApiKeyHelperPolicy = requiredElement<HTMLSelectElement>(
  '#claude-api-key-helper-policy',
);
const claudeApiKeyHelperStatus = requiredElement<HTMLElement>('#claude-api-key-helper-status');
const claudeBaseUrl = requiredElement<HTMLInputElement>('#claude-base-url');
const claudeConfigForm = requiredElement<HTMLFormElement>('#claude-config-form');
const claudeConfigStepTitle = requiredElement<HTMLElement>('#claude-config-step-title');
const claudeConfigStepDescription = requiredElement<HTMLElement>('#claude-config-step-description');
const claudeCredential = requiredElement<HTMLInputElement>('#claude-credential');
const claudeInstallationDetail = requiredElement<HTMLElement>('#claude-installation-detail');
const claudeInstallationTitle = requiredElement<HTMLElement>('#claude-installation-title');
const claudeLiveIndicator = requiredElement<HTMLElement>('#claude-live-indicator');
const claudeModel = requiredElement<HTMLInputElement>('#claude-model');
const claudeModelFast = requiredElement<HTMLInputElement>('#claude-model-fast');
const claudePreset = requiredElement<HTMLSelectElement>('#claude-preset');
const claudeProtocol = requiredElement<HTMLSelectElement>('#claude-protocol');
const claudeRouteEndpoint = requiredElement<HTMLElement>('#claude-route-endpoint');
const claudeRouteModel = requiredElement<HTMLElement>('#claude-route-model');
const claudeRouteName = requiredElement<HTMLElement>('#claude-route-name');
const claudeRuntimeWarning = requiredElement<HTMLElement>('#claude-runtime-warning');
const claudeSecurityBanner = requiredElement<HTMLElement>('#claude-security-banner');
const claudeWorkbench = requiredElement<HTMLElement>('#claude-workbench');
const brandLogo = requiredElement<HTMLImageElement>('#brand-logo');
const baseUrlField = requiredElement<HTMLElement>('#base-url-field');
const protocolField = requiredElement<HTMLElement>('#protocol-field');
const protocolHelp = requiredElement<HTMLElement>('#protocol-help');
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
const claudeCommandGrid = requiredElement<HTMLElement>('#claude-command-grid');
const codexCommandGrid = requiredElement<HTMLElement>('#codex-command-grid');
const contextPercentage = requiredElement<HTMLElement>('#context-percentage');
const contextProgress = requiredElement<HTMLElement>('.context-progress');
const contextProgressBar = requiredElement<HTMLElement>('#context-progress-bar');
const contextSize = requiredElement<HTMLElement>('#context-size');
const contextUsed = requiredElement<HTMLElement>('#context-used');
const credentialField = requiredElement<HTMLElement>('#credential-field');
const credentialSourceSettings = requiredElement<HTMLElement>('#credential-source-settings');
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
const networkPreflightCard = requiredElement<HTMLElement>('#network-preflight-card');
const networkPreflightProvider = requiredElement<HTMLElement>('#network-preflight-provider');
const networkPreflightSummary = requiredElement<HTMLElement>('#network-preflight-summary');
const networkPreflightRecheck = requiredElement<HTMLButtonElement>('#network-preflight-recheck');
const networkPreflightDetails = requiredElement<HTMLButtonElement>('#network-preflight-details');
const networkPreflightDialog = requiredElement<HTMLDialogElement>('#network-preflight-dialog');
const networkPreflightDialogSummary = requiredElement<HTMLElement>(
  '#network-preflight-dialog-summary',
);
const networkPreflightDialogMeta = requiredElement<HTMLElement>('#network-preflight-dialog-meta');
const networkPreflightDialogTone = requiredElement<HTMLElement>(
  '.network-preflight-dialog__summary',
);
const networkPreflightReasons = requiredElement<HTMLUListElement>('#network-preflight-reasons');
const networkPreflightPaths = requiredElement<HTMLUListElement>('#network-preflight-paths');
const networkPreflightProbes = requiredElement<HTMLElement>('#network-preflight-probes');
const networkPreflightClearHistory = requiredElement<HTMLButtonElement>(
  '#network-preflight-clear-history',
);
const networkPreflightDialogRecheck = requiredElement<HTMLButtonElement>(
  '#network-preflight-dialog-recheck',
);
const networkPreflightClose = requiredElement<HTMLButtonElement>('#network-preflight-close');
const footerContextLabel = requiredElement<HTMLElement>('#footer-context-label');
const footerContextRing = requiredElement<HTMLElement>('#footer-context-ring');
const footerResource = requiredElement<HTMLButtonElement>('#footer-resource');
const footerResourceMenu = requiredElement<HTMLElement>('#footer-resource-menu');
const footerResourceDetails = requiredElement<HTMLElement>('#footer-resource-details');
const footerContextWindowOptions = requiredElement<HTMLElement>('#footer-context-window-options');
const footerModel = requiredElement<HTMLButtonElement>('#footer-model');
const footerModelMenu = requiredElement<HTMLElement>('#footer-model-menu');
const footerSpeed = requiredElement<HTMLButtonElement>('#footer-speed');
const footerSpeedMenu = requiredElement<HTMLElement>('#footer-speed-menu');
const footerMode = requiredElement<HTMLButtonElement>('#footer-mode');
const footerModeMenu = requiredElement<HTMLElement>('#footer-mode-menu');
const footerEffort = requiredElement<HTMLButtonElement>('#footer-effort');
const footerEffortMenu = requiredElement<HTMLElement>('#footer-effort-menu');
const footerMore = requiredElement<HTMLButtonElement>('#footer-more');
const footerSecondaryStatus = requiredElement<HTMLElement>('#footer-secondary-status');
const footerStatus = requiredElement<HTMLElement>('#footer-status');
const gatewayCandidates = requiredElement<HTMLElement>('#gateway-candidates');
const gatewayCheckedAt = requiredElement<HTMLElement>('#gateway-checked-at');
const gatewayDiagnosticsSummary = requiredElement<HTMLElement>('#gateway-diagnostics-summary');
const gatewayDiscoverySection = requiredElement<HTMLElement>('#gateway-discovery');
const launchContinueButton = requiredElement<HTMLButtonElement>('#launch-continue');
const launchNewButton = requiredElement<HTMLButtonElement>('#launch-new');
const launchResumeButton = requiredElement<HTMLButtonElement>('#launch-resume');
const runtimePicker = requiredElement<HTMLFieldSetElement>('#runtime-picker');
const runtimeClaude = requiredElement<HTMLInputElement>('#runtime-claude');
const runtimeCodex = requiredElement<HTMLInputElement>('#runtime-codex');
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
const routerSettingsContent = requiredElement<HTMLElement>('#router-settings-content');
const routerCapabilityList = requiredElement<HTMLElement>('#router-capability-list');
const routerWizardForm = requiredElement<HTMLFormElement>('#router-wizard-form');
const routerWizardProvider = requiredElement<HTMLSelectElement>('#router-wizard-provider');
const routerWizardBaseUrlField = requiredElement<HTMLElement>('#router-wizard-base-url-field');
const routerWizardBaseUrl = requiredElement<HTMLInputElement>('#router-wizard-base-url');
const routerWizardCredentialField = requiredElement<HTMLElement>('#router-wizard-credential-field');
const routerWizardCredential = requiredElement<HTMLInputElement>('#router-wizard-credential');
const routerWizardModel = requiredElement<HTMLSelectElement>('#router-wizard-model');
const routerWizardUseRoute = requiredElement<HTMLInputElement>('#router-wizard-use-route');
const routerWizardDecision = requiredElement<HTMLElement>('#router-wizard-decision');
const routerWizardSubmit = requiredElement<HTMLButtonElement>('#router-wizard-submit');
const routerOperationProgress = requiredElement<HTMLElement>('#router-operation-progress');
const routerOperationStage = requiredElement<HTMLElement>('#router-operation-stage');
const routerOperationDetail = requiredElement<HTMLElement>('#router-operation-detail');
const routerOperationMeter = requiredElement<HTMLProgressElement>('#router-operation-meter');
const routerKernelStatus = requiredElement<HTMLElement>('#router-kernel-status');
const installCcSwitchButton = requiredElement<HTMLButtonElement>('#install-cc-switch');
const exportCcSwitchButton = requiredElement<HTMLButtonElement>('#export-cc-switch');
const uninstallCcSwitchButton = requiredElement<HTMLButtonElement>('#uninstall-cc-switch');
const ccSwitchResiduals = requiredElement<HTMLOListElement>('#cc-switch-residuals');
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
const settingsUnsavedIndicator = requiredElement<HTMLElement>('#settings-unsaved-indicator');
const settingsLaunchAtLogin = requiredElement<HTMLInputElement>('#settings-launch-at-login');
const settingsCloseBehavior = requiredElement<HTMLSelectElement>('#settings-close-behavior');
const settingsChatIdleTimeout = requiredElement<HTMLSelectElement>('#settings-chat-idle-timeout');
const settingsWebResearchIsolation = requiredElement<HTMLInputElement>(
  '#settings-web-research-isolation',
);
const settingsCcrBackendStatus = requiredElement<HTMLElement>('#settings-ccr-backend-status');
const settingsChatGptGatewayStatus = requiredElement<HTMLElement>(
  '#settings-chatgpt-gateway-status',
);
const settingsOpenCcrBackend = requiredElement<HTMLButtonElement>('#settings-open-ccr-backend');
const settingsOpenChatGptGateway = requiredElement<HTMLButtonElement>(
  '#settings-open-chatgpt-gateway',
);
const settingsTheme = requiredElement<HTMLSelectElement>('#settings-theme');
const settingsLanguage = requiredElement<HTMLSelectElement>('#settings-language');
const settingsVersion = requiredElement<HTMLOutputElement>('#settings-version');
const applicationProxyEnabled = requiredElement<HTMLInputElement>('#application-proxy-enabled');
const applicationProxyConfiguration = requiredElement<HTMLElement>(
  '#application-proxy-configuration',
);
const applicationProxyScope = requiredElement<HTMLElement>('#application-proxy-scope');
const applicationProxyProtocol = requiredElement<HTMLSelectElement>('#application-proxy-protocol');
const applicationProxyHost = requiredElement<HTMLInputElement>('#application-proxy-host');
const applicationProxyPort = requiredElement<HTMLInputElement>('#application-proxy-port');
const applicationProxyUsername = requiredElement<HTMLInputElement>('#application-proxy-username');
const applicationProxyPassword = requiredElement<HTMLInputElement>('#application-proxy-password');
const applicationProxyCredentialStatus = requiredElement<HTMLElement>(
  '#application-proxy-credential-status',
);
const applicationProxyDetect = requiredElement<HTMLButtonElement>('#application-proxy-detect');
const applicationProxySave = requiredElement<HTMLButtonElement>('#application-proxy-save');
const applicationProxyTest = requiredElement<HTMLButtonElement>('#application-proxy-test');
const applicationProxyCandidates = requiredElement<HTMLElement>('#application-proxy-candidates');
const applicationProxyTestResult = requiredElement<HTMLElement>('#application-proxy-test-result');
const applicationProxyScopeCli = requiredElement<HTMLInputElement>('#application-proxy-scope-cli');
const applicationProxyScopeApplication = requiredElement<HTMLInputElement>(
  '#application-proxy-scope-application',
);
const applicationProxyScopeConversation = requiredElement<HTMLInputElement>(
  '#application-proxy-scope-conversation',
);
const applicationProxyScopeSummary = requiredElement<HTMLElement>(
  '#application-proxy-scope-summary',
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
const runAgentLabel = requiredElement<HTMLElement>('#run-agent-label');
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
const routerRemediation = requiredElement<HTMLElement>('#router-remediation');
const routerRemediationDetail = requiredElement<HTMLElement>('#router-remediation-detail');
const routerRemediationTitle = requiredElement<HTMLElement>('#router-remediation-title');
const routerStatus = requiredElement<HTMLElement>('#router-status');
const routerStatusDetail = requiredElement<HTMLElement>('#router-status-detail');
const routerStatusTitle = requiredElement<HTMLElement>('#router-status-title');
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
const runtimeActivityTrigger = requiredElement<HTMLButtonElement>('#runtime-activity-trigger');
const runtimeActivityLabel = requiredElement<HTMLElement>('#runtime-activity-label');
const runtimeActivityPanel = requiredElement<HTMLElement>('#runtime-activity-panel');
const runtimeActivitySummary = requiredElement<HTMLElement>('#runtime-activity-summary');
const runtimeActivityClose = requiredElement<HTMLButtonElement>('#runtime-activity-close');
const runtimeTaskList = requiredElement<HTMLUListElement>('#runtime-task-list');
const runtimeProcessList = requiredElement<HTMLUListElement>('#runtime-process-list');
const titleStatus = requiredElement<HTMLElement>('#title-status');
const toast = requiredElement<HTMLElement>('#toast');
const testClaudeConnectionButton = requiredElement<HTMLButtonElement>('#test-claude-connection');
const toggleButton = requiredElement<HTMLButtonElement>('#toggle-terminal');
const toggleLabel = requiredElement<HTMLElement>('#toggle-terminal-label');
const workbenchClose = requiredElement<HTMLButtonElement>('#workbench-close');
const workbenchScrim = requiredElement<HTMLButtonElement>('#workbench-scrim');
const workbenchTrigger = requiredElement<HTMLButtonElement>('#workbench-trigger');
const workbenchTriggerLabel = requiredElement<HTMLElement>('#workbench-trigger-label');
const workbenchTitle = requiredElement<HTMLElement>('#workbench-title');
const workbenchTabs = requiredElement<HTMLElement>('#workbench-tabs');
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
const pluginCategoryFilter = requiredElement<HTMLSelectElement>('#plugin-category-filter');
const refreshUpdatesButton = requiredElement<HTMLButtonElement>('#refresh-updates');
const updateAllPluginsButton = requiredElement<HTMLButtonElement>('#update-all-plugins');
const refreshPluginsButton = requiredElement<HTMLButtonElement>('#refresh-plugins');
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
const mcpScopeFilter = requiredElement<HTMLSelectElement>('#mcp-scope-filter');
const mcpSearch = requiredElement<HTMLInputElement>('#mcp-search');
const mcpRefresh = requiredElement<HTMLButtonElement>('#mcp-refresh');
const mcpStatus = requiredElement<HTMLElement>('#mcp-status');
const mcpInstalledCount = requiredElement<HTMLElement>('#mcp-installed-count');
const mcpInstalledList = requiredElement<HTMLElement>('#mcp-installed-list');
const mcpBackupSelect = requiredElement<HTMLSelectElement>('#mcp-backup-select');
const mcpBackupRestore = requiredElement<HTMLButtonElement>('#mcp-backup-restore');
const mcpInstallScope = requiredElement<HTMLSelectElement>('#mcp-install-scope');
const mcpCatalogList = requiredElement<HTMLElement>('#mcp-catalog-list');
const mcpCatalogCount = requiredElement<HTMLElement>('#mcp-catalog-count');
const claudeUpdateDetail = requiredElement<HTMLElement>('#claude-update-detail');
const claudeUpdateVersion = requiredElement<HTMLElement>('#claude-update-version');
const applicationUpdateDetail = requiredElement<HTMLElement>('#application-update-detail');
const applicationUpdateAction = requiredElement<HTMLButtonElement>('#application-update-action');
const applicationUpdateVersion = requiredElement<HTMLElement>('#application-update-version');
const softwareUpdateCheckedAt = requiredElement<HTMLElement>('#software-update-checked-at');
const refreshSoftwareUpdatesButton = requiredElement<HTMLButtonElement>(
  '#refresh-software-updates',
);
const conversationContextMenu = requiredElement<HTMLElement>('#conversation-context-menu');
const conversationRenameDialog = requiredElement<HTMLDialogElement>('#conversation-rename-dialog');
const conversationRenameDialogTitle = requiredElement<HTMLElement>(
  '#conversation-rename-dialog-title',
);
const conversationRenameDialogDescription = requiredElement<HTMLElement>(
  '#conversation-rename-dialog-description',
);
const conversationRenameFieldLabel = requiredElement<HTMLElement>(
  '#conversation-rename-field-label',
);
const conversationRenameCancel = requiredElement<HTMLButtonElement>('#conversation-rename-cancel');
const conversationRenameInput = requiredElement<HTMLInputElement>('#conversation-rename-input');
const confirmationDialog = requiredElement<HTMLDialogElement>('#confirmation-dialog');
const confirmationDialogTitle = requiredElement<HTMLElement>('#confirmation-dialog-title');
const confirmationDialogMessage = requiredElement<HTMLElement>('#confirmation-dialog-message');
const confirmationDialogConfirm = requiredElement<HTMLButtonElement>(
  '#confirmation-dialog-confirm',
);
const quitConfirmationDialog = requiredElement<HTMLDialogElement>('#quit-confirmation-dialog');
const quitConfirmationTitle = requiredElement<HTMLElement>('#quit-confirmation-title');
const quitConfirmationMessage = requiredElement<HTMLElement>('#quit-confirmation-message');
const quitConfirmationList = requiredElement<HTMLUListElement>('#quit-confirmation-list');
const quitMinimizeButton = requiredElement<HTMLButtonElement>('#quit-minimize');
const quitForceButton = requiredElement<HTMLButtonElement>('#quit-force');
const quitCancelButton = requiredElement<HTMLButtonElement>('#quit-cancel');
const connectionHistoryList = requiredElement<HTMLElement>('#connection-history-list');
const connectionHistoryEmpty = requiredElement<HTMLElement>('#connection-history-empty');
const connectionHistoryCount = requiredElement<HTMLElement>('#connection-history-count');
const historyContextMenu = requiredElement<HTMLElement>('#history-context-menu');
const saveClaudeConfigButton = requiredElement<HTMLButtonElement>('#save-claude-config');
const terminalShell = requiredElement<HTMLElement>('#terminal-shell');
const chatShell = requiredElement<HTMLElement>('#chat-shell');
const chatConfigForm = requiredElement<HTMLFormElement>('#chat-config-form');
const chatSettingsDialog = requiredElement<HTMLDialogElement>('#chat-settings-dialog');
const claudePermissionDialog = requiredElement<HTMLDialogElement>('#claude-permission-dialog');
const claudePermissionTool = requiredElement<HTMLElement>('#claude-permission-tool');
const claudePermissionDescription = requiredElement<HTMLElement>('#claude-permission-description');
const claudePermissionSuggestions = requiredElement<HTMLFieldSetElement>(
  '#claude-permission-suggestions',
);
const claudePermissionDenyReason = requiredElement<HTMLInputElement>(
  '#claude-permission-deny-reason',
);
const claudePermissionFallback = requiredElement<HTMLButtonElement>('#claude-permission-fallback');
const claudePermissionDeny = requiredElement<HTMLButtonElement>('#claude-permission-deny');
const claudePermissionAllow = requiredElement<HTMLButtonElement>('#claude-permission-allow');
const openChatSettingsButton = requiredElement<HTMLButtonElement>('#open-chat-settings');
const closeChatSettingsButton = requiredElement<HTMLButtonElement>('#close-chat-settings');
const chatProtocol = requiredElement<HTMLSelectElement>('#chat-protocol');
const chatBaseUrl = requiredElement<HTMLInputElement>('#chat-base-url');
const chatModel = requiredElement<HTMLInputElement>('#chat-model');
const chatAuthMode = requiredElement<HTMLSelectElement>('#chat-auth-mode');
const chatCredential = requiredElement<HTMLInputElement>('#chat-credential');
const chatCredentialStatus = requiredElement<HTMLElement>('#chat-credential-status');
const chatClearCredential = requiredElement<HTMLInputElement>('#chat-clear-credential');
const saveChatConfigButton = requiredElement<HTMLButtonElement>('#save-chat-config');
const chatConfigStatus = requiredElement<HTMLElement>('#chat-config-status');
const chatConnectionTest = requiredElement<HTMLElement>('#chat-connection-test');
const testChatConnectionButton = requiredElement<HTMLButtonElement>('#test-chat-connection');
const chatActiveModel = requiredElement<HTMLElement>('#chat-active-model');
const chatContextTotal = requiredElement<HTMLElement>('#chat-context-total');
const chatTokenUsage = requiredElement<HTMLElement>('#chat-token-usage');
const chatHistoryList = requiredElement<HTMLElement>('#chat-history-list');
const chatHistoryEmpty = requiredElement<HTMLElement>('#chat-history-empty');
const chatHistoryCount = requiredElement<HTMLElement>('#chat-history-count');
const chatMessagesElement = requiredElement<HTMLElement>('#chat-messages');
const chatEmptyState = requiredElement<HTMLElement>('#chat-empty-state');
const chatComposer = requiredElement<HTMLFormElement>('#chat-composer');
const chatInput = requiredElement<HTMLTextAreaElement>('#chat-input');
const chatAttachmentInput = requiredElement<HTMLInputElement>('#chat-attachment-input');
const chatAttachmentQueue = requiredElement<HTMLElement>('#chat-attachment-queue');
const chatAttachButton = requiredElement<HTMLButtonElement>('#chat-attach');
const sendChatButton = requiredElement<HTMLButtonElement>('#send-chat');
const stopChatButton = requiredElement<HTMLButtonElement>('#stop-chat');
const newChatButton = requiredElement<HTMLButtonElement>('#new-chat');
const updateCenterDialog = requiredElement<HTMLDialogElement>('#update-center-dialog');
const closeUpdateCenterButton = requiredElement<HTMLButtonElement>('#close-update-center');
const cancelUpdateCenterButton = requiredElement<HTMLButtonElement>('#cancel-update-center');
const updateCenterAllButton = requiredElement<HTMLButtonElement>('#update-center-all');
const updateCenterEmpty = requiredElement<HTMLElement>('#update-center-empty');
const updateCenterList = requiredElement<HTMLElement>('#update-center-list');
const updateCenterSummary = requiredElement<HTMLElement>('#update-center-summary');
const openDownloadCenterButton = requiredElement<HTMLButtonElement>('#open-download-center');
const downloadActiveCount = requiredElement<HTMLElement>('#download-active-count');
const downloadCenterDialog = requiredElement<HTMLDialogElement>('#download-center-dialog');
const closeDownloadCenterButton = requiredElement<HTMLButtonElement>('#close-download-center');
const downloadCenterEmpty = requiredElement<HTMLElement>('#download-center-empty');
const downloadActiveSection = requiredElement<HTMLElement>('#download-active-section');
const downloadActiveSummary = requiredElement<HTMLElement>('#download-active-summary');
const downloadOperationList = requiredElement<HTMLElement>('#download-operation-list');
const downloadTaskList = requiredElement<HTMLElement>('#download-task-list');
const downloadHistorySection = requiredElement<HTMLElement>('#download-history-section');
const downloadHistorySummary = requiredElement<HTMLElement>('#download-history-summary');
const downloadHistoryList = requiredElement<HTMLElement>('#download-history-list');
const clearDownloadHistoryButton = requiredElement<HTMLButtonElement>('#clear-download-history');
const downloadProgressTemplate = requiredElement<HTMLTemplateElement>(
  '#download-progress-template',
);

const DOWNLOAD_STATE_LABELS: Record<DownloadTaskView['state'], string> = {
  cancelled: '已取消',
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  progressing: '下载中',
  queued: '排队中',
  verifying: '正在校验',
};

const formatDownloadBytes = (bytes: number): string => {
  if (bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value.toLocaleString('zh-CN', {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  })} ${units[unitIndex]}`;
};

const formatDownloadDuration = (milliseconds: number): string => {
  if (milliseconds < 0) {
    return '计算中…';
  }
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
};

const runDownloadAction = async (
  taskId: string,
  action: 'cancel' | 'pause' | 'resume',
): Promise<void> => {
  try {
    if (action === 'cancel') {
      await window.controlPanel.cancelDownload(taskId);
    } else if (action === 'pause') {
      await window.controlPanel.pauseDownload(taskId);
    } else {
      await window.controlPanel.resumeDownload(taskId);
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : '无法更新下载任务。', 'error');
  }
};

const appendDownloadAction = (
  container: HTMLElement,
  task: DownloadTaskView,
  action: 'cancel' | 'pause' | 'resume',
  label: string,
): void => {
  const button = document.createElement('button');
  button.className = `download-task__action download-task__action--${action}`;
  button.textContent = label;
  button.type = 'button';
  button.addEventListener('click', () => {
    button.disabled = true;
    void runDownloadAction(task.id, action);
  });
  container.append(button);
};

const ACTIVE_DOWNLOAD_STATES = new Set<DownloadTaskView['state']>([
  'paused',
  'progressing',
  'queued',
  'verifying',
]);

const createDownloadTaskCard = (task: DownloadTaskView, historical: boolean): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'download-task';
  card.dataset.state = task.state;
  const heading = document.createElement('header');
  const identity = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = task.label;
  const state = document.createElement('span');
  state.className = 'download-task__state';
  state.textContent = DOWNLOAD_STATE_LABELS[task.state];
  identity.append(title, state);

  const progress = downloadProgressTemplate.content.firstElementChild?.cloneNode(true) as
    HTMLElement | undefined;
  if (!progress) return card;
  const settled =
    task.state === 'cancelled' || task.state === 'completed' || task.state === 'failed';
  const percent = Math.max(0, task.percent);
  const indeterminate = !settled && task.percent < 0;
  progress.dataset.indeterminate = String(indeterminate);
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', `${task.label}下载进度`);
  progress.setAttribute('aria-busy', String(indeterminate));
  if (!indeterminate) progress.setAttribute('aria-valuenow', String(Math.round(percent)));
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.style.setProperty('--download-progress', `${percent}%`);
  const ringValue = progress.querySelector<HTMLElement>('.download-progress__value');
  const linearValue = progress.querySelector<HTMLElement>('.download-progress__linear > span');
  if (ringValue) ringValue.textContent = indeterminate ? '…' : `${Math.round(percent)}%`;
  if (linearValue) linearValue.style.width = indeterminate ? '42%' : `${percent}%`;
  heading.append(identity, progress);

  const metrics = document.createElement('dl');
  metrics.className = 'download-task__metrics';
  const appendMetric = (label: string, value: string): void => {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    wrapper.append(term, detail);
    metrics.append(wrapper);
  };
  appendMetric(
    '进度',
    task.totalBytes > 0
      ? `${formatDownloadBytes(task.receivedBytes)} / ${formatDownloadBytes(task.totalBytes)}`
      : `${formatDownloadBytes(task.receivedBytes)} / 计算中…`,
  );
  appendMetric(
    '速度',
    task.bytesPerSecond > 0 ? `${formatDownloadBytes(task.bytesPerSecond)}/s` : '计算中…',
  );
  appendMetric('已用', formatDownloadDuration(task.elapsedMs));
  appendMetric('剩余', formatDownloadDuration(task.remainingMs));

  if (task.errorMessage) {
    const error = document.createElement('p');
    error.className = 'download-task__error';
    error.textContent = task.errorMessage;
    card.append(heading, metrics, error);
  } else {
    card.append(heading, metrics);
  }
  const actions = document.createElement('footer');
  if (!historical && task.canPause) appendDownloadAction(actions, task, 'pause', '暂停');
  if (!historical && task.canResume) appendDownloadAction(actions, task, 'resume', '继续');
  if (!historical && !settled) appendDownloadAction(actions, task, 'cancel', '取消');
  if (historical) {
    const finishedAt = document.createElement('span');
    finishedAt.className = 'download-task__history-time';
    finishedAt.textContent = task.finishedAt
      ? new Date(task.finishedAt).toLocaleString('zh-CN')
      : '本次运行';
    const remove = document.createElement('button');
    remove.className = 'download-task__delete';
    remove.type = 'button';
    remove.textContent = '删除记录';
    remove.addEventListener('click', () => {
      void (async () => {
        const confirmed = await requestConfirmation({
          confirmLabel: '删除记录',
          message: `删除“${task.label}”的下载历史？这不会删除已经安装的软件。`,
          title: '删除下载历史',
          tone: 'danger',
        });
        if (!confirmed) return;
        remove.disabled = true;
        try {
          handleDownloadsChanged(await window.controlPanel.deleteDownloadHistory(task.id));
        } catch (error) {
          showToast(error instanceof Error ? error.message : '无法删除下载历史。', 'error');
          remove.disabled = false;
        }
      })();
    });
    actions.append(finishedAt, remove);
  }
  if (actions.childElementCount > 0) card.append(actions);
  return card;
};

const createBusyOperationCard = (lease: BusyLease): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'download-task';
  card.dataset.state = 'installing';
  const heading = document.createElement('header');
  const identity = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = lease.label;
  const state = document.createElement('span');
  state.className = 'download-task__state';
  state.textContent = lease.kind === 'uninstall' ? '卸载中' : '安装中';
  identity.append(title, state);
  const progress = downloadProgressTemplate.content.firstElementChild?.cloneNode(true) as
    HTMLElement | undefined;
  if (progress) {
    progress.dataset.indeterminate = 'true';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', `${lease.label}进度`);
    progress.setAttribute('aria-busy', 'true');
    progress.querySelector<HTMLElement>('.download-progress__value')!.textContent = '…';
    progress.querySelector<HTMLElement>('.download-progress__linear > span')!.style.width = '42%';
    heading.append(identity, progress);
  } else {
    heading.append(identity);
  }
  card.append(heading);
  return card;
};

const applicationDownloadView = (): DownloadTaskView | undefined => {
  const updater = applicationUpdaterState;
  if (!updater || updater.phase !== 'downloading') return undefined;
  const totalBytes = updater.totalBytes ?? 0;
  const receivedBytes = updater.downloadedBytes ?? 0;
  return {
    bytesPerSecond: updater.bytesPerSecond ?? 0,
    canPause: false,
    canResume: false,
    elapsedMs: 0,
    id: 'application-update-download',
    label: `ClaudeDock ${updater.latestVersion ?? ''} 应用更新`,
    percent: updater.percent ?? -1,
    receivedBytes,
    remainingMs:
      updater.bytesPerSecond && totalBytes > receivedBytes
        ? ((totalBytes - receivedBytes) / updater.bytesPerSecond) * 1_000
        : -1,
    state: 'progressing',
    totalBytes,
  };
};

const renderDownloadCenter = (): void => {
  const activeDownloads = downloadTasks.filter(({ state }) => ACTIVE_DOWNLOAD_STATES.has(state));
  const history = downloadTasks
    .filter(({ state }) => !ACTIVE_DOWNLOAD_STATES.has(state))
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));
  const applicationDownload = applicationDownloadView();
  const operations = busyLeases.filter(({ kind }) => kind === 'install' || kind === 'uninstall');
  const visibleActive = applicationDownload
    ? [applicationDownload, ...activeDownloads]
    : activeDownloads;

  downloadTaskList.replaceChildren(
    ...visibleActive.map((task) => createDownloadTaskCard(task, false)),
  );
  downloadOperationList.replaceChildren(...operations.map(createBusyOperationCard));
  downloadHistoryList.replaceChildren(...history.map((task) => createDownloadTaskCard(task, true)));
  downloadActiveSection.hidden = visibleActive.length === 0 && operations.length === 0;
  downloadHistorySection.hidden = history.length === 0;
  downloadCenterEmpty.hidden =
    visibleActive.length > 0 || operations.length > 0 || history.length > 0;
  downloadActiveSummary.textContent = `${visibleActive.length + operations.length} 项进行中`;
  downloadHistorySummary.textContent = `${history.length} 条记录`;
  clearDownloadHistoryButton.disabled = history.length === 0;

  const activeCount = visibleActive.length + operations.length;
  const aggregatePercent =
    operations.length === 0 &&
    visibleActive.length > 0 &&
    visibleActive.every(({ totalBytes }) => totalBytes > 0)
      ? (visibleActive.reduce((sum, task) => sum + task.receivedBytes, 0) /
          visibleActive.reduce((sum, task) => sum + task.totalBytes, 0)) *
        100
      : -1;
  document.body.dataset.downloading = String(activeCount > 0);
  openDownloadCenterButton.dataset.active = String(activeCount > 0);
  openDownloadCenterButton.dataset.paused = String(
    activeCount > 0 &&
      operations.length === 0 &&
      visibleActive.every(({ state }) => state === 'paused'),
  );
  openDownloadCenterButton.dataset.indeterminate = String(aggregatePercent < 0);
  openDownloadCenterButton.style.setProperty(
    '--download-progress',
    `${Math.max(0, aggregatePercent)}%`,
  );
  openDownloadCenterButton.setAttribute(
    'aria-label',
    activeCount > 0 ? `打开下载中心，${activeCount} 项未完成` : '打开下载中心',
  );
  downloadActiveCount.hidden = activeCount === 0;
  downloadActiveCount.textContent = String(activeCount);
};

const handleDownloadsChanged = (tasks: DownloadTaskView[]): void => {
  downloadTasks = tasks;
  renderDownloadCenter();
  const routerDownload = tasks.find(
    (task) =>
      ACTIVE_DOWNLOAD_STATES.has(task.state) &&
      /CCR|CC Switch|Claude Code Router|路由器/i.test(task.label),
  );
  if (routerDownload && routerOperationInProgress) {
    setRouterOperationStage(
      routerDownload.state === 'verifying' ? '校验下载' : '下载组件',
      `${routerDownload.label} · ${
        routerDownload.totalBytes > 0 ? `${Math.round(routerDownload.percent)}%` : '正在接收…'
      }`,
      routerDownload.totalBytes > 0
        ? Math.max(5, Math.min(70, routerDownload.percent * 0.7))
        : undefined,
    );
  }
};

const captureApplicationProxyDraft = (): ApplicationProxyDraftSnapshot => ({
  enabled: applicationProxyEnabled.checked,
  host: applicationProxyHost.value,
  port: applicationProxyPort.value,
  protocol: applicationProxyProtocol.value === 'socks5' ? 'socks5' : 'http',
  scope: {
    application: applicationProxyScopeApplication.checked,
    cli: applicationProxyScopeCli.checked,
    conversation: applicationProxyScopeConversation.checked,
  },
  username: applicationProxyUsername.value,
});

const applicationProxyViewSnapshot = (
  config: ApplicationProxyView,
): ApplicationProxyDraftSnapshot => ({
  enabled: config.enabled,
  host: config.host,
  port: config.port ? String(config.port) : '',
  protocol: config.protocol,
  scope: { ...config.scope },
  username: config.username,
});

const applicationProxyDraftMatches = (
  left: ApplicationProxyDraftSnapshot,
  right: ApplicationProxyDraftSnapshot,
): boolean =>
  left.enabled === right.enabled &&
  left.host === right.host &&
  left.port === right.port &&
  left.protocol === right.protocol &&
  left.username === right.username &&
  left.scope.application === right.scope.application &&
  left.scope.cli === right.scope.cli &&
  left.scope.conversation === right.scope.conversation;

const applicationProxyIsDirty = (): boolean =>
  (savedApplicationProxy
    ? !applicationProxyDraftMatches(
        captureApplicationProxyDraft(),
        applicationProxyViewSnapshot(savedApplicationProxy),
      )
    : applicationProxyDraftEdited) || applicationProxyPassword.value.length > 0;

const syncApplicationProxyInteractivity = (): void => {
  const enabled = applicationProxyEnabled.checked && !applicationProxyInitialLoadPending;
  applicationProxyEnabled.disabled = applicationProxyInitialLoadPending;
  for (const container of [applicationProxyConfiguration, applicationProxyScope]) {
    container.inert = !enabled;
    container.setAttribute('aria-disabled', String(!enabled));
    for (const control of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input, select',
    )) {
      control.disabled = !enabled;
    }
  }
  if (enabled && applicationProxyProtocol.value === 'socks5') {
    applicationProxyScopeCli.checked = false;
    applicationProxyScopeCli.disabled = true;
  }
  applicationProxySave.disabled =
    applicationProxyInitialLoadPending || applicationProxySaveInProgress;
  applicationProxyDetect.disabled = applicationProxyInitialLoadPending;
  applicationProxyTest.disabled =
    applicationProxyInitialLoadPending ||
    applicationProxyTestInProgress ||
    !savedApplicationProxy?.enabled ||
    applicationProxyIsDirty();
};

const applyApplicationProxyDraft = (draft: ApplicationProxyDraftSnapshot): void => {
  applicationProxyEnabled.checked = draft.enabled;
  applicationProxyProtocol.value = draft.protocol;
  applicationProxyHost.value = draft.host;
  applicationProxyPort.value = draft.port;
  applicationProxyUsername.value = draft.username;
  applicationProxyPassword.value = '';
  applicationProxyScopeCli.checked = draft.scope.cli;
  applicationProxyScopeApplication.checked = draft.scope.application;
  applicationProxyScopeConversation.checked = draft.scope.conversation;
  syncApplicationProxyInteractivity();
};

const renderApplicationProxyState = (
  state: ApplicationProxyState,
  preserveDirtyDraft = true,
): void => {
  const { config, test } = state;
  const draft = captureApplicationProxyDraft();
  const preserveDraft =
    preserveDirtyDraft &&
    connectionAdvancedDialog.open &&
    (applicationProxyDraftEdited || applicationProxyIsDirty());
  savedApplicationProxy = config;
  if (!preserveDraft) {
    applyApplicationProxyDraft(applicationProxyViewSnapshot(config));
  } else {
    const password = applicationProxyPassword.value;
    applyApplicationProxyDraft(draft);
    applicationProxyPassword.value = password;
    syncApplicationProxyInteractivity();
  }
  applicationProxyCredentialStatus.textContent = config.username
    ? config.passwordConfigured
      ? `账号 ${config.username} · 密码已由 Windows DPAPI 加密保存；密码框留空会保留。`
      : `账号 ${config.username} · 未保存密码。`
    : '未配置代理账号密码。';
  const enabledScopes = [
    config.scope.cli ? 'CLI' : undefined,
    config.scope.application ? 'ClaudeDock 自身网络' : undefined,
    config.scope.conversation ? '对话工作台' : undefined,
  ].filter(Boolean);
  applicationProxyScopeSummary.textContent = config.enabled
    ? `${config.protocol.toUpperCase()} ${config.host}:${config.port} 已启用；作用域：${enabledScopes.join('、') || '无'}。`
    : '应用代理已关闭；所有受支持的进程均使用各自的默认连接设置。';
  applicationProxyTestResult.dataset.ok = String(test?.ok ?? false);
  applicationProxyTestResult.textContent = test
    ? `${test.message}${test.latencyMs === undefined ? '' : ` · ${test.latencyMs} ms`} · ${new Date(test.checkedAt).toLocaleTimeString()}`
    : '保存后可通过独立会话测试该端口，不会发送模型请求。';
  updateSettingsUnsavedIndicator();
};

const loadApplicationProxyState = async (
  preserveDirtyDraft = true,
  loadGeneration = applicationProxyLoadGeneration,
): Promise<boolean> => {
  try {
    const state = await window.controlPanel.getApplicationProxyState();
    if (loadGeneration !== applicationProxyLoadGeneration) return false;
    renderApplicationProxyState(state, preserveDirtyDraft);
    return true;
  } catch {
    if (loadGeneration === applicationProxyLoadGeneration) {
      showToast('无法读取应用代理设置。', 'error');
    }
    return false;
  }
};

const renderApplicationProxyCandidates = (candidates: ApplicationProxyCandidate[]): void => {
  applicationProxyCandidates.hidden = candidates.length === 0;
  applicationProxyCandidates.replaceChildren(
    ...candidates.map((candidate) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${candidate.label} · ${candidate.protocol.toUpperCase()} ${candidate.host}:${candidate.port}`;
      button.addEventListener('click', () => {
        applicationProxyDraftEdited = true;
        applicationProxyProtocol.value = candidate.protocol;
        applicationProxyHost.value = candidate.host;
        applicationProxyPort.value = String(candidate.port);
        if (candidate.protocol === 'socks5') applicationProxyScopeCli.checked = false;
        syncApplicationProxyInteractivity();
        updateSettingsUnsavedIndicator();
        showToast('已填入候选代理；请确认作用域后保存');
      });
      return button;
    }),
  );
};

const unsubscribeDownloadsChanged = window.controlPanel.onDownloadsChanged(handleDownloadsChanged);
const unsubscribeBusyChanged = window.controlPanel.onBusyChanged((leases) => {
  busyLeases = leases;
  renderDownloadCenter();
});
const unsubscribeApplicationProxyChanged = window.controlPanel.onApplicationProxyChanged(
  (state) => {
    renderApplicationProxyState(state);
  },
);
const openDownloadCenter = (): void => {
  if (!downloadCenterDialog.open) {
    downloadCenterDialog.showModal();
  }
  closeDownloadCenterButton.focus();
};
const unsubscribeOpenDownloadCenterRequested =
  window.controlPanel.onOpenDownloadCenterRequested(openDownloadCenter);
void window.controlPanel.setConversationBusy(false);

/**
 * Grows the chat textarea with its content up to `--composer-max`, mirroring `resizeComposer` for
 * the terminal. Chat used to rely on a native `resize: vertical` handle, which meant the send button
 * and the input drifted out of alignment the moment the draft wrapped.
 */
const resizeChatComposer = (): void => {
  chatInput.style.height = 'auto';
  const maxHeight = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--composer-max'),
  );
  const height = Number.isFinite(maxHeight)
    ? Math.min(chatInput.scrollHeight, maxHeight)
    : chatInput.scrollHeight;
  chatInput.style.height = `${height}px`;
};
const artifactDetailsButton = requiredElement<HTMLButtonElement>('#chat-artifact-details');
const artifactDetailsClose = requiredElement<HTMLButtonElement>('#artifact-details-close');
const artifactDetailsPanel = requiredElement<HTMLElement>('#artifact-details-panel');
const artifactDetailsScrim = requiredElement<HTMLElement>('#artifact-details-scrim');
const artifactNetworkAllowed = requiredElement<HTMLInputElement>('#artifact-network-allowed');
const artifactActiveList = requiredElement<HTMLElement>('#artifact-active-list');
const artifactNetworkLog = requiredElement<HTMLOListElement>('#artifact-network-log');
const codexPrimaryAction = requiredElement<HTMLButtonElement>('#codex-primary-action');
const codexInstallStep = requiredElement<HTMLElement>('#codex-install-step');
const codexInstallTitle = requiredElement<HTMLElement>('#codex-install-title');
const codexInstallDetail = requiredElement<HTMLElement>('#codex-install-detail');
const codexInstallButton = requiredElement<HTMLButtonElement>('#codex-install');
const codexAccountStep = requiredElement<HTMLElement>('#codex-account-step');
const codexAccountTitle = requiredElement<HTMLElement>('#codex-account-title');
const codexAccountDetail = requiredElement<HTMLElement>('#codex-account-detail');
const codexLoginButton = requiredElement<HTMLButtonElement>('#codex-login');
const codexProjectStep = requiredElement<HTMLElement>('#codex-project-step');
const codexProjectTitle = requiredElement<HTMLElement>('#codex-project-title');
const codexProjectDetail = requiredElement<HTMLElement>('#codex-project-detail');
const codexDeviceLogin = requiredElement<HTMLElement>('#codex-device-login');
const codexDeviceCode = requiredElement<HTMLElement>('#codex-device-code');
const codexCopyDeviceCode = requiredElement<HTMLButtonElement>('#codex-copy-device-code');
const codexUsageCard = requiredElement<HTMLElement>('#codex-usage-card');
const codexPlan = requiredElement<HTMLElement>('#codex-plan');
const codexQuotaLabel = requiredElement<HTMLElement>('#codex-quota-label');
const codexQuotaValue = requiredElement<HTMLElement>('#codex-quota-value');
const codexQuotaBar = requiredElement<HTMLElement>('#codex-quota-bar');
const codexDeviceLoginAction = requiredElement<HTMLButtonElement>('#codex-device-login-action');
const codexCancelLogin = requiredElement<HTMLButtonElement>('#codex-cancel-login');
const codexLogout = requiredElement<HTMLButtonElement>('#codex-logout');
const codexLaunchNew = requiredElement<HTMLButtonElement>('#codex-launch-new');
const codexLaunchContinue = requiredElement<HTMLButtonElement>('#codex-launch-continue');
const codexLaunchResume = requiredElement<HTMLButtonElement>('#codex-launch-resume');
const codexBoundaryNote = requiredElement<HTMLElement>('#codex-boundary-note');

const connectionGlossary = requiredElement<HTMLElement>('.connection-glossary');

connectionAdvancedContent.append(
  credentialSourceSettings,
  connectionAdvice,
  gatewayDiscoverySection,
  curlOnboarding,
  converterHelp,
  connectionGlossary,
);
routerSettingsContent.append(routerManager);
routerCapabilityList.replaceChildren(
  ...CLAUDE_PROVIDERS.map((provider) => {
    const capability = ROUTER_CAPABILITIES[provider.id];
    const card = document.createElement('article');
    card.className = 'router-capability-card';
    card.dataset.mode = capability.mode;
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = provider.label;
    const badge = document.createElement('span');
    badge.textContent =
      provider.id === 'chatgpt-subscription'
        ? '本机网关'
        : capability.mode === 'direct'
          ? '直连'
          : capability.mode === 'router-required'
            ? '必须路由'
            : '路由可选';
    heading.append(title, badge);
    const detail = document.createElement('p');
    detail.textContent = capability.reason;
    const verified = document.createElement('small');
    verified.textContent = `复核：${capability.verifiedAt}`;
    card.append(heading, detail, verified);
    return card;
  }),
);
routerWizardProvider.replaceChildren(
  ...CLAUDE_PROVIDERS.filter((provider) => provider.id !== 'curl' && provider.id !== 'gateway').map(
    (provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      return option;
    },
  ),
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
const codexStates = new Map<string, CodexProjectState>();
const developmentRuntimeStates = new Map<string, DevelopmentRuntimeState>();
const runtimeActivityStates = new Map<string, RuntimeActivitySnapshot>();
const claudeStateLoadGenerations = new SessionGenerationRegistry();
const codexStateLoadGenerations = new SessionGenerationRegistry();
const runtimeStateLoadGenerations = new SessionGenerationRegistry();
const networkPreflightResults = new Map<NetworkProviderId, NetworkPreflightResult>();
/** Conversation history per project folder, keyed by the lower-cased folder path. */
const storedConversations = new Map<string, ClaudeSessionMetadata[]>();
const expandedFolders = new Set<string>();
/** Keeps each folder's history list where the user scrolled it, across sidebar rebuilds. */
const historyScrollPositions = new Map<string, number>();
const collapsedProviderGroups = new Set<ClaudeProviderGroupId>();
const folderHistoryLoads = new FolderHistoryLoadCoordinator();
let dragDepth = 0;
let configFormSessionId = '';
let connectionTestInProgress = false;
let connectionRemedyInProgress = false;
const automaticConnectionTestSessions = new Set<string>();
let networkPreflightInProgress = false;
let networkPreflightDialogProvider: NetworkProviderId | undefined;
let connectionEnvironmentReady = false;
let providerGroupExpansionPending = false;
let selectedProviderId: ClaudeProviderId | undefined;
let selectedRouterProviderId: string | undefined;
let advancedConnectionSnapshot: AdvancedConnectionSnapshot | undefined;
let savedAppSettings: AppSettingsView | undefined;
let footerResourcePreference: FooterResourcePreference = 'auto';
let managedChatGptContextWindowMode: ManagedChatGptContextWindowMode = 'standard';
let savedApplicationProxy: ApplicationProxyView | undefined;
let applicationProxyCancelBaseline: ApplicationProxyDraftSnapshot | undefined;
let applicationProxySaveInProgress = false;
let applicationProxyTestInProgress = false;
let applicationProxyLoadGeneration = 0;
let applicationProxyInitialLoadPending = false;
let applicationProxyDraftEdited = false;
let selectedRailTab: string | undefined = 'projects';
let previewRailTab: string | undefined;
let railPreviewCloseTimer: number | undefined;
type SettingsTab = 'advanced' | 'connection' | 'general' | 'legal' | 'proxy' | 'router';
let selectedSettingsTab: SettingsTab = 'general';
let mainView: 'chat' | 'terminal' = 'terminal';
let gatewayDiagnostics: ClaudeGatewayDiagnostics | undefined;
let managedChatGptSetupInProgress = false;
let renderManagedChatGptProgress: ((progress: ManagedChatGptSetupProgress) => void) | undefined;
let gatewayRefreshInProgress = false;
let gatewayRefreshTimer: number | undefined;
let lastClaudeSessionId = '';
let lastCurlAnalysis: ClaudeCurlAnalysis | undefined;
const claudeLaunchAttempts = new ClaudeLaunchAttemptRegistry();
const claudeSpeedOperations = new SessionGenerationRegistry();
const codexLaunchAttempts = new SessionGenerationRegistry();
const storedConversationRestores = new Set<string>();
let codexOperationInProgress = false;
let codexAutoLaunchSessionId = '';
const routeHealthNotifications = new Map<string, string>();
const effortRecoveryNotifications = new Map<string, number>();
let routerManagementState: ClaudeRouterManagementState | undefined;
let routerKernelState: RouterKernelState | undefined;
let lastRouterOperationProgress: RouterOperationProgress | undefined;
let routerOperationInProgress = false;
let routerRefreshInProgress = false;
let toastTimer: number | undefined;
let connectionAdviceState: ClaudeConnectionAdvice | undefined;
/** Set while a status-bar switch is in flight, so a second click cannot stack terminal writes. */
let modeSwitchInProgress = false;
let modelSwitchInProgress = false;
let effortSwitchInProgress = false;
const guardedButtons = new WeakSet<HTMLButtonElement>();
let chatConfig: ChatConfigView | undefined;
let chatConfigLoadPromise: Promise<void> | undefined;
const chatMessages: ChatMessage[] = [];
let chatConversations: ChatConversationSummary[] = [];
let activeChatConversationId: string | undefined;
let activeChatUsage: ChatTokenUsage = estimateChatUsage([]);
let activeChatProviderUsage: ChatTokenUsage | undefined;
let activeChatRequestMessages: ChatMessage[] = [];
let activeChatRequestId = '';
let activeChatReply = '';
let activeChatReplyElement: HTMLElement | undefined;
let activeChatReplyStream: MarkdownStreamRenderer | undefined;
let activeChatIdleNoticeElement: HTMLElement | undefined;
let activeChatThinking = '';
let activeChatThinkingElement: HTMLElement | undefined;
const pendingChatAttachments: ChatAttachmentView[] = [];
let activeChatAttachmentDraftId: string | undefined;
let chatAttachmentImportQueue: Promise<void> = Promise.resolve();
let queuedChatAttachmentImports = 0;
let chatSubmissionInFlight = false;
let conversationBusyLeaseActive = false;
let pendingQuitRequest: AppQuitRequest | undefined;
const claudePermissionQueue: ClaudePermissionRequestView[] = [];
let activeClaudePermissionRequest: ClaudePermissionRequestView | undefined;
let claudePermissionResponsePending = false;
let claudePermissionExpiryTimer: number | undefined;
let artifactNetworkState: ArtifactNetworkState = { allowed: true, entries: [] };
let markdownRenderer: MarkdownDomRenderer;
let markdownHighlighter: HighlighterCore | undefined;

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
/*
 * Mirrors the MCP page: the plugin lists are rebuilt wholesale on every keystroke and every mutation,
 * so without a memory of what was already on screen every card replayed its entrance animation and
 * typing in the search box read as the whole panel strobing. Only genuinely new cards animate.
 */
let pluginRenderedContext: string | null = null;
let pluginRenderedKeys: ReadonlySet<string> = new Set<string>();
let mcpCatalog: McpCatalog | undefined;
let mcpLoadPromise: Promise<void> | undefined;
let mcpMutationInProgress = false;
let softwareUpdates: SoftwareUpdateState | undefined;
let applicationUpdaterState: ApplicationUpdaterState | undefined;
let softwareUpdateInProgress = false;
let softwareUpdatePromise: Promise<void> | undefined;
let updateRefreshInProgress = false;
let updateCenterOperationInProgress = false;
let downloadTasks: DownloadTaskView[] = [];
let busyLeases: BusyLease[] = [];
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
let windowsBuildNumber: number | undefined;
terminalThemeSelect.value = activeTerminalTheme;

/**
 * The main process spawns every PTY with the bundled conpty.dll (Windows Terminal backend), so the
 * effective ConPTY behaviour is always at least this build regardless of the host OS. Reporting it
 * to xterm keeps its resize reflow enabled (xterm disables reflow for conpty builds < 21376).
 */
const BUNDLED_CONPTY_BUILD = 21376;

const buildTerminalOptions = (): ITerminalOptions => ({
  allowProposedApi: true,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: 'bar',
  fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
  fontSize: 14,
  letterSpacing: 0,
  lineHeight: 1.28,
  minimumContrastRatio: 4.5,
  scrollback: 10_000,
  theme: { ...TERMINAL_THEMES[activeTerminalTheme].palette },
  windowsPty: {
    backend: 'conpty' as const,
    buildNumber: Math.max(windowsBuildNumber ?? 0, BUNDLED_CONPTY_BUILD),
  },
});

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

const artifactThemePayload = (): {
  appearance: 'dark' | 'light';
  variables: Record<string, string>;
} => {
  const styles = getComputedStyle(document.documentElement);
  return {
    appearance: TERMINAL_THEMES[activeTerminalTheme].appearance,
    variables: Object.values(SHELL_CSS_VARIABLES).reduce<Record<string, string>>(
      (variables, property) => {
        const value = styles.getPropertyValue(property).trim();
        if (value) {
          variables[property] = value;
        }
        return variables;
      },
      {},
    ),
  };
};

const renderArtifactActiveList = (): void => {
  artifactActiveList.replaceChildren();
  const ids = artifactController?.activeIds() ?? [];
  if (ids.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'artifact-details__empty';
    empty.textContent = '当前没有正在运行的可视化。';
    artifactActiveList.append(empty);
    return;
  }
  for (const [index, artifactId] of ids.entries()) {
    const row = document.createElement('div');
    row.className = 'artifact-active-list__item';
    const copy = document.createElement('span');
    copy.textContent = `可视化 ${index + 1}`;
    copy.title = artifactId;
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = '停止运行';
    stop.addEventListener('click', () => {
      void artifactController?.stop(artifactId);
    });
    row.append(copy, stop);
    artifactActiveList.append(row);
  }
};

const formatArtifactBytes = (bytes: number | undefined): string => {
  if (bytes === undefined) {
    return '字节数未知';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
};

const renderArtifactNetworkLog = (): void => {
  artifactNetworkAllowed.checked = artifactNetworkState.allowed;
  artifactNetworkLog.replaceChildren();
  const entries = artifactNetworkState.entries.slice(-100).reverse();
  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'artifact-details__empty';
    empty.textContent = '还没有网络请求。内置库不会计入外部联网审计。';
    artifactNetworkLog.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('li');
    row.className = 'artifact-network-log__item';
    row.dataset.blocked = String(entry.blocked);
    const top = document.createElement('div');
    const method = document.createElement('strong');
    method.textContent = entry.method;
    const status = document.createElement('span');
    status.textContent = entry.blocked
      ? '已拦截'
      : entry.error
        ? '失败'
        : String(entry.status ?? '完成');
    top.append(method, status);
    const url = document.createElement('code');
    url.textContent = entry.url;
    url.title = entry.url;
    const meta = document.createElement('small');
    meta.textContent = `${new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(entry.startedAt)} · ${formatArtifactBytes(entry.responseBytes)}${
      entry.error ? ` · ${entry.error}` : ''
    }`;
    row.append(top, url, meta);
    artifactNetworkLog.append(row);
  }
};

const setArtifactDetailsOpen = (open: boolean): void => {
  closeOpenSelect();
  artifactDetailsButton.setAttribute('aria-expanded', String(open));
  artifactDetailsPanel.setAttribute('aria-hidden', String(!open));
  artifactDetailsPanel.dataset.open = String(open);
  artifactDetailsPanel.inert = !open;
  chatMessagesElement.inert = open;
  chatComposer.inert = open;
  artifactDetailsScrim.hidden = !open;
  if (open) {
    void window.controlPanel
      .getArtifactNetworkState()
      .then((state) => {
        artifactNetworkState = state;
        renderArtifactNetworkLog();
      })
      .catch(() => {
        showToast('无法读取 Artifact 审计信息。', 'error');
      });
    renderArtifactActiveList();
    artifactDetailsClose.focus();
  } else {
    artifactDetailsButton.focus();
  }
};

const artifactController = new ArtifactController({
  create: (html) => window.controlPanel.createArtifact(html),
  destroy: (artifactId) => window.controlPanel.destroyArtifact(artifactId),
  getTheme: artifactThemePayload,
  onActiveChange: renderArtifactActiveList,
  onError: (message) => showToast(message, 'error'),
});

const rebuildMarkdownRenderer = (): void => {
  const loadedLanguages = new Set(markdownHighlighter?.getLoadedLanguages() ?? []);
  markdownRenderer = createMarkdownRenderer({
    highlighter: markdownHighlighter
      ? {
          codeToTokens: (code, options) =>
            markdownHighlighter?.codeToTokens(code, {
              lang: (loadedLanguages.has(options.lang) ? options.lang : 'text') as never,
              theme:
                TERMINAL_THEMES[activeTerminalTheme].appearance === 'dark'
                  ? 'github-dark'
                  : 'github-light',
            }),
        }
      : undefined,
    mathRenderer: createKatexMathRenderer(katex),
    onOpenExternal: async (url) => {
      await window.controlPanel.openMarkdownExternal(url);
    },
    onRunArtifact: async (html, mount) => {
      await artifactController?.run(html, mount);
    },
    writeClipboardText: async (text) => {
      await window.controlPanel.writeClipboardText(text);
    },
  });
};

rebuildMarkdownRenderer();
void createHighlighterCore({
  engine: createOnigurumaEngine(import('shiki/wasm')),
  langs: [
    import('@shikijs/langs/bash'),
    import('@shikijs/langs/css'),
    import('@shikijs/langs/html'),
    import('@shikijs/langs/javascript'),
    import('@shikijs/langs/json'),
    import('@shikijs/langs/markdown'),
    import('@shikijs/langs/powershell'),
    import('@shikijs/langs/python'),
    import('@shikijs/langs/typescript'),
  ],
  themes: [import('@shikijs/themes/github-dark'), import('@shikijs/themes/github-light')],
})
  .then((highlighter) => {
    markdownHighlighter = highlighter;
    rebuildMarkdownRenderer();
    if (!activeChatRequestId && (artifactController?.activeIds().length ?? 0) === 0) {
      renderChatMessages();
    }
  })
  .catch(() => {
    // Rich Markdown remains safe and readable; only syntax colours are unavailable.
  });

window.controlPanel.onArtifactNetworkLog((entry: ArtifactNetworkLogEntry) => {
  const existing = artifactNetworkState.entries.findIndex((candidate) => candidate.id === entry.id);
  if (existing >= 0) {
    artifactNetworkState.entries.splice(existing, 1, entry);
  } else {
    artifactNetworkState.entries.push(entry);
  }
  if (artifactNetworkState.entries.length > 500) {
    artifactNetworkState.entries.splice(0, artifactNetworkState.entries.length - 500);
  }
  renderArtifactNetworkLog();
});

const applyTerminalTheme = (themeId: TerminalThemeId, announce = true, persist = true): void => {
  activeTerminalTheme = themeId;
  setEnhancedSelectValue(terminalThemeSelect, themeId);
  setEnhancedSelectValue(settingsTheme, themeId);
  if (persist) localStorage.setItem('claudedock.terminalTheme', themeId);
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
  document.documentElement.dataset.appearance = definition.appearance;
  document.documentElement.style.colorScheme = definition.appearance;
  document.documentElement.style.setProperty('--syntax-red', definition.palette.red);
  document.documentElement.style.setProperty('--syntax-blue', definition.palette.blue);
  document.documentElement.style.setProperty('--syntax-cyan', definition.palette.cyan);
  document.documentElement.style.setProperty('--syntax-green', definition.palette.green);
  document.documentElement.style.setProperty('--syntax-magenta', definition.palette.magenta);
  document.documentElement.style.setProperty('--syntax-yellow', definition.palette.yellow);
  document.documentElement.style.setProperty('--syntax-neutral', definition.palette.brightBlack);
  for (const view of terminalViews.values()) {
    view.terminal.options.theme = { ...definition.palette };
    if (view.terminal.rows > 0) {
      view.terminal.refresh(0, view.terminal.rows - 1);
    }
  }
  // The native titlebar and window background live outside the document and need the main process.
  if (persist) {
    void window.controlPanel.setAppTheme(themeId).catch(() => {
      // A repaint failure is cosmetic only; the CSS side has already switched.
    });
  }
  if (announce) {
    showToast(`主题已切换为“${definition.label}”`);
  }
  rebuildMarkdownRenderer();
  artifactController?.updateTheme();
};

applyTerminalTheme(activeTerminalTheme, false, false);

const projectNameFromPath = (directoryPath: string): string => {
  const parts = directoryPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? directoryPath ?? '项目终端';
};

const activeStatus = (): TerminalStatus | undefined =>
  workspaceState.sessions.find((status) => status.id === workspaceState.activeSessionId);

const activeDevelopmentRuntime = (): DevelopmentRuntime => {
  const status = activeStatus();
  return status ? (developmentRuntimeStates.get(status.id)?.runtime ?? 'claude') : 'claude';
};

const RUNTIME_PHASE_LABELS: Record<RuntimeActivitySnapshot['phase'], string> = {
  'cli-idle': 'CLI 空闲',
  failed: '需要处理',
  'foreground-running': '前台响应中',
  resuming: '正在恢复对话',
  stopped: '已停止',
  'waiting-background': '等待后台唤醒',
};

const runtimeTaskIsUnfinished = (task: RuntimeTaskView): boolean =>
  task.status === 'queued' || task.status === 'running' || task.status === 'waiting';

const renderRuntimeActivity = (snapshot?: RuntimeActivitySnapshot): void => {
  const activeSessionId = workspaceState.activeSessionId;
  const state = snapshot ?? runtimeActivityStates.get(activeSessionId);
  if (state) runtimeActivityStates.set(state.sessionId, state);
  if (!state || state.sessionId !== activeSessionId) {
    runtimeActivityTrigger.hidden = true;
    runtimeActivityPanel.hidden = true;
    runtimeActivityTrigger.setAttribute('aria-expanded', 'false');
    return;
  }

  const unfinished = state.tasks.filter(runtimeTaskIsUnfinished);
  const visible = unfinished.length > 0 || state.webProcesses.length > 0;
  runtimeActivityTrigger.hidden = !visible;
  runtimeActivityTrigger.dataset.phase = state.phase;
  runtimeActivityLabel.textContent = `后台任务 ${unfinished.length} · ${RUNTIME_PHASE_LABELS[state.phase]}`;
  runtimeActivitySummary.textContent = `${RUNTIME_PHASE_LABELS[state.phase]} · 子代理 ${state.subagentCount} · ${
    state.willResumeConversation === true
      ? '完成后会恢复主对话'
      : state.willResumeConversation === false
        ? '不会自动恢复主对话'
        : '是否恢复待确认'
  }`;
  if (state.phase === 'waiting-background' || state.phase === 'resuming') {
    titleStatus.textContent =
      state.phase === 'waiting-background'
        ? `后台任务仍在运行 · ${unfinished.length} 项`
        : '后台任务已返回 · 正在恢复主对话';
    footerStatus.textContent = RUNTIME_PHASE_LABELS[state.phase];
  } else if (state.phase === 'failed') {
    titleStatus.textContent = '本轮响应失败 · 终端上下文已保留';
    footerStatus.textContent = '需要手动继续';
  }

  runtimeTaskList.replaceChildren(
    ...state.tasks.map((task) => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = task.description;
      const details = document.createElement('span');
      const tokenLabel =
        task.tokenUse === 'likely'
          ? '可能持续消耗 token'
          : task.tokenUse === 'none'
            ? '不消耗模型 token'
            : 'token 状态未知';
      const wakeLabel =
        task.willWakeParent === true
          ? '完成后唤醒主对话'
          : task.willWakeParent === false
            ? '不唤醒主对话'
            : '唤醒状态未知';
      details.textContent = `${task.kind} · ${task.status} · ${tokenLabel} · ${wakeLabel}`;
      item.append(title, details);
      return item;
    }),
  );
  if (state.tasks.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = '暂无任务记录';
    runtimeTaskList.append(empty);
  }

  runtimeProcessList.replaceChildren(
    ...state.webProcesses.map((process) => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = `${process.name} · PID ${process.pid}`;
      const command = document.createElement('span');
      command.textContent = process.commandSummary;
      item.append(title, command);
      for (const target of process.urls) {
        const link = document.createElement('a');
        link.href = target.url;
        link.textContent = `${target.url}（${target.confirmed ? '已确认' : '由监听端口推断'}）`;
        link.addEventListener('click', (event) => {
          event.preventDefault();
          void openExternal(target.url);
        });
        item.append(link);
      }
      if (process.exposureWarning) {
        const warning = document.createElement('span');
        warning.textContent = process.exposureWarning;
        item.append(warning);
      }
      const terminate = document.createElement('button');
      terminate.type = 'button';
      terminate.textContent = process.status === 'stopping' ? '正在结束…' : '结束进程';
      terminate.disabled = process.status === 'stopping';
      terminate.addEventListener('click', () => {
        terminate.disabled = true;
        void window.controlPanel
          .terminateRuntimeProcess(state.sessionId, process.processKey)
          .then(renderRuntimeActivity)
          .catch(() => showToast('无法结束该 Web 进程；所有权可能已经变化。', 'error'));
      });
      item.append(terminate);
      return item;
    }),
  );
  if (state.webProcesses.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = '未发现当前会话派生的 Web 监听进程';
    runtimeProcessList.append(empty);
  }

  if (!visible) {
    runtimeActivityPanel.hidden = true;
    runtimeActivityTrigger.setAttribute('aria-expanded', 'false');
  }
};

const loadActiveRuntimeActivity = async (): Promise<void> => {
  const sessionId = workspaceState.activeSessionId;
  if (!sessionId) {
    runtimeActivityTrigger.hidden = true;
    runtimeActivityPanel.hidden = true;
    return;
  }
  try {
    const state = await window.controlPanel.getRuntimeActivity(sessionId);
    if (workspaceState.activeSessionId === sessionId) renderRuntimeActivity(state);
  } catch {
    runtimeActivityTrigger.hidden = true;
  }
};

const renderClaudePermissionRequest = (): void => {
  const request = activeClaudePermissionRequest;
  if (!request || claudePermissionResponsePending) return;
  claudePermissionTool.textContent = request.toolName;
  claudePermissionDescription.textContent = request.description;
  claudePermissionDenyReason.value = '';
  claudePermissionSuggestions.replaceChildren();
  claudePermissionSuggestions.hidden = request.suggestions.length === 0;
  for (const suggestion of request.suggestions) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'claude-permission-suggestion';
    radio.value = suggestion.id;
    label.append(radio, document.createTextNode(suggestion.label));
    claudePermissionSuggestions.append(label);
  }
  claudePermissionAllow.textContent = '本次允许';
  claudePermissionSuggestions.addEventListener(
    'change',
    () => {
      claudePermissionAllow.textContent = '允许并保存所选范围';
    },
    { once: true },
  );
  claudePermissionDialog.returnValue = '';
  if (!claudePermissionDialog.open) claudePermissionDialog.showModal();
  if (claudePermissionExpiryTimer !== undefined) window.clearTimeout(claudePermissionExpiryTimer);
  claudePermissionExpiryTimer = window.setTimeout(
    () => void respondToClaudePermission({ behavior: 'fallback' }),
    Math.max(0, request.expiresAt - Date.now()),
  );
};

const showNextClaudePermissionRequest = (): void => {
  if (activeClaudePermissionRequest || claudePermissionQueue.length === 0) return;
  activeClaudePermissionRequest = claudePermissionQueue.shift();
  renderClaudePermissionRequest();
};

async function respondToClaudePermission(decision: ClaudePermissionDecision): Promise<void> {
  const request = activeClaudePermissionRequest;
  if (!request || claudePermissionResponsePending) return;
  claudePermissionResponsePending = true;
  claudePermissionAllow.disabled = true;
  claudePermissionDeny.disabled = true;
  claudePermissionFallback.disabled = true;
  if (claudePermissionExpiryTimer !== undefined) {
    window.clearTimeout(claudePermissionExpiryTimer);
    claudePermissionExpiryTimer = undefined;
  }
  try {
    await window.controlPanel.respondClaudePermission(request.requestId, decision);
  } finally {
    activeClaudePermissionRequest = undefined;
    claudePermissionResponsePending = false;
    claudePermissionAllow.disabled = false;
    claudePermissionDeny.disabled = false;
    claudePermissionFallback.disabled = false;
    if (claudePermissionDialog.open) claudePermissionDialog.close();
    window.setTimeout(showNextClaudePermissionRequest, 0);
  }
}

const activeNetworkProvider = (): NetworkProviderId | undefined => {
  if (activeDevelopmentRuntime() === 'codex') {
    return 'openai-codex';
  }
  const status = activeStatus();
  const state = status ? claudeStates.get(status.id) : undefined;
  return state?.config.provider === 'gateway' ? undefined : 'anthropic-claude';
};

const savedClaudeConfigInput = (config: ClaudeProjectState['config']): SaveClaudeConfigInput => ({
  apiKeyHelperPolicy: config.apiKeyHelperPolicy,
  authMode: config.sourceAuthMode ?? config.authMode,
  baseUrl: config.sourceBaseUrl ?? config.baseUrl,
  credentialAction: 'keep',
  model: config.sourceModel ?? config.model,
  modelFast: config.sourceModelFast ?? config.modelFast,
  preset: config.preset,
  protocol: config.protocol === 'openai' ? 'openai' : 'anthropic',
  provider: config.provider,
  routerProviderId: config.routerProviderId,
});

const networkPreflightTone = (
  result: NetworkPreflightResult | undefined,
): 'error' | 'pending' | 'success' | 'unknown' | 'warning' => {
  if (!result) {
    return 'unknown';
  }
  if (result.status === 'testing') {
    return 'pending';
  }
  if (result.status === 'blocked') {
    return 'error';
  }
  if (result.status === 'allowed') {
    return 'success';
  }
  return 'warning';
};

const networkStatusLabel = (result: NetworkPreflightResult): string => {
  switch (result.status) {
    case 'allowed':
      return '官方网络正常';
    case 'allowed_with_notice':
      return '网络可用 · 有路径提示';
    case 'blocked':
      return '官方网络已阻止';
    case 'degraded':
      return '网络结果不完整';
    case 'partially_available':
      return '基础可用 · 云任务受限';
    case 'testing':
      return '正在执行无额度预检';
    case 'unknown':
      return '网络状态未知';
    case 'warning':
      return '网络可用 · 需要确认';
  }
};

const replaceList = (target: HTMLUListElement, values: string[], empty: string): void => {
  const items = values.length > 0 ? values : [empty];
  target.replaceChildren(
    ...items.map((value) => {
      const item = document.createElement('li');
      item.textContent = value;
      return item;
    }),
  );
};

const renderNetworkPreflightDetails = (result?: NetworkPreflightResult): void => {
  const tone = networkPreflightTone(result);
  networkPreflightDialogTone.dataset.tone = tone;
  if (!result) {
    networkPreflightDialogSummary.textContent = '尚无探测结果';
    networkPreflightDialogMeta.textContent = '探测不调用模型、不读取登录令牌，也不修改系统代理。';
    replaceList(networkPreflightReasons, [], '打开工作台后会自动执行首次检查。');
    replaceList(networkPreflightPaths, [], '尚未解析进程网络路径。');
    networkPreflightProbes.replaceChildren();
    return;
  }
  networkPreflightDialogSummary.textContent = result.summary;
  const checkedAt = result.checkedAt
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(result.checkedAt)
    : '正在检测';
  networkPreflightDialogMeta.textContent = `${checkedAt} · 风险 ${result.riskScore}/100 · 仅检查本机路径与服务商官方端点`;
  replaceList(networkPreflightReasons, result.reasons, '没有需要用户处理的风险信号。');
  replaceList(
    networkPreflightPaths,
    result.paths.map(
      (pathView) =>
        `${pathView.detail} ${
          pathView.proxyConfigured ? `可见代理第一跳：${pathView.proxyKind}` : '未发现本机显式代理'
        }${
          pathView.virtualInterfaces.length > 0
            ? `；虚拟接口：${pathView.virtualInterfaces.join('、')}`
            : ''
        }`,
    ),
    '尚未解析进程网络路径。',
  );
  networkPreflightProbes.replaceChildren(
    ...result.probes.map((probe) => {
      const row = document.createElement('div');
      const status = document.createElement('span');
      status.dataset.status = probe.status;
      status.textContent =
        probe.status === 'passed'
          ? '通过'
          : probe.status === 'failed'
            ? '失败'
            : probe.status === 'warning'
              ? '警告'
              : probe.status === 'skipped'
                ? '已跳过'
                : '未知';
      const label = document.createElement('strong');
      label.textContent = probe.label;
      const detail = document.createElement('span');
      detail.textContent = probe.detail;
      row.append(status, label, detail);
      return row;
    }),
  );
};

const renderActiveNetworkPreflight = (): void => {
  const provider = activeNetworkProvider();
  if (!provider) {
    networkPreflightCard.dataset.tone = 'success';
    networkPreflightProvider.textContent = '自定义网关';
    networkPreflightSummary.textContent = '不使用官方服务守卫，按当前网关健康状态运行';
    networkPreflightRecheck.disabled = false;
    return;
  }
  const result = networkPreflightResults.get(provider);
  const tone = networkPreflightTone(result);
  networkPreflightCard.dataset.tone = tone;
  networkPreflightProvider.textContent =
    result?.providerLabel ??
    (provider === 'openai-codex' ? 'OpenAI Codex' : 'Anthropic Claude Code');
  networkPreflightSummary.textContent = result?.summary ?? '等待首次无额度探测';
  networkPreflightRecheck.disabled = networkPreflightInProgress || result?.status === 'testing';
  if (activeDevelopmentRuntime() === 'codex') {
    footerConnection.dataset.tone = tone === 'unknown' ? 'warning' : tone;
    footerConnection.disabled = result?.status === 'testing';
    footerConnection.setAttribute('aria-busy', String(result?.status === 'testing'));
    footerConnectionLabel.textContent = result ? networkStatusLabel(result) : '官方网络待检测';
  }
  if (result?.status === 'blocked') {
    runClaudeButton.disabled = true;
    runClaudeButton.title = result.reasons[0] ?? result.summary;
    for (const button of [
      launchNewButton,
      launchContinueButton,
      launchResumeButton,
      codexLaunchNew,
      codexLaunchContinue,
      codexLaunchResume,
    ]) {
      button.disabled = true;
    }
  }
};

const runActiveNetworkPreflight = async (
  force: boolean,
  providerOverride?: NetworkProviderId,
): Promise<void> => {
  const provider = providerOverride ?? activeNetworkProvider();
  if (!provider || networkPreflightInProgress) {
    if (!provider && force) {
      showToast('当前 Claude 配置使用自定义网关，不需要官方服务预检。');
    }
    return;
  }
  networkPreflightInProgress = true;
  networkPreflightRecheck.disabled = true;
  networkPreflightDialogRecheck.disabled = true;
  try {
    const result = await window.controlPanel.runNetworkPreflight({
      action: 'background',
      force,
      provider,
    });
    networkPreflightResults.set(provider, result);
    renderActiveNetworkPreflight();
    if (!networkPreflightDialogProvider || networkPreflightDialogProvider === provider) {
      renderNetworkPreflightDetails(result);
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : '网络预检无法完成。', 'error');
  } finally {
    networkPreflightInProgress = false;
    networkPreflightDialogRecheck.disabled = false;
    renderActiveNetworkPreflight();
  }
};

const openNetworkPreflightDialog = async (providerOverride?: NetworkProviderId): Promise<void> => {
  const provider = providerOverride ?? activeNetworkProvider();
  networkPreflightDialogProvider = provider;
  renderNetworkPreflightDetails(provider ? networkPreflightResults.get(provider) : undefined);
  if (!networkPreflightDialog.open) {
    networkPreflightDialog.showModal();
  }
};

const chatConfigInput = (): SaveChatConfigInput => {
  const credential = chatCredential.value.trim();
  return {
    authMode: chatAuthMode.value as SaveChatConfigInput['authMode'],
    baseUrl: chatBaseUrl.value,
    credential: credential || undefined,
    credentialAction: chatClearCredential.checked ? 'clear' : credential ? 'replace' : 'keep',
    model: chatModel.value,
    protocol: chatProtocol.value as SaveChatConfigInput['protocol'],
  };
};

const renderChatUsage = (): void => {
  const draft = chatInput.value.trim();
  const displayUsage = draft
    ? estimateChatUsage([...chatMessages, { content: draft, role: 'user' }])
    : activeChatUsage;
  const marker = displayUsage.source === 'estimated' ? '约 ' : '';
  chatContextTotal.textContent = `${marker}${formatTokenCount(displayUsage.totalTokens)} tokens`;
  chatTokenUsage.textContent = `输入 ${marker}${formatTokenCount(displayUsage.inputTokens)} · 输出 ${marker}${formatTokenCount(displayUsage.outputTokens)}`;
  const detail =
    displayUsage.source === 'provider'
      ? 'Token 数由当前模型接口返回。'
      : draft
        ? '已把输入框草稿计入当前上下文，并按文本长度实时估算。'
        : '当前接口尚未返回 usage，暂按文本长度估算。';
  chatContextTotal.title = detail;
  chatTokenUsage.title = detail;
};

const formatChatHistoryTime = (timestamp: number): string =>
  new Intl.DateTimeFormat('zh-CN', {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  }).format(new Date(timestamp));

const loadChatConversation = async (conversationId: string): Promise<void> => {
  if (activeChatRequestId || queuedChatAttachmentImports > 0 || chatSubmissionInFlight) {
    return;
  }
  try {
    const conversation = await window.controlPanel.getChatConversation(conversationId);
    if (!conversation) {
      showToast('这条对话历史已经不存在。', 'error');
      await loadChatHistory();
      return;
    }
    const discardedDraftId = activeChatAttachmentDraftId;
    activeChatAttachmentDraftId = undefined;
    pendingChatAttachments.splice(0);
    if (discardedDraftId) {
      void window.controlPanel.releaseChatAttachmentDraft(discardedDraftId).catch((error) => {
        showToast(error instanceof Error ? error.message : '无法清理未发送的附件草稿。', 'error');
      });
    }
    activeChatConversationId = conversation.id;
    chatMessages.splice(0, chatMessages.length, ...conversation.messages);
    activeChatUsage = { ...conversation.usage };
    activeChatProviderUsage =
      conversation.usage.source === 'provider' ? { ...conversation.usage } : undefined;
    activeChatRequestMessages = [];
    renderChatMessages();
    renderChatUsage();
    renderChatHistory();
    chatInput.focus();
  } catch (error) {
    showToast(error instanceof Error ? error.message : '无法读取这条对话历史。', 'error');
  }
};

const deleteChatConversation = async (conversation: ChatConversationSummary): Promise<void> => {
  if (
    activeChatRequestId ||
    queuedChatAttachmentImports > 0 ||
    chatSubmissionInFlight ||
    !(await requestConfirmation({
      confirmLabel: '删除对话',
      message: `永久删除“${conversation.title}”及其本机消息记录？此操作无法撤销。`,
      title: '删除对话历史',
      tone: 'danger',
    }))
  ) {
    return;
  }
  try {
    const deleted = await window.controlPanel.deleteChatConversation(conversation.id);
    if (!deleted) {
      throw new Error('对话历史已经不存在。');
    }
    if (activeChatConversationId === conversation.id) {
      resetChatConversation();
    }
    cancelChatTitleAnimation(conversation.id);
    await loadChatHistory();
    showToast(`已删除对话“${conversation.title}”`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '无法删除对话历史。', 'error');
  }
};

/*
 * Chat history titles get the same typewriter treatment as project conversations: the old name is
 * erased character by character and the new one typed in behind a blinking caret. The state lives
 * outside the DOM because the history list is rebuilt from scratch on every reload — each rebuild
 * re-reads the current frame, and each timer tick patches the live element between rebuilds.
 */
interface ChatTitleAnimationState {
  chars: string[];
  keep: number;
  phase: 'erasing' | 'typing';
  target: string[];
  timer: number;
}

const chatTitleAnimations = new Map<string, ChatTitleAnimationState>();

const displayedChatTitle = (conversation: ChatConversationSummary): string => {
  const animation = chatTitleAnimations.get(conversation.id);
  return animation ? animation.chars.join('') : conversation.title;
};

const cancelChatTitleAnimation = (conversationId: string): void => {
  const animation = chatTitleAnimations.get(conversationId);
  if (!animation) {
    return;
  }
  window.clearTimeout(animation.timer);
  chatTitleAnimations.delete(conversationId);
};

const applyChatTitleFrame = (conversationId: string): void => {
  const animation = chatTitleAnimations.get(conversationId);
  const label = chatHistoryList.querySelector<HTMLElement>(
    `strong[data-conversation-id="${CSS.escape(conversationId)}"]`,
  );
  if (!label) {
    return;
  }
  if (animation) {
    label.textContent = animation.chars.join('');
    label.dataset.titleTyping = 'true';
    return;
  }
  label.dataset.titleTyping = 'false';
};

const stepChatTitleAnimation = (conversationId: string): void => {
  const animation = chatTitleAnimations.get(conversationId);
  if (!animation) {
    return;
  }

  let delay: number;
  if (animation.phase === 'erasing') {
    if (animation.chars.length > animation.keep) {
      animation.chars.pop();
      delay = CHAT_TITLE_ERASE_MS;
    } else {
      animation.phase = 'typing';
      delay = CHAT_TITLE_PHASE_PAUSE_MS;
    }
  } else if (animation.chars.length < animation.target.length) {
    animation.chars.push(animation.target[animation.chars.length] ?? '');
    // Slightly uneven keystrokes read as typing rather than a mechanical ticker.
    delay = CHAT_TITLE_TYPE_MS + Math.random() * 42;
  } else {
    cancelChatTitleAnimation(conversationId);
    applyChatTitleFrame(conversationId);
    return;
  }

  applyChatTitleFrame(conversationId);
  animation.timer = window.setTimeout(() => {
    stepChatTitleAnimation(conversationId);
  }, delay);
};

const CHAT_TITLE_ERASE_MS = 24;
const CHAT_TITLE_TYPE_MS = 44;
const CHAT_TITLE_PHASE_PAUSE_MS = 200;

const startChatTitleAnimation = (
  conversationId: string,
  fromTitle: string,
  toTitle: string,
): void => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cancelChatTitleAnimation(conversationId);
    applyChatTitleFrame(conversationId);
    return;
  }
  const existing = chatTitleAnimations.get(conversationId);
  // A retarget mid-animation continues from whatever is on screen right now.
  const chars = existing ? existing.chars : [...fromTitle];
  if (existing) {
    window.clearTimeout(existing.timer);
  }

  const target = [...toTitle];
  let keep = 0;
  while (keep < chars.length && keep < target.length && chars[keep] === target[keep]) {
    keep += 1;
  }

  const animation: ChatTitleAnimationState = {
    chars,
    keep,
    phase: chars.length > keep ? 'erasing' : 'typing',
    target,
    timer: 0,
  };
  chatTitleAnimations.set(conversationId, animation);
  applyChatTitleFrame(conversationId);
  animation.timer = window.setTimeout(() => {
    stepChatTitleAnimation(conversationId);
  }, CHAT_TITLE_ERASE_MS);
};

const renameChatConversation = async (conversation: ChatConversationSummary): Promise<void> => {
  if (activeChatRequestId || queuedChatAttachmentImports > 0 || chatSubmissionInFlight) {
    return;
  }
  const nextTitle = await requestConversationTitle(conversation.title, true);
  if (!nextTitle) {
    return;
  }
  const previousTitle = conversation.title;
  try {
    const renamed = await window.controlPanel.renameChatConversation(conversation.id, nextTitle);
    if (!renamed) {
      throw new Error('对话历史已经不存在。');
    }
    // Reload first so the list carries the persisted name, then animate from the old label to it.
    await loadChatHistory();
    startChatTitleAnimation(conversation.id, previousTitle, renamed.title);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '无法重命名对话。', 'error');
  }
};

const renderChatHistory = (): void => {
  chatHistoryList.replaceChildren();
  chatHistoryEmpty.hidden = chatConversations.length > 0;
  chatHistoryEmpty.textContent = '还没有历史记录；发送第一条消息后会自动保存。';
  chatHistoryCount.textContent = `${chatConversations.length} 条`;
  for (const conversation of chatConversations) {
    const row = document.createElement('div');
    row.className = 'chat-history__item';
    row.dataset.active = String(conversation.id === activeChatConversationId);

    const busy =
      Boolean(activeChatRequestId) || queuedChatAttachmentImports > 0 || chatSubmissionInFlight;

    const open = document.createElement('button');
    open.className = 'chat-history__open';
    open.type = 'button';
    open.disabled = busy;
    open.setAttribute('aria-label', `打开对话 ${conversation.title}`);
    const title = document.createElement('strong');
    title.dataset.conversationId = conversation.id;
    // A rename in flight owns the label until its animation finishes.
    title.textContent = displayedChatTitle(conversation);
    title.dataset.titleTyping = String(chatTitleAnimations.has(conversation.id));
    const meta = document.createElement('span');
    meta.textContent = `${formatChatHistoryTime(conversation.updatedAt)} · ${conversation.messageCount} 条消息 · ${formatTokenCount(conversation.usage.totalTokens)} tokens`;
    open.append(title, meta);
    open.addEventListener('click', () => {
      void loadChatConversation(conversation.id);
    });

    const rename = document.createElement('button');
    rename.className = 'chat-history__rename';
    rename.type = 'button';
    rename.disabled = busy;
    rename.title = '重命名对话';
    rename.setAttribute('aria-label', `重命名对话 ${conversation.title}`);
    const renameIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    renameIcon.setAttribute('viewBox', '0 0 24 24');
    renameIcon.setAttribute('aria-hidden', 'true');
    const renamePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    renamePath.setAttribute('d', 'M4 20h4l10-10-4-4L4 16v4ZM14.5 5.5l4 4');
    renameIcon.append(renamePath);
    rename.append(renameIcon);
    rename.addEventListener('click', () => {
      void renameChatConversation(conversation);
    });

    const remove = document.createElement('button');
    remove.className = 'chat-history__delete';
    remove.type = 'button';
    remove.disabled = busy;
    remove.title = '删除对话历史';
    remove.setAttribute('aria-label', `删除对话 ${conversation.title}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      void deleteChatConversation(conversation);
    });
    row.append(open, rename, remove);
    chatHistoryList.append(row);
  }
};

async function loadChatHistory(): Promise<void> {
  try {
    chatConversations = await window.controlPanel.getChatConversations();
    renderChatHistory();
  } catch (error) {
    chatHistoryEmpty.hidden = false;
    chatHistoryEmpty.textContent =
      error instanceof Error ? error.message : '无法读取本机对话历史。';
  }
}

const renderChatMessages = (): void => {
  artifactController?.stopAll();
  chatMessagesElement.replaceChildren(chatEmptyState);
  chatEmptyState.hidden = chatMessages.length > 0;
  for (const message of chatMessages) {
    if (message.role !== 'system') {
      appendChatMessage(message.role, message.content);
    }
  }
};

const persistActiveChat = async (): Promise<void> => {
  if (chatMessages.length === 0) {
    return;
  }
  try {
    const saved = await window.controlPanel.saveChatConversation({
      conversationId: activeChatConversationId,
      messages: [...chatMessages],
      usage: { ...activeChatUsage },
    });
    activeChatConversationId = saved.id;
    chatConversations = [
      saved,
      ...chatConversations.filter((conversation) => conversation.id !== saved.id),
    ];
    renderChatHistory();
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : '消息已发送，但本机对话历史保存失败。',
      'error',
    );
  }
};

function resetChatConversation(): void {
  activeChatReplyStream?.destroy();
  activeChatReplyStream = undefined;
  activeChatThinking = '';
  activeChatThinkingElement = undefined;
  artifactController?.stopAll();
  activeChatConversationId = undefined;
  chatMessages.splice(0);
  activeChatUsage = estimateChatUsage([]);
  activeChatProviderUsage = undefined;
  activeChatRequestMessages = [];
  chatMessagesElement.replaceChildren(chatEmptyState);
  chatEmptyState.hidden = false;
  chatInput.value = '';
  resizeChatComposer();
  const discardedDraftId = activeChatAttachmentDraftId;
  activeChatAttachmentDraftId = undefined;
  pendingChatAttachments.splice(0);
  if (discardedDraftId) {
    void window.controlPanel.releaseChatAttachmentDraft(discardedDraftId).catch((error) => {
      showToast(error instanceof Error ? error.message : '无法清理未发送的附件草稿。', 'error');
    });
  }
  renderPendingChatAttachments();
  renderChatUsage();
  renderChatHistory();
}

const renderChatConfig = (config: ChatConfigView): void => {
  chatConfig = config;
  chatProtocol.value = config.protocol;
  chatBaseUrl.value = config.baseUrl;
  chatModel.value = config.model;
  chatAuthMode.value = config.authMode;
  chatCredential.value = '';
  chatClearCredential.checked = false;
  chatCredential.disabled = config.authMode === 'none';
  chatClearCredential.disabled = config.authMode === 'none';
  chatCredentialStatus.textContent =
    config.authMode === 'none'
      ? '当前接口不使用认证凭据。'
      : config.credentialConfigured
        ? '已通过 Windows 安全存储保存凭据；留空可继续使用。'
        : '尚未保存凭据。';
  chatActiveModel.textContent = config.model || '尚未配置模型';
};

const loadChatConfig = (force = false): Promise<void> => {
  if (chatConfigLoadPromise && !force) {
    return chatConfigLoadPromise;
  }
  chatConfigLoadPromise = window.controlPanel
    .getChatConfig()
    .then((config) => {
      renderChatConfig(config);
      chatConfigStatus.textContent = config.model ? '独立接入已就绪。' : '请填写模型并保存。';
    })
    .catch(() => {
      chatConfigStatus.textContent = '无法读取独立对话配置。';
      showToast('无法读取独立对话配置。', 'error');
    })
    .finally(() => {
      chatConfigLoadPromise = undefined;
    });
  return chatConfigLoadPromise;
};

const normalizedChatBlocks = (content: ChatMessage['content']): ChatContentBlock[] =>
  typeof content === 'string' ? [{ text: content, type: 'text' }] : content;

const chatTextContent = (content: ChatMessage['content']): string =>
  normalizedChatBlocks(content)
    .filter((block): block is Extract<ChatContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');

const formatAttachmentSize = (sizeBytes: number): string => {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(sizeBytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
};

const appendAttachmentCard = (
  container: HTMLElement,
  block: Exclude<ChatContentBlock, { type: 'text' }>,
): void => {
  const card = document.createElement('div');
  card.className = `chat-attachment-card chat-attachment-card--${block.type}`;
  const preview = document.createElement('div');
  preview.className = 'chat-attachment-card__preview';
  preview.textContent =
    block.type === 'image' ? '图片' : block.mediaType === 'application/pdf' ? 'PDF' : '文件';
  const copy = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = block.fileName || (block.type === 'image' ? '图片附件' : '文档附件');
  const meta = document.createElement('small');
  meta.textContent = block.mediaType;
  copy.append(name, meta);
  card.append(preview, copy);
  container.append(card);

  if (block.source.type !== 'local') {
    return;
  }
  void window.controlPanel
    .readChatAttachment(block.source.attachmentId)
    .then((attachment) => {
      if (!attachment || !card.isConnected) {
        return;
      }
      name.textContent = attachment.fileName;
      meta.textContent = `${attachment.mediaType} · ${formatAttachmentSize(attachment.sizeBytes)}`;
      if (attachment.type === 'image' && attachment.previewDataUrl) {
        const image = document.createElement('img');
        image.alt = attachment.fileName;
        image.loading = 'lazy';
        image.src = attachment.previewDataUrl;
        preview.replaceChildren(image);
      }
    })
    .catch(() => {
      meta.textContent = '附件在本机已不可用';
      card.dataset.missing = 'true';
    });
};

const appendChatMessage = (
  role: 'assistant' | 'user',
  content: ChatMessage['content'],
  renderMarkdown = true,
): HTMLElement => {
  const article = document.createElement('article');
  article.className = `chat-message chat-message--${role}`;
  const label = document.createElement('strong');
  label.textContent = role === 'user' ? '你' : 'AI 生成';
  const body = document.createElement('div');
  body.className = 'chat-message__content';
  const blocks = normalizedChatBlocks(content);
  const attachments = blocks.filter(
    (block): block is Exclude<ChatContentBlock, { type: 'text' }> => block.type !== 'text',
  );
  if (attachments.length > 0) {
    const attachmentList = document.createElement('div');
    attachmentList.className = 'chat-message__attachments';
    for (const attachment of attachments) {
      appendAttachmentCard(attachmentList, attachment);
    }
    body.append(attachmentList);
  }
  const text = chatTextContent(content);
  let textMount: HTMLElement | undefined;
  if (text) {
    textMount = document.createElement('div');
    textMount.className = 'chat-message__markdown';
    body.append(textMount);
    if (role === 'assistant' && renderMarkdown) {
      void markdownRenderer.renderInto(textMount, text);
    } else {
      textMount.textContent = text;
    }
  }
  article.append(label, body);
  chatMessagesElement.append(article);
  chatEmptyState.hidden = true;
  chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
  return textMount ?? body;
};

const setChatBusy = (busy: boolean): void => {
  const preparing = queuedChatAttachmentImports > 0 || chatSubmissionInFlight;
  const protectsConversation = busy || preparing;
  if (protectsConversation !== conversationBusyLeaseActive) {
    conversationBusyLeaseActive = protectsConversation;
    void window.controlPanel.setConversationBusy(protectsConversation).catch(() => {
      conversationBusyLeaseActive = !protectsConversation;
    });
  }
  chatInput.disabled = busy;
  chatAttachButton.disabled = busy || preparing;
  sendChatButton.disabled = busy || preparing;
  stopChatButton.hidden = !busy;
  newChatButton.disabled = busy || preparing;
  testChatConnectionButton.disabled = busy || preparing;
  chatComposer.setAttribute('aria-busy', String(busy || preparing));
  renderChatHistory();
};

const finishChatRequest = (): void => {
  activeChatReplyStream?.destroy();
  activeChatRequestId = '';
  activeChatReply = '';
  activeChatReplyElement = undefined;
  activeChatReplyStream = undefined;
  activeChatIdleNoticeElement = undefined;
  activeChatThinking = '';
  activeChatThinkingElement = undefined;
  activeChatRequestMessages = [];
  setChatBusy(false);
  chatInput.focus();
};

const appendChatContinuationButton = (replyElement: HTMLElement): HTMLButtonElement | undefined => {
  const article = replyElement.closest('article');
  if (!article) {
    return undefined;
  }
  const button = document.createElement('button');
  button.className = 'chat-message__continue';
  button.disabled = true;
  button.textContent = '继续生成';
  button.type = 'button';
  button.addEventListener('click', () => {
    button.remove();
    chatInput.value = '请从上一条回答中断处继续，不要重复已经给出的内容。';
    resizeChatComposer();
    void submitChatMessage();
  });
  article.append(button);
  return button;
};

const handleChatStream = (event: ChatStreamEvent): void => {
  if (event.requestId !== activeChatRequestId) {
    return;
  }
  if (event.usage) {
    activeChatProviderUsage = { ...event.usage };
    activeChatUsage = { ...event.usage };
    renderChatUsage();
  }
  if (event.type === 'idle') {
    const article = activeChatReplyElement?.closest('article');
    if (article && !activeChatIdleNoticeElement) {
      activeChatIdleNoticeElement = document.createElement('p');
      activeChatIdleNoticeElement.className = 'chat-message__idle-notice';
      activeChatIdleNoticeElement.setAttribute('role', 'status');
      article.append(activeChatIdleNoticeElement);
    }
    const minutes = Math.max(1, Math.floor((event.idleMs ?? 0) / 60_000));
    const probe =
      event.probe?.ok === true
        ? '接口连通正常'
        : event.probe?.ok === false
          ? '接口探测失败'
          : '正在探测接口…';
    if (activeChatIdleNoticeElement) {
      activeChatIdleNoticeElement.textContent = `已 ${minutes} 分钟未收到数据 · ${probe}`;
      activeChatIdleNoticeElement.dataset.tone =
        event.probe?.ok === false ? 'warning' : event.probe?.ok === true ? 'success' : 'pending';
      activeChatIdleNoticeElement.title = event.probe?.detail ?? '';
    }
    return;
  }
  if (event.type === 'delta' && event.delta) {
    activeChatIdleNoticeElement?.remove();
    activeChatIdleNoticeElement = undefined;
    activeChatReply += event.delta;
    if (activeChatReplyElement) {
      if (!activeChatReplyStream) {
        activeChatReplyElement.replaceChildren();
        activeChatReplyStream = markdownRenderer.createStream(activeChatReplyElement);
      }
      void activeChatReplyStream.update(activeChatReply).then(() => {
        chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
      });
    }
    if (!event.usage) {
      const estimated = estimateChatUsage(activeChatRequestMessages, activeChatReply);
      activeChatUsage = activeChatProviderUsage
        ? {
            inputTokens: activeChatProviderUsage.inputTokens,
            outputTokens: estimated.outputTokens,
            source: 'estimated',
            totalTokens: activeChatProviderUsage.inputTokens + estimated.outputTokens,
          }
        : estimated;
      renderChatUsage();
    }
    return;
  }
  if (event.type === 'thinking' && event.delta) {
    activeChatThinking += event.delta;
    if (activeChatReplyElement) {
      if (!activeChatThinkingElement) {
        const details = document.createElement('details');
        details.className = 'chat-thinking';
        const summary = document.createElement('summary');
        summary.textContent = '思考过程';
        activeChatThinkingElement = document.createElement('div');
        details.append(summary, activeChatThinkingElement);
        activeChatReplyElement.before(details);
      }
      activeChatThinkingElement.textContent = activeChatThinking;
    }
    return;
  }
  if (event.type === 'input-json' && event.delta) {
    activeChatThinking += event.delta;
    if (activeChatThinkingElement) {
      activeChatThinkingElement.textContent = activeChatThinking;
    }
    return;
  }
  if (event.type === 'retrying') {
    if (activeChatReplyElement && !activeChatReply) {
      const attempt = event.attempt ?? 2;
      const maximum = event.maxAttempts ?? attempt;
      const wait = event.retryAfterMs
        ? `，约 ${Math.max(1, Math.ceil(event.retryAfterMs / 1000))} 秒后`
        : '';
      activeChatReplyElement.textContent = `${event.detail ?? '连接暂时中断，正在自动重试。'}${wait}（${attempt}/${maximum}）`;
    }
    return;
  }
  if (event.type === 'refusal') {
    const refusal = event.refusal || '模型拒绝了这项请求。';
    activeChatReply = activeChatReply ? `${activeChatReply}\n\n> ${refusal}` : `> ${refusal}`;
    if (activeChatReplyElement) {
      activeChatReplyStream ??= markdownRenderer.createStream(activeChatReplyElement);
      void activeChatReplyStream.update(activeChatReply);
    }
    return;
  }
  if (event.type === 'done') {
    if (activeChatReply) {
      chatMessages.push({
        content: [{ text: activeChatReply, type: 'text' }],
        role: 'assistant',
      });
    } else if (activeChatReplyElement) {
      activeChatReplyElement.textContent = '模型没有返回可显示的文本。';
    }
    if (!activeChatProviderUsage) {
      activeChatUsage = estimateChatUsage(activeChatRequestMessages, activeChatReply);
      renderChatUsage();
    }
    void (async () => {
      await activeChatReplyStream?.finish(activeChatReply);
      await persistActiveChat();
    })().finally(finishChatRequest);
    return;
  }
  if (event.type === 'aborted') {
    const localTimeout = event.abortReason === 'local-timeout';
    const notice = localTimeout ? '已按本地静默超时设置停止生成。' : '已停止生成。';
    const visibleReply = activeChatReply ? `${activeChatReply}\n\n> ${notice}` : `> ${notice}`;
    if (activeChatReplyElement && !activeChatReply) {
      activeChatReplyElement.textContent = notice;
    } else if (localTimeout && activeChatReply) {
      activeChatReplyStream ??= activeChatReplyElement
        ? markdownRenderer.createStream(activeChatReplyElement)
        : undefined;
      void activeChatReplyStream?.update(visibleReply);
    }
    if (activeChatReply) {
      chatMessages.push({
        content: [{ text: activeChatReply, type: 'text' }],
        role: 'assistant',
      });
    }
    activeChatUsage = activeChatProviderUsage
      ? { ...activeChatProviderUsage }
      : estimateChatUsage(activeChatRequestMessages, activeChatReply);
    renderChatUsage();
    if (localTimeout) {
      showToast(notice, 'error');
    }
    void (async () => {
      await activeChatReplyStream?.finish(visibleReply);
      await persistActiveChat();
    })().finally(finishChatRequest);
    return;
  }
  if (event.type === 'error') {
    const continuationButton =
      event.continuable && activeChatReply && activeChatReplyElement
        ? appendChatContinuationButton(activeChatReplyElement)
        : undefined;
    const notice = activeChatReply
      ? `${activeChatReply}\n\n> 生成中断：${event.error ?? '请求失败'}`
      : `> 请求失败：${event.error ?? '未知错误'}`;
    if (activeChatReplyElement) {
      activeChatReplyStream ??= markdownRenderer.createStream(activeChatReplyElement);
      void activeChatReplyStream.update(notice);
    }
    if (activeChatReply) {
      chatMessages.push({
        content: [{ text: activeChatReply, type: 'text' }],
        role: 'assistant',
      });
    }
    activeChatUsage = activeChatProviderUsage
      ? { ...activeChatProviderUsage }
      : estimateChatUsage(activeChatRequestMessages, activeChatReply);
    renderChatUsage();
    showToast(event.error ?? '独立对话请求失败。', 'error');
    void (async () => {
      await activeChatReplyStream?.finish(notice);
      await persistActiveChat();
    })().finally(() => {
      finishChatRequest();
      if (continuationButton?.isConnected) {
        continuationButton.disabled = false;
      }
    });
  }
};

const renderPendingChatAttachments = (): void => {
  chatAttachmentQueue.replaceChildren();
  chatAttachmentQueue.hidden = pendingChatAttachments.length === 0;
  for (const attachment of pendingChatAttachments) {
    const card = document.createElement('div');
    card.className = `chat-attachment-draft chat-attachment-draft--${attachment.type}`;
    const preview = document.createElement('div');
    preview.className = 'chat-attachment-draft__preview';
    if (attachment.previewDataUrl) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = attachment.previewDataUrl;
      preview.append(image);
    } else {
      preview.textContent =
        attachment.type === 'image'
          ? 'IMG'
          : attachment.mediaType === 'application/pdf'
            ? 'PDF'
            : 'DOC';
    }
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = attachment.fileName;
    const meta = document.createElement('small');
    meta.textContent = formatAttachmentSize(attachment.sizeBytes);
    copy.append(name, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `移除附件 ${attachment.fileName}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const index = pendingChatAttachments.findIndex(
        (candidate) => candidate.attachmentId === attachment.attachmentId,
      );
      const draftId = activeChatAttachmentDraftId;
      if (index < 0 || !draftId) {
        return;
      }
      remove.disabled = true;
      void window.controlPanel
        .deleteChatDraftAttachment(draftId, attachment.attachmentId)
        .then((removed) => {
          if (!removed) {
            throw new Error('附件草稿已经变化，请重新选择文件。');
          }
          const currentIndex = pendingChatAttachments.findIndex(
            (candidate) => candidate.attachmentId === attachment.attachmentId,
          );
          if (currentIndex >= 0) {
            pendingChatAttachments.splice(currentIndex, 1);
          }
          renderPendingChatAttachments();
          renderChatUsage();
        })
        .catch((error) => {
          remove.disabled = false;
          showToast(error instanceof Error ? error.message : '无法移除附件。', 'error');
        });
    });
    card.append(preview, copy, remove);
    chatAttachmentQueue.append(card);
  }
};

const applyChatAttachmentImportResult = (result: ChatAttachmentImportResult): void => {
  if (result.draftId) {
    activeChatAttachmentDraftId = result.draftId;
  }
  pendingChatAttachments.push(...result.attachments);
  renderPendingChatAttachments();
  for (const attachment of result.attachments) {
    if (attachment.type === 'image') {
      void window.controlPanel.readChatAttachment(attachment.attachmentId).then((preview) => {
        if (preview?.previewDataUrl) {
          attachment.previewDataUrl = preview.previewDataUrl;
          renderPendingChatAttachments();
        }
      });
    }
  }
  if (
    chatProtocol.value === 'openai' &&
    result.attachments.some((attachment) => attachment.mediaType === 'application/pdf')
  ) {
    showToast('已添加 PDF；当前 OpenAI 兼容端点可能不支持 PDF，请以服务端结果为准。');
  } else if (result.attachments.length > 0) {
    showToast(`已安全导入 ${result.attachments.length} 个附件`);
  }
  if (result.errors.length > 0) {
    showToast(result.errors[0]?.message ?? '部分附件无法导入。', 'error');
  }
};

/** Clipboard payloads have no path on disk, so a name has to be synthesized from the MIME type. */
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/tab-separated-values': '.tsv',
};

const pastedFileName = (file: File, index: number): string => {
  const name = file.name.replace(/[\\/]/g, '').trim();
  if (name && /\.[a-z0-9]{1,8}$/i.test(name)) {
    return name;
  }
  const extension = EXTENSION_BY_MEDIA_TYPE[file.type.toLowerCase()] ?? '.png';
  return `${name || `粘贴内容-${index + 1}`}${extension}`;
};

const importChatAttachments = async (files: File[]): Promise<void> => {
  const remaining = 10 - pendingChatAttachments.length;
  if (remaining <= 0) {
    showToast('每条消息最多添加 10 个附件。', 'error');
    return;
  }
  const selected = files.slice(0, remaining);
  // Files dropped or picked from disk expose a native path; clipboard payloads do not, so they
  // travel to the main process as bytes instead. One paste can contain both kinds.
  const paths: string[] = [];
  const inMemory: File[] = [];
  for (const file of selected) {
    let filePath: string;
    try {
      filePath = window.controlPanel.getDroppedPath(file) ?? '';
    } catch {
      filePath = '';
    }
    if (filePath) {
      paths.push(filePath);
    } else {
      inMemory.push(file);
    }
  }
  if (paths.length === 0 && inMemory.length === 0) {
    showToast('无法读取所选附件的内容。', 'error');
    return;
  }
  try {
    if (paths.length > 0) {
      applyChatAttachmentImportResult(
        await window.controlPanel.importChatAttachments({
          draftId: activeChatAttachmentDraftId,
          paths,
        }),
      );
    }
    if (inMemory.length > 0) {
      const sources = await Promise.all(
        inMemory.map(async (file, index) => ({
          bytes: await file.arrayBuffer(),
          fileName: pastedFileName(file, index),
        })),
      );
      applyChatAttachmentImportResult(
        await window.controlPanel.importChatAttachmentBytes({
          draftId: activeChatAttachmentDraftId,
          sources,
        }),
      );
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : '无法导入附件。', 'error');
  } finally {
    chatAttachmentInput.value = '';
  }
};

const queueChatAttachmentImport = (files: File[]): void => {
  if (files.length === 0 || activeChatRequestId || chatSubmissionInFlight) {
    return;
  }
  queuedChatAttachmentImports += 1;
  setChatBusy(Boolean(activeChatRequestId));
  const queued = chatAttachmentImportQueue.then(() => importChatAttachments(files));
  chatAttachmentImportQueue = queued
    .catch(() => {
      // importChatAttachments already presents an actionable error.
    })
    .finally(() => {
      queuedChatAttachmentImports = Math.max(0, queuedChatAttachmentImports - 1);
      setChatBusy(Boolean(activeChatRequestId));
    });
};

const submitChatMessage = async (): Promise<void> => {
  if (activeChatRequestId || chatSubmissionInFlight) {
    return;
  }
  chatSubmissionInFlight = true;
  setChatBusy(false);
  let previousMessages: ChatMessage[] | undefined;
  let previousUsage: ChatTokenUsage | undefined;
  let previousProviderUsage: ChatTokenUsage | undefined;
  let requestId = '';
  let historyRepaired = false;
  let pendingUserArticle: HTMLElement | undefined;
  let pendingAssistantArticle: HTMLElement | undefined;
  try {
    await chatAttachmentImportQueue;
    const content = chatInput.value.trim();
    if (!content && pendingChatAttachments.length === 0) {
      return;
    }
    if (!chatConfig?.model) {
      await loadChatConfig(true);
    }
    if (!chatConfig?.model) {
      showToast('请先在左侧保存独立对话模型配置。', 'error');
      return;
    }

    const contentBlocks: ChatContentBlock[] = [
      ...pendingChatAttachments.map((attachment): Exclude<ChatContentBlock, { type: 'text' }> => ({
        fileName: attachment.fileName,
        mediaType: attachment.mediaType,
        source: { attachmentId: attachment.attachmentId, type: 'local' },
        type: attachment.type,
      })),
      ...(content ? ([{ text: content, type: 'text' }] satisfies ChatContentBlock[]) : []),
    ];
    const candidateMessages = [...chatMessages, { content: contentBlocks, role: 'user' as const }];
    requestId = crypto.randomUUID();
    const prepared = await window.controlPanel.preflightChat({
      draftId: activeChatAttachmentDraftId,
      messages: candidateMessages,
      requestId,
    });
    if (prepared.warning) {
      showToast(prepared.warning);
    }

    previousMessages = [...chatMessages];
    previousUsage = { ...activeChatUsage };
    previousProviderUsage = activeChatProviderUsage ? { ...activeChatProviderUsage } : undefined;
    // The draft is committed here, so this is where the bubble should lift — same confirmation the
    // terminal composer gives. Clearing the textarea now keeps the lift and the empty input in sync.
    playSendAnimation(content, chatInput, 'chat');
    chatInput.value = '';
    resizeChatComposer();
    chatMessages.splice(0, chatMessages.length, ...prepared.messages);
    activeChatRequestMessages = [...prepared.messages];
    activeChatUsage = estimateChatUsage(activeChatRequestMessages);
    activeChatProviderUsage = undefined;
    activeChatReply = '';
    activeChatRequestId = requestId;
    historyRepaired = prepared.removedAttachmentIds.length > 0;
    if (historyRepaired) {
      renderChatMessages();
    } else {
      const currentMessage = prepared.messages.at(-1);
      if (currentMessage?.role === 'user') {
        const mount = appendChatMessage('user', currentMessage.content);
        pendingUserArticle = mount.closest('article') as HTMLElement | undefined;
      }
    }
    renderChatUsage();
    activeChatReplyElement = appendChatMessage('assistant', '正在连接模型…', false);
    pendingAssistantArticle = activeChatReplyElement.closest('article') as HTMLElement | undefined;
    setChatBusy(true);

    const accepted = await window.controlPanel.startChat({
      draftId: activeChatAttachmentDraftId,
      messages: prepared.messages,
      requestId,
    });
    activeChatRequestMessages = [...accepted.messages];
    chatMessages.splice(0, chatMessages.length, ...accepted.messages);
    if (accepted.removedAttachmentIds.length > prepared.removedAttachmentIds.length) {
      historyRepaired = true;
      renderChatMessages();
      activeChatReplyElement = appendChatMessage('assistant', '正在连接模型…', false);
    }
    if (accepted.warning && accepted.warning !== prepared.warning) {
      showToast(accepted.warning);
    }
    activeChatAttachmentDraftId = undefined;
    pendingChatAttachments.splice(0);
    renderPendingChatAttachments();
    await persistActiveChat();
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法启动独立对话请求。';
    if (previousMessages && activeChatRequestId === requestId) {
      chatMessages.splice(0, chatMessages.length, ...previousMessages);
      activeChatUsage = previousUsage ?? estimateChatUsage(previousMessages);
      activeChatProviderUsage = previousProviderUsage;
      if (historyRepaired) {
        renderChatMessages();
      } else {
        pendingUserArticle?.remove();
        pendingAssistantArticle?.remove();
        chatEmptyState.hidden = chatMessages.length > 0;
      }
      renderChatUsage();
      finishChatRequest();
    }
    showToast(message, 'error');
  } finally {
    chatSubmissionInFlight = false;
    setChatBusy(Boolean(activeChatRequestId));
  }
};

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

const syncApiKeyHelperPolicyUi = (): void => {
  const usesExplicitCredential =
    claudeAuthMode.value === 'apiKey' || claudeAuthMode.value === 'authToken';
  claudeApiKeyHelperPolicy.disabled =
    !connectionEnvironmentReady ||
    connectionTestInProgress ||
    connectionRemedyInProgress ||
    !usesExplicitCredential;
  const helperSources =
    gatewayDiagnostics?.configurationHints
      .filter((hint) => hint.apiKeyHelperConfigured)
      .map((hint) => hint.label) ?? [];
  const helperDetail =
    helperSources.length > 0 ? `已检测到：${helperSources.join('、')}。` : '当前未检测到 helper。';

  if (!usesExplicitCredential) {
    claudeApiKeyHelperStatus.textContent =
      '当前连接没有注入 ClaudeDock 密钥；apiKeyHelper 继续属于 Claude Code 自己的认证链。';
    return;
  }
  claudeApiKeyHelperStatus.textContent =
    claudeApiKeyHelperPolicy.value === 'prefer-claudedock'
      ? `${helperDetail} 启动时会用临时高优先级设置停用它，只保留本项目加密保存的凭据；原设置文件不变。`
      : `${helperDetail} 将按 Claude Code 官方优先级保留 helper；同时填写静态 API Key 时，Claude Code 可能显示双重认证警告。`;
};

const syncConnectionInteractivity = (): void => {
  const busy = connectionTestInProgress || connectionRemedyInProgress;
  providerPicker.setAttribute('aria-disabled', String(busy));
  providerPicker.inert = busy;
  claudeConfigForm.inert = !connectionEnvironmentReady || busy;
  connectionRemedyActions.inert = busy;
  for (const button of providerGroups.querySelectorAll<HTMLButtonElement>('.provider-card')) {
    button.disabled = busy;
  }
  for (const control of claudeConfigForm.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >('button, input, select')) {
    control.disabled = !connectionEnvironmentReady || busy;
  }
  for (const button of connectionRemedyActions.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = busy;
  }
  if (connectionEnvironmentReady && !busy) {
    const config = claudeStates.get(workspaceState.activeSessionId)?.config;
    clearCredentialButton.disabled = !(
      config?.sourceCredentialConfigured ?? config?.credentialConfigured
    );
  }
  syncApiKeyHelperPolicyUi();
};

const buildChatGptSubscriptionGuide = (): HTMLElement => {
  const guide = document.createElement('section');
  guide.className = 'subscription-gateway-guide';
  guide.setAttribute('aria-label', 'ChatGPT 订阅托管网关');

  const title = document.createElement('strong');
  title.textContent = 'OpenAI Codex 负责人公开分享的 claudex 路径';
  const source = document.createElement('p');
  source.textContent =
    'Thibault “Tibo” Sottiaux 公开分享了 CLIProxyAPI 接入 Claude Code 的实践。ClaudeDock 把安装、配置和后台运行收进一个界面，不要求你打开终端或第三方控制台。';
  const statusCard = document.createElement('div');
  statusCard.className = 'subscription-gateway-status';
  statusCard.setAttribute('aria-live', 'polite');
  const statusText = document.createElement('div');
  const statusTitle = document.createElement('strong');
  statusTitle.textContent = '正在检查托管网关';
  const statusDetail = document.createElement('span');
  statusDetail.textContent = '请稍候…';
  statusText.append(statusTitle, statusDetail);
  const action = document.createElement('button');
  action.type = 'button';
  action.dataset.ripple = '';
  action.textContent = '一键安装并登录';
  action.disabled = true;
  statusCard.append(statusText, action);
  const progressCard = document.createElement('div');
  progressCard.className = 'subscription-gateway-progress';
  progressCard.setAttribute('aria-live', 'polite');
  progressCard.hidden = true;
  const progressTitle = document.createElement('strong');
  const progressDetail = document.createElement('span');
  const progressMeter = document.createElement('progress');
  progressMeter.setAttribute('aria-label', 'ChatGPT 自动接入进度');
  progressMeter.max = 8;
  progressCard.append(progressTitle, progressDetail, progressMeter);
  const modelField = document.createElement('label');
  modelField.className = 'field subscription-gateway-model';
  modelField.hidden = true;
  const modelLabel = document.createElement('span');
  modelLabel.textContent = '当前模型';
  const modelSelect = document.createElement('select');
  const modelHelpText = document.createElement('small');
  modelHelpText.textContent = '列表来自本机网关实时接口；切换后会自动复测并保存，无需再点接入。';
  modelField.append(modelLabel, modelSelect, modelHelpText);
  enhanceSelect(modelSelect);
  const secondaryActions = document.createElement('div');
  secondaryActions.className = 'subscription-gateway-actions';
  const boundary = document.createElement('small');
  boundary.textContent =
    '一次点击会自动检测 Claude Code、补齐缺失组件、打开 OpenAI 官方授权、读取模型列表、真实测试并保存。此方式不需要 CCR；不会读取 OAuth Token 内容，也不会修改 shell、Codex、Claude Code 用户设置或系统级路由。';

  const renderModels = (models: readonly string[], preferredModel?: string): void => {
    const currentModel = claudeStates.get(workspaceState.activeSessionId)?.config.model;
    const selected = models.includes(modelSelect.value)
      ? modelSelect.value
      : preferredModel && models.includes(preferredModel)
        ? preferredModel
        : currentModel && models.includes(currentModel)
          ? currentModel
          : models[0];
    modelSelect.replaceChildren(
      ...models.map((model) => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        return option;
      }),
    );
    if (selected) {
      modelSelect.value = selected;
    }
    modelField.hidden = models.length === 0;
  };

  renderManagedChatGptProgress = (progress): void => {
    if (progress.sessionId !== workspaceState.activeSessionId) {
      return;
    }
    managedChatGptSetupInProgress = progress.active;
    progressCard.hidden = false;
    progressTitle.textContent = `第 ${progress.step}/${progress.totalSteps} 步`;
    progressDetail.textContent = progress.detail;
    progressMeter.max = progress.totalSteps;
    progressMeter.value = progress.step;
    action.disabled = progress.active;
    action.setAttribute('aria-busy', String(progress.active));
    modelSelect.disabled = progress.active;
    if (progress.active) {
      action.textContent = '正在自动接入…';
    }
  };

  const renderState = (state: ManagedChatGptGatewayState, preferredModel?: string): void => {
    const operationBusy = state.busy || managedChatGptSetupInProgress;
    statusCard.dataset.phase = state.phase;
    statusTitle.textContent = operationBusy
      ? '正在自动检测并接入'
      : state.phase === 'ready'
        ? 'ChatGPT 一键接入已就绪'
        : state.phase === 'stopped'
          ? '授权已完成，等待启用'
          : state.phase === 'login-required'
            ? '安装完成，等待 OpenAI 授权'
            : '尚未安装托管网关';
    statusDetail.textContent = state.message;
    renderModels(state.availableModels, preferredModel);
    action.disabled = operationBusy;
    action.setAttribute('aria-busy', String(operationBusy));
    modelSelect.disabled = operationBusy;
    action.textContent = operationBusy
      ? '安装进行中…'
      : state.phase === 'not-installed'
        ? '一键安装并登录'
        : state.phase === 'login-required'
          ? '登录 OpenAI 并自动配置'
          : state.phase === 'stopped'
            ? '启动并用于当前项目'
            : '检查并自动修复';
    secondaryActions.replaceChildren();
    if (state.authenticated && !operationBusy) {
      const relogin = document.createElement('button');
      relogin.type = 'button';
      relogin.textContent = '重新登录 OpenAI';
      relogin.addEventListener('click', () => {
        void runSetup(true, relogin);
      });
      secondaryActions.append(relogin);
    }
    claudeConfigForm.hidden = selectedProviderId === 'chatgpt-subscription';
  };

  const runSetup = async (forceLogin: boolean, button: HTMLButtonElement): Promise<void> => {
    if (managedChatGptSetupInProgress) {
      showToast('托管网关正在安装或配置，请等待当前操作完成。');
      return;
    }
    const sessionId = workspaceState.activeSessionId;
    if (!sessionId) {
      showToast('请先选择一个项目。', 'error');
      return;
    }
    managedChatGptSetupInProgress = true;
    button.disabled = true;
    modelSelect.disabled = true;
    const original = button.textContent;
    let restoreOriginalLabel = true;
    let resultStateRendered = false;
    statusCard.dataset.phase = 'installing';
    statusTitle.textContent = '正在安装并配置托管网关';
    button.textContent = forceLogin ? '等待 OpenAI 授权…' : '正在安装并打开授权页…';
    statusDetail.textContent =
      '如果需要登录，浏览器会自动打开 OpenAI 官方页面；完成授权后无需复制任何代码。';
    try {
      const result = await window.controlPanel.setupManagedChatGptGateway(sessionId, forceLogin);
      managedChatGptSetupInProgress = false;
      renderState(result.state, result.projectState?.config.model);
      resultStateRendered = true;
      if (!result.ok) {
        statusCard.dataset.phase = 'error';
        statusTitle.textContent = '配置未完成';
        statusDetail.textContent = result.error ?? result.message;
        if (button === action) {
          action.textContent = '重试';
          restoreOriginalLabel = false;
        }
        showToast(result.error ?? result.message, 'error');
        return;
      }
      if (result.projectState) {
        renderClaudeState(result.projectState);
      }
      if (result.connectionTest) {
        statusDetail.textContent = result.connectionTest.message;
      }
      showToast(result.message);
    } catch {
      statusCard.dataset.phase = 'error';
      statusTitle.textContent = '配置未完成';
      statusDetail.textContent = '无法完成 ChatGPT 托管网关配置，请稍后重试。';
      if (button === action) {
        action.textContent = '重试';
        restoreOriginalLabel = false;
      }
      showToast('无法完成 ChatGPT 托管网关配置。', 'error');
    } finally {
      managedChatGptSetupInProgress = false;
      if (button.isConnected) {
        button.disabled = false;
        if (restoreOriginalLabel && !resultStateRendered) {
          button.textContent = original;
        }
      } else if (selectedProviderId === 'chatgpt-subscription') {
        applyPresetUi('chatgpt-subscription', true);
      }
      if (guide.isConnected) {
        modelSelect.disabled = false;
      }
    }
  };

  action.addEventListener('click', () => {
    void runSetup(false, action);
  });
  modelSelect.addEventListener('change', () => {
    const sessionId = workspaceState.activeSessionId;
    const previousModel = claudeStates.get(sessionId)?.config.model;
    const requestedModel = modelSelect.value;
    if (!sessionId || !requestedModel || managedChatGptSetupInProgress) {
      return;
    }
    managedChatGptSetupInProgress = true;
    modelSelect.disabled = true;
    void window.controlPanel
      .setManagedChatGptGatewayModel(sessionId, requestedModel)
      .then((result) => {
        renderState(result.state, result.projectState?.config.model);
        if (!result.ok) {
          if (previousModel && result.state.availableModels.includes(previousModel)) {
            modelSelect.value = previousModel;
          }
          statusCard.dataset.phase = 'error';
          statusTitle.textContent = '模型切换未完成';
          statusDetail.textContent = result.error ?? result.message;
          showToast(result.error ?? result.message, 'error');
          return;
        }
        if (result.projectState) {
          renderClaudeState(result.projectState);
        }
        statusTitle.textContent = '模型已验证并切换';
        statusDetail.textContent = result.message;
        showToast(result.message);
      })
      .catch(() => {
        if (previousModel) {
          modelSelect.value = previousModel;
        }
        statusCard.dataset.phase = 'error';
        statusTitle.textContent = '模型切换未完成';
        statusDetail.textContent = '无法验证并切换所选模型。';
        showToast('无法验证并切换所选模型。', 'error');
      })
      .finally(() => {
        managedChatGptSetupInProgress = false;
        modelSelect.disabled = false;
      });
  });
  void window.controlPanel
    .getManagedChatGptGatewayState()
    .then((state) => {
      if (guide.isConnected) {
        renderState(state);
      }
    })
    .catch(() => {
      statusCard.dataset.phase = 'error';
      statusTitle.textContent = '无法读取托管网关状态';
      statusDetail.textContent = '请稍后重试。';
      action.disabled = false;
    });
  guide.append(title, source, statusCard, progressCard, modelField, secondaryActions, boundary);
  return guide;
};

const moveProviderTools = (providerId?: ClaudeProviderId): void => {
  renderManagedChatGptProgress = undefined;
  providerSpecialSetup.replaceChildren();
  connectionAdvancedContent.append(
    connectionAdvice,
    gatewayDiscoverySection,
    curlOnboarding,
    converterHelp,
    connectionGlossary,
  );
  if (providerId === 'chatgpt-subscription') {
    providerSpecialSetup.append(buildChatGptSubscriptionGuide());
    return;
  }
  if (providerId === 'curl') {
    providerSpecialSetup.append(curlOnboarding);
    return;
  }
  if (providerId === 'gateway') {
    providerSpecialSetup.append(gatewayDiscoverySection);
  }
};

const clearProviderSelection = (clearDraft = true): void => {
  selectedProviderId = undefined;
  selectedRouterProviderId = undefined;
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

const applyDefaultProviderGroupExpansion = (providerId?: ClaudeProviderId): void => {
  collapsedProviderGroups.clear();
  for (const groupId of collapsedClaudeProviderGroups(providerId)) {
    collapsedProviderGroups.add(groupId);
  }
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
      card.disabled = connectionTestInProgress || connectionRemedyInProgress;

      const title = document.createElement('strong');
      title.textContent = provider.label;
      const detail = document.createElement('span');
      detail.textContent = provider.description;
      card.append(title, detail);
      if (provider.group === 'subscription') {
        const badge = document.createElement('small');
        badge.textContent = '本地转换 · 非官方直连';
        card.append(badge);
      }
      if (provider.id === configuredPreset) {
        const badge = document.createElement('small');
        badge.textContent = '当前配置';
        card.append(badge);
      }
      card.addEventListener('click', () => {
        if (!connectionEnvironmentReady && provider.id !== 'chatgpt-subscription') {
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
  const isManagedChatGpt = provider.id === 'chatgpt-subscription';
  environmentSetup.hidden = isManagedChatGpt || connectionEnvironmentReady;
  claudeConfigForm.hidden = isManagedChatGpt;
  const isOfficialLogin = provider.id === 'anthropic';
  const isAdvanced =
    provider.id === 'custom' || provider.id === 'gateway' || provider.id === 'curl';
  const supportsProtocolSwitch = provider.id === 'custom';
  if (!preserveValues || !supportsProtocolSwitch) {
    claudeProtocol.value = 'anthropic';
    selectedRouterProviderId = undefined;
  }
  const protocol = claudeProtocol.value as ConfigurableEndpointProtocol;
  protocolField.hidden = !supportsProtocolSwitch;
  baseUrlField.hidden = isManagedChatGpt || !provider.editableBaseUrl;
  authModeField.hidden = isManagedChatGpt;
  credentialSourceSettings.hidden = isManagedChatGpt;
  claudeConfigStepTitle.textContent = isManagedChatGpt ? '选择托管网关模型' : '选择模型并填写凭据';
  claudeConfigStepDescription.textContent = isManagedChatGpt
    ? '地址和本地访问密钥由 ClaudeDock 自动配置；你只需要按需调整模型。'
    : '密钥只交给主进程加密保存，界面不会回显已保存内容。';

  if (isAdvanced) {
    setAuthOptions(
      supportsProtocolSwitch && protocol === 'openai'
        ? [
            { label: '接口密钥（Authorization / Bearer）', value: 'authToken' },
            { label: '无需认证（仅建议本机网关）', value: 'none' },
          ]
        : [
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
  baseUrlHelp.textContent = supportsProtocolSwitch
    ? protocol === 'openai'
      ? '可填域名、/v1、/v1/chat/completions 或 /v1/responses；保存时会自动补全，并由本地 Router 转换。'
      : '按服务商给出的基址填写（含 /v1 等路径都会保留）；Claude Code 会自己追加 /v1/messages。'
    : provider.id === 'chatgpt-subscription'
      ? '填写本机 Anthropic Messages 兼容网关的基址；CLIProxyAPI 默认是 127.0.0.1:8317。不要填写 OAuth 回调端口 1455 或管理页地址。'
      : provider.id === 'gateway'
        ? '填写路由器真正的模型接口；默认 3456 是模型接口，3458 是管理页。'
        : '接口必须提供 Anthropic /v1/messages，且不能直接使用 OpenAI /chat/completions。';
  protocolHelp.textContent =
    provider.id === 'chatgpt-subscription'
      ? 'Claude Code 访问本机 Anthropic Messages 入口；本地网关再完成 Codex OAuth 请求与协议转换，这不是官方直连。'
      : protocol === 'openai'
        ? 'OpenAI 请求会自动写入并启动本地 Router，再转换为 Claude Code 使用的 Anthropic Messages 请求。'
        : 'Anthropic Messages 接口由 Claude Code 直接访问，不经过协议转换。';
  modelHelp.textContent =
    provider.id === 'chatgpt-subscription'
      ? `默认映射为主模型 ${provider.model}、小型/备用模型 ${provider.modelFast ?? provider.model}；后者会更换模型，不是服务速度档位。请以本地网关实时可用模型为准，可在这里修改。`
      : `主模型会同时用于默认、Opus 与 Sonnet 路由；当前推荐 ${provider.model}。`;
  authModeHelp.textContent =
    provider.id === 'chatgpt-subscription'
      ? '这里填写本地网关 config.yaml 的 api-keys 客户端密钥，并以 Bearer Token 发送；不要粘贴 ChatGPT 密码、Cookie 或 OAuth Token。'
      : provider.authMode === 'existing'
        ? 'ClaudeDock 不读取或复用 Claude Code 的登录令牌。'
        : provider.authMode === 'apiKey'
          ? '该服务商使用 x-api-key 请求头。'
          : '该服务商使用 Authorization: Bearer 请求头。';
  authModeLabel.textContent = isOfficialLogin
    ? '官方认证方式'
    : supportsProtocolSwitch && protocol === 'openai'
      ? '中转站认证方式'
      : 'Claude Code 到接口的认证方式';
  credentialLabel.textContent =
    provider.id === 'chatgpt-subscription'
      ? '本地网关访问密钥（不是 ChatGPT 凭据）'
      : provider.id === 'gateway'
        ? '路由器访问密钥（不是上游密钥）'
        : supportsProtocolSwitch && protocol === 'openai'
          ? 'OpenAI 中转站密钥'
          : `${provider.label} 凭据`;
  claudeCredential.placeholder = provider.keyHint ?? '留空则保留已保存的凭据';
  credentialField.hidden =
    isManagedChatGpt ||
    claudeAuthMode.value === 'existing' ||
    claudeAuthMode.value === 'none' ||
    provider.id === 'ollama';

  providerSetup.hidden = false;
  providerTitle.textContent = provider.label;
  providerDescription.textContent = provider.description;
  providerCaveat.hidden = !provider.caveat;
  providerCaveat.textContent = provider.caveat ?? '';
  openProviderConsoleButton.hidden = !provider.consoleUrl;
  openProviderConsoleButton.dataset.externalUrl = provider.consoleUrl ?? '';
  openProviderConsoleButton.textContent =
    provider.id === 'chatgpt-subscription' ? '查看公开原帖' : '打开密钥控制台';
  openProviderDocsButton.hidden = !provider.docsUrl;
  openProviderDocsButton.dataset.externalUrl = provider.docsUrl ?? '';
  openProviderDocsButton.textContent =
    provider.id === 'chatgpt-subscription' ? '查看上游源码' : '查看官方文档';
  moveProviderTools(provider.id);
  renderProviderPicker();
  syncConnectionInteractivity();
};

/**
 * What the connection field should hold once it is tidied up. The OpenAI path targets the local
 * Router, which stores a complete request URL, so the endpoint is completed there. The Anthropic
 * path stays the base URL Claude Code expects: the CLI appends `/v1/messages` itself, and rewriting
 * the field would silently drop path segments some relays require.
 */
const resolveConnectionAddress = (value: string, protocol: ConfigurableEndpointProtocol): string =>
  protocol === 'openai'
    ? completeConnectionEndpoint(value, 'openai')
    : normalizeConnectionBaseUrl(value);

const populateClaudeConfigForm = (state: ClaudeProjectState): void => {
  const { config } = state;
  if (!claudePreset.querySelector(`option[value="${config.preset}"]`)) {
    const option = document.createElement('option');
    option.value = config.preset;
    option.textContent = findClaudeProvider(config.preset)?.label ?? config.preset;
    claudePreset.append(option);
  }
  claudePreset.value = config.preset;
  claudeProtocol.value = config.protocol === 'openai' ? 'openai' : 'anthropic';
  claudeApiKeyHelperPolicy.value = config.apiKeyHelperPolicy;
  applyPresetUi(config.preset, true);
  const displayedBaseUrl = config.sourceBaseUrl ?? config.baseUrl;
  claudeBaseUrl.value = displayedBaseUrl;
  if (config.preset === 'custom' && displayedBaseUrl) {
    try {
      claudeBaseUrl.value = resolveConnectionAddress(
        displayedBaseUrl,
        config.protocol === 'openai' ? 'openai' : 'anthropic',
      );
    } catch {
      // Keep a manually edited legacy value visible so the user can repair it in the form.
    }
  }
  claudeModel.value = config.sourceModel ?? config.model;
  claudeModelFast.value =
    config.sourceModelFast ?? config.sourceModel ?? config.modelFast ?? config.model;
  claudeAuthMode.value = config.sourceAuthMode ?? config.authMode;
  credentialField.hidden =
    config.preset === 'chatgpt-subscription' ||
    claudeAuthMode.value === 'existing' ||
    claudeAuthMode.value === 'none';
  if (config.preset === 'ollama') {
    credentialField.hidden = true;
  }
  claudeCredential.value = '';
  const credentialConfigured = config.sourceCredentialConfigured ?? config.credentialConfigured;
  credentialStatus.textContent = credentialConfigured
    ? config.protocol === 'openai'
      ? '已由本地 Router 保存；留空将继续使用'
      : '已使用 Windows 安全存储加密保存；留空将继续使用'
    : '当前项目未保存凭据';
  clearCredentialButton.disabled = !credentialConfigured;
  selectedRouterProviderId = config.routerProviderId;
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
  protocol: claudeProtocol.value as ConfigurableEndpointProtocol,
  providerId: selectedProviderId,
  routerProviderId: selectedRouterProviderId,
});

const restoreAdvancedConnectionSnapshot = (snapshot: AdvancedConnectionSnapshot): void => {
  claudeProtocol.value = snapshot.protocol;
  if (snapshot.providerId) {
    applyPresetUi(snapshot.providerId, true);
  } else {
    clearProviderSelection(false);
  }
  claudeBaseUrl.value = snapshot.baseUrl;
  claudeModel.value = snapshot.model;
  claudeModelFast.value = snapshot.modelFast;
  selectedRouterProviderId = snapshot.routerProviderId;
  claudeAuthMode.value = snapshot.authMode;
  claudeCredential.value = snapshot.credential;
  credentialField.hidden =
    snapshot.authMode === 'existing' ||
    snapshot.authMode === 'none' ||
    snapshot.providerId === 'chatgpt-subscription' ||
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

const modelSpeedFastLabel = (state: ClaudeProjectState): string => {
  if (state.speed.mechanism === 'claude-native-fast') {
    return 'Claude Fast';
  }
  if (
    state.speed.mechanism === 'gpt-service-tier' ||
    state.config.preset === 'chatgpt-subscription'
  ) {
    return 'GPT 1.5x';
  }
  return state.config.provider === 'anthropic' ? 'Claude Fast' : '快速档';
};

const modelSpeedFooterLabel = (state: ClaudeProjectState): string => {
  if (state.speed.status === 'active') {
    return '速度 Claude Fast 已开启';
  }
  if (state.speed.status === 'not-active') {
    return state.speed.mechanism === 'gpt-service-tier'
      ? '速度 GPT 1.5x 未生效'
      : '速度 Claude Fast 未生效';
  }
  if (state.speed.status === 'requested') {
    return state.speed.mechanism === 'gpt-service-tier'
      ? '速度 已请求 GPT 1.5x'
      : '速度 已请求 Claude Fast';
  }
  if (state.speed.availability === 'unsupported') {
    return '速度 不支持';
  }
  if (state.speed.availability === 'unverified') {
    return '速度 未验证';
  }
  if (state.speed.availability === 'update-required') {
    return '速度 需更新';
  }
  return '速度 标准';
};

const hideFooterMenus = (): void => {
  for (const [menu, trigger] of [
    [footerResourceMenu, footerResource],
    [footerModelMenu, footerModel],
    [footerSpeedMenu, footerSpeed],
    [footerModeMenu, footerMode],
    [footerEffortMenu, footerEffort],
  ] as const) {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
};

const setFooterSecondaryOpen = (open: boolean): void => {
  const compact = window.matchMedia('(max-width: 1040px)').matches;
  const next = open && compact;
  footerSecondaryStatus.dataset.open = String(next);
  footerMore.setAttribute('aria-expanded', String(next));
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

const buildFooterRadioMenuItem = (
  label: string,
  detail: string,
  selected: boolean,
  onChoose: () => void,
  disabled = false,
): HTMLButtonElement => {
  const item = buildFooterMenuItem(label, detail, selected, onChoose, disabled);
  item.role = 'menuitemradio';
  item.setAttribute('aria-checked', String(selected));
  return item;
};

const formatResourceAmount = (amount: number, currency: string): string =>
  currency.toUpperCase() === 'USD'
    ? `$${amount.toFixed(amount < 10 ? 2 : 0)}`
    : `${amount.toFixed(amount < 10 ? 2 : 0)} ${currency}`;

const formatResetTime = (resetsAt: number | undefined): string => {
  if (resetsAt === undefined) return '重置时间未提供';
  const milliseconds = resetsAt < 10_000_000_000 ? resetsAt * 1000 : resetsAt;
  const remaining = milliseconds - Date.now();
  if (remaining <= 0) return '正在重置';
  const minutes = Math.ceil(remaining / 60_000);
  return minutes >= 1440
    ? `${Math.ceil(minutes / 1440)} 天后重置`
    : minutes >= 60
      ? `${Math.ceil(minutes / 60)} 小时后重置`
      : `${minutes} 分钟后重置`;
};

const resourceSourceLabel = (
  source: NonNullable<ClaudeProjectState['resourceUsage']>['source'],
): string =>
  ({
    'claude-statusline': 'Claude Code 状态行',
    'codex-app-server': 'Codex 官方 App Server',
    'deepseek-balance': 'DeepSeek 官方余额接口',
    'managed-chatgpt-gateway': '受管 ChatGPT 本地网关',
    'openrouter-key': 'OpenRouter 官方密钥接口',
  })[source];

const managedContextWindowSelectable = (state: ClaudeProjectState | undefined): boolean =>
  Boolean(
    state?.config.preset === 'chatgpt-subscription' &&
    (state.config.model.toLowerCase() === 'gpt-5.6-sol' ||
      state.config.model.toLowerCase() === 'gpt-5.6'),
  );

const syncManagedChatGptContextWindowSelection = (): void => {
  for (const button of footerContextWindowOptions.querySelectorAll<HTMLButtonElement>(
    '[data-context-window-mode]',
  )) {
    button.setAttribute(
      'aria-checked',
      String(button.dataset.contextWindowMode === managedChatGptContextWindowMode),
    );
  }
};

const renderFooterResource = (
  usage: ClaudeProjectState['resourceUsage'] | CodexProjectState['resourceUsage'],
  contextWindowSelectable = false,
): void => {
  const preference = footerResourcePreference;
  const context = usage?.contextUsedPercent;
  const window = usage?.windows?.[0];
  const balance = usage?.balance?.balances?.[0];
  const quotaText =
    window?.usedPercent === undefined ? undefined : `额度 ${window.usedPercent.toFixed(0)}%`;
  const contextText = context === undefined ? undefined : `上下文 ${context.toFixed(0)}%`;
  const balanceText = balance
    ? `余额 ${formatResourceAmount(balance.amount, balance.currency)}`
    : undefined;
  const selected =
    usage?.availability === 'stale'
      ? { percent: window?.usedPercent ?? context, text: '资源 已过期' }
      : usage?.availability === 'unavailable'
        ? { percent: undefined, text: '资源 不可用' }
        : preference === 'context'
          ? {
              percent: context ?? window?.usedPercent,
              text: contextText ?? quotaText ?? balanceText ?? '资源 —',
            }
          : {
              percent: window?.usedPercent ?? context,
              text: quotaText ?? balanceText ?? contextText ?? '资源 —',
            };
  footerContextLabel.textContent = selected.text;
  footerContextRing.hidden = selected.percent === undefined;
  footerContextRing.style.setProperty('--context-progress', `${selected.percent ?? 0}%`);
  footerContextRing.dataset.level =
    selected.percent !== undefined && selected.percent >= 85
      ? 'danger'
      : selected.percent !== undefined && selected.percent >= 65
        ? 'warning'
        : 'normal';
  footerResource.dataset.availability = usage?.availability ?? 'unavailable';
  footerResource.title = '点击查看上下文、订阅窗口、余额和显示偏好';
  footerResourceDetails.replaceChildren();
  const lines = [
    usage?.contextUsedTokens === undefined || usage.contextWindowTokens === undefined
      ? contextText
      : `上下文：${formatTokenCount(usage.contextUsedTokens)} / ${formatTokenCount(usage.contextWindowTokens)}（${context?.toFixed(1) ?? '—'}%）`,
    usage?.autoCompactAtTokens === undefined
      ? undefined
      : `自动压缩线：约 ${formatTokenCount(usage.autoCompactAtTokens)}`,
    ...(usage?.windows ?? []).map(
      (item) =>
        `${item.label}：${item.usedPercent === undefined ? '缺失' : `已用 ${item.usedPercent.toFixed(0)}%`} · ${formatResetTime(item.resetsAt)}`,
    ),
    ...(usage?.balance?.balances ?? []).map(
      (item) => `余额：${formatResourceAmount(item.amount, item.currency)}`,
    ),
    usage?.balance?.used === undefined ? undefined : `累计用量：$${usage.balance.used.toFixed(2)}`,
    usage?.detail,
    usage ? `来源：${resourceSourceLabel(usage.source)}` : undefined,
  ].filter((line): line is string => Boolean(line));
  for (const line of lines.length > 0 ? lines : ['尚无资源数据。']) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    footerResourceDetails.append(paragraph);
  }
  for (const button of footerResourceMenu.querySelectorAll<HTMLButtonElement>(
    '[data-resource-preference]',
  )) {
    button.setAttribute('aria-checked', String(button.dataset.resourcePreference === preference));
  }
  footerContextWindowOptions.hidden = !contextWindowSelectable;
  syncManagedChatGptContextWindowSelection();
};

const loadAdvancedRouterBackends = async (): Promise<void> => {
  const status = activeStatus();
  settingsCcrBackendStatus.textContent = status
    ? '正在检查 CCR CLI 后台状态…'
    : '请先打开一个项目后再检查 CCR CLI 后台。';
  settingsChatGptGatewayStatus.textContent = '正在检查 ChatGPT 本地网关状态…';
  settingsOpenCcrBackend.disabled = true;
  settingsOpenChatGptGateway.disabled = true;

  const [routerResult, gatewayResult] = await Promise.allSettled([
    status
      ? window.controlPanel.getClaudeRouterManagementState(status.id)
      : Promise.resolve(undefined),
    window.controlPanel.getManagedChatGptGatewayState(),
  ]);
  if (routerResult.status === 'fulfilled' && routerResult.value) {
    const state = routerResult.value;
    routerManagementState = state;
    settingsCcrBackendStatus.textContent = state.serviceRunning
      ? state.managementAvailable
        ? `运行中 · ${state.version ? `v${state.version}` : '版本待识别'}`
        : '检测到后台进程，但不是可安全接管的 CCR CLI。'
      : state.installed
        ? 'CCR CLI 已安装，后台当前未运行。'
        : 'CCR CLI 尚未安装。';
    settingsOpenCcrBackend.disabled = !state.serviceRunning || !state.managementAvailable;
  } else if (status) {
    settingsCcrBackendStatus.textContent = '无法读取 CCR CLI 后台状态。';
  }

  if (gatewayResult.status === 'fulfilled') {
    settingsChatGptGatewayStatus.textContent = gatewayResult.value.message;
    settingsOpenChatGptGateway.disabled = !gatewayResult.value.managementAvailable;
  } else {
    settingsChatGptGatewayStatus.textContent = '无法读取 ChatGPT 本地网关状态。';
  }
};

const selectSettingsTab = (tab: SettingsTab): void => {
  selectedSettingsTab = tab;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')) {
    const selected = button.dataset.settingsTab === tab;
    button.classList.toggle('settings-tab--active', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-settings-panel]')) {
    panel.classList.toggle('settings-panel--active', panel.dataset.settingsPanel === tab);
  }
  if (tab === 'connection' || tab === 'router') {
    setConnectionPolling(true);
  } else {
    setConnectionPolling(selectedRailTab === 'connection');
  }
  if (tab === 'proxy') {
    void loadApplicationProxyState();
  }
  if (tab === 'advanced') {
    void loadAdvancedRouterBackends();
  }
  if (tab === 'router') {
    void loadRouterManagement();
    void loadRouterKernelState();
  }
};

const pendingAppSettings = (): Pick<
  AppSettingsView,
  'advanced' | 'closeBehavior' | 'launchAtLogin' | 'theme'
> => ({
  advanced: {
    chatIdleTimeoutMinutes: Number(settingsChatIdleTimeout.value) as 0 | 5 | 10 | 30,
    webResearchIsolation: settingsWebResearchIsolation.checked,
  },
  closeBehavior: settingsCloseBehavior.value === 'exit' ? 'exit' : 'tray',
  launchAtLogin: settingsLaunchAtLogin.checked,
  theme: isTerminalThemeId(settingsTheme.value) ? settingsTheme.value : DEFAULT_TERMINAL_THEME,
});

const updateSettingsUnsavedIndicator = (): number => {
  if (!savedAppSettings) {
    const count = applicationProxyIsDirty() ? 1 : 0;
    settingsUnsavedIndicator.hidden = count === 0;
    settingsUnsavedIndicator.textContent = `*${count} 项未保存`;
    return count;
  }
  const pending = pendingAppSettings();
  const count = [
    pending.launchAtLogin !== savedAppSettings.launchAtLogin,
    pending.closeBehavior !== savedAppSettings.closeBehavior,
    pending.theme !== savedAppSettings.theme,
    pending.advanced.chatIdleTimeoutMinutes !== savedAppSettings.advanced.chatIdleTimeoutMinutes,
    pending.advanced.webResearchIsolation !== savedAppSettings.advanced.webResearchIsolation,
    applicationProxyIsDirty(),
  ].filter(Boolean).length;
  settingsUnsavedIndicator.hidden = count === 0;
  settingsUnsavedIndicator.textContent = `*${count} 项未保存`;
  return count;
};

const applyAppSettingsToControls = (settings: AppSettingsView): void => {
  settingsLaunchAtLogin.checked = settings.launchAtLogin;
  settingsCloseBehavior.value = settings.closeBehavior;
  settingsChatIdleTimeout.value = String(settings.advanced.chatIdleTimeoutMinutes);
  settingsWebResearchIsolation.checked = settings.advanced.webResearchIsolation;
  settingsLanguage.value = settings.language;
  settingsVersion.value = settings.version;
  settingsVersion.textContent = settings.version;
  setEnhancedSelectValue(settingsTheme, settings.theme);
  applyTerminalTheme(settings.theme, false, false);
};

const loadAppSettings = async (): Promise<void> => {
  try {
    const settings = await window.controlPanel.getAppSettings();
    savedAppSettings = settings;
    footerResourcePreference = settings.footerResourcePreference;
    managedChatGptContextWindowMode = settings.managedChatGptContextWindowMode;
    applyAppSettingsToControls(settings);
    updateSettingsUnsavedIndicator();
  } catch {
    showToast('无法读取全局设置。', 'error');
  }
};

const openAdvancedConnectionDialog = (): void => {
  if (connectionAdvancedDialog.open) {
    return;
  }
  closeRailPreview();
  advancedConnectionSnapshot = captureAdvancedConnectionSnapshot();
  applicationProxyCancelBaseline = captureApplicationProxyDraft();
  const loadGeneration = ++applicationProxyLoadGeneration;
  applicationProxyInitialLoadPending = true;
  applicationProxyDraftEdited = false;
  syncApplicationProxyInteractivity();
  completeConnectionAdvancedButton.disabled = true;
  selectSettingsTab('general');
  void Promise.all([loadAppSettings(), loadApplicationProxyState(false, loadGeneration)]).then(
    ([, proxyLoaded]) => {
      if (loadGeneration !== applicationProxyLoadGeneration) return;
      applicationProxyInitialLoadPending = false;
      if (proxyLoaded) applicationProxyCancelBaseline = captureApplicationProxyDraft();
      syncApplicationProxyInteractivity();
      completeConnectionAdvancedButton.disabled = false;
      updateSettingsUnsavedIndicator();
    },
  );
  connectionAdvancedDialog.showModal();
};

const closeAdvancedConnectionDialog = (complete: boolean): void => {
  if (!connectionAdvancedDialog.open) {
    return;
  }
  if (!complete && advancedConnectionSnapshot) {
    restoreAdvancedConnectionSnapshot(advancedConnectionSnapshot);
  }
  if (!complete && savedAppSettings) {
    applyAppSettingsToControls(savedAppSettings);
  }
  if (!complete && applicationProxyCancelBaseline) {
    applyApplicationProxyDraft(applicationProxyCancelBaseline);
  }
  advancedConnectionSnapshot = undefined;
  applicationProxyCancelBaseline = undefined;
  applicationProxyLoadGeneration += 1;
  applicationProxyInitialLoadPending = false;
  applicationProxyDraftEdited = false;
  savedAppSettings = undefined;
  settingsUnsavedIndicator.hidden = true;
  connectionAdvancedDialog.close(complete ? 'complete' : 'cancel');
  setConnectionPolling(selectedRailTab === 'connection');
  openConnectionAdvancedButton.focus();
};

const pendingApplicationProxyInput = (): SaveApplicationProxyInput => {
  const port = Number.parseInt(applicationProxyPort.value, 10);
  return {
    enabled: applicationProxyEnabled.checked,
    host: applicationProxyHost.value,
    password: applicationProxyPassword.value || undefined,
    port: Number.isInteger(port) ? port : undefined,
    protocol: applicationProxyProtocol.value === 'socks5' ? 'socks5' : 'http',
    scope: {
      application: applicationProxyScopeApplication.checked,
      cli: applicationProxyScopeCli.checked,
      conversation: applicationProxyScopeConversation.checked,
    },
    username: applicationProxyUsername.value,
  };
};

const savePendingApplicationProxy = async (): Promise<boolean> => {
  if (!applicationProxyIsDirty() || applicationProxySaveInProgress) return false;
  applicationProxySaveInProgress = true;
  applicationProxySave.disabled = true;
  try {
    const state = await window.controlPanel.saveApplicationProxy(pendingApplicationProxyInput());
    renderApplicationProxyState(state, false);
    applicationProxyDraftEdited = false;
    applicationProxyCancelBaseline = captureApplicationProxyDraft();
    await window.controlPanel.invalidateNetworkPreflight('application-proxy-change');
    void runActiveNetworkPreflight(true);
    return true;
  } finally {
    applicationProxySaveInProgress = false;
    applicationProxySave.disabled = false;
  }
};

const savePendingAppSettings = async (): Promise<void> => {
  const saved = savedAppSettings;
  if (!saved) {
    showToast('全局设置仍在读取，请稍后重试。', 'error');
    return;
  }
  const proxyDirty = applicationProxyIsDirty();
  const appSettingsDirty = updateSettingsUnsavedIndicator() > (proxyDirty ? 1 : 0);
  if (!appSettingsDirty && !proxyDirty) {
    closeAdvancedConnectionDialog(true);
    return;
  }
  const pending = pendingAppSettings();
  completeConnectionAdvancedButton.disabled = true;
  cancelConnectionAdvancedButton.disabled = true;
  completeConnectionAdvancedButton.textContent = '正在保存…';
  try {
    if (proxyDirty) {
      await savePendingApplicationProxy();
    }
    if (pending.launchAtLogin !== saved.launchAtLogin) {
      await window.controlPanel.setLaunchAtLogin(pending.launchAtLogin);
    }
    if (pending.closeBehavior !== saved.closeBehavior) {
      await window.controlPanel.setCloseBehavior(pending.closeBehavior);
    }
    if (
      pending.advanced.chatIdleTimeoutMinutes !== saved.advanced.chatIdleTimeoutMinutes ||
      pending.advanced.webResearchIsolation !== saved.advanced.webResearchIsolation
    ) {
      await window.controlPanel.setAdvancedSettings(pending.advanced);
    }
    if (pending.theme !== saved.theme) {
      await window.controlPanel.setAppTheme(pending.theme);
      localStorage.setItem('claudedock.terminalTheme', pending.theme);
    }
    showToast('设置已保存');
    closeAdvancedConnectionDialog(true);
  } catch {
    showToast('部分设置未能保存，已重新读取当前值。', 'error');
    await Promise.all([loadAppSettings(), loadApplicationProxyState(false)]);
  } finally {
    completeConnectionAdvancedButton.disabled = false;
    cancelConnectionAdvancedButton.disabled = false;
    completeConnectionAdvancedButton.textContent = '完成';
  }
};

const renderDevelopmentRuntimeState = (
  state: DevelopmentRuntimeState,
  invalidatePendingLoad = true,
): void => {
  if (!workspaceState.sessions.some((session) => session.id === state.sessionId)) {
    return;
  }
  if (invalidatePendingLoad) {
    runtimeStateLoadGenerations.invalidate(state.sessionId);
  }
  developmentRuntimeStates.set(state.sessionId, state);
  if (state.sessionId !== workspaceState.activeSessionId) {
    return;
  }
  const codexSelected = state.runtime === 'codex';
  document.body.dataset.agentRuntime = state.runtime;
  runtimeClaude.checked = !codexSelected;
  runtimeCodex.checked = codexSelected;
  runtimePicker.disabled = false;
  workbenchTabs.hidden = codexSelected;
  workbenchTitle.textContent = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
  workbenchTriggerLabel.textContent = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
  workbenchTrigger.title = codexSelected ? 'Codex 工作台' : 'Claude 工作台';
  claudeWorkbench.setAttribute(
    'aria-label',
    codexSelected ? 'Codex 可视化工作台' : 'Claude 可视化工作台',
  );
  if (codexSelected) {
    const codexState = codexStates.get(state.sessionId);
    if (codexState) {
      renderCodexState(codexState, false);
    } else {
      runAgentLabel.textContent = '正在检查 Codex';
      runClaudeButton.disabled = true;
      void loadCodexState(state.sessionId);
    }
  } else {
    const claudeState = claudeStates.get(state.sessionId);
    if (claudeState) {
      renderClaudeState(claudeState, true, false);
    } else {
      renderClaudeLaunchControls(state.sessionId);
      void loadClaudeState(state.sessionId);
    }
  }
  void runActiveNetworkPreflight(false);
};

const renderCodexState = (state: CodexProjectState, invalidatePendingLoad = true): void => {
  if (!workspaceState.sessions.some((session) => session.id === state.sessionId)) {
    return;
  }
  if (invalidatePendingLoad) {
    codexStateLoadGenerations.invalidate(state.sessionId);
  }
  codexStates.set(state.sessionId, state);
  if (
    state.sessionId !== workspaceState.activeSessionId ||
    activeDevelopmentRuntime() !== 'codex'
  ) {
    return;
  }

  const { account, installation, login, rateLimits } = state;
  const installed = installation.installed;
  const accountReady = Boolean(account) || !state.requiresOpenaiAuth;
  const ready = installed && accountReady;
  const waitingForLogin = login.phase === 'waiting' || login.phase === 'starting';
  const launchInProgress = codexLaunchAttempts.isActive(state.sessionId);

  codexInstallStep.dataset.state = installed ? 'ready' : 'error';
  codexInstallTitle.textContent = installed
    ? `Codex CLI ${installation.version ?? '已安装'}`
    : '需要安装 Codex CLI';
  codexInstallDetail.textContent = state.operationMessage ?? installation.message;
  codexInstallButton.hidden = installed && !installation.updateAvailable;
  codexInstallButton.textContent = installation.updateAvailable ? '更新' : '安装';
  codexInstallButton.disabled = codexOperationInProgress;

  codexAccountStep.dataset.state = accountReady
    ? 'ready'
    : login.phase === 'error'
      ? 'error'
      : 'pending';
  codexAccountTitle.textContent = account
    ? account.type === 'chatgpt'
      ? 'ChatGPT 账号已连接'
      : account.type === 'apiKey'
        ? 'Codex 已使用 API Key'
        : 'Codex 账号已连接'
    : waitingForLogin
      ? '等待完成 ChatGPT 登录'
      : '尚未登录 ChatGPT';
  codexAccountDetail.textContent = account
    ? [account.email, account.planType].filter(Boolean).join(' · ') || '凭据由 Codex 官方管理'
    : (login.error ?? '浏览器登录可直接使用 ChatGPT 订阅额度');
  codexLoginButton.hidden = accountReady || waitingForLogin;
  codexLoginButton.disabled = !installed || codexOperationInProgress;

  codexProjectStep.dataset.state = ready ? 'ready' : 'pending';
  codexProjectTitle.textContent = ready ? '当前项目已就绪' : '等待环境与账号就绪';
  codexProjectDetail.textContent = ready
    ? `将在 ${projectNameFromPath(state.cwd)} 中以工作区写入沙箱启动`
    : '完成安装和登录后，不需要再填写 Token 或配置路由';

  codexDeviceLogin.hidden = !(
    login.phase === 'waiting' &&
    login.method === 'device-code' &&
    login.userCode
  );
  codexDeviceCode.textContent = login.userCode ?? '—';
  codexDeviceLoginAction.hidden = accountReady || waitingForLogin || !installed;
  codexCancelLogin.hidden = !waitingForLogin;
  codexLogout.hidden = !account;

  codexUsageCard.hidden = !account;
  codexPlan.textContent =
    account?.type === 'chatgpt'
      ? `${account.planType ? account.planType.toUpperCase() : 'ChatGPT'} · ${account.email ?? '已登录'}`
      : account?.type === 'apiKey'
        ? 'OpenAI API Key'
        : 'Codex 账号';
  const quota = rateLimits?.primary;
  codexQuotaLabel.textContent = quota?.windowDurationMins
    ? `${quota.windowDurationMins} 分钟窗口`
    : '当前额度窗口';
  codexQuotaValue.textContent = quota ? `已用 ${quota.usedPercent.toFixed(0)}%` : '等待额度数据';
  codexQuotaBar.style.width = `${quota?.usedPercent ?? 0}%`;

  const actionLabel =
    codexOperationInProgress || launchInProgress
      ? '正在准备 Codex…'
      : !installed
        ? '一键安装、登录并启动'
        : !accountReady
          ? '使用 ChatGPT 登录并启动'
          : '新建 Codex 安全会话';
  codexPrimaryAction.textContent = actionLabel;
  codexPrimaryAction.disabled = codexOperationInProgress || launchInProgress || waitingForLogin;
  codexPrimaryAction.setAttribute(
    'aria-busy',
    String(codexOperationInProgress || launchInProgress),
  );
  runAgentLabel.textContent = launchInProgress
    ? '正在启动 Codex…'
    : ready
      ? '新建 Codex 会话'
      : '一键准备 Codex';
  runClaudeButton.disabled = codexOperationInProgress || launchInProgress || waitingForLogin;
  runClaudeButton.setAttribute('aria-busy', String(codexOperationInProgress || launchInProgress));
  runClaudeButton.dataset.routeHealth = ready ? 'success' : 'warning';
  runClaudeButton.title = ready
    ? '在当前项目启动官方 Codex 安全会话'
    : '自动完成官方安装与 ChatGPT 登录';

  for (const button of [codexLaunchNew, codexLaunchContinue, codexLaunchResume]) {
    button.disabled = !ready || codexOperationInProgress || launchInProgress;
    button.setAttribute('aria-busy', String(launchInProgress));
  }

  routeHealth.hidden = true;
  footerConnection.disabled = false;
  footerConnection.dataset.tone = ready ? 'success' : 'warning';
  footerConnectionLabel.textContent = ready
    ? account?.type === 'chatgpt'
      ? 'ChatGPT 已连接'
      : 'Codex 已连接'
    : 'Codex 待准备';
  footerContextLabel.textContent = '上下文 —';
  footerContextRing.style.setProperty('--context-progress', '0%');
  renderFooterResource(state.resourceUsage);
  footerModel.textContent = '模型 Codex 自动';
  footerModel.disabled = true;
  footerSpeed.textContent = '速度 Codex 内管理';
  footerSpeed.disabled = true;
  footerSpeed.title = '原生 Codex 的速度设置由 Codex 自己管理，ClaudeDock 不接管。';
  footerSpeed.setAttribute('aria-busy', 'false');
  footerMode.textContent = '模式 工作区写入';
  footerMode.disabled = true;
  footerEffort.textContent = '思考 Codex 自动';
  footerEffort.disabled = true;
  codexBoundaryNote.textContent = state.warning
    ? `${state.warning} 首版任务界面仍可回退到官方 Codex TUI。`
    : '首版任务界面使用官方 Codex TUI：默认仅写当前工作区，模型需要更高权限时仍会向你确认。App Server 只用于结构化登录和账号状态，不会读取或转存 ChatGPT 令牌。';
  renderActiveNetworkPreflight();
};

const loadCodexState = async (
  sessionId: string,
  errorMessage = '无法读取 Codex 工作台状态。',
): Promise<CodexProjectState | undefined> => {
  const request = codexStateLoadGenerations.begin(sessionId);
  let state: CodexProjectState;
  try {
    state = await window.controlPanel.getCodexProjectState(sessionId);
  } catch {
    if (codexStateLoadGenerations.finish(request)) {
      showToast(errorMessage, 'error');
    }
    return;
  }
  if (!codexStateLoadGenerations.finish(request) || state.sessionId !== sessionId) {
    return;
  }
  renderCodexState(state, false);
  return state;
};

const loadDevelopmentRuntime = async (sessionId: string): Promise<void> => {
  const request = runtimeStateLoadGenerations.begin(sessionId);
  let state: DevelopmentRuntimeState;
  try {
    state = await window.controlPanel.getDevelopmentRuntime(sessionId);
  } catch {
    if (runtimeStateLoadGenerations.finish(request)) {
      showToast('无法读取当前项目的开发引擎。', 'error');
    }
    return;
  }
  if (!runtimeStateLoadGenerations.finish(request) || state.sessionId !== sessionId) {
    return;
  }
  renderDevelopmentRuntimeState(state, false);
};

const claudeLaunchBlocked = (state: ClaudeProjectState): boolean =>
  state.installation.security !== 'ready' || Boolean(state.routeHealth?.blocking);

const renderClaudeLaunchControls = (sessionId: string, launchBlocked = false): void => {
  if (sessionId !== workspaceState.activeSessionId || activeDevelopmentRuntime() !== 'claude') {
    return;
  }
  const busy = claudeLaunchAttempts.isBusy(sessionId);
  runAgentLabel.textContent = busy ? '正在启动安全会话…' : '新建安全会话';
  runClaudeButton.disabled = busy || launchBlocked;
  runClaudeButton.setAttribute('aria-busy', String(busy));
  launchNewButton.textContent = busy ? '正在启动安全会话…' : '新建安全会话';
  for (const button of [launchNewButton, launchContinueButton, launchResumeButton]) {
    button.disabled = busy || launchBlocked;
    button.setAttribute('aria-busy', String(busy));
  }
};

const refreshClaudeLaunchControls = (sessionId: string): void => {
  const state = claudeStates.get(sessionId);
  if (state) {
    renderClaudeState(state, true, false);
  } else {
    renderClaudeLaunchControls(sessionId);
  }
};

const beginClaudeLaunchAttempt = (
  status: TerminalStatus,
  state = claudeStates.get(status.id),
): ClaudeLaunchAttemptToken => {
  const token = claudeLaunchAttempts.begin(status.id, {
    active: state?.active,
    conversationId: state?.metrics?.sessionId,
    terminalPhase: status.phase,
    terminalPid: status.pid,
    terminalPtyGeneration: status.ptyGeneration,
  });
  renderClaudeLaunchControls(status.id, state ? claudeLaunchBlocked(state) : false);
  return token;
};

const failClaudeLaunchAttempt = (token: ClaudeLaunchAttemptToken): boolean => {
  if (!claudeLaunchAttempts.fail(token)) {
    return false;
  }
  refreshClaudeLaunchControls(token.sessionId);
  return true;
};

const claudeStateCanApply = (state: ClaudeProjectState): boolean => {
  const status = workspaceState.sessions.find((session) => session.id === state.sessionId);
  if (!status) {
    return false;
  }
  return claudeStateOwnershipIsCurrent(
    state,
    claudeStates.get(state.sessionId)?.stateRevision,
    status.ptyGeneration,
  );
};

const renderClaudeLaunchResult = (
  token: ClaudeLaunchAttemptToken,
  state: ClaudeProjectState,
  disposition: ClaudeLaunchResultDisposition,
): boolean => {
  if (
    state.sessionId !== token.sessionId ||
    !claudeLaunchAttempts.acceptResult(token, disposition)
  ) {
    return false;
  }
  renderClaudeState(state);
  return true;
};

const renderClaudeState = (
  state: ClaudeProjectState,
  observeLaunch = true,
  invalidatePendingLoad = true,
): void => {
  if (!claudeStateCanApply(state)) {
    return;
  }
  if (invalidatePendingLoad) {
    claudeStateLoadGenerations.invalidate(state.sessionId);
  }
  if (observeLaunch) {
    claudeLaunchAttempts.observeClaude({
      active: state.active,
      conversationId: state.metrics?.sessionId,
      sessionId: state.sessionId,
    });
  }
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
  if (activeDevelopmentRuntime() !== 'claude') {
    if (configFormSessionId !== state.sessionId) {
      populateClaudeConfigForm(state);
    }
    renderProviderPicker();
    syncConnectionInteractivity();
    return;
  }
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
      if (!claudeLaunchAttempts.isBusy(state.sessionId)) {
        showToast(health.headline, 'error');
      }
    }
  }
  runClaudeButton.dataset.routeHealth = health?.tone ?? 'unknown';
  const launchBlocked = claudeLaunchBlocked(state);
  renderClaudeLaunchControls(state.sessionId, launchBlocked);
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
  renderFooterResource(state.resourceUsage, managedContextWindowSelectable(state));
  footerModel.textContent = `模型 ${metrics?.modelDisplayName ?? metrics?.modelId ?? '—'}`;
  footerModel.disabled = modelSwitchInProgress;
  footerModel.setAttribute('aria-busy', String(modelSwitchInProgress));
  footerModel.title = state.active ? '点击切换模型' : '启动 Claude Code 后可切换模型';
  const speedOperationActive = claudeSpeedOperations.isActive(state.sessionId);
  footerSpeed.textContent = modelSpeedFooterLabel(state);
  footerSpeed.dataset.availability = state.speed.availability;
  footerSpeed.dataset.mechanism = state.speed.mechanism;
  footerSpeed.dataset.status = state.speed.status;
  footerSpeed.disabled =
    speedOperationActive || claudeLaunchAttempts.isBusy(state.sessionId) || modelSwitchInProgress;
  footerSpeed.setAttribute('aria-busy', String(speedOperationActive));
  footerSpeed.title = state.speed.detail;
  const requestedPermissionMode = state.permissionModeRequest ?? state.permissionMode;
  footerMode.textContent = `模式 ${permissionModeLabel(state.permissionMode)}`;
  footerMode.dataset.mode = state.permissionMode ?? 'unknown';
  footerMode.dataset.requestedMode = requestedPermissionMode ?? 'unknown';
  footerMode.disabled = modeSwitchInProgress;
  footerMode.title = state.active
    ? requestedPermissionMode !== state.permissionMode
      ? `请求：${permissionModeLabel(requestedPermissionMode)} · 实际：${permissionModeLabel(state.permissionMode)}；点击切换权限模式`
      : '点击切换权限模式，或在终端按 Shift+Tab'
    : '启动 Claude Code 后可切换权限模式';
  // The status line reports what Claude Code applied, which can sit below a request the model caps.
  const effortApplied = state.metrics?.effortLevel;
  const effortShown =
    state.effortCompatibility?.recovery === 'recovered'
      ? (state.effortRequest ?? effortApplied)
      : (effortApplied ?? state.effortRequest);
  footerEffort.textContent = `思考 ${claudeEffortLabel(effortShown)}`;
  footerEffort.dataset.effort = effortShown ?? 'unknown';
  footerEffort.dataset.requestedEffort = state.effortRequest ?? 'unknown';
  footerEffort.dataset.appliedEffort = effortApplied ?? 'unknown';
  footerEffort.disabled =
    effortSwitchInProgress || state.effortCompatibility?.recovery === 'pending';
  footerEffort.setAttribute(
    'aria-busy',
    String(effortSwitchInProgress || state.effortCompatibility?.recovery === 'pending'),
  );
  footerEffort.title = !state.active
    ? '启动 Claude Code 后可调整思考程度'
    : state.effortCompatibility
      ? state.effortCompatibility.recovery === 'failed'
        ? '自动回退失败；请打开菜单手动选择“均衡”或更低档位'
        : '搜索兼容重试期间暂用“均衡”；成功后会自动恢复原思考档位'
      : effortApplied === undefined
        ? '点击调整思考程度；当前模型未上报思考档位，可能不支持该参数'
        : '点击调整思考程度，或在终端运行 /effort';
  if (
    state.effortCompatibility?.recovery === 'recovered' &&
    effortRecoveryNotifications.get(state.sessionId) !== state.effortCompatibility.detectedAt
  ) {
    effortRecoveryNotifications.set(state.sessionId, state.effortCompatibility.detectedAt);
    showToast('搜索任务已临时切到“均衡”；重试完成后会自动恢复原思考档位。');
  }
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

  if (configFormSessionId !== state.sessionId) {
    populateClaudeConfigForm(state);
  }
  if (providerGroupExpansionPending) {
    applyDefaultProviderGroupExpansion(selectedProviderId ?? config.preset);
    providerGroupExpansionPending = false;
  }
  renderProviderPicker();
  syncConnectionInteractivity();
  if (routerManagementState) {
    renderRouterRemediation(routerManagementState);
  }
  updateSmartGuidance();
  renderActiveNetworkPreflight();
  scheduleAutomaticConnectionTest(state);
};

const loadClaudeState = async (sessionId: string): Promise<void> => {
  const request = claudeStateLoadGenerations.begin(sessionId);
  const attemptAtRequest = claudeLaunchAttempts.current(sessionId);
  let state: ClaudeProjectState;
  try {
    state = await window.controlPanel.getClaudeProjectState(sessionId);
  } catch {
    if (claudeStateLoadGenerations.finish(request)) {
      showToast('无法读取 Claude 工作台状态。', 'error');
    }
    return;
  }
  if (
    !claudeStateLoadGenerations.finish(request) ||
    state.sessionId !== sessionId ||
    !claudeStateCanApply(state)
  ) {
    return;
  }
  const currentAttempt = claudeLaunchAttempts.current(sessionId);
  if (
    currentAttempt &&
    attemptAtRequest &&
    currentAttempt.generation !== attemptAtRequest.generation
  ) {
    return;
  }
  if (currentAttempt && !attemptAtRequest) {
    claudeLaunchAttempts.hydrateClaude(currentAttempt, {
      active: state.active,
      conversationId: state.metrics?.sessionId,
      sessionId: state.sessionId,
    });
    renderClaudeState(state, false, false);
    return;
  }
  renderClaudeState(state, true, false);
};

/**
 * Resumes a stored Claude conversation in its own terminal, so a project folder can keep several
 * historical conversations running side by side instead of restarting the active one.
 */
async function resumeStoredConversation(
  projectPath: string,
  session: ClaudeSessionMetadata,
): Promise<void> {
  const restoreKey = `${projectPath.toLowerCase()}:${session.conversationId}`;
  if (storedConversationRestores.has(restoreKey)) {
    return;
  }
  storedConversationRestores.add(restoreKey);
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
    retryTerminalFitUntilMeasured();
    requestComposerFocus(result.state.activeSessionId);
  } catch {
    showToast('无法恢复这个历史会话。', 'error');
  } finally {
    storedConversationRestores.delete(restoreKey);
  }
}

const openExternal = async (url: string): Promise<void> => {
  if (!(await window.controlPanel.openExternal(url))) {
    showToast('无法打开该帮助或管理地址。', 'error');
  }
};

const applyGatewayCandidate = (candidate: ClaudeGatewayCandidate): void => {
  const preset: ClaudePreset = 'gateway';
  claudePreset.value = preset;
  applyPresetUi(preset, false);
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
    empty.textContent = '没有发现 CCR、CLIProxyAPI、LiteLLM 或当前项目保存的本机服务。';
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
      purgeButton.textContent = '卸载 CLI 路由';
      purgeButton.addEventListener('click', () => {
        void uninstallRouterCli(purgeButton);
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
      item.textContent = [
        `${hint.label}：${hint.baseUrl ?? '未设置基址'}`,
        hint.authConfigured ? '已配置静态凭据' : '未发现静态凭据',
        hint.apiKeyHelperConfigured ? '已配置 apiKeyHelper' : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      configurationHints.append(item);
    }
  }
  syncApiKeyHelperPolicyUi();
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

  installRouterButton.hidden = !routerActionVisible;
  installRouterButton.textContent = actions.router === 'update' ? '一键更新' : '一键安装';

  pluginUpdateActions.hidden = false;
  updateAllPluginsButton.hidden = !actions.plugins;

  const refreshLabel =
    actions.totalAvailable > 0
      ? `检查全部更新，当前发现 ${actions.totalAvailable} 项可更新`
      : '检查全部更新';
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

const routerOperationLabel = (progress: RouterOperationProgress): string => {
  const labels: Record<RouterOperationProgress['stage'], string> = {
    checking: '检查环境',
    complete: '操作完成',
    configuring: '写入配置',
    downloading: '下载 CLI',
    error: '操作未完成',
    installing: '安装 CLI',
    recovering: '恢复中断任务',
    starting: '启动后台',
    stopping: '停止后台',
    verifying: '校验安装',
  };
  return labels[progress.stage];
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
  const progress = lastRouterOperationProgress;
  if (progress && (progress.active || Date.now() - progress.updatedAt < 6_000)) {
    routerStatus.dataset.state = progress.stage === 'error' ? 'error' : 'starting';
    routerStatusTitle.textContent = `${routerOperationLabel(progress)} · 第 ${progress.step}/${progress.totalSteps} 步`;
    routerStatusDetail.textContent = progress.detail;
  }
  routerVersion.textContent = state.version ? `v${state.version}` : '版本待识别';
  renderRouterRemediation(state);
  applyRouterRelevance();

  installRouterButton.disabled = routerOperationInProgress;
  syncUpdateActionVisibility();
  uninstallRouterButton.disabled = routerOperationInProgress || !state.canUninstall;
  uninstallRouterButton.title = state.canUninstall
    ? '只卸载 ClaudeDock 管理的 CCR CLI；不会卸载桌面版或改写 Claude/Codex App'
    : '未检测到可由 ClaudeDock 卸载的 CCR CLI';
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
            : window.controlPanel.installClaudeRouterFromSource(sessionId, 'npm'),
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
      if (!status || routerOperationInProgress) {
        return;
      }
      if (
        !(await requestConfirmation({
          confirmLabel: '删除',
          message: `从路由器删除服务提供方“${provider.name}”？`,
          title: '删除服务提供方',
          tone: 'danger',
        }))
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

const setRouterOperationStage = (stage: string, detail: string, percent?: number): void => {
  routerOperationProgress.hidden = false;
  routerOperationStage.textContent = stage;
  routerOperationDetail.textContent = detail;
  if (percent === undefined) {
    routerOperationMeter.removeAttribute('value');
  } else {
    routerOperationMeter.value = Math.max(0, Math.min(100, percent));
  }
};

const unsubscribeManagedChatGptSetupProgress = window.controlPanel.onManagedChatGptSetupProgress(
  (progress) => {
    if (progress.sessionId === workspaceState.activeSessionId) {
      managedChatGptSetupInProgress = progress.active;
      renderManagedChatGptProgress?.(progress);
    }
  },
);

const unsubscribeRouterOperationProgress = window.controlPanel.onRouterOperationProgress(
  (progress) => {
    lastRouterOperationProgress = progress;
    routerOperationInProgress = progress.active;
    setRouterOperationStage(
      `${routerOperationLabel(progress)} · 第 ${progress.step}/${progress.totalSteps} 步`,
      progress.detail,
      (progress.step / Math.max(1, progress.totalSteps)) * 100,
    );
    if (routerManagementState) {
      renderRouterManagement(routerManagementState);
    }
    if (!progress.active) {
      window.setTimeout(() => {
        if (
          lastRouterOperationProgress?.updatedAt === progress.updatedAt &&
          routerManagementState
        ) {
          renderRouterManagement(routerManagementState);
        }
      }, 6_100);
    }
  },
);

const setRouterWizardModels = (models: readonly string[], preferred?: string): void => {
  const unique = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  const selected = preferred && unique.includes(preferred) ? preferred : unique[0];
  routerWizardModel.replaceChildren(
    ...unique.map((model) => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      return option;
    }),
  );
  if (selected) {
    routerWizardModel.value = selected;
  }
};

const syncRouterWizard = (): void => {
  const provider = findClaudeProvider(routerWizardProvider.value);
  if (!provider) {
    return;
  }
  const capability = ROUTER_CAPABILITIES[provider.id];
  const needsCredential = provider.authMode === 'apiKey' || provider.authMode === 'authToken';
  routerWizardBaseUrlField.hidden = !provider.editableBaseUrl;
  routerWizardBaseUrl.required = provider.editableBaseUrl;
  if (!provider.editableBaseUrl || !routerWizardBaseUrl.value.trim()) {
    routerWizardBaseUrl.value = provider.editableBaseUrl ? '' : provider.baseUrl;
  }
  routerWizardCredentialField.hidden = !needsCredential;
  routerWizardCredential.required = needsCredential && provider.id !== 'ollama';
  routerWizardCredential.placeholder = provider.keyHint ?? '仅在提交时交给主进程安全保存';
  const previousProvider = routerWizardModel.dataset.providerId;
  const existingModels = routerManagementState?.providers.find(
    (item) => item.name === `wizard-${provider.id}`,
  )?.models;
  setRouterWizardModels(
    [
      ...(existingModels ?? []),
      provider.model,
      ...(provider.modelFast ? [provider.modelFast] : []),
    ],
    previousProvider === provider.id ? routerWizardModel.value : provider.model,
  );
  routerWizardModel.dataset.providerId = provider.id;
  if (capability.mode === 'direct') {
    routerWizardUseRoute.checked = false;
  } else if (capability.mode === 'router-required') {
    routerWizardUseRoute.checked = true;
  } else {
    routerWizardUseRoute.checked = false;
  }
  routerWizardUseRoute.disabled = true;
  const routed = routerWizardUseRoute.checked;
  routerWizardDecision.dataset.mode = routed ? 'router' : 'direct';
  routerWizardDecision.textContent = `${routed ? '将使用 CCR 完成协议转换' : '将直接写入 Claude Code CLI 配置'}：${capability.reason}`;
};

const wizardDirectInput = (): SaveClaudeConfigInput => {
  const provider = findClaudeProvider(routerWizardProvider.value);
  if (!provider) {
    throw new Error('请选择有效的服务提供方。');
  }
  const credential =
    provider.id === 'ollama'
      ? routerWizardCredential.value.trim() || 'ollama'
      : routerWizardCredential.value.trim();
  const needsCredential = provider.authMode === 'apiKey' || provider.authMode === 'authToken';
  return {
    apiKeyHelperPolicy: 'prefer-claudedock',
    authMode: provider.authMode,
    baseUrl: provider.editableBaseUrl ? routerWizardBaseUrl.value.trim() : provider.baseUrl,
    credential: needsCredential ? credential : undefined,
    credentialAction: needsCredential ? 'replace' : 'clear',
    model: routerWizardModel.value.trim() || provider.model,
    modelFast: provider.modelFast,
    preset: provider.id,
    protocol: 'anthropic',
    provider: providerForPreset(provider.id),
  };
};

const verifySavedRouterConfiguration = async (
  sessionId: string,
  projectState: ClaudeProjectState | undefined,
): Promise<ClaudeConnectionTestResult | undefined> => {
  const config = projectState?.config;
  if (!config) {
    return undefined;
  }
  return window.controlPanel.testClaudeConnection(sessionId, {
    apiKeyHelperPolicy: config.apiKeyHelperPolicy,
    authMode: config.authMode,
    baseUrl: config.baseUrl,
    credentialAction: 'keep',
    model: config.model,
    modelFast: config.modelFast,
    preset: config.preset,
    protocol: config.protocol === 'unknown' ? 'anthropic' : config.protocol,
    provider: config.provider,
    routerProviderId: config.routerProviderId,
  });
};

const runRouterWizard = async (): Promise<void> => {
  const status = activeStatus();
  const provider = findClaudeProvider(routerWizardProvider.value);
  if (!status || !provider || routerOperationInProgress || !routerWizardForm.reportValidity()) {
    return;
  }
  const capability = ROUTER_CAPABILITIES[provider.id];
  const routed = capability.mode === 'router-required';
  routerOperationInProgress = true;
  setRouterOperationStage('准备', `正在校验 ${provider.label} 接入参数…`, 5);
  await runGuarded(routerWizardSubmit, '正在自动配置…', async () => {
    try {
      if (!routed) {
        const input = wizardDirectInput();
        setRouterOperationStage('连通性校验', '先验证端点、认证与模型，避免写入不可用配置。', 55);
        const test = await window.controlPanel.testClaudeConnection(status.id, input);
        renderConnectionTest(test);
        if (!test.ok) {
          throw new Error(test.message);
        }
        setRouterOperationStage('写入配置', '正在保存项目级 Claude Code CLI 接入配置…', 80);
        const saved = await window.controlPanel.saveClaudeConfig(status.id, input);
        renderClaudeState(saved.state);
        if (!saved.ok) {
          throw new Error(saved.error ?? '无法保存接入配置。');
        }
        populateClaudeConfigForm(saved.state);
      } else {
        const upstreamBaseUrl = provider.editableBaseUrl
          ? routerWizardBaseUrl.value.trim()
          : provider.baseUrl;
        const upstreamCredential =
          provider.id === 'ollama' ? undefined : routerWizardCredential.value.trim() || undefined;
        setRouterOperationStage(
          '发现模型',
          '正在读取当前接口的实时模型列表；这一步同时验证地址与密钥。',
          10,
        );
        const discovery = await window.controlPanel.discoverClaudeProviderModels({
          baseUrl: upstreamBaseUrl,
          credential: upstreamCredential,
        });
        if (!discovery.ok || discovery.models.length === 0) {
          throw new Error(discovery.error ?? discovery.message);
        }
        const selectedBeforeDiscovery = routerWizardModel.value;
        setRouterWizardModels(
          discovery.models,
          discovery.models.includes(selectedBeforeDiscovery)
            ? selectedBeforeDiscovery
            : discovery.models[0],
        );
        setRouterOperationStage('检查路由内核', '正在确认 CCR 已安装且管理接口可用…', 15);
        let management = await window.controlPanel.getClaudeRouterManagementState(status.id);
        if (!management.installed) {
          setRouterOperationStage('安装路由内核', '正在通过受管下载与 npm 安装 CCR…', 25);
          const installed = await window.controlPanel.installClaudeRouterFromSource(
            status.id,
            'npm',
          );
          renderRouterManagement(installed.routerState);
          if (!installed.ok) {
            throw new Error(installed.message);
          }
          management = installed.routerState;
        }
        if (!management.managementAvailable) {
          setRouterOperationStage('启动路由内核', '正在启动 CCR 并等待本地管理端点…', 65);
          const started = await window.controlPanel.startClaudeRouter(status.id);
          renderRouterManagement(started.routerState);
          if (!started.routerState.managementAvailable) {
            throw new Error(started.message);
          }
          management = started.routerState;
        }
        setRouterOperationStage('写入路由配置', '正在写入上游、模型与当前项目绑定…', 80);
        const baseUrl = upstreamBaseUrl;
        const existing = management.providers.find((item) => item.name === `wizard-${provider.id}`);
        const saved = await window.controlPanel.saveClaudeRouterProvider(status.id, {
          apiKey:
            provider.id === 'ollama'
              ? routerWizardCredential.value.trim() || 'ollama'
              : routerWizardCredential.value.trim(),
          baseUrl,
          credentialAction: 'replace',
          id: existing?.id,
          makePreferred: true,
          models: [routerWizardModel.value],
          name: `wizard-${provider.id}`,
          protocol: 'openai_chat_completions',
          useForCurrentProject: true,
        });
        renderRouterManagement(saved.routerState);
        if (saved.projectState) {
          renderClaudeState(saved.projectState);
          populateClaudeConfigForm(saved.projectState);
        }
        if (!saved.ok) {
          throw new Error(saved.message);
        }
        setRouterOperationStage('连通性校验', '正在通过本地路由验证端点、认证与模型…', 92);
        const test = await verifySavedRouterConfiguration(status.id, saved.projectState);
        if (test) {
          renderConnectionTest(test);
          if (!test.ok) {
            throw new Error(test.message);
          }
        }
      }
      routerWizardCredential.value = '';
      setRouterOperationStage('完成', `${provider.label} 已配置并通过真实连接校验。`, 100);
      showToast(`${provider.label} 接入已完成`);
      void loadConnectionHistory();
      void loadGatewayDiagnostics();
    } catch (error) {
      const message = error instanceof Error ? error.message : '自动配置失败。';
      setRouterOperationStage('未完成', message, 100);
      showToast(message, 'error');
    } finally {
      routerOperationInProgress = false;
      void loadRouterKernelState();
    }
  });
};

const renderRouterKernelState = (state: RouterKernelState): void => {
  routerKernelState = state;
  const activeLabel =
    state.active === 'ccr' ? 'CCR' : state.active === 'cc-switch' ? 'CC Switch' : '无';
  routerKernelStatus.textContent = state.conflict
    ? '检测到 CCR 与 CC Switch 同时运行；请停止其中一个，避免接入状态相互覆盖。'
    : `当前活跃内核：${activeLabel}。${state.ccSwitch.message}`;
  routerKernelStatus.dataset.tone = state.conflict ? 'danger' : 'neutral';
  installCcSwitchButton.disabled = routerOperationInProgress || state.ccSwitch.installed;
  exportCcSwitchButton.disabled =
    routerOperationInProgress ||
    !state.ccSwitch.installed ||
    !state.ccSwitch.protocolRegistered ||
    !activeStatus();
  uninstallCcSwitchButton.disabled =
    routerOperationInProgress ||
    (!state.ccSwitch.installed && state.ccSwitch.residuals.length === 0);
  ccSwitchResiduals.replaceChildren(
    ...state.ccSwitch.residuals.map((residual) => {
      const item = document.createElement('li');
      item.textContent = residual;
      return item;
    }),
  );
};

const loadRouterKernelState = async (): Promise<void> => {
  const status = activeStatus();
  if (!status || routerOperationInProgress) {
    return;
  }
  try {
    const state = await window.controlPanel.getRouterKernelState(status.id);
    renderRouterKernelState(state);
    renderRouterManagement(state.ccr);
  } catch {
    routerKernelStatus.textContent = '无法读取路由内核状态。';
    routerKernelStatus.dataset.tone = 'danger';
  }
};

const runKernelOperation = async (
  action: (sessionId: string) => Promise<RouterKernelOperationResult>,
  busyLabel: string,
  button: HTMLButtonElement,
): Promise<void> => {
  const status = activeStatus();
  if (!status || routerOperationInProgress) {
    return;
  }
  routerOperationInProgress = true;
  setRouterOperationStage('准备', busyLabel || '正在准备路由内核操作…', 5);
  await runGuarded(button, busyLabel, async () => {
    try {
      setRouterOperationStage('执行', busyLabel || '正在执行路由内核操作…', 70);
      const result = await action(status.id);
      renderRouterKernelState(result.state);
      renderRouterManagement(result.state.ccr);
      setRouterOperationStage(result.ok ? '完成' : '未完成', result.error ?? result.message, 100);
      showToast(result.error ?? result.message, result.ok ? 'success' : 'error');
    } catch {
      setRouterOperationStage('未完成', '路由内核操作发生异常。', 100);
      showToast('路由内核操作发生异常。', 'error');
    } finally {
      routerOperationInProgress = false;
      if (routerKernelState) {
        renderRouterKernelState(routerKernelState);
      }
    }
  });
};

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
  setRouterOperationStage('准备', busyLabel || '正在准备路由器操作…', 5);
  await runGuarded(button, busyLabel, async () => {
    try {
      setRouterOperationStage('执行', busyLabel || '正在执行路由器操作…', 70);
      const result = await action(status.id);
      handleRouterResult(result);
      setRouterOperationStage(result.ok ? '完成' : '未完成', result.message, 100);
      void loadGatewayDiagnostics();
      void loadSoftwareUpdates(false);
    } catch {
      setRouterOperationStage('未完成', '路由器操作发生异常。', 100);
      showToast('路由器操作发生异常。', 'error');
    } finally {
      routerOperationInProgress = false;
      if (routerManagementState) {
        renderRouterManagement(routerManagementState);
      }
      void loadRouterKernelState();
    }
  });
};

const uninstallRouterCli = async (button: HTMLButtonElement): Promise<void> => {
  if (
    !(await requestConfirmation({
      confirmLabel: '卸载 CLI',
      message:
        '卸载 ClaudeDock 管理的 CCR CLI？\n\n' +
        '不会卸载 CCR 桌面版，不会改写 Claude/Codex App，也不会删除桌面版可能使用的共享配置。\n' +
        '以后需要时，可在 ClaudeDock 中一键重新安装。',
      title: '卸载 CLI 路由',
      tone: 'danger',
    }))
  ) {
    return;
  }
  void runRouterOperation(
    async (sessionId) => {
      return window.controlPanel.uninstallClaudeRouter(sessionId);
    },
    '正在卸载…',
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
      void runConnectionRemedyAction(button, action);
    });
    connectionRemedyActions.append(button);
  }
};

const runConnectionRemedyAction = async (
  button: HTMLButtonElement,
  action: ClaudeConnectionRemedyAction,
): Promise<void> => {
  if (connectionRemedyInProgress || connectionTestInProgress) {
    return;
  }
  connectionRemedyInProgress = true;
  connectionRemedy.setAttribute('aria-busy', 'true');
  const originalLabel = button.textContent;
  button.textContent = '处理中…';
  syncConnectionInteractivity();
  try {
    await handleConnectionRemedyAction(action);
  } finally {
    connectionRemedyInProgress = false;
    connectionRemedy.setAttribute('aria-busy', 'false');
    button.textContent = originalLabel;
    syncConnectionInteractivity();
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
      await runRouterOperation(
        (sessionId) => window.controlPanel.installClaudeRouterFromSource(sessionId, 'npm'),
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
    renderClaudeState(knownState, true, false);
  }
  const originalLabel = testClaudeConnectionButton.textContent;
  testClaudeConnectionButton.disabled = true;
  testClaudeConnectionButton.setAttribute('aria-busy', 'true');
  testClaudeConnectionButton.textContent = '正在发送单令牌测试…';
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
  } catch (error) {
    connectionTestResult.dataset.tone = 'error';
    connectionTestTitle.textContent = '连接测试发生异常';
    connectionTestSummary.textContent =
      error instanceof Error ? error.message : '后台测试已结束，请稍后重试。';
    connectionTestStages.replaceChildren();
    connectionRemedy.hidden = true;
    showToast(error instanceof Error ? error.message : '连接测试发生异常。', 'error');
  } finally {
    connectionTestInProgress = false;
    connectionTestResult.setAttribute('aria-busy', 'false');
    testClaudeConnectionButton.setAttribute('aria-busy', 'false');
    testClaudeConnectionButton.textContent = originalLabel;
    syncConnectionInteractivity();
    const latestState = claudeStates.get(status.id);
    if (latestState) {
      renderClaudeState(latestState, true, false);
    }
  }
};

const scheduleAutomaticConnectionTest = (state: ClaudeProjectState): void => {
  if (
    state.sessionId !== workspaceState.activeSessionId ||
    developmentRuntimeStates.get(state.sessionId)?.runtime !== 'claude' ||
    automaticConnectionTestSessions.has(state.sessionId)
  ) {
    return;
  }
  automaticConnectionTestSessions.add(state.sessionId);
  window.setTimeout(() => {
    const currentState = claudeStates.get(state.sessionId);
    if (
      !currentState ||
      workspaceState.activeSessionId !== state.sessionId ||
      developmentRuntimeStates.get(state.sessionId)?.runtime !== 'claude'
    ) {
      automaticConnectionTestSessions.delete(state.sessionId);
      return;
    }
    if (connectionTestInProgress) {
      automaticConnectionTestSessions.delete(state.sessionId);
      window.setTimeout(() => scheduleAutomaticConnectionTest(currentState), 250);
      return;
    }
    void runConnectionTest(false, savedClaudeConfigInput(currentState.config));
  }, 0);
};

const rerunAutomaticConnectionTestForActiveProject = (): void => {
  const status = activeStatus();
  const state = status ? claudeStates.get(status.id) : undefined;
  if (!state || developmentRuntimeStates.get(state.sessionId)?.runtime !== 'claude') {
    return;
  }
  automaticConnectionTestSessions.delete(state.sessionId);
  scheduleAutomaticConnectionTest(state);
};

const setWorkbenchOpen = (open: boolean): void => {
  if (open) closeRailPreview();
  // The listbox is a fixed-position popup on `body`, so closing the panel underneath it has to
  // dismiss it explicitly or it would hang over the terminal.
  closeOpenSelect();
  claudeWorkbench.classList.toggle('claude-workbench--open', open);
  claudeWorkbench.setAttribute('aria-hidden', String(!open));
  workbenchScrim.classList.toggle('workbench-scrim--visible', open);
  workbenchTrigger.setAttribute('aria-expanded', String(open));
  if (open && workspaceState.activeSessionId) {
    if (activeDevelopmentRuntime() === 'codex') {
      void loadCodexState(workspaceState.activeSessionId);
    } else {
      void loadClaudeState(workspaceState.activeSessionId);
      void loadConnectionAdvice();
    }
  }
};

interface TerminalMaskState {
  depth: number;
  focusBeforeMask: HTMLElement | null;
  label: HTMLElement;
  overlay: HTMLDivElement;
  view: TerminalView;
}

const terminalMasks = new Map<string, TerminalMaskState>();

const releaseTerminalMask = (sessionId: string, state: TerminalMaskState): void => {
  state.depth -= 1;
  if (state.depth > 0 || terminalMasks.get(sessionId) !== state) {
    return;
  }
  terminalMasks.delete(sessionId);
  state.overlay.remove();
  state.view.container.inert = false;
  const restore = state.focusBeforeMask;
  if (restore?.isConnected) {
    restore.focus({ preventScroll: true });
  } else if (workspaceState.activeSessionId === sessionId) {
    focusComposer();
  }
};

const copyTerminalCanvasLayers = (source: HTMLElement, target: HTMLElement): boolean => {
  const sourceCanvases = [...source.querySelectorAll<HTMLCanvasElement>('canvas')];
  const targetCanvases = [...target.querySelectorAll<HTMLCanvasElement>('canvas')];
  let copied = 0;
  for (const [index, sourceCanvas] of sourceCanvases.entries()) {
    const targetCanvas = targetCanvases[index];
    if (!targetCanvas) {
      continue;
    }
    targetCanvas.width = sourceCanvas.width;
    targetCanvas.height = sourceCanvas.height;
    try {
      targetCanvas.getContext('2d')?.drawImage(sourceCanvas, 0, 0);
      copied += 1;
    } catch {
      // A GPU driver can reject readback after context loss; the text fallback below stays usable.
    }
  }
  return copied > 0;
};

/**
 * Freezes what the user sees while keeping the real xterm alive behind it. Permission-mode changes
 * depend on xterm consuming screen deltas, so pausing the output queue here would deadlock the
 * before/after badge probe. A copied visual layer gives the requested frozen blur without breaking
 * that state machine.
 */
const beginTerminalMask = (sessionId: string, label: string): (() => void) => {
  const existing = terminalMasks.get(sessionId);
  if (existing) {
    existing.depth += 1;
    existing.label.textContent = label;
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      releaseTerminalMask(sessionId, existing);
    };
  }

  const view = terminalViews.get(sessionId);
  if (!view) {
    return () => undefined;
  }
  const overlay = document.createElement('div');
  overlay.className = 'terminal-mask';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');

  const snapshot = view.container.cloneNode(true) as HTMLDivElement;
  snapshot.className = 'terminal-mask__snapshot';
  snapshot.removeAttribute('data-session-id');
  snapshot.setAttribute('aria-hidden', 'true');
  snapshot.inert = true;
  if (!copyTerminalCanvasLayers(view.container, snapshot)) {
    const fallback = document.createElement('pre');
    fallback.className = 'terminal-mask__fallback';
    const buffer = view.terminal.buffer.active;
    const firstRow = Math.max(0, buffer.baseY);
    const rows: string[] = [];
    for (
      let index = firstRow;
      index < Math.min(buffer.length, firstRow + view.terminal.rows);
      index++
    ) {
      rows.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    fallback.textContent = rows.join('\n');
    snapshot.replaceChildren(fallback);
  }
  const veil = document.createElement('div');
  veil.className = 'terminal-mask__veil';
  const message = document.createElement('strong');
  message.className = 'terminal-mask__label';
  message.textContent = label;
  veil.append(message);
  overlay.append(snapshot, veil);
  terminalStage.append(overlay);

  const focusBeforeMask =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  view.container.inert = true;
  overlay.focus({ preventScroll: true });
  const state: TerminalMaskState = {
    depth: 1,
    focusBeforeMask,
    label: message,
    overlay,
    view,
  };
  terminalMasks.set(sessionId, state);

  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    releaseTerminalMask(sessionId, state);
  };
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
  if (!status || claudeLaunchAttempts.isBusy(status.id)) {
    return;
  }
  const attempt = beginClaudeLaunchAttempt(status);
  let endMask = (): void => undefined;
  let loadStateAfterCompletion = false;
  try {
    const outcome = await orchestrateClaudeLaunchAttempt({
      applyResult: (result) =>
        renderClaudeLaunchResult(attempt, result.state, result.ok ? 'success' : 'failure'),
      confirmation: () =>
        requestConfirmation({
          confirmLabel: '压缩并重启',
          message: `${summary}\n\n这需要重启 Claude Code 会话。对话历史会通过 --continue 恢复，但终端画面会重绘。\n\n确定后会先压缩上下文再重启。`,
          title: '重启 Claude Code 会话',
        }),
      onRelease: () => refreshClaudeLaunchControls(attempt.sessionId),
      prepare: () => {
        endMask = beginTerminalMask(status.id, '正在压缩上下文并恢复会话');
      },
      registry: claudeLaunchAttempts,
      start: () =>
        window.controlPanel.relaunchClaudeSession(status.id, {
          ...input,
          compactFirst: true,
        }),
      token: attempt,
    });
    if (outcome.status === 'rejected') {
      loadStateAfterCompletion = true;
      showToast('重启会话时发生异常。', 'error');
      return;
    }
    if (outcome.status !== 'resolved') {
      return;
    }

    const { result } = outcome;
    loadStateAfterCompletion = true;
    if (!result.ok) {
      failClaudeLaunchAttempt(attempt);
    }
    showToast(
      result.ok ? '会话已重启并恢复上下文。' : (result.error ?? '重启会话失败。'),
      result.ok ? 'success' : 'error',
    );
  } finally {
    endMask();
    if (loadStateAfterCompletion) {
      void loadClaudeState(status.id);
    }
  }
};

const switchClaudeModel = async (option: ClaudeModelOption): Promise<void> => {
  const status = activeStatus();
  if (!status || modelSwitchInProgress) {
    return;
  }
  if (option.requiresRelaunch) {
    const summary =
      option.relaunchReason === 'connection'
        ? `切换到「${option.providerLabel} · ${option.model}」需要更换接口地址与凭据。`
        : option.relaunchReason === 'speed-profile'
          ? `切换到「${option.providerLabel} · ${option.model}」会同时应用该模型已保存的服务速度配置。`
          : `切换到「${option.providerLabel} · ${option.model}」需要重启当前会话。`;
    await relaunchClaudeSession(summary, { entryId: option.entryId });
    return;
  }

  modelSwitchInProgress = true;
  footerModel.disabled = true;
  footerModel.setAttribute('aria-busy', 'true');
  const endMask = beginTerminalMask(status.id, '正在切换模型');
  try {
    const result = await window.controlPanel.switchClaudeModel(status.id, option.id);
    renderClaudeState(result.state);
    if (!result.ok) {
      showToast(result.error ?? '无法切换模型。', 'error');
    }
  } catch {
    showToast('切换模型时发生异常。', 'error');
  } finally {
    endMask();
    modelSwitchInProgress = false;
    footerModel.disabled = false;
    footerModel.setAttribute('aria-busy', 'false');
    const knownState = claudeStates.get(status.id);
    if (knownState) {
      renderClaudeState(knownState, true, false);
    }
    void loadClaudeState(status.id);
  }
};

const switchClaudeModelSpeed = async (mode: ModelSpeedMode): Promise<void> => {
  const status = activeStatus();
  const state = status ? claudeStates.get(status.id) : undefined;
  if (
    !status ||
    !state ||
    claudeSpeedOperations.isActive(status.id) ||
    claudeLaunchAttempts.isBusy(status.id)
  ) {
    return;
  }
  if (mode === 'fast' && !state.speed.canSelectFast) {
    showToast(state.speed.detail, 'error');
    return;
  }

  const operation = claudeSpeedOperations.begin(status.id);
  const attempt = beginClaudeLaunchAttempt(status, state);
  renderClaudeState(state, false, false);
  const fastLabel = modelSpeedFastLabel(state);
  const speedDetail =
    mode === 'standard'
      ? `将「${state.speed.model}」恢复为标准服务速度。`
      : state.speed.mechanism === 'claude-native-fast'
        ? `将「${state.speed.model}」切换为 ${fastLabel}。Claude Fast 仅适用于受支持的 Opus 5 / 4.8，最高约 2.5x，并按更高单价计费；组织资格、额度和模型可用性仍由 Anthropic 判定。`
        : `将为「${state.speed.model}」请求 ${fastLabel}（service_tier=fast）。该档位的额度消耗或计价可能更高；ClaudeDock 只能确认请求已发送，无法确认 ChatGPT 上游最终采用。`;
  const lifecycleDetail =
    '如果主进程确认 Claude Code 仍在运行，ClaudeDock 会重启当前 PowerShell，并通过 --resume 精确恢复当前对话；不会压缩上下文。如果会话已经停止，则只保存此接入与模型的速度偏好，供下次新建或恢复时使用。';
  let endMask = (): void => undefined;
  try {
    const outcome = await orchestrateSessionOperation({
      applyResult: (result) => {
        if (result.state.sessionId !== operation.sessionId) {
          return false;
        }
        renderClaudeState(result.state);
        return true;
      },
      confirmation: () =>
        requestConfirmation({
          confirmLabel: '确认切换',
          message: `${speedDetail}\n\n${lifecycleDetail}`,
          title: '切换服务速度',
        }),
      onCancel: () => {
        if (claudeLaunchAttempts.cancel(attempt)) {
          refreshClaudeLaunchControls(attempt.sessionId);
        }
      },
      registry: claudeSpeedOperations,
      start: () => {
        if (!claudeLaunchAttempts.isCurrent(attempt)) {
          throw new Error('确认期间会话状态已经变化。');
        }
        endMask = beginTerminalMask(status.id, '正在应用服务速度设置');
        return window.controlPanel.setClaudeModelSpeed(status.id, mode);
      },
      token: operation,
    });
    if (outcome.status === 'rejected') {
      failClaudeLaunchAttempt(attempt);
      showToast('切换服务速度时发生异常。', 'error');
      return;
    }
    if (outcome.status !== 'resolved') {
      return;
    }

    const { result } = outcome;
    if (!result.ok) {
      failClaudeLaunchAttempt(attempt);
      showToast(result.error ?? '无法切换服务速度。', 'error');
      return;
    }
    if (!result.state.active) {
      if (claudeLaunchAttempts.cancel(attempt)) {
        refreshClaudeLaunchControls(attempt.sessionId);
      }
      showToast('速度偏好已保存；下次新建或恢复会话时生效。', 'success');
    } else if (mode === 'standard') {
      showToast('已按标准速度恢复当前对话。', 'success');
    } else if (result.state.speed.mechanism === 'gpt-service-tier') {
      showToast('已为当前对话请求 GPT 1.5x；上游是否采用仍由 ChatGPT 决定。', 'success');
    } else {
      showToast('已请求 Claude Fast；是否生效将由 Claude Code 状态行确认。', 'success');
    }
  } finally {
    endMask();
    if (claudeSpeedOperations.finish(operation)) {
      const knownState = claudeStates.get(status.id);
      if (knownState) {
        renderClaudeState(knownState, true, false);
      }
      void loadClaudeState(status.id);
    }
  }
};

const switchPermissionMode = async (mode: ClaudePermissionMode): Promise<void> => {
  const status = activeStatus();
  if (!status || modeSwitchInProgress) {
    return;
  }
  if (mode === 'dontAsk' || mode === 'bypassPermissions') {
    const confirmed = await requestConfirmation({
      confirmLabel: mode === 'bypassPermissions' ? '确认完全允许' : '确认仅预批准',
      message:
        mode === 'bypassPermissions'
          ? '“完全允许”会跳过 Claude 的权限确认。仅在你信任当前项目及其指令时启用。'
          : '“仅预批准”会重启并恢复当前会话，未预先批准的工具请求将直接被拒绝。确认继续吗？',
      title: mode === 'bypassPermissions' ? '确认高风险权限模式' : '确认严格权限模式',
      tone: 'danger',
    });
    if (!confirmed) {
      return;
    }
  }
  if (mode === 'dontAsk') {
    await relaunchClaudeSession('「仅预批准」只能在会话启动时设定。', { permissionMode: mode });
    return;
  }

  modeSwitchInProgress = true;
  footerMode.disabled = true;
  const endMask = beginTerminalMask(status.id, '正在切换权限模式');
  try {
    const result = await window.controlPanel.setClaudePermissionMode(status.id, mode);
    renderClaudeState(result.state);
    if (!result.ok) {
      showToast(result.error ?? '无法切换权限模式。', 'error');
    }
  } catch {
    showToast('切换权限模式时发生异常。', 'error');
  } finally {
    endMask();
    modeSwitchInProgress = false;
    void loadClaudeState(status.id);
  }
};

/**
 * `/effort` lands inside the running conversation, so every level — including the session-only
 * `max` and `ultracode` — applies without a relaunch.
 */
const switchEffortLevel = async (effort: ClaudeEffortRequest): Promise<void> => {
  const status = activeStatus();
  if (!status || effortSwitchInProgress) {
    return;
  }

  effortSwitchInProgress = true;
  footerEffort.disabled = true;
  footerEffort.setAttribute('aria-busy', 'true');
  const endMask = beginTerminalMask(status.id, '正在调整思考程度');
  try {
    const result = await window.controlPanel.setClaudeEffortLevel(status.id, effort);
    renderClaudeState(result.state);
    if (!result.ok) {
      showToast(result.error ?? '无法调整思考程度。', 'error');
    }
  } catch {
    showToast('调整思考程度时发生异常。', 'error');
  } finally {
    endMask();
    effortSwitchInProgress = false;
    footerEffort.disabled = false;
    footerEffort.setAttribute('aria-busy', 'false');
    const knownState = claudeStates.get(status.id);
    if (knownState) {
      renderClaudeState(knownState, true, false);
    }
    void loadClaudeState(status.id);
  }
};

const openModelMenu = async (trigger = footerModel): Promise<void> => {
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
  openFooterMenu(footerModelMenu, trigger);
};

const openSpeedMenu = (): void => {
  const status = activeStatus();
  const state = status ? claudeStates.get(status.id) : undefined;
  if (!status || !state || activeDevelopmentRuntime() !== 'claude') {
    return;
  }

  const fastLabel = modelSpeedFastLabel(state);
  const fastDetail = state.speed.canSelectFast
    ? state.speed.mechanism === 'claude-native-fast'
      ? 'Claude Code 原生 Fast；仅支持 Opus 5 / 4.8，最高约 2.5x，单价更高，资格与额度由 Anthropic 判定。'
      : '请求 service_tier=fast（约 1.5x）；额度消耗或计价可能更高，ClaudeDock 无法确认上游最终采用。'
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
      () => {
        void switchClaudeModelSpeed('standard');
      },
      speedOperationActive || standardAlreadyApplied,
    ),
    buildFooterRadioMenuItem(
      fastLabel,
      fastDetail,
      state.speed.preference === 'fast',
      () => {
        void switchClaudeModelSpeed('fast');
      },
      speedOperationActive || !state.speed.canSelectFast || fastAlreadyApplied,
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

const openEffortMenu = (): void => {
  const status = activeStatus();
  if (!status) {
    return;
  }

  const state = claudeStates.get(status.id);
  const running = state?.active ?? false;
  const compatibility = state?.effortCompatibility;
  // The applied level is authoritative; the pending request only shows until the status line ticks.
  const current =
    compatibility?.recovery === 'recovered'
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
        () => {
          void switchEffortLevel(option.id);
        },
        !running ||
          Boolean(compatibility && !isClaudeEffortSafeAfterThinkingDisabledError(option.id)),
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
        ? '检测到高档思考与 thinking 关闭冲突，正在自动切换到“均衡”…'
        : compatibility.recovery === 'recovered'
          ? '已临时切到“均衡”；请重试刚才的搜索，成功后会自动恢复原思考档位。'
          : '自动切换失败；请手动选择“均衡”或更低档位后重试。';
    footerEffortMenu.append(hint);
  } else if (state?.metrics?.effortLevel === undefined) {
    const hint = document.createElement('p');
    hint.className = 'footer-menu__hint';
    hint.textContent = '当前模型没有上报思考档位，可能不支持该参数；选择后仍会按所选档位下发。';
    footerEffortMenu.append(hint);
  }
  openFooterMenu(footerEffortMenu, footerEffort);
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

const prepareRailTab = (tab: string): void => {
  if (tab === 'chat') {
    void loadChatConfig();
    void loadChatHistory();
    renderChatUsage();
  } else if (tab === 'connection') {
    const lastProvider =
      selectedProviderId ?? claudeStates.get(workspaceState.activeSessionId)?.config.preset;
    applyDefaultProviderGroupExpansion(lastProvider);
    providerGroupExpansionPending = Boolean(workspaceState.activeSessionId && !lastProvider);
    renderProviderPicker();
  } else if (tab === 'plugins') {
    void loadPluginCatalog(false);
  } else if (tab === 'mcp') {
    void loadMcpCatalog(false);
  }
};

const renderRailPresentation = (tab: string | undefined, preview: boolean): void => {
  const collapsed = selectedRailTab === undefined;
  workspace.classList.toggle('workspace--rail-collapsed', collapsed);
  workspace.classList.toggle('workspace--rail-preview', preview && tab !== undefined);
  workspace.dataset.railPanel = tab ?? 'collapsed';
  controlPanel.inert = tab === undefined;
  controlPanel.setAttribute('aria-hidden', String(tab === undefined));
  panelResizer.tabIndex = collapsed ? -1 : 0;
  for (const button of activityRail.querySelectorAll<HTMLButtonElement>('[data-rail-tab]')) {
    const selected = button.dataset.railTab === selectedRailTab;
    const transient = preview && button.dataset.railTab === tab;
    button.classList.toggle('activity-rail__button--active', selected);
    button.classList.toggle('activity-rail__button--preview', transient);
    button.setAttribute('aria-expanded', String(selected || transient));
    button.setAttribute('aria-pressed', String(selected));
    const label = button.querySelector<HTMLElement>('span:not(.activity-rail__dot)')?.textContent;
    button.title = selected ? `${label ?? '侧栏'}（再次点击可收起侧栏）` : (label ?? '打开侧栏');
  }
  for (const page of document.querySelectorAll<HTMLElement>('[data-rail-page]')) {
    page.classList.toggle('rail-page--active', page.dataset.railPage === tab);
  }
  const chatVisible = mainView === 'chat';
  terminalShell.hidden = chatVisible;
  chatShell.hidden = !chatVisible;
  setConnectionPolling(
    tab === 'connection' ||
      (connectionAdvancedDialog.open &&
        (selectedSettingsTab === 'connection' || selectedSettingsTab === 'router')),
  );
  if (!chatVisible && !preview) {
    retryTerminalFitUntilMeasured();
  }
};

const cancelRailPreviewClose = (): void => {
  window.clearTimeout(railPreviewCloseTimer);
  railPreviewCloseTimer = undefined;
};

const closeRailPreview = (): void => {
  cancelRailPreviewClose();
  if (previewRailTab === undefined) return;
  previewRailTab = undefined;
  renderRailPresentation(selectedRailTab, false);
};

const railPreviewDialogObserver = new MutationObserver((records) => {
  if (
    previewRailTab !== undefined &&
    records.some(({ target }) => target instanceof HTMLDialogElement && target.hasAttribute('open'))
  ) {
    closeRailPreview();
  }
});
railPreviewDialogObserver.observe(document.body, {
  attributeFilter: ['open'],
  attributes: true,
  subtree: true,
});

const scheduleRailPreviewClose = (delay = 120): void => {
  cancelRailPreviewClose();
  railPreviewCloseTimer = window.setTimeout(closeRailPreview, delay);
};

const showRailPreview = (tab: string): void => {
  if (selectedRailTab !== undefined) return;
  cancelRailPreviewClose();
  if (previewRailTab !== tab) prepareRailTab(tab);
  previewRailTab = tab;
  renderRailPresentation(tab, true);
};

const applyRailTab = (tab?: string): void => {
  closeRailPreview();
  if (tab === 'chat') mainView = 'chat';
  else if (tab !== undefined) mainView = 'terminal';
  const entering = tab !== undefined && tab !== selectedRailTab;
  selectedRailTab = tab;
  if (entering && tab) prepareRailTab(tab);
  renderRailPresentation(tab, false);
};

/**
 * The sidebar column eases open and closed now, so the fit `applyRailTab` schedules lands while the
 * grid is still moving. One more pass once the transition ends settles xterm on the final width —
 * and doing it here rather than per animation frame keeps ConPTY from being resized dozens of times.
 */
workspace.addEventListener('transitionend', (event) => {
  if (event.target === workspace && event.propertyName === 'grid-template-columns') {
    retryTerminalFitUntilMeasured();
  }
});

const focusChatInputAfterNavigation = (): void => {
  window.requestAnimationFrame(() => {
    const detailsOpen = artifactDetailsButton.getAttribute('aria-expanded') === 'true';
    if (
      mainView !== 'chat' ||
      chatShell.hidden ||
      chatInput.disabled ||
      chatComposer.inert ||
      chatSettingsDialog.open ||
      detailsOpen
    ) {
      return;
    }
    chatInput.focus({ preventScroll: true });
  });
};

function selectRailTab(tab: string): void {
  applyRailTab(tab);
}

const toggleRailTab = (tab: string): void => {
  applyRailTab(selectedRailTab === tab ? undefined : tab);
  if (tab === 'chat') {
    focusChatInputAfterNavigation();
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

const renderCliCommandCatalog = (grid: HTMLElement, entries: CliCommandDefinition[]): void => {
  const nodes: HTMLElement[] = [];
  let previousCategory = '';
  for (const entry of entries) {
    if (entry.category !== previousCategory) {
      const heading = document.createElement('h4');
      heading.className = 'command-grid__category';
      heading.textContent = entry.category;
      nodes.push(heading);
      previousCategory = entry.category;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.commandAction = entry.action;
    button.dataset.commandRuntime = entry.runtime;
    button.dataset.commandValue = entry.command;
    button.dataset.commandRisk = entry.risk;
    if (entry.runtime === 'claude' && entry.action === 'run') {
      button.dataset.claudeCommand = entry.command;
      if (entry.syntax.includes('[参数]')) button.dataset.usesArgument = 'true';
    }
    if (entry.risk === 'destructive') button.classList.add('command-danger');
    const code = document.createElement('code');
    code.textContent = entry.command;
    const description = document.createElement('span');
    description.textContent = entry.aliases.length
      ? `${entry.description} · 别名 ${entry.aliases.join('、')}`
      : entry.description;
    const requirements = entry.requirements.length
      ? ` · 条件：${entry.requirements.join('；')}`
      : '';
    button.title = `${entry.syntax} · ${entry.documentedVersion} · ${entry.platforms.join('/')} · ${entry.action === 'run' ? '可视化执行' : '填入输入框确认'}${requirements}`;
    button.append(code, description);
    nodes.push(button);
  }
  grid.replaceChildren(...nodes);
};

renderCliCommandCatalog(claudeCommandGrid, CLAUDE_COMMAND_CATALOG);
renderCliCommandCatalog(codexCommandGrid, CODEX_COMMAND_CATALOG);

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

const pluginCategory = (plugin: ClaudePluginView): string => localizePluginCopy(plugin).category;

/**
 * The category dropdown mirrors MCP's 作用域 filter: same control, same position in the toolbar, same
 * "全部" default. Its options are derived from the catalogue rather than hard-coded, so a market that
 * ships plugins in a category the localizer has not seen before is still reachable, and a category
 * nobody has installed does not sit in the list as a dead end. The current pick survives a refresh
 * whenever it still matches something.
 */
const syncPluginCategoryOptions = (catalog: ClaudePluginCatalog): void => {
  const categories = [
    ...new Set([...catalog.installed, ...catalog.available].map(pluginCategory)),
  ].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const previous = pluginCategoryFilter.value;
  const options = [
    Object.assign(document.createElement('option'), { textContent: '全部', value: 'all' }),
    ...categories.map((category) =>
      Object.assign(document.createElement('option'), {
        textContent: category,
        value: category,
      }),
    ),
  ];
  pluginCategoryFilter.replaceChildren(...options);
  pluginCategoryFilter.value = categories.includes(previous) ? previous : 'all';
};

const selectPluginTab = (tab: string): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-plugin-tab]')) {
    button.classList.toggle('plugin-tab--active', button.dataset.pluginTab === tab);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-plugin-panel]')) {
    panel.classList.toggle('plugin-panel--active', panel.dataset.pluginPanel === tab);
  }
};

/** Same tab machinery as the plugins page, pointed at the MCP page's data attributes. */
const selectMcpTab = (tab: string): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mcp-tab]')) {
    button.classList.toggle('plugin-tab--active', button.dataset.mcpTab === tab);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-mcp-panel]')) {
    panel.classList.toggle('plugin-panel--active', panel.dataset.mcpPanel === tab);
  }
};

const renderApplicationUpdater = (state: ApplicationUpdaterState): void => {
  applicationUpdaterState = state;
  const active = ['available', 'checking', 'downloaded', 'downloading', 'error'].includes(
    state.phase,
  );
  if (active || state.phase === 'up-to-date') {
    const sourceRate = state.sourceThroughputBps
      ? ` · ${(state.sourceThroughputBps / 1024 / 1024).toFixed(1)} MiB/s`
      : '';
    applicationUpdateDetail.textContent = `${state.message}${
      state.sourceLabel ? ` · ${state.sourceLabel}${sourceRate}` : ''
    }`;
  }
  if (state.latestVersion) {
    applicationUpdateVersion.textContent = `v${state.currentVersion} → ${state.latestVersion}`;
  }
  const softwareReportsUpdate = softwareUpdates?.application.updateAvailable === true;
  applicationUpdateAction.hidden =
    state.phase === 'disabled' || (state.phase === 'up-to-date' && !softwareReportsUpdate);
  applicationUpdateAction.disabled = state.phase === 'checking' || state.phase === 'downloading';
  applicationUpdateAction.textContent =
    state.phase === 'downloaded'
      ? '重启并安装'
      : state.phase === 'checking'
        ? '正在检查…'
        : state.phase === 'downloading'
          ? `正在下载${state.percent === undefined ? '…' : ` ${Math.round(state.percent)}%`}`
          : state.phase === 'error'
            ? '重试检查'
            : state.phase === 'available' || softwareReportsUpdate
              ? '下载更新'
              : '检查应用更新';
  applicationUpdateVersion.dataset.update = String(
    state.phase === 'downloaded' || state.phase === 'downloading' || softwareReportsUpdate,
  );
  renderDownloadCenter();
  if (updateCenterDialog.open) renderUpdateCenter();
};

const runApplicationUpdateAction = async (): Promise<void> => {
  if (applicationUpdaterState?.phase === 'downloaded') {
    const confirmed = await requestConfirmation({
      confirmLabel: '重启并安装',
      message:
        'ClaudeDock 将关闭当前窗口并启动已校验的更新安装包。请先保存终端中尚未写入磁盘的内容。',
      title: '安装 ClaudeDock 更新',
    });
    if (!confirmed) return;
    try {
      await window.controlPanel.installApplicationUpdate();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法启动更新安装。', 'error');
    }
    return;
  }
  applicationUpdateAction.disabled = true;
  applicationUpdateAction.textContent = '正在检查…';
  try {
    renderApplicationUpdater(await window.controlPanel.downloadApplicationUpdate());
  } catch (error) {
    showToast(error instanceof Error ? error.message : '无法下载应用更新。', 'error');
  } finally {
    if (applicationUpdaterState) renderApplicationUpdater(applicationUpdaterState);
  }
};

const unsubscribeApplicationUpdaterChanged =
  window.controlPanel.onApplicationUpdaterChanged(renderApplicationUpdater);

const renderSoftwareUpdates = (state: SoftwareUpdateState): void => {
  softwareUpdates = state;
  applicationUpdateDetail.textContent = state.application.message;
  applicationUpdateVersion.textContent = `v${state.application.currentVersion ?? '未知'}${
    state.application.updateAvailable ? ` → ${state.application.latestVersion}` : ''
  }`;
  applicationUpdateVersion.dataset.update = String(state.application.updateAvailable);
  if (applicationUpdaterState) {
    renderApplicationUpdater(applicationUpdaterState);
  }
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
      const [updates, updater] = await Promise.all([
        window.controlPanel.getSoftwareUpdates(refresh),
        window.controlPanel.getApplicationUpdaterState(),
      ]);
      applicationUpdaterState = updater;
      renderSoftwareUpdates(updates);
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
    const result = await window.controlPanel.installOrUpdateClaudeCode();
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
    /*
     * The flag has to be cleared *before* the catalogue is re-rendered. Rendering replaces every card,
     * and each freshly built button takes its initial `disabled` from this flag — so clearing it
     * afterwards left the whole panel dead until the tab was reopened and reloaded the catalogue.
     */
    pluginMutationInProgress = false;
    renderPluginCatalog(result.catalog);
    showToast(result.message, result.ok ? 'success' : 'error');
  } catch {
    showToast('插件操作发生异常。', 'error');
  } finally {
    pluginMutationInProgress = false;
    // On the success path the button was discarded by the re-render; only the failure path still owns it.
    if (button.isConnected) {
      button.textContent = originalLabel;
      button.disabled = false;
    }
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

const renderPluginCard = (plugin: ClaudePluginView, fresh: boolean): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'plugin-card';
  card.dataset.enabled = String(plugin.enabled);
  card.dataset.fresh = String(fresh);
  /*
   * The dimmed treatment means "installed but switched off", so it needs the installation state as
   * well: a plugin in the 可安装 list is also `enabled: false`, and keying the dimming on that alone
   * greyed out the entire catalogue of things the user had not installed yet.
   */
  card.dataset.installed = String(plugin.installed);

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
    uninstall.addEventListener('click', async () => {
      if (
        !(await requestConfirmation({
          confirmLabel: '卸载',
          message: `卸载插件“${plugin.name}”？`,
          title: '卸载插件',
          tone: 'danger',
        }))
      ) {
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
  isFresh: (plugin: ClaudePluginView) => boolean,
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
    container.append(renderPluginCard(plugin, isFresh(plugin)));
  }
};

function renderPluginCatalog(catalog: ClaudePluginCatalog): void {
  pluginCatalog = catalog;
  syncPluginCategoryOptions(catalog);
  const needle = pluginSearch.value.trim().toLowerCase();
  const categoryFilter = pluginCategoryFilter.value;
  const matches = (plugin: ClaudePluginView): boolean =>
    (categoryFilter === 'all' || pluginCategory(plugin) === categoryFilter) &&
    pluginMatchesSearch(plugin, needle);
  const installed = catalog.installed.filter(matches);
  const installedKeys = new Set(catalog.installed.map(pluginKey));
  const available = catalog.available
    .filter((plugin) => !installedKeys.has(pluginKey(plugin)))
    .filter(matches);

  const renderContext = `${categoryFilter}|${needle}`;
  const previousKeys = pluginRenderedContext === renderContext ? pluginRenderedKeys : null;
  const isFresh = (plugin: ClaudePluginView): boolean =>
    previousKeys === null || !previousKeys.has(pluginKey(plugin));
  pluginRenderedContext = renderContext;
  pluginRenderedKeys = new Set([...catalog.installed, ...catalog.available].map(pluginKey));

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

  const filtered = needle !== '' || categoryFilter !== 'all';
  renderPluginList(
    pluginInstalledList,
    installed,
    filtered ? '没有匹配当前筛选条件的已安装插件。' : '还没有安装任何插件。到“可安装”里挑一个吧。',
    isFresh,
  );
  renderPluginList(
    pluginAvailableList,
    available,
    filtered
      ? '没有匹配当前筛选条件的可安装插件。'
      : '当前插件市场里没有更多可安装的插件；可以在下面添加新的市场。',
    isFresh,
  );

  pluginMarketplaceList.replaceChildren();
  if (catalog.marketplaces.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = '还没有添加插件市场。添加后即可浏览它提供的插件。';
    pluginMarketplaceList.append(empty);
  }
  for (const marketplace of catalog.marketplaces) {
    pluginMarketplaceList.append(renderMarketplaceCard(marketplace, previousKeys === null));
  }
  addPluginMarketplaceButton.disabled = pluginMutationInProgress || !catalog.cliAvailable;
  updateAllPluginsButton.disabled =
    pluginMutationInProgress || !catalog.cliAvailable || catalog.updatesAvailable === 0;
  syncUpdateActionVisibility();
}

const renderMarketplaceCard = (
  marketplace: ClaudePluginMarketplaceView,
  fresh: boolean,
): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'plugin-card plugin-card--marketplace';
  card.dataset.fresh = String(fresh);

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
  remove.addEventListener('click', async () => {
    if (
      !(await requestConfirmation({
        confirmLabel: '移除',
        message: `移除插件市场“${marketplace.name}”？来自它的插件将不再可见。`,
        title: '移除插件市场',
        tone: 'danger',
      }))
    ) {
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

const mcpScopeLabel = (scope: McpScope): string =>
  scope === 'user'
    ? 'user · 用户级'
    : scope === 'project'
      ? 'project · 项目共享'
      : 'local · 项目私有';

/*
 * Every MCP render rebuilds both lists from scratch, so without a memory of what was on screen the
 * card entrance replays for every row and an install looks like the whole panel blinking. Keying the
 * previous render lets a card that survived sit still while a genuinely new server animates in.
 * `null` means "no comparable previous render" (first paint, project switch) — then everything is new
 * and the list arrives as a whole, which is what it actually is.
 */
const mcpServerKey = (server: McpServerView): string =>
  `${server.client}\\u0000${server.scope}\\u0000${server.name}`;

let mcpRenderedContext: string | null = null;
let mcpRenderedKeys: ReadonlySet<string> = new Set<string>();

const mcpMatchesSearch = (
  value: Pick<McpServerView, 'configPath' | 'name'> | Pick<McpCatalogEntry, 'description' | 'name'>,
  needle: string,
): boolean =>
  needle === '' ||
  Object.values(value).some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(needle),
  );

const runMcpMutation = async (
  button: HTMLButtonElement,
  busyLabel: string,
  operation: () => ReturnType<typeof window.controlPanel.installMcpServer>,
): Promise<void> => {
  if (mcpMutationInProgress) return;
  mcpMutationInProgress = true;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  mcpStatus.textContent = `${busyLabel} 配置写入期间退出保护已开启。`;
  try {
    const result = await operation();
    mcpMutationInProgress = false;
    renderMcpCatalog(result.catalog);
    void loadMcpBackups();
    showToast(result.message, result.ok ? 'success' : 'error');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'MCP 操作发生异常。', 'error');
  } finally {
    mcpMutationInProgress = false;
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
};

const renderMcpInstalledCard = (
  server: McpServerView,
  cwd: string,
  fresh: boolean,
): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'plugin-card';
  card.dataset.enabled = String(server.enabled);
  card.dataset.fresh = String(fresh);
  card.dataset.installed = 'true';
  const header = document.createElement('div');
  header.className = 'plugin-card__header';
  const title = document.createElement('strong');
  title.textContent = server.name;
  const badge = document.createElement('span');
  badge.className = 'plugin-card__badge';
  badge.textContent = `${server.client === 'claude' ? 'Claude' : 'Codex'} · ${server.transport}`;
  header.append(title, badge);

  const health = document.createElement('p');
  health.className = 'mcp-card__health';
  health.dataset.health = server.health;
  health.textContent = `${
    server.health === 'connected'
      ? '已连接'
      : server.health === 'failed'
        ? '连接失败'
        : server.health === 'disabled'
          ? '已停用'
          : '状态未知'
  } · ${server.healthDetail ?? '尚未执行健康检查。'}`;
  const meta = document.createElement('div');
  meta.className = 'plugin-card__meta';
  const scope = document.createElement('span');
  scope.textContent = mcpScopeLabel(server.scope);
  const pathLabel = document.createElement('code');
  pathLabel.className = 'mcp-card__path';
  pathLabel.textContent = server.configPath;
  meta.append(scope);

  const actions = document.createElement('div');
  actions.className = 'plugin-card__actions';
  if (server.toggleSupported) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'button button--secondary button--small';
    toggle.textContent = server.enabled ? '停用' : '启用';
    toggle.disabled = mcpMutationInProgress;
    toggle.addEventListener('click', async () => {
      try {
        const preview = await window.controlPanel.previewMcpToggle(
          cwd,
          server.name,
          !server.enabled,
        );
        if (
          !(await requestConfirmation({
            confirmLabel: server.enabled ? '确认停用' : '确认启用',
            message: `目标文件：${preview.targetPath}\n\n改动预览：\n- ${preview.before}\n+ ${preview.after}\n\n写入前会创建可逐字节还原的备份。`,
            title: `${server.enabled ? '停用' : '启用'} MCP ${server.name}`,
            tone: 'danger',
          }))
        ) {
          return;
        }
        void runMcpMutation(toggle, '正在写入…', () =>
          window.controlPanel.applyMcpToggle(preview.id, cwd),
        );
      } catch (error) {
        showToast(error instanceof Error ? error.message : '无法生成 MCP 改动预览。', 'error');
      }
    });
    actions.append(toggle);
  }
  if (server.client === 'claude') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button button--quiet button--small plugin-card__danger';
    remove.textContent = '卸载';
    remove.disabled = mcpMutationInProgress;
    remove.addEventListener('click', async () => {
      if (
        !(await requestConfirmation({
          confirmLabel: '卸载',
          message: `从 ${mcpScopeLabel(server.scope)} 移除 MCP“${server.name}”？\n\n配置来源：${server.configPath}`,
          title: '卸载 MCP',
          tone: 'danger',
        }))
      ) {
        return;
      }
      void runMcpMutation(remove, '正在卸载…', () =>
        window.controlPanel.removeMcpServer({
          cwd,
          name: server.name,
          scope: server.scope,
        }),
      );
    });
    actions.append(remove);
  }
  card.append(header, health, meta, pathLabel, actions);
  return card;
};

const renderMcpCatalogCard = (
  entry: McpCatalogEntry,
  cwd: string,
  installedNames: ReadonlySet<string>,
  fresh: boolean,
): HTMLElement => {
  const card = document.createElement('article');
  card.className = 'plugin-card';
  card.dataset.fresh = String(fresh);
  card.dataset.installed = String(installedNames.has(entry.name));
  const header = document.createElement('div');
  header.className = 'plugin-card__header';
  const title = document.createElement('strong');
  title.textContent = entry.name;
  const badge = document.createElement('span');
  badge.className = 'plugin-card__badge';
  badge.textContent = entry.featured ? `精选 · ${entry.transport}` : `注册表 · ${entry.transport}`;
  header.append(title, badge);
  const description = document.createElement('p');
  description.textContent = entry.description;
  const actions = document.createElement('div');
  actions.className = 'plugin-card__actions';
  const install = document.createElement('button');
  install.type = 'button';
  install.className = 'button button--primary button--small';
  install.textContent = installedNames.has(entry.name) ? '已安装' : '安装';
  install.disabled =
    mcpMutationInProgress || installedNames.has(entry.name) || entry.requiresCredential;
  install.title = entry.requiresCredential ? '该条目需要凭据，不能自动写入明文配置。' : '';
  install.addEventListener('click', () => {
    void runMcpMutation(install, '正在安装…', () =>
      window.controlPanel.installMcpServer({
        catalogId: entry.id,
        cwd,
        scope: mcpInstallScope.value as McpScope,
      }),
    );
  });
  actions.append(install);
  card.append(header, description, actions);
  return card;
};

function renderMcpCatalog(catalog: McpCatalog): void {
  mcpCatalog = catalog;
  const status = activeStatus();
  const cwd = status?.cwd;
  const needle = mcpSearch.value.trim().toLowerCase();
  const scopeFilter = mcpScopeFilter.value;
  const installed = catalog.installed.filter(
    (server) =>
      (scopeFilter === 'all' || server.scope === scopeFilter) && mcpMatchesSearch(server, needle),
  );
  const available = catalog.available.filter((entry) => mcpMatchesSearch(entry, needle));
  const renderContext = `${cwd ?? ''}|${scopeFilter}|${needle}`;
  const previousKeys = mcpRenderedContext === renderContext ? mcpRenderedKeys : null;
  const isFresh = (server: McpServerView): boolean =>
    previousKeys === null || !previousKeys.has(mcpServerKey(server));
  mcpRenderedContext = renderContext;
  mcpRenderedKeys = new Set(catalog.installed.map(mcpServerKey));
  mcpInstalledCount.textContent = String(installed.length);
  mcpCatalogCount.textContent = String(available.length);
  mcpStatus.textContent = `${catalog.message} · 上次读取 ${new Date(catalog.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  mcpInstalledList.replaceChildren();
  if (!cwd || installed.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = cwd
      ? needle || scopeFilter !== 'all'
        ? '没有匹配当前筛选条件的 MCP。'
        : '当前没有发现 MCP。可以从“可安装”里定向安装一个。'
      : '请先打开一个项目，再发现或安装 MCP。';
    if (cwd && !needle && scopeFilter === 'all') {
      const browse = document.createElement('button');
      browse.type = 'button';
      browse.textContent = '去目录看看';
      browse.addEventListener('click', () => selectMcpTab('catalog'));
      empty.append(document.createElement('br'), browse);
    }
    mcpInstalledList.append(empty);
  } else {
    mcpInstalledList.append(
      ...installed.map((server) => renderMcpInstalledCard(server, cwd, isFresh(server))),
    );
  }
  mcpCatalogList.replaceChildren();
  if (!cwd || available.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = cwd ? '目录中没有匹配项。' : '打开项目后即可安装精选 MCP。';
    mcpCatalogList.append(empty);
  } else {
    const installedNames = new Set(catalog.installed.map((server) => server.name));
    mcpCatalogList.append(
      ...available.map((entry) =>
        renderMcpCatalogCard(entry, cwd, installedNames, previousKeys === null),
      ),
    );
  }
}

const loadMcpBackups = async (): Promise<void> => {
  try {
    const backups = await window.controlPanel.getMcpBackups();
    mcpBackupSelect.replaceChildren(
      ...(backups.length > 0
        ? backups.map((backup) => {
            const option = document.createElement('option');
            option.value = backup.id;
            option.textContent = `${new Date(backup.createdAt).toLocaleString('zh-CN')} · ${backup.path}`;
            return option;
          })
        : [
            (() => {
              const option = document.createElement('option');
              option.value = '';
              option.textContent = '暂无可还原备份';
              return option;
            })(),
          ]),
    );
    mcpBackupRestore.disabled = backups.length === 0 || mcpMutationInProgress;
  } catch {
    mcpBackupRestore.disabled = true;
  }
};

function loadMcpCatalog(refresh: boolean): Promise<void> {
  if (mcpLoadPromise) return mcpLoadPromise;
  const status = activeStatus();
  if (!status) {
    mcpStatus.textContent = '请先打开一个项目以发现 MCP。';
    return Promise.resolve();
  }
  mcpLoadPromise = (async () => {
    mcpRefresh.disabled = true;
    if (refresh || !mcpCatalog) mcpStatus.textContent = '正在发现 MCP 并执行受限健康检查…';
    try {
      renderMcpCatalog(await window.controlPanel.getMcpCatalog(status.cwd, refresh));
      await loadMcpBackups();
    } catch (error) {
      mcpStatus.textContent = error instanceof Error ? error.message : '无法读取 MCP 配置。';
    } finally {
      mcpLoadPromise = undefined;
      mcpRefresh.disabled = false;
    }
  })();
  return mcpLoadPromise;
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

interface UpdateCenterItem {
  actionLabel: string;
  detail: string;
  disabled?: boolean;
  id: string;
  run: () => Promise<void>;
  title: string;
  version: string;
}

const updateCenterItems = (): UpdateCenterItem[] => {
  const items: UpdateCenterItem[] = [];
  if (softwareUpdates?.application.updateAvailable) {
    const updaterDisabled = applicationUpdaterState?.phase === 'disabled';
    items.push({
      actionLabel: applicationUpdaterState?.phase === 'downloaded' ? '重启并安装' : '下载更新',
      detail: softwareUpdates.application.message,
      disabled:
        updateCenterOperationInProgress ||
        updaterDisabled ||
        applicationUpdaterState?.phase === 'checking' ||
        applicationUpdaterState?.phase === 'downloading',
      id: 'application',
      run: runApplicationUpdateAction,
      title: 'ClaudeDock',
      version: `v${softwareUpdates.application.currentVersion ?? '未知'} → ${softwareUpdates.application.latestVersion ?? '未知'}`,
    });
  }
  if (softwareUpdates?.claudeCode.updateAvailable) {
    items.push({
      actionLabel: '更新',
      detail: softwareUpdates.claudeCode.message,
      disabled: updateCenterOperationInProgress || softwareUpdateInProgress,
      id: 'claude-code',
      run: runClaudeInstallUpdate,
      title: 'Claude Code',
      version: `v${softwareUpdates.claudeCode.currentVersion ?? '未知'} → ${softwareUpdates.claudeCode.latestVersion ?? '未知'}`,
    });
  }
  if (softwareUpdates?.router.updateAvailable) {
    const status = activeStatus();
    items.push({
      actionLabel: status ? '更新' : '先打开项目',
      detail: status
        ? softwareUpdates.router.message
        : `${softwareUpdates.router.message} 路由器操作需要一个已打开项目作为安全作用域。`,
      disabled: updateCenterOperationInProgress || routerOperationInProgress || !status,
      id: 'router',
      run: async () => {
        await runRouterOperation(
          (sessionId) => window.controlPanel.installClaudeRouterFromSource(sessionId, 'npm'),
          '正在更新…',
          installRouterButton,
        );
      },
      title: 'Claude Code Router',
      version: `v${softwareUpdates.router.currentVersion ?? '未知'} → ${softwareUpdates.router.latestVersion ?? '未知'}`,
    });
  }
  for (const plugin of pluginCatalog?.installed.filter(({ updateAvailable }) => updateAvailable) ??
    []) {
    items.push({
      actionLabel: '更新',
      detail: `${plugin.marketplaceName} · ${localizePluginCopy(plugin).description}`,
      disabled: updateCenterOperationInProgress || pluginMutationInProgress,
      id: `plugin:${plugin.pluginId}`,
      run: async () => {
        await runPluginMutation(
          () => window.controlPanel.updateClaudePlugin(plugin.pluginId),
          '正在更新…',
          updateAllPluginsButton,
        );
      },
      title: plugin.name,
      version: `v${plugin.version ?? '未知'} → ${plugin.latestVersion ?? '最新'}`,
    });
  }
  return items;
};

const renderUpdateCenter = (): void => {
  const items = updateCenterItems();
  updateCenterList.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement('article');
      row.className = 'update-center-item';
      row.dataset.updateId = item.id;
      const copy = document.createElement('div');
      copy.className = 'update-center-item__copy';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const version = document.createElement('span');
      version.textContent = item.version;
      const detail = document.createElement('small');
      detail.textContent = item.detail;
      copy.append(title, version, detail);
      const action = document.createElement('button');
      action.className = 'update-center-item__action';
      action.type = 'button';
      action.textContent = item.actionLabel;
      action.disabled = item.disabled === true;
      action.addEventListener('click', () => {
        void runUpdateCenterAction(item);
      });
      row.append(copy, action);
      return row;
    }),
  );
  updateCenterEmpty.hidden = items.length > 0;
  updateCenterSummary.textContent =
    items.length > 0 ? `共 ${items.length} 项可更新` : '全部项目均为当前可检测到的最新版本';
  updateCenterAllButton.hidden = items.length === 0;
  updateCenterAllButton.disabled =
    updateCenterOperationInProgress || items.every(({ disabled }) => disabled);
};

const runUpdateCenterAction = async (item: UpdateCenterItem): Promise<void> => {
  if (updateCenterOperationInProgress || item.disabled) return;
  updateCenterOperationInProgress = true;
  renderUpdateCenter();
  updateCenterDialog.close('start-update');
  openDownloadCenter();
  try {
    await item.run();
  } finally {
    updateCenterOperationInProgress = false;
    await loadSoftwareUpdates(true);
    renderUpdateCenter();
  }
};

const runAllUpdates = async (): Promise<void> => {
  if (updateCenterOperationInProgress) return;
  const actions = deriveUpdateActionState(softwareUpdates, pluginCatalog);
  const hasProject = Boolean(activeStatus());
  updateCenterOperationInProgress = true;
  renderUpdateCenter();
  updateCenterDialog.close('start-all-updates');
  openDownloadCenter();
  try {
    if (actions.application && applicationUpdaterState?.phase !== 'downloaded') {
      try {
        renderApplicationUpdater(await window.controlPanel.downloadApplicationUpdate());
      } catch (error) {
        showToast(error instanceof Error ? error.message : '无法下载 ClaudeDock 更新。', 'error');
      }
    }
    if (actions.claudeCode === 'update') await runClaudeInstallUpdate();
    if (actions.router === 'update' && hasProject) {
      await runRouterOperation(
        (sessionId) => window.controlPanel.installClaudeRouterFromSource(sessionId, 'npm'),
        '正在更新…',
        installRouterButton,
      );
    }
    if (actions.plugins) {
      await runPluginMutation(
        () => window.controlPanel.updateAllClaudePlugins(),
        '正在更新…',
        updateAllPluginsButton,
      );
    }
  } finally {
    updateCenterOperationInProgress = false;
    await loadSoftwareUpdates(true);
    renderUpdateCenter();
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
    const project = activeStatus();
    const results = await Promise.allSettled([
      loadSoftwareUpdates(manual),
      // Plugin update flags are only trustworthy after the local marketplace checkout is refreshed.
      // This remains a background CLI task on first load and only becomes user-visible through the
      // titlebar busy state.
      refreshPluginUpdates(),
      project ? loadMcpCatalog(true) : Promise.resolve(),
    ]);
    const pluginsOk = results[1]?.status === 'fulfilled' && results[1].value;
    const failedSources = results.filter(({ status }) => status === 'rejected').length;
    syncUpdateActionVisibility();
    if (manual) {
      const actions = deriveUpdateActionState(softwareUpdates, pluginCatalog);
      if (!pluginsOk || failedSources > 0) {
        showToast('全局检查已完成，但至少一个更新来源暂时不可用。', 'error');
      }
      renderUpdateCenter();
      if (!updateCenterDialog.open) updateCenterDialog.showModal();
      closeUpdateCenterButton.focus();
      if (pluginsOk && failedSources === 0) {
        showToast(
          actions.totalAvailable > 0
            ? `检查完成，发现 ${actions.totalAvailable} 项可更新。`
            : '检查完成，当前没有发现可用更新。',
        );
      }
    }
  } finally {
    updateRefreshInProgress = false;
    refreshUpdatesButton.disabled = false;
    refreshUpdatesButton.classList.remove('titlebar__refresh--busy');
    refreshUpdatesButton.setAttribute('aria-busy', 'false');
  }
};

const terminalStatusForSession = (sessionId: string): TerminalStatus | undefined =>
  workspaceState.sessions.find((status) => status.id === sessionId);

/**
 * An xterm instance is an ownership token for one exact PTY generation. Checking both map identity
 * and workspace status prevents an old event closure from targeting a replacement view or PTY.
 */
const ownsTerminalGeneration = (
  sessionId: string,
  ptyGeneration: PtyGeneration,
  view: TerminalView,
): boolean => {
  const status = terminalStatusForSession(sessionId);
  return (
    terminalViews.get(sessionId) === view &&
    view.ptyGeneration === ptyGeneration &&
    status?.ptyGeneration === ptyGeneration
  );
};

const writableTerminalGeneration = (
  sessionId: string,
  ptyGeneration: PtyGeneration,
  view: TerminalView,
): boolean =>
  ownsTerminalGeneration(sessionId, ptyGeneration, view) &&
  terminalStatusForSession(sessionId)?.phase === 'running';

const terminalViewForStatus = (status: TerminalStatus): TerminalView | undefined => {
  const view = terminalViews.get(status.id);
  return view && ownsTerminalGeneration(status.id, status.ptyGeneration, view) ? view : undefined;
};

const writeToTerminalGeneration = (
  sessionId: string,
  ptyGeneration: PtyGeneration,
  view: TerminalView,
  data: string,
): boolean => {
  if (!writableTerminalGeneration(sessionId, ptyGeneration, view)) {
    return false;
  }
  window.controlPanel.writeTerminal(sessionId, ptyGeneration, data);
  return true;
};

const pasteIntoTerminalGeneration = async (
  sessionId: string,
  ptyGeneration: PtyGeneration,
  view: TerminalView,
): Promise<void> => {
  if (!writableTerminalGeneration(sessionId, ptyGeneration, view)) {
    return;
  }
  const text = await window.controlPanel.readClipboardText();
  if (!writableTerminalGeneration(sessionId, ptyGeneration, view)) {
    return;
  }
  if (text) {
    writeToTerminalGeneration(sessionId, ptyGeneration, view, text.replace(/\r?\n/g, '\r'));
  }
  if (writableTerminalGeneration(sessionId, ptyGeneration, view)) {
    view.terminal.focus();
  }
};

const pasteIntoActiveTerminal = async (): Promise<void> => {
  const status = activeStatus();
  const view = status ? terminalViewForStatus(status) : undefined;
  if (!status || status.phase !== 'running' || !view) {
    return;
  }
  await pasteIntoTerminalGeneration(status.id, status.ptyGeneration, view);
};

const copyActiveTerminalSelection = async (): Promise<void> => {
  const terminal = terminalViews.get(workspaceState.activeSessionId)?.terminal;
  if (terminal?.hasSelection()) {
    await window.controlPanel.writeClipboardText(terminal.getSelection());
  }
  terminal?.focus();
};

interface ConfirmationRequest {
  confirmLabel?: string;
  message: string;
  title: string;
  tone?: 'danger' | 'default';
}

/**
 * Uses an in-page modal instead of `window.confirm`. Electron on Windows can lose the renderer's
 * DOM focus after a native JavaScript dialog closes, leaving both the composer and xterm's hidden
 * IME textarea unable to regain focus. A DOM `<dialog>` keeps focus ownership inside the page.
 */
const requestConfirmation = ({
  confirmLabel = '确认',
  message,
  title,
  tone = 'default',
}: ConfirmationRequest): Promise<boolean> => {
  if (confirmationDialog.open) {
    return Promise.resolve(false);
  }

  confirmationDialogTitle.textContent = title;
  confirmationDialogMessage.textContent = message;
  confirmationDialogConfirm.textContent = confirmLabel;
  confirmationDialog.dataset.tone = tone;
  confirmationDialog.returnValue = 'cancel';
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;

  return new Promise((resolve) => {
    const finish = (): void => {
      const confirmed = confirmationDialog.returnValue === 'confirm';
      resolve(confirmed);
      window.requestAnimationFrame(() => {
        const previouslyFocusedControl =
          previouslyFocused instanceof HTMLButtonElement ||
          previouslyFocused instanceof HTMLInputElement ||
          previouslyFocused instanceof HTMLSelectElement ||
          previouslyFocused instanceof HTMLTextAreaElement
            ? previouslyFocused
            : undefined;
        if (
          document.activeElement === document.body &&
          previouslyFocused?.isConnected &&
          !previouslyFocusedControl?.disabled
        ) {
          previouslyFocused.focus({ preventScroll: true });
        }
      });
    };
    confirmationDialog.addEventListener('close', finish, { once: true });
    try {
      confirmationDialog.showModal();
    } catch {
      confirmationDialog.removeEventListener('close', finish);
      resolve(false);
    }
  });
};

const hideTerminalContextMenu = (): void => {
  terminalContextMenu.hidden = true;
};

const hideConversationContextMenu = (): void => {
  conversationContextMenu.hidden = true;
  conversationContextTarget = undefined;
};

interface RenameDialogCopy {
  description: string;
  fieldLabel: string;
  title: string;
}

const requestRenamedValue = (
  currentValue: string,
  copy: RenameDialogCopy,
): Promise<string | null> =>
  new Promise((resolve) => {
    conversationRenameDialogTitle.textContent = copy.title;
    conversationRenameDialogDescription.textContent = copy.description;
    conversationRenameFieldLabel.textContent = copy.fieldLabel;
    conversationRenameInput.value = currentValue;
    conversationRenameDialog.returnValue = 'cancel';
    conversationRenameDialog.addEventListener(
      'close',
      () => {
        if (conversationRenameDialog.returnValue !== 'confirm') {
          resolve(null);
          return;
        }
        const title = conversationRenameInput.value.trim();
        resolve(title && title !== currentValue ? title : null);
      },
      { once: true },
    );
    conversationRenameDialog.showModal();
    window.setTimeout(() => {
      conversationRenameInput.focus();
      conversationRenameInput.select();
    });
  });

const requestConversationTitle = (
  currentTitle: string,
  historical: boolean,
): Promise<string | null> =>
  requestRenamedValue(currentTitle, {
    description: '名称会同步显示在项目列表和历史对话中。',
    fieldLabel: '对话名称',
    title: historical ? '重命名历史对话' : '重命名运行中对话',
  });

const requestConnectionHistoryName = (currentName: string): Promise<string | null> =>
  requestRenamedValue(currentName, {
    description: '名称只用于区分当前项目的连接历史，不会修改实际接口配置。',
    fieldLabel: '连接名称',
    title: '重命名连接',
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
  const deleteButton = conversationContextMenu.querySelector<HTMLButtonElement>(
    '[data-conversation-context-action="delete"]',
  );
  if (deleteButton) {
    deleteButton.hidden = target.kind !== 'history';
  }
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

const createTerminalView = (status: TerminalStatus, active: boolean): TerminalView => {
  const sessionId = status.id;
  const ptyGeneration = status.ptyGeneration;
  const container = document.createElement('div');
  container.className = active ? 'project-terminal project-terminal--active' : 'project-terminal';
  container.dataset.sessionId = sessionId;
  terminalStage.prepend(container);

  const terminal = new Terminal(buildTerminalOptions());
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

  const view: TerminalView = {
    container,
    fitAddon,
    outputPump: new TerminalOutputPump({
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      isCurrent: () => ownsTerminalGeneration(sessionId, ptyGeneration, view),
      onAppliedRevision: () => {
        reportTerminalPermissionMode(sessionId, view);
        answerReadyPermissionModeProbes(sessionId, view);
      },
      scheduleFrame: (callback) => window.requestAnimationFrame(callback),
      write: (data, callback) => terminal.write(data, callback),
    }),
    permissionModeProbes: [],
    ptyGeneration,
    terminal,
  };

  terminal.onData((data) => {
    writeToTerminalGeneration(sessionId, ptyGeneration, view, data);
  });

  terminal.attachCustomKeyEventHandler((event) => {
    if (!ownsTerminalGeneration(sessionId, ptyGeneration, view)) {
      return false;
    }
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
      void pasteIntoTerminalGeneration(sessionId, ptyGeneration, view);
      return false;
    }
    if (event.shiftKey && !event.ctrlKey && event.code === 'Enter') {
      writeToTerminalGeneration(sessionId, ptyGeneration, view, '\x0a');
      return false;
    }

    return true;
  });
  container.addEventListener('contextmenu', showTerminalContextMenu);

  terminalViews.set(sessionId, view);
  return view;
};

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
  if (!ownsTerminalGeneration(sessionId, view.ptyGeneration, view)) {
    return;
  }
  const mode = readTerminalPermissionMode(view);
  if (!mode || mode === view.observedPermissionMode) {
    return;
  }
  view.observedPermissionMode = mode;
  window.controlPanel.observeClaudePermissionMode(sessionId, view.ptyGeneration, mode);
};

const answerReadyPermissionModeProbes = (sessionId: string, view: TerminalView): void => {
  if (!ownsTerminalGeneration(sessionId, view.ptyGeneration, view)) {
    return;
  }
  const ready = view.permissionModeProbes.filter(
    (probe) =>
      probe.ptyGeneration === view.ptyGeneration &&
      probe.requiredRevision <= view.outputPump.appliedRevision,
  );
  if (ready.length === 0) {
    return;
  }
  view.permissionModeProbes = view.permissionModeProbes.filter(
    (probe) =>
      probe.ptyGeneration !== view.ptyGeneration ||
      probe.requiredRevision > view.outputPump.appliedRevision,
  );
  const mode = readTerminalPermissionMode(view);
  for (const { probeId, ptyGeneration } of ready) {
    window.controlPanel.reportClaudePermissionModeProbe(sessionId, ptyGeneration, probeId, mode);
  }
};

const rejectPermissionModeProbes = (sessionId: string, view: TerminalView): void => {
  for (const { probeId, ptyGeneration } of view.permissionModeProbes) {
    window.controlPanel.reportClaudePermissionModeProbe(sessionId, ptyGeneration, probeId);
  }
  view.permissionModeProbes.length = 0;
};

/**
 * Output is admitted into the exact generation's lossless pump. The pump coalesces work per frame,
 * bounds each xterm parse quantum, and never starts another write until xterm acknowledges this one.
 */
const queueTerminalOutput = (
  sessionId: string,
  ptyGeneration: PtyGeneration,
  data: string,
): void => {
  const view = terminalViews.get(sessionId);
  if (!view || !ownsTerminalGeneration(sessionId, ptyGeneration, view)) {
    return;
  }
  view.outputPump.enqueue(data);
};

const disposeTerminalView = (sessionId: string, view: TerminalView): void => {
  if (terminalViews.get(sessionId) === view) {
    terminalViews.delete(sessionId);
  }
  view.outputPump.dispose();
  rejectPermissionModeProbes(sessionId, view);
  const mask = terminalMasks.get(sessionId);
  if (mask?.view === view) {
    mask.overlay.remove();
    terminalMasks.delete(sessionId);
  }
  view.terminal.dispose();
  view.container.remove();
};

const ensureTerminalView = (status: TerminalStatus, active: boolean): TerminalView => {
  const existing = terminalViews.get(status.id);
  if (existing?.ptyGeneration === status.ptyGeneration) {
    return existing;
  }
  if (existing) {
    disposeTerminalView(status.id, existing);
  }
  return createTerminalView(status, active);
};

const fitActiveTerminal = (): boolean => {
  const sessionId = workspaceState.activeSessionId;
  const view = terminalViews.get(sessionId);
  if (!view) {
    return false;
  }
  const ptyGeneration = view.ptyGeneration;
  const bounds = view.container.getBoundingClientRect();
  if (
    !ownsTerminalGeneration(sessionId, ptyGeneration, view) ||
    !view.container.isConnected ||
    !view.container.classList.contains('project-terminal--active') ||
    bounds.width < 1 ||
    bounds.height < 1
  ) {
    return false;
  }

  try {
    view.fitAddon.fit();
    if (!ownsTerminalGeneration(sessionId, ptyGeneration, view)) {
      return false;
    }
    window.controlPanel.resizeTerminal(
      sessionId,
      ptyGeneration,
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
const retryTerminalFitUntilMeasured = (): void => {
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

const TERMINAL_FIT_DEBOUNCE_MS = 100;
let terminalFitDebounceTimer: number | undefined;
let terminalFitDirty = false;
let isDraggingLayout = false;

const flushDebouncedTerminalFit = (): void => {
  if (terminalFitDebounceTimer !== undefined) {
    window.clearTimeout(terminalFitDebounceTimer);
    terminalFitDebounceTimer = undefined;
  }
  if (!terminalFitDirty || isDraggingLayout) {
    return;
  }
  terminalFitDirty = false;
  fitActiveTerminal();
};

const debounceTerminalFit = (): void => {
  terminalFitDirty = true;
  if (isDraggingLayout) {
    return;
  }
  if (terminalFitDebounceTimer !== undefined) {
    window.clearTimeout(terminalFitDebounceTimer);
  }
  terminalFitDebounceTimer = window.setTimeout(flushDebouncedTerminalFit, TERMINAL_FIT_DEBOUNCE_MS);
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
  debounceTerminalFit();
};

const setDrawerWidth = (value: number): void => {
  const minimum = window.innerWidth <= 900 ? 320 : 360;
  const width = clamp(value, minimum, Math.max(minimum, Math.min(760, window.innerWidth - 140)));
  document.documentElement.style.setProperty('--drawer-w', `${width}px`);
  localStorage.setItem('claudedock.drawerWidth', String(width));
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
    isDraggingLayout = true;
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
          isDraggingLayout = false;
          flushDebouncedTerminalFit();
        }
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
 * the transcript. It is a throwaway element positioned over the textarea, so it never affects
 * layout, and it is skipped entirely when the user has asked for reduced motion. Both the terminal
 * and chat composers call this, so the two surfaces confirm a send the same way.
 */
const playSendAnimation = (
  text: string,
  source: HTMLTextAreaElement = composerInput,
  variant: 'terminal' | 'chat' = 'terminal',
): void => {
  const trimmed = text.trim();
  if (!trimmed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  const rect = source.getBoundingClientRect();
  const bubble = document.createElement('div');
  bubble.className =
    variant === 'chat' ? 'composer-send-bubble composer-send-bubble--chat' : 'composer-send-bubble';
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
  const view = status ? terminalViewForStatus(status) : undefined;
  if (!status || status.phase !== 'running' || !view) {
    showToast('终端还没有运行，无法发送。', 'error');
    return;
  }
  const ptyGeneration = status.ptyGeneration;

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
  void writeTerminalSubmission(
    submission,
    (data) => {
      writeToTerminalGeneration(status.id, ptyGeneration, view, data);
    },
    // The session can be closed, stopped or replaced during the gap between the two writes.
    () => writableTerminalGeneration(status.id, ptyGeneration, view),
  );

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
    const view = status ? terminalViewForStatus(status) : undefined;
    if (
      status?.phase === 'running' &&
      view &&
      writeToTerminalGeneration(status.id, status.ptyGeneration, view, '\x1b[Z')
    ) {
      event.preventDefault();
    }
  }
});

composerInput.addEventListener('input', () => {
  composerHistory = resetBrowsing(composerHistory);
  resizeComposer();
});

/*
 * Claude Code names a conversation after its first prompt, so the real title arrives mid-session
 * through the statusLine sync. Instead of snapping, the old label is erased character by character
 * and the new one typed in behind a blinking caret. The state machine lives outside the DOM because
 * the sidebar is rebuilt on every workspace tick — each rebuild re-reads the animation's current
 * frame, and each timer tick patches the live elements in place between rebuilds.
 */
interface TitleAnimationState {
  chars: string[];
  keep: number;
  phase: 'erasing' | 'typing';
  target: string[];
  timer: number;
}

const TITLE_ERASE_MS = 24;
const TITLE_TYPE_MS = 44;
const TITLE_PHASE_PAUSE_MS = 200;

const titleAnimations = new Map<string, TitleAnimationState>();
const renderedConversationTitles = new Map<string, string>();
/** Manual renames land instantly — the typewriter is reserved for titles Claude produced. */
const suppressedTitleAnimations = new Set<string>();

const displayedConversationTitle = (status: TerminalStatus): string => {
  const animation = titleAnimations.get(status.id);
  return animation ? animation.chars.join('') : status.title;
};

const isTitleAnimating = (sessionId: string): boolean => titleAnimations.has(sessionId);

const applyAnimatedTitleFrame = (sessionId: string): void => {
  const status = workspaceState.sessions.find((session) => session.id === sessionId);
  if (!status) {
    return;
  }
  const text = displayedConversationTitle(status);
  const typing = String(isTitleAnimating(sessionId));
  const label = projectList.querySelector<HTMLElement>(
    `.conversation-item[data-session-id="${CSS.escape(sessionId)}"] .conversation-item__label`,
  );
  if (label) {
    label.textContent = text;
    label.dataset.titleTyping = typing;
  }
  if (sessionId === workspaceState.activeSessionId) {
    const scoped = `${projectNameFromPath(status.cwd)} · ${text}`;
    terminalProject.textContent = scoped;
    terminalProject.dataset.titleTyping = typing;
    workbenchScope.textContent = scoped;
    workbenchScope.dataset.titleTyping = typing;
  }
};

const cancelTitleAnimation = (sessionId: string): void => {
  const animation = titleAnimations.get(sessionId);
  if (!animation) {
    return;
  }
  window.clearTimeout(animation.timer);
  titleAnimations.delete(sessionId);
};

const stepTitleAnimation = (sessionId: string): void => {
  const animation = titleAnimations.get(sessionId);
  if (!animation) {
    return;
  }

  let delay: number;
  if (animation.phase === 'erasing') {
    if (animation.chars.length > animation.keep) {
      animation.chars.pop();
      delay = TITLE_ERASE_MS;
    } else {
      animation.phase = 'typing';
      delay = TITLE_PHASE_PAUSE_MS;
    }
  } else if (animation.chars.length < animation.target.length) {
    animation.chars.push(animation.target[animation.chars.length] ?? '');
    // Slightly uneven keystrokes read as typing rather than a mechanical ticker.
    delay = TITLE_TYPE_MS + Math.random() * 42;
  } else {
    cancelTitleAnimation(sessionId);
    applyAnimatedTitleFrame(sessionId);
    return;
  }

  applyAnimatedTitleFrame(sessionId);
  animation.timer = window.setTimeout(() => {
    stepTitleAnimation(sessionId);
  }, delay);
};

const startTitleAnimation = (sessionId: string, fromTitle: string, toTitle: string): void => {
  const existing = titleAnimations.get(sessionId);
  // A retarget mid-animation continues from whatever is on screen right now.
  const chars = existing ? existing.chars : [...fromTitle];
  if (existing) {
    window.clearTimeout(existing.timer);
  }

  const target = [...toTitle];
  let keep = 0;
  while (keep < chars.length && keep < target.length && chars[keep] === target[keep]) {
    keep += 1;
  }

  const animation: TitleAnimationState = {
    chars,
    keep,
    phase: chars.length > keep ? 'erasing' : 'typing',
    target,
    timer: 0,
  };
  titleAnimations.set(sessionId, animation);
  animation.timer = window.setTimeout(() => {
    stepTitleAnimation(sessionId);
  }, TITLE_ERASE_MS);
};

const syncConversationTitles = (state: WorkspaceState): void => {
  const validSessionIds = new Set(state.sessions.map((session) => session.id));
  for (const sessionId of [...renderedConversationTitles.keys()]) {
    if (!validSessionIds.has(sessionId)) {
      renderedConversationTitles.delete(sessionId);
      suppressedTitleAnimations.delete(sessionId);
      cancelTitleAnimation(sessionId);
    }
  }

  for (const status of state.sessions) {
    const previous = renderedConversationTitles.get(status.id);
    renderedConversationTitles.set(status.id, status.title);
    if (previous === undefined || previous === status.title) {
      continue;
    }
    if (
      suppressedTitleAnimations.delete(status.id) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      cancelTitleAnimation(status.id);
      continue;
    }
    startTitleAnimation(status.id, previous, status.title);
  }
};

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
  const displayedTitle = displayedConversationTitle(status);
  const scopedTitle = `${projectNameFromPath(status.cwd)} · ${displayedTitle}`;
  const typing = String(isTitleAnimating(status.id));
  terminalProject.textContent = scopedTitle;
  terminalProject.dataset.titleTyping = typing;
  terminalProject.title = status.cwd;
  workbenchScope.textContent = scopedTitle;
  workbenchScope.dataset.titleTyping = typing;
  runtimePicker.disabled = false;
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
  terminalProject.dataset.titleTyping = 'false';
  workbenchScope.textContent = '未打开项目';
  workbenchScope.dataset.titleTyping = 'false';
  workbenchTabs.hidden = false;
  workbenchTitle.textContent = 'Claude 工作台';
  workbenchTriggerLabel.textContent = 'Claude 工作台';
  workbenchTrigger.title = 'Claude 工作台';
  claudeWorkbench.setAttribute('aria-label', 'Claude 可视化工作台');
  setWorkbenchOpen(false);
  runtimePicker.disabled = true;
  runtimeClaude.checked = true;
  runtimeCodex.checked = false;
  document.body.dataset.agentRuntime = 'claude';
  setComposerEnabled(false);
  runtimeActivityTrigger.hidden = true;
  runtimeActivityPanel.hidden = true;
};

const activateProject = async (sessionId: string): Promise<void> => {
  const result = await window.controlPanel.activateProject(sessionId);
  if (!result.ok) {
    showToast(result.error ?? '无法切换对话。', 'error');
    return;
  }
  renderWorkspace(result.state);
  retryTerminalFitUntilMeasured();
  requestComposerFocus(result.state.activeSessionId);
};

/**
 * Closing a running conversation is an archive, not a deletion: the terminal process stops, and the
 * conversation itself stays on disk under 历史对话. The folder is expanded and its history re-read
 * afterwards so the row visibly lands there instead of appearing to vanish.
 */
const closeProject = async (status: TerminalStatus): Promise<void> => {
  if (
    status.phase === 'running' &&
    !(await requestConfirmation({
      confirmLabel: '关闭并归档',
      message: `“${status.title}”还在运行。关闭会先停止它的终端进程，对话本身会归档到“历史对话”，随时可以恢复。`,
      title: '关闭正在运行的对话',
      tone: 'default',
    }))
  ) {
    return;
  }

  const projectPath = status.cwd;
  const result = await window.controlPanel.closeProject(status.id);
  if (!result.ok) {
    showToast(result.error ?? '无法关闭这个对话。', 'error');
    return;
  }
  renderWorkspace(result.state);
  expandedFolders.add(projectPath.toLowerCase());
  await loadFolderHistory(projectPath, true);
  showToast(`已关闭“${status.title}”，可在历史对话中恢复`);
};

const openConversation = async (projectPath: string): Promise<void> => {
  const result = await window.controlPanel.openConversation(projectPath);
  renderWorkspace(result.state);
  if (!result.ok) {
    showToast(result.error ?? '无法新建对话。', 'error');
    return;
  }
  showToast(`已在 ${projectNameFromPath(projectPath)} 新开一个对话`);
  retryTerminalFitUntilMeasured();
  requestComposerFocus(result.state.activeSessionId);
};

const renameConversation = async (status: TerminalStatus): Promise<void> => {
  const nextTitle = await requestConversationTitle(status.title, false);
  if (!nextTitle) {
    return;
  }
  suppressedTitleAnimations.add(status.id);
  const result = await window.controlPanel.renameConversation(status.id, nextTitle);
  renderWorkspace(result.state);
  suppressedTitleAnimations.delete(status.id);
  if (!result.ok) {
    showToast(result.error ?? '无法重命名这个对话。', 'error');
    return;
  }
  showToast(`对话已重命名为“${nextTitle}”`);
};

const closeProjectFolder = async (project: WorkspaceProjectView): Promise<void> => {
  if (
    project.sessionIds.length > 0 &&
    !(await requestConfirmation({
      confirmLabel: '关闭并归档',
      message: `关闭“${project.name}”的全部 ${project.sessionIds.length} 个对话？终端会停止，对话会归档到“历史对话”。`,
      title: '关闭项目对话',
      tone: 'danger',
    }))
  ) {
    return;
  }
  const result = await window.controlPanel.closeProjectFolder(project.path);
  renderWorkspace(result.state);
  if (!result.ok) {
    showToast(result.error ?? '无法关闭这个项目。', 'error');
    return;
  }
  expandedFolders.add(project.path.toLowerCase());
  await loadFolderHistory(project.path, true);
  showToast(`已关闭 ${project.name}，对话已归档到历史记录`);
};

const forgetProject = async (project: WorkspaceProjectView): Promise<void> => {
  if (
    !(await requestConfirmation({
      confirmLabel: '从列表移除',
      message: `把“${project.name}”从列表中移除？磁盘上的文件不会被删除。`,
      title: '移除项目',
      tone: 'danger',
    }))
  ) {
    return;
  }
  const result = await window.controlPanel.forgetProject(project.path);
  renderWorkspace(result.state);
  if (!result.ok) {
    showToast(result.error ?? '无法移除这个项目。', 'error');
    return;
  }
  const key = project.path.toLowerCase();
  folderHistoryLoads.invalidate(key);
  storedConversations.delete(key);
  expandedFolders.delete(key);
  historyScrollPositions.delete(key);
  showToast(`已从列表中移除 ${project.name}`);
};

const workspaceContainsProject = (projectKey: string): boolean =>
  workspaceState.projects.some((project) => project.path.toLowerCase() === projectKey);

/** Loads a folder's Claude conversation history without requiring a live terminal for it. */
async function loadFolderHistory(projectPath: string, force = false): Promise<void> {
  const key = projectPath.toLowerCase();
  if (!force && storedConversations.has(key)) {
    return;
  }
  const token = folderHistoryLoads.request(key, force);
  if (!token) {
    return;
  }

  try {
    const conversations = await window.controlPanel.getClaudeSessionsForPath(projectPath);
    if (!folderHistoryLoads.isCurrent(token) || !workspaceContainsProject(key)) {
      return;
    }
    storedConversations.set(key, conversations);
    renderProjectList();
  } catch {
    if (folderHistoryLoads.isCurrent(token) && workspaceContainsProject(key)) {
      storedConversations.set(key, []);
    }
  } finally {
    const completion = folderHistoryLoads.finish(token);
    if (completion.current && completion.reloadRequested && workspaceContainsProject(key)) {
      void loadFolderHistory(projectPath, true);
    }
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

const deleteStoredConversation = async (
  projectPath: string,
  session: ClaudeSessionMetadata,
): Promise<void> => {
  const title = session.sessionName || session.sessionId.slice(0, 8);
  if (
    !(await requestConfirmation({
      confirmLabel: '永久删除',
      message: `永久删除历史对话“${title}”？此操作无法撤销；如果该对话仍在运行，会先关闭对应终端。`,
      title: '删除历史对话',
      tone: 'danger',
    }))
  ) {
    return;
  }

  try {
    const result = await window.controlPanel.deleteClaudeSession(projectPath, session.sessionId);
    renderWorkspace(result.state);
    if (!result.ok || !result.deleted) {
      throw new Error(result.error ?? '历史对话文件已不存在或无法删除。');
    }
    await loadFolderHistory(projectPath, true);
    showToast(`已删除历史对话“${title}”`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '无法删除这个历史对话。', 'error');
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
  label.textContent = displayedConversationTitle(status);
  label.dataset.titleTyping = String(isTitleAnimating(status.id));

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
  closeButton.title = `关闭并归档 ${status.title}`;
  closeButton.setAttribute('aria-label', `关闭对话 ${status.title}，归档到历史对话`);
  closeButton.addEventListener('click', () => {
    void closeProject(status);
  });

  row.append(selectButton, renameButton, closeButton);
  return row;
};

const renderHistoryRow = (projectPath: string, session: ClaudeSessionMetadata): HTMLElement => {
  const row = document.createElement('div');
  row.className = 'history-item';
  row.setAttribute('role', 'listitem');
  row.title = `恢复或删除历史对话：${session.sessionId}`;
  const selectButton = document.createElement('button');
  selectButton.className = 'history-item__select';
  selectButton.type = 'button';
  selectButton.setAttribute(
    'aria-label',
    `恢复历史对话 ${session.sessionName || session.sessionId.slice(0, 8)}`,
  );

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

  selectButton.append(icon, label, time);
  selectButton.addEventListener('click', () => {
    void resumeStoredConversation(projectPath, session);
  });
  const deleteButton = document.createElement('button');
  deleteButton.className = 'history-item__delete';
  deleteButton.type = 'button';
  deleteButton.textContent = '×';
  deleteButton.title = '删除历史对话';
  deleteButton.setAttribute(
    'aria-label',
    `删除历史对话 ${session.sessionName || session.sessionId.slice(0, 8)}`,
  );
  deleteButton.addEventListener('click', () => {
    void deleteStoredConversation(projectPath, session);
  });
  row.append(selectButton, deleteButton);
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
  /*
   * Expansion only governs the history section. Running conversations always stay visible, so a
   * folder that is in use can still be collapsed — collapsing it tucks the history away and keeps
   * the live rows. Before, an active folder was forced open and its disclosure did nothing.
   */
  const expanded = expandedFolders.has(key);
  const showsRunning = sessions.length > 0;

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

  if (!expanded && !showsRunning) {
    return folder;
  }

  const body = document.createElement('div');
  body.className = 'project-folder__body';

  for (const session of sessions) {
    body.append(renderConversationRow(session));
  }

  if (!expanded) {
    // Collapsed while in use: live conversations stay, the history section is tucked away.
    folder.append(body);
    return folder;
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

    // Running conversations above stay put; only the history list itself scrolls.
    const scroller = document.createElement('div');
    scroller.className = 'project-folder__history';
    scroller.setAttribute('role', 'list');
    scroller.setAttribute('aria-label', `${project.name} 的历史对话`);
    for (const session of history) {
      scroller.append(renderHistoryRow(project.path, session));
    }
    const savedScroll = historyScrollPositions.get(key) ?? 0;
    if (savedScroll > 0) {
      // The list is rebuilt on every workspace tick; restore after it has a layout box.
      requestAnimationFrame(() => {
        scroller.scrollTop = savedScroll;
      });
    }
    scroller.addEventListener('scroll', () => {
      historyScrollPositions.set(key, scroller.scrollTop);
    });
    body.append(scroller);
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
  const previousActiveSessionId = workspaceState.activeSessionId;
  const nextActiveStatus = state.sessions.find((status) => status.id === state.activeSessionId);
  const activeViewAlreadyExists =
    nextActiveStatus !== undefined &&
    terminalViews.get(nextActiveStatus.id)?.ptyGeneration === nextActiveStatus.ptyGeneration;
  syncConversationTitles(state);
  const validSessionIds = new Set(state.sessions.map((status) => status.id));
  const releasedClaudeLaunches = new Set<string>();
  const releasedCodexLaunches = new Set<string>();
  for (const status of state.sessions) {
    const release = claudeLaunchAttempts.observeTerminal(status);
    if (release) {
      releasedClaudeLaunches.add(release.token.sessionId);
    }
    if (
      (status.phase === 'error' || status.phase === 'stopped') &&
      codexLaunchAttempts.invalidate(status.id)
    ) {
      releasedCodexLaunches.add(status.id);
    }
  }
  for (const release of claudeLaunchAttempts.prune(validSessionIds)) {
    releasedClaudeLaunches.add(release.token.sessionId);
  }
  for (const token of codexLaunchAttempts.prune(validSessionIds)) {
    releasedCodexLaunches.add(token.sessionId);
  }
  claudeSpeedOperations.prune(validSessionIds);
  claudeStateLoadGenerations.prune(validSessionIds);
  codexStateLoadGenerations.prune(validSessionIds);
  runtimeStateLoadGenerations.prune(validSessionIds);
  if (codexAutoLaunchSessionId && !validSessionIds.has(codexAutoLaunchSessionId)) {
    codexAutoLaunchSessionId = '';
  }
  workspaceState = state;
  if (
    pendingComposerFocusSessionId &&
    (pendingComposerFocusSessionId !== state.activeSessionId ||
      !validSessionIds.has(pendingComposerFocusSessionId))
  ) {
    pendingComposerFocusSessionId = '';
  }

  for (const status of state.sessions) {
    const active = status.id === state.activeSessionId;
    const view = ensureTerminalView(status, active);
    view.container.classList.toggle('project-terminal--active', active);
  }

  for (const [sessionId, view] of terminalViews) {
    if (!validSessionIds.has(sessionId)) {
      disposeTerminalView(sessionId, view);
    }
  }
  for (const sessionId of claudeStates.keys()) {
    if (!validSessionIds.has(sessionId)) {
      claudeStates.delete(sessionId);
      automaticConnectionTestSessions.delete(sessionId);
      effortRecoveryNotifications.delete(sessionId);
    }
  }
  for (const sessionId of codexStates.keys()) {
    if (!validSessionIds.has(sessionId)) {
      codexStates.delete(sessionId);
    }
  }
  for (const sessionId of developmentRuntimeStates.keys()) {
    if (!validSessionIds.has(sessionId)) {
      developmentRuntimeStates.delete(sessionId);
    }
  }

  renderProjectList();
  const status = activeStatus();
  if (status) {
    renderActiveStatus(status);
    if (releasedClaudeLaunches.has(status.id) && activeDevelopmentRuntime() === 'claude') {
      refreshClaudeLaunchControls(status.id);
    }
    if (releasedCodexLaunches.has(status.id) && activeDevelopmentRuntime() === 'codex') {
      const latest = codexStates.get(status.id);
      if (latest) {
        renderCodexState(latest, false);
      }
    }
  } else {
    renderNoActiveSession();
  }
  flushPendingComposerFocus();
  if (state.activeSessionId !== lastClaudeSessionId) {
    lastClaudeSessionId = state.activeSessionId;
    configFormSessionId = '';
    connectionEnvironmentReady = false;
    providerGroupExpansionPending = selectedRailTab === 'connection';
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
    const knownRuntimeState = developmentRuntimeStates.get(state.activeSessionId);
    if (knownRuntimeState) {
      renderDevelopmentRuntimeState(knownRuntimeState, false);
    } else if (state.activeSessionId) {
      void loadDevelopmentRuntime(state.activeSessionId);
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
  if (
    state.activeSessionId &&
    (state.activeSessionId !== previousActiveSessionId || !activeViewAlreadyExists)
  ) {
    retryTerminalFitUntilMeasured();
  }
  renderRuntimeActivity(runtimeActivityStates.get(state.activeSessionId));
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
      retryTerminalFitUntilMeasured();
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
  if (!status || claudeLaunchAttempts.isBusy(status.id)) {
    return;
  }

  // Capture the lifecycle baseline and paint the busy state before the first await, including when
  // the renderer has not loaded a ClaudeProjectState for this session yet.
  const attempt = beginClaudeLaunchAttempt(status);
  const outcome = await orchestrateClaudeLaunchAttempt({
    applyResult: (result) =>
      renderClaudeLaunchResult(attempt, result.state, result.ok ? 'success' : 'failure'),
    onRelease: () => refreshClaudeLaunchControls(attempt.sessionId),
    prepare: () => terminalViews.get(status.id)?.terminal.clear(),
    registry: claudeLaunchAttempts,
    start: () => window.controlPanel.launchClaude(status.id, mode),
    token: attempt,
  });
  if (outcome.status === 'rejected') {
    showToast('无法启动 Claude Code。', 'error');
    return;
  }
  if (outcome.status !== 'resolved') {
    return;
  }

  const { result } = outcome;
  if (!result.ok) {
    failClaudeLaunchAttempt(attempt);
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
};

const launchCodex = async (mode: CodexLaunchMode): Promise<void> => {
  const status = activeStatus();
  if (!status || codexLaunchAttempts.isActive(status.id) || codexOperationInProgress) {
    return;
  }
  const attempt = codexLaunchAttempts.begin(status.id);
  const existingState = codexStates.get(status.id);
  if (existingState) {
    renderCodexState(existingState, false);
  }
  try {
    if (!codexLaunchAttempts.isCurrent(attempt)) {
      return;
    }
    terminalViews.get(status.id)?.terminal.clear();
    if (!codexLaunchAttempts.isCurrent(attempt)) {
      return;
    }
    const result = await window.controlPanel.launchCodex(status.id, mode);
    if (!codexLaunchAttempts.isCurrent(attempt) || result.state.sessionId !== attempt.sessionId) {
      return;
    }
    renderCodexState(result.state);
    if (!result.ok) {
      showToast(result.error ?? '无法启动 Codex。', 'error');
      return;
    }
    showToast(
      mode === 'new'
        ? `已在 ${projectNameFromPath(status.cwd)} 启动 Codex`
        : mode === 'continue'
          ? '正在续接当前项目最近的 Codex 会话'
          : '已打开 Codex 历史会话选择器',
    );
    if (mode === 'resume') {
      terminalViews.get(status.id)?.terminal.focus();
    } else {
      requestComposerFocus(status.id);
    }
  } catch {
    if (codexLaunchAttempts.isCurrent(attempt)) {
      showToast('无法启动 Codex。', 'error');
    }
  } finally {
    if (codexLaunchAttempts.finish(attempt)) {
      const latest = codexStates.get(status.id);
      if (latest) {
        renderCodexState(latest, false);
      }
    }
  }
};

const installOrUpdateCodex = async (): Promise<CodexProjectState | undefined> => {
  const status = activeStatus();
  if (!status || codexOperationInProgress) {
    return undefined;
  }
  codexOperationInProgress = true;
  const existing = codexStates.get(status.id);
  if (existing) {
    renderCodexState(existing, false);
  }
  try {
    const result = await window.controlPanel.installOrUpdateCodex(status.id);
    renderCodexState(result.state);
    if (!result.ok) {
      showToast(result.error ?? 'Codex 安装失败。', 'error');
      return undefined;
    }
    showToast(`Codex CLI ${result.state.installation.version ?? ''} 已就绪。`);
    return result.state;
  } catch {
    showToast('Codex 安装失败，请检查网络后重试。', 'error');
    return undefined;
  } finally {
    codexOperationInProgress = false;
    const latest = codexStates.get(status.id);
    if (latest) {
      renderCodexState(latest, false);
    }
  }
};

const startCodexLogin = async (
  method: CodexLoginMethod,
  launchAfterLogin: boolean,
): Promise<void> => {
  const status = activeStatus();
  if (!status || codexOperationInProgress) {
    return;
  }
  codexOperationInProgress = true;
  if (launchAfterLogin) {
    codexAutoLaunchSessionId = status.id;
  }
  const existing = codexStates.get(status.id);
  if (existing) {
    renderCodexState(existing, false);
  }
  try {
    const result = await window.controlPanel.startCodexLogin(status.id, method);
    renderCodexState(result.state);
    if (!result.ok) {
      codexAutoLaunchSessionId = '';
      showToast(result.error ?? '无法启动 ChatGPT 登录。', 'error');
      return;
    }
    showToast(
      method === 'device-code'
        ? '浏览器已打开，请输入工作台中显示的设备验证码。'
        : '浏览器已打开；登录完成后会自动回到当前项目。',
    );
  } catch {
    codexAutoLaunchSessionId = '';
    showToast('无法启动 ChatGPT 登录。', 'error');
  } finally {
    codexOperationInProgress = false;
    const latest = codexStates.get(status.id);
    if (latest) {
      renderCodexState(latest, false);
      if (
        codexAutoLaunchSessionId === latest.sessionId &&
        latest.account &&
        latest.sessionId === workspaceState.activeSessionId &&
        activeDevelopmentRuntime() === 'codex'
      ) {
        codexAutoLaunchSessionId = '';
        void launchCodex('new');
      }
    }
  }
};

const prepareAndLaunchCodex = async (): Promise<void> => {
  const status = activeStatus();
  if (!status || codexOperationInProgress || codexLaunchAttempts.isActive(status.id)) {
    return;
  }
  let state = codexStates.get(status.id);
  if (!state) {
    state = await loadCodexState(status.id, '无法读取 Codex 环境。');
    if (!state) {
      return;
    }
  }
  if (!state.installation.installed) {
    state = await installOrUpdateCodex();
    if (!state) {
      return;
    }
  }
  if (state.requiresOpenaiAuth && !state.account) {
    await startCodexLogin('browser', true);
    return;
  }
  await launchCodex('new');
};

const switchDevelopmentRuntime = async (runtime: DevelopmentRuntime): Promise<void> => {
  const status = activeStatus();
  if (!status || runtimePicker.disabled) {
    return;
  }
  runtimePicker.disabled = true;
  try {
    const state = await window.controlPanel.setDevelopmentRuntime(status.id, runtime);
    const normalizedCwd = state.cwd.toLocaleLowerCase();
    for (const session of workspaceState.sessions) {
      if (session.cwd.toLocaleLowerCase() === normalizedCwd) {
        runtimeStateLoadGenerations.invalidate(session.id);
        developmentRuntimeStates.set(session.id, {
          ...state,
          sessionId: session.id,
        });
      }
    }
    renderDevelopmentRuntimeState({
      ...state,
      sessionId: status.id,
    });
    if (runtime === 'codex') {
      await loadCodexState(status.id);
      setWorkbenchOpen(true);
    } else {
      await loadClaudeState(status.id);
    }
    await window.controlPanel.invalidateNetworkPreflight('provider-switch');
    void runActiveNetworkPreflight(true);
    showToast(runtime === 'codex' ? '当前项目已切换到 Codex。' : '当前项目已切换到 Claude Code。');
  } catch (error) {
    const current = developmentRuntimeStates.get(status.id)?.runtime ?? 'claude';
    runtimeClaude.checked = current === 'claude';
    runtimeCodex.checked = current === 'codex';
    showToast(error instanceof Error ? error.message : '无法切换开发引擎。', 'error');
  } finally {
    runtimePicker.disabled = false;
  }
};

const currentConfigInput = (
  credentialAction: SaveClaudeConfigInput['credentialAction'],
): SaveClaudeConfigInput => {
  const preset = claudePreset.value as ClaudePreset;
  const protocol: ConfigurableEndpointProtocol =
    preset === 'custom' ? (claudeProtocol.value as ConfigurableEndpointProtocol) : 'anthropic';
  const baseUrl =
    preset === 'custom' && claudeBaseUrl.value.trim()
      ? resolveConnectionAddress(claudeBaseUrl.value, protocol)
      : claudeBaseUrl.value;
  if (preset === 'custom') {
    claudeBaseUrl.value = baseUrl;
  }
  return {
    apiKeyHelperPolicy:
      claudeApiKeyHelperPolicy.value as SaveClaudeConfigInput['apiKeyHelperPolicy'],
    authMode: claudeAuthMode.value as SaveClaudeConfigInput['authMode'],
    baseUrl,
    credential: claudeCredential.value,
    credentialAction,
    model: claudeModel.value,
    modelFast: claudeModelFast.value,
    preset,
    protocol,
    provider: providerForPreset(preset),
    routerProviderId: protocol === 'openai' ? selectedRouterProviderId : undefined,
  };
};

const completeVisibleConnectionEndpoint = (reportError: boolean): void => {
  if (claudePreset.value !== 'custom' || !claudeBaseUrl.value.trim()) {
    claudeBaseUrl.setCustomValidity('');
    return;
  }
  try {
    claudeBaseUrl.value = resolveConnectionAddress(
      claudeBaseUrl.value,
      claudeProtocol.value as ConfigurableEndpointProtocol,
    );
    claudeBaseUrl.setCustomValidity('');
  } catch (error) {
    claudeBaseUrl.setCustomValidity(
      error instanceof Error ? error.message : '无法识别这个接口地址。',
    );
    if (reportError) {
      claudeBaseUrl.reportValidity();
    }
  }
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
      } catch (error) {
        showToast(error instanceof Error ? error.message : '无法保存接入配置。', 'error');
        return false;
      }
    })) ?? false
  );
};

const presetLabel = (preset: ClaudePreset): string =>
  findClaudeProvider(preset)?.label ?? '自定义中转站接口';

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

const historyDisplayName = (entry: ClaudeConnectionHistoryEntry): string => {
  if (entry.name) {
    return entry.name;
  }
  if (entry.preset === 'custom' || entry.preset === 'gateway') {
    try {
      return (
        new URL(entry.sourceBaseUrl || entry.baseUrl || entry.gatewayEndpoint || '').host ||
        presetLabel(entry.preset)
      );
    } catch {
      return presetLabel(entry.preset);
    }
  }
  return presetLabel(entry.preset);
};

const historyProtocolLabel = (protocol: ClaudeConnectionHistoryEntry['protocol']): string => {
  switch (protocol) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'unknown':
      return '协议待确认';
  }
};

const historyRouteLabel = (entry: ClaudeConnectionHistoryEntry): string => {
  if (entry.preset === 'anthropic') {
    return '官方直连';
  }
  if (entry.protocol === 'openai') {
    return 'Router 转换';
  }
  if (entry.preset === 'gateway') {
    return '本机转换器';
  }
  if (findClaudeProvider(entry.preset)?.group === 'local') {
    return '本地直连';
  }
  return '中转直连';
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
    const displayName = historyDisplayName(entry);
    restore.title = `恢复连接：${displayName}`;

    const titleRow = document.createElement('span');
    titleRow.className = 'connection-history__title-row';
    const title = document.createElement('strong');
    title.textContent = displayName;
    const tags = document.createElement('span');
    tags.className = 'connection-history__tags';
    const protocolTag = document.createElement('span');
    protocolTag.className = 'connection-history__tag';
    protocolTag.dataset.protocol = entry.protocol;
    protocolTag.textContent = historyProtocolLabel(entry.protocol);
    const routeTag = document.createElement('span');
    routeTag.className = 'connection-history__tag connection-history__tag--route';
    routeTag.textContent = historyRouteLabel(entry);
    tags.append(protocolTag, routeTag);
    titleRow.append(title, tags);
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
    const displayedBaseUrl = entry.sourceBaseUrl ?? entry.baseUrl;
    const displayedModel = entry.sourceModel ?? entry.model;
    const displayedModelFast = entry.sourceModelFast ?? entry.modelFast ?? displayedModel;
    appendParameter('接口 / 网关', displayedBaseUrl || 'Anthropic 官方端点');
    if (entry.protocol === 'openai' && entry.baseUrl !== displayedBaseUrl) {
      appendParameter('本地转换', entry.baseUrl);
    } else if (entry.gatewayEndpoint && entry.gatewayEndpoint !== displayedBaseUrl) {
      appendParameter('检测网关', entry.gatewayEndpoint);
    }
    appendParameter('主模型', displayedModel || '默认模型');
    appendParameter('小型/备用模型', displayedModelFast || displayedModel || '跟随主模型');
    const meta = document.createElement('span');
    meta.className = 'connection-history__meta';
    meta.textContent = [
      formatHistoryTimestamp(entry.savedAt),
      historyAuthModeLabel(entry.sourceAuthMode ?? entry.authMode),
      (entry.sourceCredentialConfigured ?? entry.credentialConfigured) ? '含凭据' : '无凭据',
      entry.apiKeyHelperPolicy === 'inherit' ? '保留 apiKeyHelper' : 'ClaudeDock 单一凭据',
      GATEWAY_STATE_LABELS[entry.gatewayState],
    ].join(' · ');
    restore.append(titleRow, parameters, meta);

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

const renameConnectionHistory = async (entryId: string): Promise<void> => {
  const status = activeStatus();
  const entry = connectionHistoryEntries.find((candidate) => candidate.id === entryId);
  if (!status || !entry || connectionHistoryMutationInProgress) {
    return;
  }
  const nextName = await requestConnectionHistoryName(historyDisplayName(entry));
  if (!nextName) {
    return;
  }
  connectionHistoryMutationInProgress = true;
  try {
    const result = await window.controlPanel.renameClaudeConnectionHistory(
      status.id,
      entryId,
      nextName,
    );
    connectionHistoryEntries = result.entries;
    renderConnectionHistory();
    if (!result.ok) {
      showToast(result.error ?? '无法重命名这条接入记录。', 'error');
      return;
    }
    showToast('连接名称已更新。');
  } catch {
    showToast('无法重命名这条接入记录。', 'error');
  } finally {
    connectionHistoryMutationInProgress = false;
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

window.controlPanel.onTerminalData((sessionId, ptyGeneration, data) => {
  queueTerminalOutput(sessionId, ptyGeneration, data);
});
window.controlPanel.onClaudePermissionModeProbe((sessionId, ptyGeneration, probeId) => {
  const view = terminalViews.get(sessionId);
  if (!view || !ownsTerminalGeneration(sessionId, ptyGeneration, view)) {
    window.controlPanel.reportClaudePermissionModeProbe(sessionId, ptyGeneration, probeId);
    return;
  }
  if (view.outputPump.appliedRevision >= view.outputPump.acceptedRevision) {
    window.controlPanel.reportClaudePermissionModeProbe(
      sessionId,
      ptyGeneration,
      probeId,
      readTerminalPermissionMode(view),
    );
    return;
  }
  view.permissionModeProbes.push({
    probeId,
    ptyGeneration,
    requiredRevision: view.outputPump.acceptedRevision,
  });
});
/*
 * The PTY clamps the size it was asked for. xterm has to follow, because PSReadLine repaints its
 * edit buffer with absolute cursor moves — a one-row disagreement puts that repaint on the wrong
 * line and leaves the previous screen visible underneath it.
 */
window.controlPanel.onTerminalSize((sessionId, ptyGeneration, cols, rows) => {
  const view = terminalViews.get(sessionId);
  if (
    !view ||
    !ownsTerminalGeneration(sessionId, ptyGeneration, view) ||
    (view.terminal.cols === cols && view.terminal.rows === rows)
  ) {
    return;
  }
  try {
    view.terminal.resize(cols, rows);
  } catch {
    // A resize can race with the terminal being disposed.
  }
});
const unsubscribeAppWindowRestored = window.controlPanel.onAppWindowRestored(() => {
  rerunAutomaticConnectionTestForActiveProject();
});
const closeQuitConfirmation = (decision: boolean | 'retry'): void => {
  pendingQuitRequest = undefined;
  if (quitConfirmationDialog.open) {
    quitConfirmationDialog.close(decision === true ? 'quit' : String(decision));
  }
  window.controlPanel.confirmQuit(decision);
};

const renderQuitConfirmation = (request: AppQuitRequest): void => {
  pendingQuitRequest = request;
  quitConfirmationTitle.textContent = request.runtimeCleanupFailed
    ? '仍有派生 Web 进程未能安全结束'
    : request.hasBlocking
      ? '有操作正在进行，不建议退出'
      : request.leases.length > 0
        ? '还有后台任务未完成'
        : '确认退出 ClaudeDock？';
  quitConfirmationMessage.textContent = request.runtimeCleanupFailed
    ? '安全清理尚未完成。请重试；只有明确强制退出才会留下列出的进程。'
    : request.leases.length > 0
      ? '退出会结束下列会话或任务；也可以最小化到托盘，让它们继续运行。'
      : '确认要彻底退出吗？所有 ClaudeDock 窗口和终端都会关闭。';
  quitMinimizeButton.textContent = request.runtimeCleanupFailed
    ? '重试安全清理'
    : '最小化到托盘，继续运行';
  quitCancelButton.hidden = request.runtimeCleanupFailed === true;
  quitForceButton.dataset.tone = request.hasBlocking ? 'danger' : 'neutral';
  quitConfirmationList.hidden = request.leases.length === 0;
  quitConfirmationList.replaceChildren(
    ...request.leases.map((lease) => {
      const item = document.createElement('li');
      const label = document.createElement('strong');
      const badge = document.createElement('span');
      item.dataset.severity = lease.severity;
      label.textContent = lease.label;
      badge.textContent = lease.severity === 'blocking' ? '中断会留下不完整状态' : '可稍后继续';
      item.append(label, badge);
      return item;
    }),
  );
  if (!quitConfirmationDialog.open) {
    quitConfirmationDialog.showModal();
  }
  quitMinimizeButton.focus();
};

/* Every path answers the main-process handshake, including Esc and the default safe action. */
const unsubscribeAppQuitRequested = window.controlPanel.onAppQuitRequested(renderQuitConfirmation);
quitMinimizeButton.addEventListener('click', () => {
  if (pendingQuitRequest?.runtimeCleanupFailed) {
    closeQuitConfirmation('retry');
    return;
  }
  closeQuitConfirmation(false);
  window.controlPanel.minimizeToTray();
});
quitCancelButton.addEventListener('click', () => {
  if (pendingQuitRequest?.runtimeCleanupFailed) return;
  closeQuitConfirmation(false);
});
quitConfirmationDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  if (pendingQuitRequest?.runtimeCleanupFailed) return;
  closeQuitConfirmation(false);
});
quitConfirmationDialog.addEventListener('click', (event) => {
  if (event.target === quitConfirmationDialog && !pendingQuitRequest?.runtimeCleanupFailed) {
    closeQuitConfirmation(false);
  }
});
quitForceButton.addEventListener('click', () => {
  const request = pendingQuitRequest;
  if (!request) {
    return;
  }
  quitConfirmationDialog.close('force-requested');
  if (!request.hasBlocking) {
    closeQuitConfirmation(true);
    return;
  }
  void requestConfirmation({
    confirmLabel: '仍要退出',
    message: request.runtimeCleanupFailed
      ? '安全清理仍未完成。强制退出可能留下上方列出的派生 Web 进程，确认仍要退出吗？'
      : '退出会中断不可恢复的安装或配置操作，并可能留下不完整状态。确认仍要退出吗？',
    title: request.runtimeCleanupFailed ? '确认带残留强制退出' : '确认中断关键操作',
    tone: 'danger',
  }).then((confirmed) => {
    closeQuitConfirmation(confirmed);
  });
});
window.controlPanel.onClaudeState(renderClaudeState);
window.controlPanel.onCodexState((state) => {
  renderCodexState(state);
  if (
    codexAutoLaunchSessionId === state.sessionId &&
    state.account &&
    state.sessionId === workspaceState.activeSessionId &&
    activeDevelopmentRuntime() === 'codex' &&
    !codexOperationInProgress
  ) {
    codexAutoLaunchSessionId = '';
    void launchCodex('new');
  }
});
window.controlPanel.onNetworkPreflight((result) => {
  networkPreflightResults.set(result.provider, result);
  if (result.provider === activeNetworkProvider()) {
    const status = activeStatus();
    const codexState = status ? codexStates.get(status.id) : undefined;
    const claudeState = status ? claudeStates.get(status.id) : undefined;
    if (activeDevelopmentRuntime() === 'codex' && codexState) {
      renderCodexState(codexState, false);
    } else if (claudeState) {
      renderClaudeState(claudeState, true, false);
    } else {
      renderActiveNetworkPreflight();
    }
    if (
      networkPreflightDialog.open &&
      (!networkPreflightDialogProvider || networkPreflightDialogProvider === result.provider)
    ) {
      renderNetworkPreflightDetails(result);
    }
  } else if (result.status === 'blocked') {
    networkPreflightDialogProvider = result.provider;
    renderNetworkPreflightDetails(result);
    if (!networkPreflightDialog.open) {
      networkPreflightDialog.showModal();
    }
  }
});
const unsubscribeRuntimeActivityChanged = window.controlPanel.onRuntimeActivityChanged((state) => {
  runtimeActivityStates.set(state.sessionId, state);
  if (state.sessionId === workspaceState.activeSessionId) renderRuntimeActivity(state);
});
const unsubscribeClaudePermissionRequest = window.controlPanel.onClaudePermissionRequest(
  (request) => {
    if (
      request.expiresAt <= Date.now() ||
      request.requestId === activeClaudePermissionRequest?.requestId ||
      claudePermissionQueue.some((queued) => queued.requestId === request.requestId)
    ) {
      return;
    }
    claudePermissionQueue.push(request);
    showNextClaudePermissionRequest();
  },
);
window.controlPanel.onWorkspaceState((state) => {
  renderWorkspace(state);
  void loadActiveRuntimeActivity();
});
window.controlPanel.onChatStream(handleChatStream);

chooseDirectoryButton.addEventListener('click', () => {
  void openDirectoryPicker();
});
runClaudeButton.addEventListener('click', () => {
  if (activeDevelopmentRuntime() === 'codex') {
    void prepareAndLaunchCodex();
  } else {
    void launchClaude('new');
  }
});
runtimeClaude.addEventListener('change', () => {
  if (runtimeClaude.checked) {
    void switchDevelopmentRuntime('claude');
  }
});
runtimeCodex.addEventListener('change', () => {
  if (runtimeCodex.checked) {
    void switchDevelopmentRuntime('codex');
  }
});
routeHealthAction.addEventListener('click', () => {
  setWorkbenchOpen(false);
  selectRailTab('connection');
});
for (const button of activityRail.querySelectorAll<HTMLButtonElement>('[data-rail-tab]')) {
  const railTab = button.dataset.railTab ?? 'projects';
  button.addEventListener('click', () => {
    toggleRailTab(railTab);
  });
  button.addEventListener('pointerenter', () => showRailPreview(railTab));
  button.addEventListener('focusin', () => showRailPreview(railTab));
  button.addEventListener('pointerleave', () => scheduleRailPreviewClose());
}
controlPanel.addEventListener('pointerenter', cancelRailPreviewClose);
controlPanel.addEventListener('pointerleave', () => scheduleRailPreviewClose());
controlPanel.addEventListener('focusin', cancelRailPreviewClose);
controlPanel.addEventListener('focusout', (event) => {
  const next = event.relatedTarget as Node | null;
  if (next && (controlPanel.contains(next) || activityRail.contains(next))) return;
  scheduleRailPreviewClose(0);
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-plugin-tab]')) {
  button.addEventListener('click', () => {
    selectPluginTab(button.dataset.pluginTab ?? 'installed');
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mcp-tab]')) {
  button.addEventListener('click', () => {
    selectMcpTab(button.dataset.mcpTab ?? 'installed');
  });
}
refreshUpdatesButton.addEventListener('click', () => {
  void refreshAvailableUpdates(true);
});
closeUpdateCenterButton.addEventListener('click', () => {
  updateCenterDialog.close('close');
});
cancelUpdateCenterButton.addEventListener('click', () => {
  updateCenterDialog.close('cancel');
});
updateCenterAllButton.addEventListener('click', () => {
  void runAllUpdates();
});
updateCenterDialog.addEventListener('click', (event) => {
  if (event.target === updateCenterDialog) updateCenterDialog.close('backdrop');
});
updateCenterDialog.addEventListener('close', () => {
  if (!downloadCenterDialog.open) refreshUpdatesButton.focus();
});
openDownloadCenterButton.addEventListener('click', () => {
  openDownloadCenter();
});
closeDownloadCenterButton.addEventListener('click', () => {
  downloadCenterDialog.close('close');
});
downloadCenterDialog.addEventListener('click', (event) => {
  if (event.target === downloadCenterDialog) {
    downloadCenterDialog.close('backdrop');
  }
});
downloadCenterDialog.addEventListener('close', () => {
  openDownloadCenterButton.focus();
});
clearDownloadHistoryButton.addEventListener('click', () => {
  void (async () => {
    const confirmed = await requestConfirmation({
      confirmLabel: '清空历史',
      message: '清空全部下载历史？这不会删除已经下载或安装的软件。',
      title: '清空下载历史',
      tone: 'danger',
    });
    if (!confirmed) return;
    clearDownloadHistoryButton.disabled = true;
    try {
      handleDownloadsChanged(await window.controlPanel.clearDownloadHistory());
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法清空下载历史。', 'error');
      clearDownloadHistoryButton.disabled = false;
    }
  })();
});
updateAllPluginsButton.addEventListener('click', () => {
  void runPluginMutation(
    () => window.controlPanel.updateAllClaudePlugins(),
    '正在更新…',
    updateAllPluginsButton,
  );
});
refreshPluginsButton.addEventListener('click', () => {
  refreshPluginsButton.disabled = true;
  void refreshPluginUpdates().finally(() => {
    refreshPluginsButton.disabled = false;
  });
});
refreshSoftwareUpdatesButton.addEventListener('click', () => {
  refreshSoftwareUpdatesButton.disabled = true;
  void loadSoftwareUpdates(true).finally(() => {
    refreshSoftwareUpdatesButton.disabled = false;
  });
});
applicationUpdateAction.addEventListener('click', () => {
  void runApplicationUpdateAction();
});
pluginSearch.addEventListener('input', () => {
  if (pluginCatalog) {
    renderPluginCatalog(pluginCatalog);
  }
});
pluginCategoryFilter.addEventListener('change', () => {
  if (pluginCatalog) {
    renderPluginCatalog(pluginCatalog);
  }
});
mcpSearch.addEventListener('input', () => {
  if (mcpCatalog) renderMcpCatalog(mcpCatalog);
});
mcpScopeFilter.addEventListener('change', () => {
  if (mcpCatalog) renderMcpCatalog(mcpCatalog);
});
mcpRefresh.addEventListener('click', () => {
  void loadMcpCatalog(true);
});
mcpBackupRestore.addEventListener('click', async () => {
  const status = activeStatus();
  const backupId = mcpBackupSelect.value;
  if (!status || !backupId || mcpMutationInProgress) return;
  if (
    !(await requestConfirmation({
      confirmLabel: '还原备份',
      message: `将用备份 ${backupId} 逐字节替换 ~/.claude.json。\n\n当前文件会先另存为新的安全备份，失败时自动回滚。`,
      title: '还原 MCP 配置备份',
      tone: 'danger',
    }))
  ) {
    return;
  }
  void runMcpMutation(mcpBackupRestore, '正在还原…', () =>
    window.controlPanel.restoreMcpBackup(backupId, status.cwd),
  ).then(() => loadMcpBackups());
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
  if (activeDevelopmentRuntime() === 'claude') {
    selectWorkbenchPage('shortcuts');
  }
});
terminalThemeSelect.addEventListener('change', () => {
  const themeId = terminalThemeSelect.value;
  if (isTerminalThemeId(themeId)) {
    applyTerminalTheme(themeId);
  }
});
settingsTheme.addEventListener('change', () => {
  const themeId = settingsTheme.value;
  if (isTerminalThemeId(themeId)) {
    applyTerminalTheme(themeId, false, false);
  }
  updateSettingsUnsavedIndicator();
});
settingsLaunchAtLogin.addEventListener('change', () => {
  updateSettingsUnsavedIndicator();
});
settingsCloseBehavior.addEventListener('change', () => {
  updateSettingsUnsavedIndicator();
});
settingsWebResearchIsolation.addEventListener('change', () => {
  updateSettingsUnsavedIndicator();
});
settingsOpenCcrBackend.addEventListener('click', () => {
  const status = activeStatus();
  if (!status || settingsOpenCcrBackend.disabled) {
    return;
  }
  void runGuarded(settingsOpenCcrBackend, '正在打开…', async () => {
    const result = await window.controlPanel.openClaudeRouterManagement(status.id);
    handleRouterResult(result);
    await loadAdvancedRouterBackends();
  });
});
settingsOpenChatGptGateway.addEventListener('click', () => {
  if (settingsOpenChatGptGateway.disabled) {
    return;
  }
  void runGuarded(settingsOpenChatGptGateway, '正在打开…', async () => {
    const result = await window.controlPanel.openManagedChatGptGatewayManagement();
    showToast(
      result.message ?? result.error ?? '无法打开 ChatGPT 网关后台。',
      result.ok ? 'success' : 'error',
    );
    await loadAdvancedRouterBackends();
  });
});
settingsChatIdleTimeout.addEventListener('change', () => {
  const requested = Number(settingsChatIdleTimeout.value);
  if (requested !== 0 && requested !== 5 && requested !== 10 && requested !== 30) {
    settingsChatIdleTimeout.value = '0';
  }
  updateSettingsUnsavedIndicator();
});
applicationProxyEnabled.addEventListener('change', () => {
  applicationProxyDraftEdited = true;
  syncApplicationProxyInteractivity();
  updateSettingsUnsavedIndicator();
});
applicationProxyProtocol.addEventListener('change', () => {
  applicationProxyDraftEdited = true;
  syncApplicationProxyInteractivity();
  updateSettingsUnsavedIndicator();
});
for (const control of [
  applicationProxyHost,
  applicationProxyPort,
  applicationProxyUsername,
  applicationProxyPassword,
]) {
  control.addEventListener('input', () => {
    applicationProxyDraftEdited = true;
    syncApplicationProxyInteractivity();
    updateSettingsUnsavedIndicator();
  });
}
for (const control of [
  applicationProxyScopeCli,
  applicationProxyScopeApplication,
  applicationProxyScopeConversation,
]) {
  control.addEventListener('change', () => {
    applicationProxyDraftEdited = true;
    syncApplicationProxyInteractivity();
    updateSettingsUnsavedIndicator();
  });
}
applicationProxySave.addEventListener('click', () => {
  void savePendingApplicationProxy()
    .then((saved) => {
      if (saved) showToast('应用代理设置已保存');
    })
    .catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : '无法保存应用代理设置。', 'error');
    });
});
applicationProxyDetect.addEventListener('click', () => {
  applicationProxyDetect.disabled = true;
  void window.controlPanel
    .detectApplicationProxyCandidates()
    .then((candidates) => {
      renderApplicationProxyCandidates(candidates);
      if (candidates.length === 0) showToast('没有检测到系统或环境变量代理');
    })
    .catch(() => showToast('无法检测现有代理。', 'error'))
    .finally(() => {
      applicationProxyDetect.disabled = false;
    });
});
applicationProxyTest.addEventListener('click', () => {
  applicationProxyTestInProgress = true;
  syncApplicationProxyInteractivity();
  applicationProxyTest.textContent = '正在测试…';
  void window.controlPanel
    .testApplicationProxy()
    .then((state) => {
      renderApplicationProxyState(state);
      showToast(state.test?.message ?? '代理测试完成', state.test?.ok ? 'success' : 'error');
    })
    .catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : '应用代理测试失败。', 'error');
    })
    .finally(() => {
      applicationProxyTestInProgress = false;
      applicationProxyTest.textContent = '测试 GitHub 连接';
      syncApplicationProxyInteractivity();
    });
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')) {
  button.addEventListener('click', () => {
    const requested = button.dataset.settingsTab;
    selectSettingsTab(
      requested === 'advanced' ||
        requested === 'connection' ||
        requested === 'legal' ||
        requested === 'proxy' ||
        requested === 'router'
        ? requested
        : 'general',
    );
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-legal-url]')) {
  button.addEventListener('click', () => {
    const url = button.dataset.legalUrl;
    if (url) void openExternal(url);
  });
}
routerWizardProvider.addEventListener('change', () => {
  routerWizardBaseUrl.value = '';
  routerWizardModel.value = '';
  syncRouterWizard();
});
routerWizardForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void runRouterWizard();
});
syncRouterWizard();
installCcSwitchButton.addEventListener('click', () => {
  void runKernelOperation(
    (sessionId) => window.controlPanel.installCcSwitch(sessionId),
    '正在安装…',
    installCcSwitchButton,
  );
});
exportCcSwitchButton.addEventListener('click', () => {
  void runKernelOperation(
    (sessionId) => window.controlPanel.exportCurrentProviderToCcSwitch(sessionId),
    '正在导出…',
    exportCcSwitchButton,
  );
});
uninstallCcSwitchButton.addEventListener('click', async () => {
  const residuals = routerKernelState?.ccSwitch.residuals ?? [];
  if (
    !(await requestConfirmation({
      confirmLabel: '彻底卸载',
      message:
        '将通过 Windows Installer 卸载 CC Switch，并删除以下已知数据目录：\n' +
        (residuals.length > 0 ? residuals.join('\n') : '卸载后扫描到的 CC Switch 专属数据目录') +
        '\n\n不会读取或修改 CC Switch 的 SQLite 内容；目录将整体删除且无法恢复。',
      title: '彻底卸载 CC Switch',
      tone: 'danger',
    }))
  ) {
    return;
  }
  void runKernelOperation(
    (sessionId) => window.controlPanel.uninstallCcSwitch(sessionId),
    '正在卸载…',
    uninstallCcSwitchButton,
  );
});
conversationRenameCancel.addEventListener('click', () => {
  conversationRenameDialog.close('cancel');
});
openConnectionAdvancedButton.addEventListener('click', openAdvancedConnectionDialog);
completeConnectionAdvancedButton.addEventListener('click', () => {
  void savePendingAppSettings();
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
chatConfigForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void runGuarded(saveChatConfigButton, '正在保存…', async () => {
    try {
      const config = await window.controlPanel.saveChatConfig(chatConfigInput());
      renderChatConfig(config);
      chatConfigStatus.textContent = '独立接入已保存并可用于新消息。';
      showToast('独立对话接入已保存');
      chatSettingsDialog.close('saved');
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法保存独立对话接入。';
      chatConfigStatus.textContent = message;
      showToast(message, 'error');
    }
  });
});
openChatSettingsButton.addEventListener('click', () => {
  if (chatSettingsDialog.open) {
    return;
  }
  // Re-read from the main process so the dialog never shows a stale draft from a previous open.
  void loadChatConfig(true);
  chatSettingsDialog.showModal();
  chatModel.focus();
});
closeChatSettingsButton.addEventListener('click', () => {
  chatSettingsDialog.close('cancel');
});
chatSettingsDialog.addEventListener('close', () => {
  chatCredential.value = '';
  chatClearCredential.checked = false;
});
testChatConnectionButton.addEventListener('click', () => {
  chatConnectionTest.dataset.tone = 'pending';
  chatConnectionTest.textContent = '正在发送最小请求，验证接口、认证和模型…';
  void runGuarded(testChatConnectionButton, '正在测试…', async () => {
    try {
      const result = await window.controlPanel.testChatConnection(chatConfigInput());
      chatConnectionTest.dataset.tone = result.ok ? 'success' : 'error';
      chatConnectionTest.textContent = `${result.detail} · ${result.latencyMs} ms${
        result.usage ? ` · ${formatTokenCount(result.usage.totalTokens)} tokens` : ''
      }`;
      showToast(
        result.ok ? '独立对话连接测试通过' : result.detail,
        result.ok ? 'success' : 'error',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接测试失败。';
      chatConnectionTest.dataset.tone = 'error';
      chatConnectionTest.textContent = message;
      showToast(message, 'error');
    }
  });
});
chatConfigForm.addEventListener('input', (event) => {
  if (event.target === testChatConnectionButton || event.target === saveChatConfigButton) {
    return;
  }
  chatConnectionTest.dataset.tone = 'idle';
  chatConnectionTest.textContent = '配置已变化，请重新测试连接。';
});
chatAuthMode.addEventListener('change', () => {
  const disabled = chatAuthMode.value === 'none';
  chatCredential.disabled = disabled;
  chatClearCredential.disabled = disabled;
  chatCredentialStatus.textContent = disabled
    ? '当前接口不使用认证凭据。'
    : chatConfig?.credentialConfigured
      ? '已通过 Windows 安全存储保存凭据；留空可继续使用。'
      : '尚未保存凭据。';
});
chatProtocol.addEventListener('change', () => {
  chatBaseUrl.placeholder =
    chatProtocol.value === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com';
});
chatComposer.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitChatMessage();
});
chatAttachButton.addEventListener('click', () => {
  chatAttachmentInput.click();
});
chatAttachmentInput.addEventListener('change', () => {
  queueChatAttachmentImport(Array.from(chatAttachmentInput.files ?? []));
});
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submitChatMessage();
  }
});
chatInput.addEventListener('input', () => {
  renderChatUsage();
  resizeChatComposer();
});
chatInput.addEventListener('paste', (event) => {
  const clipboard = event.clipboardData;
  if (!clipboard) {
    return;
  }
  const files = Array.from(clipboard.files);
  if (files.length > 0) {
    // Let the file(s) become attachments and keep any co-pasted text out of the textarea, matching
    // how claude.ai treats a paste that carries both a rendering and its source bytes.
    event.preventDefault();
    queueChatAttachmentImport(files);
    return;
  }
  // No files: fall through to the browser's own plain-text insertion.
});
stopChatButton.addEventListener('click', () => {
  if (activeChatRequestId) {
    void window.controlPanel.stopChat(activeChatRequestId);
  }
});
newChatButton.addEventListener('click', () => {
  resetChatConversation();
  chatInput.focus();
});
artifactDetailsButton.addEventListener('click', () => {
  setArtifactDetailsOpen(artifactDetailsButton.getAttribute('aria-expanded') !== 'true');
});
artifactDetailsClose.addEventListener('click', () => {
  setArtifactDetailsOpen(false);
});
artifactDetailsScrim.addEventListener('click', () => {
  setArtifactDetailsOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && artifactDetailsButton.getAttribute('aria-expanded') === 'true') {
    event.preventDefault();
    setArtifactDetailsOpen(false);
  }
  if (event.key === 'Escape' && footerSecondaryStatus.dataset.open === 'true') {
    event.preventDefault();
    setFooterSecondaryOpen(false);
    footerMore.focus();
  }
  if (event.key === 'Escape' && previewRailTab !== undefined) {
    event.preventDefault();
    const trigger = activityRail.querySelector<HTMLButtonElement>(
      `[data-rail-tab="${previewRailTab}"]`,
    );
    closeRailPreview();
    trigger?.focus();
  }
});
artifactNetworkAllowed.addEventListener('change', () => {
  artifactNetworkAllowed.disabled = true;
  void window.controlPanel
    .setArtifactNetworkAllowed(artifactNetworkAllowed.checked)
    .then((state) => {
      artifactNetworkState = state;
      renderArtifactNetworkLog();
      showToast(state.allowed ? 'Artifact 联网已开启' : 'Artifact 联网已关闭');
    })
    .catch(() => {
      artifactNetworkAllowed.checked = artifactNetworkState.allowed;
      showToast('无法保存 Artifact 联网设置。', 'error');
    })
    .finally(() => {
      artifactNetworkAllowed.disabled = false;
    });
});
footerConnection.addEventListener('click', () => {
  if (activeDevelopmentRuntime() === 'codex') {
    void openNetworkPreflightDialog();
    const provider = activeNetworkProvider();
    if (provider && !networkPreflightResults.has(provider)) {
      void runActiveNetworkPreflight(false);
    }
    return;
  }
  if (connectionTestInProgress) {
    return;
  }
  const status = activeStatus();
  const state = status ? claudeStates.get(status.id) : undefined;
  if (!state) {
    showToast('无法读取当前接入配置。', 'error');
    return;
  }
  void runConnectionTest(false, savedClaudeConfigInput(state.config));
});
networkPreflightDetails.addEventListener('click', () => {
  void openNetworkPreflightDialog();
});
networkPreflightRecheck.addEventListener('click', () => {
  void runActiveNetworkPreflight(true);
});
networkPreflightDialogRecheck.addEventListener('click', () => {
  void runActiveNetworkPreflight(true, networkPreflightDialogProvider);
});
networkPreflightClose.addEventListener('click', () => {
  networkPreflightDialog.close();
});
networkPreflightClearHistory.addEventListener('click', () => {
  networkPreflightClearHistory.disabled = true;
  void window.controlPanel
    .clearNetworkPreflightHistory()
    .then(() => {
      showToast('网络诊断历史已清除。');
    })
    .catch(() => {
      showToast('无法清除网络诊断历史。', 'error');
    })
    .finally(() => {
      networkPreflightClearHistory.disabled = false;
    });
});
footerResource.addEventListener('click', () => {
  if (footerResourceMenu.hidden) {
    openFooterMenu(footerResourceMenu, footerResource);
  } else {
    hideFooterMenus();
  }
});
runtimeActivityTrigger.addEventListener('click', () => {
  const opening = runtimeActivityPanel.hidden;
  runtimeActivityPanel.hidden = !opening;
  runtimeActivityTrigger.setAttribute('aria-expanded', String(opening));
  if (opening) runtimeActivityClose.focus({ preventScroll: true });
});
runtimeActivityClose.addEventListener('click', () => {
  runtimeActivityPanel.hidden = true;
  runtimeActivityTrigger.setAttribute('aria-expanded', 'false');
  runtimeActivityTrigger.focus({ preventScroll: true });
});
claudePermissionFallback.addEventListener('click', () => {
  void respondToClaudePermission({ behavior: 'fallback' });
});
claudePermissionDeny.addEventListener('click', () => {
  const message = claudePermissionDenyReason.value.trim();
  void respondToClaudePermission({
    behavior: 'deny',
    ...(message ? { message } : {}),
  });
});
claudePermissionAllow.addEventListener('click', () => {
  const selected = claudePermissionSuggestions.querySelector<HTMLInputElement>(
    'input[name="claude-permission-suggestion"]:checked',
  );
  void respondToClaudePermission({
    behavior: 'allow',
    ...(selected?.value ? { suggestionId: selected.value } : {}),
  });
});
claudePermissionDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  void respondToClaudePermission({ behavior: 'fallback' });
});
footerMore.addEventListener('click', () => {
  setFooterSecondaryOpen(footerSecondaryStatus.dataset.open !== 'true');
});
footerResourceMenu.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    '[data-resource-preference], [data-context-window-mode]',
  );
  const contextWindowMode = button?.dataset.contextWindowMode as
    ManagedChatGptContextWindowMode | undefined;
  if (contextWindowMode) {
    void window.controlPanel
      .setManagedChatGptContextWindowMode(contextWindowMode)
      .then((settings) => {
        managedChatGptContextWindowMode = settings.managedChatGptContextWindowMode;
        syncManagedChatGptContextWindowSelection();
        hideFooterMenus();
        showToast('上下文窗口选择已保存；下次新建或重启托管 ChatGPT 会话生效。');
      })
      .catch(() => showToast('无法保存 ChatGPT 上下文窗口选择。', 'error'));
    return;
  }
  const preference = button?.dataset.resourcePreference as FooterResourcePreference | undefined;
  if (!preference) return;
  void window.controlPanel
    .setFooterResourcePreference(preference)
    .then((settings) => {
      footerResourcePreference = settings.footerResourcePreference;
      const status = activeStatus();
      const codexSelected = activeDevelopmentRuntime() === 'codex';
      const claudeState = status && !codexSelected ? claudeStates.get(status.id) : undefined;
      const usage = status
        ? codexSelected
          ? codexStates.get(status.id)?.resourceUsage
          : claudeState?.resourceUsage
        : undefined;
      renderFooterResource(usage, managedContextWindowSelectable(claudeState));
      hideFooterMenus();
    })
    .catch(() => showToast('无法保存底栏资源偏好。', 'error'));
});
footerModel.addEventListener('click', () => {
  if (footerModelMenu.hidden) {
    void openModelMenu();
  } else {
    hideFooterMenus();
  }
});
footerSpeed.addEventListener('click', () => {
  if (footerSpeedMenu.hidden) {
    openSpeedMenu();
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
footerEffort.addEventListener('click', () => {
  if (footerEffortMenu.hidden) {
    openEffortMenu();
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
codexPrimaryAction.addEventListener('click', () => {
  void prepareAndLaunchCodex();
});
codexInstallButton.addEventListener('click', () => {
  void installOrUpdateCodex();
});
codexLoginButton.addEventListener('click', () => {
  void startCodexLogin('browser', false);
});
codexDeviceLoginAction.addEventListener('click', () => {
  void startCodexLogin('device-code', true);
});
codexCancelLogin.addEventListener('click', () => {
  const status = activeStatus();
  if (!status || codexOperationInProgress) {
    return;
  }
  codexOperationInProgress = true;
  codexAutoLaunchSessionId = '';
  void window.controlPanel
    .cancelCodexLogin(status.id)
    .then((result) => {
      renderCodexState(result.state);
      if (!result.ok) {
        showToast(result.error ?? '无法取消 Codex 登录。', 'error');
      }
    })
    .catch(() => {
      showToast('无法取消 Codex 登录。', 'error');
    })
    .finally(() => {
      codexOperationInProgress = false;
      const latest = codexStates.get(status.id);
      if (latest) {
        renderCodexState(latest, false);
      }
    });
});
codexLogout.addEventListener('click', () => {
  const status = activeStatus();
  if (!status || codexOperationInProgress) {
    return;
  }
  void requestConfirmation({
    confirmLabel: '退出账号',
    message: '这会让 Codex CLI 与共用其登录缓存的官方客户端退出当前账号，是否继续？',
    title: '退出 Codex 账号',
  }).then((confirmed) => {
    if (!confirmed) {
      return;
    }
    codexOperationInProgress = true;
    void window.controlPanel
      .logoutCodex(status.id)
      .then((result) => {
        renderCodexState(result.state);
        showToast(
          result.ok ? '已退出 Codex 账号。' : (result.error ?? '退出失败。'),
          result.ok ? 'success' : 'error',
        );
      })
      .catch(() => {
        showToast('无法退出 Codex 账号。', 'error');
      })
      .finally(() => {
        codexOperationInProgress = false;
        const latest = codexStates.get(status.id);
        if (latest) {
          renderCodexState(latest, false);
        }
      });
  });
});
codexCopyDeviceCode.addEventListener('click', () => {
  const code = codexDeviceCode.textContent?.trim();
  if (!code || code === '—') {
    return;
  }
  void window.controlPanel.writeClipboardText(code).then((copied) => {
    showToast(copied ? '设备验证码已复制。' : '无法复制设备验证码。', copied ? 'success' : 'error');
  });
});
codexLaunchNew.addEventListener('click', () => {
  void launchCodex('new');
});
codexLaunchContinue.addEventListener('click', () => {
  void launchCodex('continue');
});
codexLaunchResume.addEventListener('click', () => {
  void launchCodex('resume');
});
claudePreset.addEventListener('change', () => {
  selectedRouterProviderId = undefined;
  applyPresetUi(claudePreset.value as ClaudePreset, false);
  connectionTestResult.hidden = true;
  connectionRemedy.hidden = true;
});
claudeProtocol.addEventListener('change', () => {
  completeVisibleConnectionEndpoint(false);
  applyPresetUi('custom', true);
  connectionTestResult.hidden = true;
  connectionRemedy.hidden = true;
});
claudeBaseUrl.addEventListener('blur', () => {
  completeVisibleConnectionEndpoint(true);
});
claudeAuthMode.addEventListener('change', () => {
  credentialField.hidden =
    selectedProviderId === 'chatgpt-subscription' ||
    claudeAuthMode.value === 'existing' ||
    claudeAuthMode.value === 'none';
  connectionTestResult.hidden = true;
  connectionRemedy.hidden = true;
  syncApiKeyHelperPolicyUi();
});
claudeApiKeyHelperPolicy.addEventListener('change', () => {
  connectionTestResult.hidden = true;
  connectionRemedy.hidden = true;
  syncApiKeyHelperPolicyUi();
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
  void runRouterOperation(
    (sessionId) => window.controlPanel.installClaudeRouterFromSource(sessionId, 'npm'),
    '正在安装…',
    installRouterButton,
  );
});
uninstallRouterButton.addEventListener('click', () => {
  void uninstallRouterCli(uninstallRouterButton);
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
clearCredentialButton.addEventListener('click', async () => {
  if (
    await requestConfirmation({
      confirmLabel: '清除凭据',
      message: '清除当前连接已保存的接口凭据？',
      title: '清除接口凭据',
      tone: 'danger',
    })
  ) {
    void saveClaudeConfig('clear');
  }
});
for (const field of [claudeBaseUrl, claudeModel, claudeModelFast, claudeCredential]) {
  field.addEventListener('input', () => {
    if (field === claudeBaseUrl) {
      claudeBaseUrl.setCustomValidity('');
    }
    connectionTestResult.hidden = true;
    connectionRemedy.hidden = true;
  });
}
const composeWorkbenchCommand = async (button: HTMLButtonElement): Promise<void> => {
  const command = button.dataset.commandValue;
  if (!command) return;
  if (
    button.dataset.commandRisk === 'destructive' &&
    !(await requestConfirmation({
      confirmLabel: '填入命令',
      message: `${command} 可能结束、删除或清空当前状态。ClaudeDock 只会填入输入框，不会自动发送。`,
      title: '确认高风险命令',
      tone: 'danger',
    }))
  ) {
    return;
  }
  composerInput.value = `${command}${button.title.includes('[参数]') ? ' ' : ''}`;
  resizeComposer();
  composerInput.focus();
  composerInput.setSelectionRange(composerInput.value.length, composerInput.value.length);
  setWorkbenchOpen(false);
  showToast(`已填入 ${command}，确认后按 Enter 发送`);
};

claudeCommandGrid.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-command-value]');
  const status = activeStatus();
  if (!button || !status) return;
  if (button.dataset.commandAction !== 'run') {
    await composeWorkbenchCommand(button);
    return;
  }
  const command = button.dataset.claudeCommand;
  if (!command) return;
  const argument = button.dataset.usesArgument === 'true' ? commandArgument.value : undefined;
  const result = await window.controlPanel.runClaudeCommand(status.id, command, argument);
  renderClaudeState(result.state);
  if (!result.ok) {
    showToast(result.error ?? '无法执行 Claude 命令。', 'error');
    return;
  }
  showToast(`已执行 ${command}`);
  focusComposer();
});

codexCommandGrid.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-command-value]');
  if (button) void composeWorkbenchCommand(button);
});
restartButton.addEventListener('click', async () => {
  const status = activeStatus();
  if (!status) {
    return;
  }
  const result = await window.controlPanel.restartTerminal(status.id, status.ptyGeneration);
  if (handleOperation(result, result.ok ? '终端已重启' : undefined)) {
    retryTerminalFitUntilMeasured();
    requestComposerFocus(status.id);
  }
});
toggleButton.addEventListener('click', async () => {
  const status = activeStatus();
  if (!status) {
    return;
  }

  if (status.phase === 'running') {
    handleOperation(
      await window.controlPanel.stopTerminal(status.id, status.ptyGeneration),
      '终端已停止',
    );
  } else {
    const result = await window.controlPanel.startTerminal(status.id, status.ptyGeneration);
    if (handleOperation(result, '终端已启动')) {
      retryTerminalFitUntilMeasured();
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
conversationContextMenu
  .querySelector<HTMLButtonElement>('[data-conversation-context-action="delete"]')
  ?.addEventListener('click', () => {
    const target = conversationContextTarget;
    hideConversationContextMenu();
    if (target?.kind === 'history') {
      void deleteStoredConversation(target.projectPath, target.session);
    }
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
    if (action === 'rename') {
      void renameConnectionHistory(entryId);
    } else if (action === 'apply') {
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
    !footerResourceMenu.contains(event.target as Node) &&
    !footerModelMenu.contains(event.target as Node) &&
    !footerSpeedMenu.contains(event.target as Node) &&
    !footerModeMenu.contains(event.target as Node) &&
    !footerEffortMenu.contains(event.target as Node) &&
    !footerResource.contains(event.target as Node) &&
    !footerModel.contains(event.target as Node) &&
    !footerSpeed.contains(event.target as Node) &&
    !footerMode.contains(event.target as Node) &&
    !footerEffort.contains(event.target as Node)
  ) {
    hideFooterMenus();
  }
  if (
    !footerSecondaryStatus.contains(event.target as Node) &&
    !footerMore.contains(event.target as Node)
  ) {
    setFooterSecondaryOpen(false);
  }
  if (
    !runtimeActivityPanel.hidden &&
    !runtimeActivityPanel.contains(event.target as Node) &&
    !runtimeActivityTrigger.contains(event.target as Node)
  ) {
    runtimeActivityPanel.hidden = true;
    runtimeActivityTrigger.setAttribute('aria-expanded', 'false');
  }
});
window.addEventListener('blur', () => {
  cancelActiveResizes();
  hideTerminalContextMenu();
  hideConversationContextMenu();
  hideHistoryContextMenu();
  hideFooterMenus();
  setFooterSecondaryOpen(false);
  runtimeActivityPanel.hidden = true;
  runtimeActivityTrigger.setAttribute('aria-expanded', 'false');
  closeRailPreview();
});
window.addEventListener('resize', () => {
  setFooterSecondaryOpen(false);
  closeRailPreview();
});

let workspaceActivationSyncInProgress = false;
const reconcileWorkspaceAfterActivation = async (): Promise<void> => {
  if (workspaceActivationSyncInProgress) {
    return;
  }
  workspaceActivationSyncInProgress = true;
  try {
    renderWorkspace(await window.controlPanel.getWorkspace());
  } catch {
    // Keep the last rendered snapshot; the normal workspace event stream may still recover.
  } finally {
    workspaceActivationSyncInProgress = false;
  }
};

window.addEventListener('focus', () => {
  // Tray restoration is a fresh layout/focus boundary even when Chromium missed the earlier blur.
  cancelActiveResizes();
  void reconcileWorkspaceAfterActivation();
  retryTerminalFitUntilMeasured();
  flushPendingComposerFocus();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void reconcileWorkspaceAfterActivation();
    retryTerminalFitUntilMeasured();
    flushPendingComposerFocus();
  } else {
    cancelActiveResizes();
  }
});

document.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  const title = dropOverlay.querySelector('strong');
  const detail = dropOverlay.querySelector('span');
  if (title && detail) {
    title.textContent = mainView === 'chat' ? '松开以添加到当前消息' : '松开以添加项目';
    detail.textContent =
      mainView === 'chat'
        ? '支持图片、PDF、CSV 与纯文本；文件只会复制到本机应用数据目录'
        : '将为该项目创建独立终端会话';
  }
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

  const files = Array.from(event.dataTransfer?.files ?? []);
  const file = files[0];
  if (!file) {
    showToast('没有检测到文件夹。', 'error');
    return;
  }

  try {
    if (mainView === 'chat') {
      queueChatAttachmentImport(files);
      return;
    }
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

const handleNetworkEnvironmentChange = (): void => {
  void window.controlPanel
    .invalidateNetworkPreflight('network-environment-changed')
    .then(() => runActiveNetworkPreflight(true))
    .catch(() => {
      showToast('网络环境已变化，但自动复检无法启动。', 'error');
    });
};
window.addEventListener('online', handleNetworkEnvironmentChange);
window.addEventListener('offline', handleNetworkEnvironmentChange);
const networkInformation = (
  navigator as Navigator & {
    connection?: EventTarget;
  }
).connection;
networkInformation?.addEventListener('change', handleNetworkEnvironmentChange);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void runActiveNetworkPreflight(false);
  }
});

let observedTerminalWidth = -1;
let observedTerminalHeight = -1;
const resizeObserver = new ResizeObserver(([entry]) => {
  if (!entry) {
    return;
  }
  const width = Math.round(entry.contentRect.width);
  const height = Math.round(entry.contentRect.height);
  if (width === observedTerminalWidth && height === observedTerminalHeight) {
    return;
  }
  observedTerminalWidth = width;
  observedTerminalHeight = height;
  debounceTerminalFit();
});
resizeObserver.observe(terminalStage);

window.addEventListener('beforeunload', () => {
  railPreviewDialogObserver.disconnect();
  unsubscribeAppQuitRequested();
  unsubscribeAppWindowRestored();
  unsubscribeDownloadsChanged();
  unsubscribeBusyChanged();
  unsubscribeApplicationUpdaterChanged();
  unsubscribeOpenDownloadCenterRequested();
  unsubscribeApplicationProxyChanged();
  unsubscribeManagedChatGptSetupProgress();
  unsubscribeRouterOperationProgress();
  unsubscribeRuntimeActivityChanged();
  unsubscribeClaudePermissionRequest();
  window.removeEventListener('online', handleNetworkEnvironmentChange);
  window.removeEventListener('offline', handleNetworkEnvironmentChange);
  networkInformation?.removeEventListener('change', handleNetworkEnvironmentChange);
  cancelActiveResizes();
  activeChatReplyStream?.destroy();
  artifactController?.stopAll();
  markdownHighlighter?.dispose();
  terminalFitGeneration += 1;
  if (terminalFitDebounceTimer !== undefined) {
    window.clearTimeout(terminalFitDebounceTimer);
  }
  resizeObserver.disconnect();
  if (gatewayRefreshTimer !== undefined) {
    window.clearInterval(gatewayRefreshTimer);
  }
  if (claudePermissionExpiryTimer !== undefined) {
    window.clearTimeout(claudePermissionExpiryTimer);
  }
  for (const [sessionId, view] of [...terminalViews]) {
    disposeTerminalView(sessionId, view);
  }
  terminalMasks.clear();
});

void (async () => {
  try {
    handleDownloadsChanged(await window.controlPanel.listDownloads());
  } catch {
    handleDownloadsChanged([]);
  }
  try {
    busyLeases = await window.controlPanel.listBusyLeases();
    renderDownloadCenter();
  } catch {
    busyLeases = [];
  }
  void loadApplicationProxyState();
  try {
    const initialSettings = await window.controlPanel.getAppSettings();
    const reportedWindowsBuild = initialSettings.windowsBuildNumber;
    windowsBuildNumber =
      typeof reportedWindowsBuild === 'number' &&
      Number.isInteger(reportedWindowsBuild) &&
      reportedWindowsBuild > 0
        ? reportedWindowsBuild
        : undefined;
    artifactNetworkState.allowed = initialSettings.artifactNetworkAllowed ?? true;
    footerResourcePreference = initialSettings.footerResourcePreference;
    managedChatGptContextWindowMode = initialSettings.managedChatGptContextWindowMode;
    settingsCloseBehavior.value = initialSettings.closeBehavior;
    renderArtifactNetworkLog();
    if (initialSettings.theme !== activeTerminalTheme) {
      applyTerminalTheme(initialSettings.theme, false, false);
    }
  } catch {
    // The terminal still works without Windows-specific reflow hints; settings can be retried later.
  }
  renderWorkspace(await window.controlPanel.getWorkspace());
  void loadActiveRuntimeActivity();
  window.setTimeout(() => {
    void runActiveNetworkPreflight(false);
  }, 0);
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
    handleOperation(await window.controlPanel.startTerminal(status.id, status.ptyGeneration));
  }
  void loadConnectionHistory();
  retryTerminalFitUntilMeasured();
  requestComposerFocus(status.id);
})();
