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
  ArtifactNetworkLogEntry,
  ArtifactNetworkState,
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
  NetworkPreflightResult,
  NetworkProviderId,
  SoftwareUpdateState,
  SaveClaudeRouterProviderInput,
  SaveClaudeConfigInput,
  SaveChatConfigInput,
  OperationResult,
  TerminalPhase,
  TerminalStatus,
  WorkspaceProjectView,
  WorkspaceResult,
  WorkspaceState,
} from '../shared/contracts';
import { estimateChatUsage } from '../shared/chat-usage';
import { parseClaudeCurl, type ClaudeCurlAnalysis } from '../shared/claude-curl';
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
  closeOpenSelect,
  enhanceAllSelects,
  installPressRipples,
  installSelectDismissHandlers,
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
const claudeApiKeyHelperPolicy = requiredElement<HTMLSelectElement>(
  '#claude-api-key-helper-policy',
);
const claudeApiKeyHelperStatus = requiredElement<HTMLElement>('#claude-api-key-helper-status');
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
const networkPreflightPrivacy = requiredElement<HTMLInputElement>('#network-preflight-privacy');
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
const settingsLaunchAtLogin = requiredElement<HTMLInputElement>('#settings-launch-at-login');
const settingsTheme = requiredElement<HTMLSelectElement>('#settings-theme');
const settingsLanguage = requiredElement<HTMLSelectElement>('#settings-language');
const settingsVersion = requiredElement<HTMLOutputElement>('#settings-version');
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
const confirmationDialog = requiredElement<HTMLDialogElement>('#confirmation-dialog');
const confirmationDialogTitle = requiredElement<HTMLElement>('#confirmation-dialog-title');
const confirmationDialogMessage = requiredElement<HTMLElement>('#confirmation-dialog-message');
const confirmationDialogConfirm = requiredElement<HTMLButtonElement>(
  '#confirmation-dialog-confirm',
);
const connectionHistoryList = requiredElement<HTMLElement>('#connection-history-list');
const connectionHistoryEmpty = requiredElement<HTMLElement>('#connection-history-empty');
const connectionHistoryCount = requiredElement<HTMLElement>('#connection-history-count');
const historyContextMenu = requiredElement<HTMLElement>('#history-context-menu');
const saveClaudeConfigButton = requiredElement<HTMLButtonElement>('#save-claude-config');
const terminalShell = requiredElement<HTMLElement>('#terminal-shell');
const chatShell = requiredElement<HTMLElement>('#chat-shell');
const chatConfigForm = requiredElement<HTMLFormElement>('#chat-config-form');
const chatSettingsDialog = requiredElement<HTMLDialogElement>('#chat-settings-dialog');
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
const codexStates = new Map<string, CodexProjectState>();
const developmentRuntimeStates = new Map<string, DevelopmentRuntimeState>();
const networkPreflightResults = new Map<NetworkProviderId, NetworkPreflightResult>();
/** Conversation history per project folder, keyed by the lower-cased folder path. */
const storedConversations = new Map<string, ClaudeSessionMetadata[]>();
const expandedFolders = new Set<string>();
/** Keeps each folder's history list where the user scrolled it, across sidebar rebuilds. */
const historyScrollPositions = new Map<string, number>();
const collapsedProviderGroups = new Set<ClaudeProviderGroupId>();
const historyLoadsInFlight = new Set<string>();
let dragDepth = 0;
let claudeRequestGeneration = 0;
let codexRequestGeneration = 0;
let runtimeRequestGeneration = 0;
let configFormSessionId = '';
let connectionTestInProgress = false;
const automaticConnectionTestSessions = new Set<string>();
let networkPreflightInProgress = false;
let networkPreflightDialogProvider: NetworkProviderId | undefined;
let connectionEnvironmentReady = false;
let providerGroupExpansionPending = false;
let selectedProviderId: ClaudeProviderId | undefined;
let advancedConnectionSnapshot: AdvancedConnectionSnapshot | undefined;
let selectedRailTab: string | undefined = 'projects';
let selectedSettingsTab: 'connection' | 'general' = 'general';
let mainView: 'chat' | 'terminal' = 'terminal';
let gatewayDiagnostics: ClaudeGatewayDiagnostics | undefined;
let gatewayRefreshInProgress = false;
let gatewayRefreshTimer: number | undefined;
let lastClaudeSessionId = '';
let lastCurlAnalysis: ClaudeCurlAnalysis | undefined;
let launchInProgress = false;
let codexOperationInProgress = false;
let codexAutoLaunchSessionId = '';
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
let activeChatThinking = '';
let activeChatThinkingElement: HTMLElement | undefined;
const pendingChatAttachments: ChatAttachmentView[] = [];
let activeChatAttachmentDraftId: string | undefined;
let chatAttachmentImportQueue: Promise<void> = Promise.resolve();
let queuedChatAttachmentImports = 0;
let chatSubmissionInFlight = false;
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

const applyTerminalTheme = (themeId: TerminalThemeId, announce = true): void => {
  activeTerminalTheme = themeId;
  terminalThemeSelect.value = themeId;
  settingsTheme.value = themeId;
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
  void window.controlPanel.setAppTheme(themeId).catch(() => {
    // A repaint failure is cosmetic only; the CSS side has already switched.
  });
  if (announce) {
    showToast(`主题已切换为“${definition.label}”`);
  }
  rebuildMarkdownRenderer();
  artifactController?.updateTheme();
};

applyTerminalTheme(activeTerminalTheme, false);

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
  authMode: config.authMode,
  baseUrl: config.baseUrl,
  credentialAction: 'keep',
  model: config.model,
  modelFast: config.modelFast,
  preset: config.preset,
  provider: config.provider,
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
  const egress = result.egress;
  const egressDetail = egress
    ? [
        egress.countryCode,
        egress.ipv4 ?? egress.ipv6,
        `${egress.sourceCount} 个出口来源`,
        egress.sources?.join(' + '),
        egress.riskFlags?.length ? `辅助标签：${egress.riskFlags.join('、')}` : undefined,
        egress.sourcesAgree ? '双源一致' : '未形成双源共识',
      ]
        .filter(Boolean)
        .join(' · ')
    : '出口情报未启用或不可用';
  networkPreflightDialogMeta.textContent = `${checkedAt} · 风险 ${result.riskScore}/100 · ${egressDetail}`;
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
  try {
    networkPreflightPrivacy.checked = (
      await window.controlPanel.getNetworkPreflightSettings()
    ).enhancedPrivacyMode;
  } catch {
    networkPreflightPrivacy.checked = false;
  }
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
  label.textContent = role === 'user' ? '你' : '模型';
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
  activeChatThinking = '';
  activeChatThinkingElement = undefined;
  activeChatRequestMessages = [];
  setChatBusy(false);
  chatInput.focus();
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
  if (event.type === 'delta' && event.delta) {
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
    const timedOut = event.abortReason === 'timeout';
    const notice = timedOut ? '请求长时间没有返回数据，已超时停止。' : '已停止生成。';
    if (activeChatReplyElement && !activeChatReply) {
      activeChatReplyElement.textContent = notice;
    } else if (timedOut && activeChatReply) {
      activeChatReply = `${activeChatReply}\n\n> ${notice}`;
      activeChatReplyStream ??= activeChatReplyElement
        ? markdownRenderer.createStream(activeChatReplyElement)
        : undefined;
      void activeChatReplyStream?.update(activeChatReply);
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
    if (timedOut) {
      showToast(notice, 'error');
    }
    void (async () => {
      await activeChatReplyStream?.finish(activeChatReply);
      await persistActiveChat();
    })().finally(finishChatRequest);
    return;
  }
  if (event.type === 'error') {
    if (activeChatReplyElement) {
      activeChatReply = activeChatReply
        ? `${activeChatReply}\n\n> 生成中断：${event.error ?? '请求失败'}`
        : `> 请求失败：${event.error ?? '未知错误'}`;
      activeChatReplyStream ??= markdownRenderer.createStream(activeChatReplyElement);
      void activeChatReplyStream.update(activeChatReply);
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
      await activeChatReplyStream?.finish(activeChatReply);
      await persistActiveChat();
    })().finally(finishChatRequest);
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
    !connectionEnvironmentReady || connectionTestInProgress || !usesExplicitCredential;
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
  syncApiKeyHelperPolicyUi();
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
  claudeApiKeyHelperPolicy.value = config.apiKeyHelperPolicy;
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

const selectSettingsTab = (tab: 'connection' | 'general'): void => {
  selectedSettingsTab = tab;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')) {
    const selected = button.dataset.settingsTab === tab;
    button.classList.toggle('settings-tab--active', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-settings-panel]')) {
    panel.classList.toggle('settings-panel--active', panel.dataset.settingsPanel === tab);
  }
  if (tab === 'connection') {
    setConnectionPolling(true);
  } else {
    setConnectionPolling(selectedRailTab === 'connection');
  }
};

const loadAppSettings = async (): Promise<void> => {
  try {
    const settings = await window.controlPanel.getAppSettings();
    settingsLaunchAtLogin.checked = settings.launchAtLogin;
    settingsLanguage.value = settings.language;
    settingsVersion.value = settings.version;
    settingsVersion.textContent = settings.version;
    settingsTheme.value = settings.theme;
  } catch {
    showToast('无法读取全局设置。', 'error');
  }
};

const openAdvancedConnectionDialog = (): void => {
  if (connectionAdvancedDialog.open) {
    return;
  }
  advancedConnectionSnapshot = captureAdvancedConnectionSnapshot();
  selectSettingsTab('general');
  void loadAppSettings();
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
  setConnectionPolling(selectedRailTab === 'connection');
  openConnectionAdvancedButton.focus();
};

const renderDevelopmentRuntimeState = (state: DevelopmentRuntimeState): void => {
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
      renderCodexState(codexState);
    } else {
      runAgentLabel.textContent = '正在检查 Codex';
      runClaudeButton.disabled = true;
      void loadCodexState(state.sessionId);
    }
  } else {
    const claudeState = claudeStates.get(state.sessionId);
    if (claudeState) {
      renderClaudeState(claudeState);
    } else {
      runAgentLabel.textContent = '新建安全会话';
      void loadClaudeState(state.sessionId);
    }
  }
  void runActiveNetworkPreflight(false);
};

const renderCodexState = (state: CodexProjectState): void => {
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

  codexInstallStep.dataset.state = installed ? 'ready' : 'error';
  codexInstallTitle.textContent = installed
    ? `Codex CLI ${installation.version ?? '已安装'}`
    : '需要安装 Codex CLI';
  codexInstallDetail.textContent = installation.message;
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

  const actionLabel = codexOperationInProgress
    ? '正在准备 Codex…'
    : !installed
      ? '一键安装、登录并启动'
      : !accountReady
        ? '使用 ChatGPT 登录并启动'
        : '新建 Codex 安全会话';
  codexPrimaryAction.textContent = actionLabel;
  codexPrimaryAction.disabled = codexOperationInProgress || waitingForLogin;
  runAgentLabel.textContent = ready ? '新建 Codex 会话' : '一键准备 Codex';
  runClaudeButton.disabled = codexOperationInProgress || waitingForLogin;
  runClaudeButton.dataset.routeHealth = ready ? 'success' : 'warning';
  runClaudeButton.title = ready
    ? '在当前项目启动官方 Codex 安全会话'
    : '自动完成官方安装与 ChatGPT 登录';

  for (const button of [codexLaunchNew, codexLaunchContinue, codexLaunchResume]) {
    button.disabled = !ready || codexOperationInProgress || launchInProgress;
  }

  routeHealth.hidden = true;
  footerConnection.disabled = false;
  footerConnection.dataset.tone = ready ? 'success' : 'warning';
  footerConnectionLabel.textContent = ready
    ? account?.type === 'chatgpt'
      ? 'ChatGPT 已连接'
      : 'Codex 已连接'
    : 'Codex 待准备';
  footerContextLabel.textContent = quota ? `额度 ${quota.usedPercent.toFixed(0)}%` : '额度 —';
  footerContextRing.style.setProperty('--context-progress', `${quota?.usedPercent ?? 0}%`);
  footerModel.textContent = '模型 Codex 自动';
  footerModel.disabled = true;
  footerMode.textContent = '模式 工作区写入';
  footerMode.disabled = true;
  codexBoundaryNote.textContent = state.warning
    ? `${state.warning} 首版任务界面仍可回退到官方 Codex TUI。`
    : '首版任务界面使用官方 Codex TUI：默认仅写当前工作区，模型需要更高权限时仍会向你确认。App Server 只用于结构化登录和账号状态，不会读取或转存 ChatGPT 令牌。';
  renderActiveNetworkPreflight();
};

const loadCodexState = async (sessionId: string): Promise<void> => {
  const generation = ++codexRequestGeneration;
  try {
    const state = await window.controlPanel.getCodexProjectState(sessionId);
    if (generation === codexRequestGeneration) {
      renderCodexState(state);
    }
  } catch {
    if (generation === codexRequestGeneration) {
      showToast('无法读取 Codex 工作台状态。', 'error');
    }
  }
};

const loadDevelopmentRuntime = async (sessionId: string): Promise<void> => {
  const generation = ++runtimeRequestGeneration;
  try {
    const state = await window.controlPanel.getDevelopmentRuntime(sessionId);
    if (generation === runtimeRequestGeneration) {
      renderDevelopmentRuntimeState(state);
    }
  } catch {
    if (generation === runtimeRequestGeneration) {
      showToast('无法读取当前项目的开发引擎。', 'error');
    }
  }
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
  if (activeDevelopmentRuntime() !== 'claude') {
    if (configFormSessionId !== state.sessionId) {
      populateClaudeConfigForm(state);
    }
    renderProviderPicker();
    syncConnectionInteractivity();
    return;
  }
  runAgentLabel.textContent = '新建安全会话';
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
  footerModel.setAttribute('aria-busy', String(modelSwitchInProgress));
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
    retryTerminalFitUntilMeasured();
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
        void purgeRouter(purgeButton);
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
const purgeRouter = async (button: HTMLButtonElement): Promise<void> => {
  if (
    !(await requestConfirmation({
      confirmLabel: '彻底清除',
      message:
        '彻底卸载路由器并清除全部数据？\n\n' +
        '将删除：路由器程序、全部服务提供方配置、保存在其中的上游密钥与用量记录。\n' +
        '不会改动：Claude Code 与 Codex 自己的配置。\n\n' +
        '删除后无法恢复；完成后可以选择新的安装来源重新安装。',
      title: '彻底清除路由器',
      tone: 'danger',
    }))
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
    testClaudeConnectionButton.setAttribute('aria-busy', 'false');
    testClaudeConnectionButton.textContent = originalLabel;
    syncConnectionInteractivity();
    const latestState = claudeStates.get(status.id);
    if (latestState) {
      renderClaudeState(latestState);
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
  if (!status || launchInProgress) {
    return;
  }
  if (
    !(await requestConfirmation({
      confirmLabel: '压缩并重启',
      message: `${summary}\n\n这需要重启 Claude Code 会话。对话历史会通过 --continue 恢复，但终端画面会重绘。\n\n确定后会先压缩上下文再重启。`,
      title: '重启 Claude Code 会话',
    }))
  ) {
    return;
  }

  launchInProgress = true;
  const known = claudeStates.get(status.id);
  if (known) {
    renderClaudeState(known);
  }
  const endMask = beginTerminalMask(status.id, '正在压缩上下文并恢复会话');
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
    endMask();
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
      renderClaudeState(knownState);
    }
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
  const enteringConnection = tab === 'connection' && selectedRailTab !== 'connection';
  if (tab === 'chat') {
    mainView = 'chat';
  } else if (tab !== undefined) {
    mainView = 'terminal';
  }
  selectedRailTab = tab;
  if (enteringConnection) {
    const lastProvider =
      selectedProviderId ?? claudeStates.get(workspaceState.activeSessionId)?.config.preset;
    applyDefaultProviderGroupExpansion(lastProvider);
    providerGroupExpansionPending = Boolean(workspaceState.activeSessionId && !lastProvider);
    renderProviderPicker();
  }
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
  const chatVisible = mainView === 'chat';
  terminalShell.hidden = chatVisible;
  chatShell.hidden = !chatVisible;
  workspace.classList.toggle('workspace--chat', chatVisible);
  setConnectionPolling(
    tab === 'connection' || (connectionAdvancedDialog.open && selectedSettingsTab === 'connection'),
  );
  if (tab === 'chat') {
    void loadChatConfig();
    void loadChatHistory();
    renderChatUsage();
  }
  if (tab === 'plugins') {
    void loadPluginCatalog(false);
  }
  if (!chatVisible) {
    retryTerminalFitUntilMeasured();
  }
};

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

const createTerminalView = (sessionId: string, active: boolean): TerminalView => {
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
  void writeTerminalSubmission(
    submission,
    (data) => {
      window.controlPanel.writeTerminal(status.id, data);
    },
    // The session can be closed or stopped during the gap between the two writes.
    () => activeStatus()?.id === status.id && activeStatus()?.phase === 'running',
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

const closeProject = async (status: TerminalStatus): Promise<void> => {
  if (
    status.phase === 'running' &&
    !(await requestConfirmation({
      confirmLabel: '关闭对话',
      message: `关闭“${status.title}”会终止它的终端进程，是否继续？`,
      title: '关闭正在运行的对话',
      tone: 'danger',
    }))
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
      confirmLabel: '全部关闭',
      message: `关闭“${project.name}”的全部 ${project.sessionIds.length} 个对话？`,
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
  showToast(`已关闭 ${project.name}，项目仍然会被记住`);
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
  expandedFolders.delete(project.path.toLowerCase());
  historyScrollPositions.delete(project.path.toLowerCase());
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

const deleteStoredConversation = async (
  projectPath: string,
  session: ClaudeSessionMetadata,
): Promise<void> => {
  const title = session.sessionName || session.sessionId.slice(0, 8);
  const runningMatches = workspaceState.sessions.filter(
    (status) =>
      status.cwd.toLowerCase() === projectPath.toLowerCase() &&
      claudeStates.get(status.id)?.metrics?.sessionId === session.sessionId,
  );
  const activeWarning =
    runningMatches.length > 0 ? '\n\n该历史对话当前仍在运行；继续后会先关闭对应终端。' : '';
  if (
    !(await requestConfirmation({
      confirmLabel: '永久删除',
      message: `永久删除历史对话“${title}”？此操作无法撤销。${activeWarning}`,
      title: '删除历史对话',
      tone: 'danger',
    }))
  ) {
    return;
  }

  try {
    for (const status of runningMatches) {
      const result = await window.controlPanel.closeProject(status.id);
      renderWorkspace(result.state);
      if (!result.ok) {
        throw new Error(result.error ?? '无法关闭仍在运行的历史对话。');
      }
    }
    const deleted = await window.controlPanel.deleteClaudeSession(projectPath, session.sessionId);
    if (!deleted) {
      throw new Error('历史对话文件已不存在或无法删除。');
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
  closeButton.title = `关闭 ${status.title}`;
  closeButton.setAttribute('aria-label', `关闭对话 ${status.title}`);
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
  const activeViewAlreadyExists = terminalViews.has(state.activeSessionId);
  syncConversationTitles(state);
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
      terminalMasks.get(sessionId)?.overlay.remove();
      terminalMasks.delete(sessionId);
      view.terminal.dispose();
      view.container.remove();
      terminalViews.delete(sessionId);
    }
  }
  for (const sessionId of claudeStates.keys()) {
    if (!validSessionIds.has(sessionId)) {
      claudeStates.delete(sessionId);
      automaticConnectionTestSessions.delete(sessionId);
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
      renderDevelopmentRuntimeState(knownRuntimeState);
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

const launchCodex = async (mode: CodexLaunchMode): Promise<void> => {
  const status = activeStatus();
  if (!status || launchInProgress || codexOperationInProgress) {
    return;
  }
  launchInProgress = true;
  const existingState = codexStates.get(status.id);
  if (existingState) {
    renderCodexState(existingState);
  }
  try {
    terminalViews.get(status.id)?.terminal.clear();
    const result = await window.controlPanel.launchCodex(status.id, mode);
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
    showToast('无法启动 Codex。', 'error');
  } finally {
    launchInProgress = false;
    const latest = codexStates.get(status.id);
    if (latest) {
      renderCodexState(latest);
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
    renderCodexState(existing);
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
      renderCodexState(latest);
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
    renderCodexState(existing);
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
      renderCodexState(latest);
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
  if (!status || codexOperationInProgress || launchInProgress) {
    return;
  }
  let state = codexStates.get(status.id);
  if (!state) {
    try {
      state = await window.controlPanel.getCodexProjectState(status.id);
      renderCodexState(state);
    } catch {
      showToast('无法读取 Codex 环境。', 'error');
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
  return {
    apiKeyHelperPolicy:
      claudeApiKeyHelperPolicy.value as SaveClaudeConfigInput['apiKeyHelperPolicy'],
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
      entry.apiKeyHelperPolicy === 'inherit' ? '保留 apiKeyHelper' : 'ClaudeDock 单一凭据',
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
const unsubscribeAppWindowRestored = window.controlPanel.onAppWindowRestored(() => {
  rerunAutomaticConnectionTestForActiveProject();
});
/*
 * The main process has cancelled its own quit and handed the decision here, because only the renderer
 * knows whether a reply is still streaming. A running terminal deliberately does not count: those keep
 * running in the tray by design, and the tray balloon already says so, so warning about them would
 * turn every quit into a prompt. What is worth protecting is work that dies with the process — a
 * streaming reply, a submission in flight, or attachments still being read.
 *
 * Every path must answer, including the cancelling one, or the app becomes impossible to close.
 */
const unsubscribeAppQuitRequested = window.controlPanel.onAppQuitRequested(() => {
  const streaming = Boolean(activeChatRequestId);
  const preparing = chatSubmissionInFlight || queuedChatAttachmentImports > 0;
  if (!streaming && !preparing) {
    window.controlPanel.confirmQuit(true);
    return;
  }

  if (confirmationDialog.open) {
    // Another confirmation owns the modal; treat the quit as declined rather than dropping it.
    window.controlPanel.confirmQuit(false);
    return;
  }

  void requestConfirmation({
    confirmLabel: '退出',
    message: streaming
      ? '当前对话正在生成回复，退出会中断这次回复且无法恢复。确认要退出 ClaudeDock 吗？'
      : '当前对话正在准备发送，退出会丢弃这次发送。确认要退出 ClaudeDock 吗？',
    title: '对话正在进行中',
    tone: 'danger',
  }).then((confirmed) => {
    window.controlPanel.confirmQuit(confirmed);
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
      renderCodexState(codexState);
    } else if (claudeState) {
      renderClaudeState(claudeState);
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
window.controlPanel.onWorkspaceState(renderWorkspace);
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
    applyTerminalTheme(themeId);
  }
});
settingsLaunchAtLogin.addEventListener('change', () => {
  const requested = settingsLaunchAtLogin.checked;
  settingsLaunchAtLogin.disabled = true;
  void window.controlPanel
    .setLaunchAtLogin(requested)
    .then((settings) => {
      settingsLaunchAtLogin.checked = settings.launchAtLogin;
      showToast(settings.launchAtLogin ? '已开启开机启动' : '已关闭开机启动');
    })
    .catch(() => {
      settingsLaunchAtLogin.checked = !requested;
      showToast('无法修改开机启动设置。', 'error');
    })
    .finally(() => {
      settingsLaunchAtLogin.disabled = false;
    });
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')) {
  button.addEventListener('click', () => {
    selectSettingsTab(button.dataset.settingsTab === 'connection' ? 'connection' : 'general');
  });
}
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
chatSettingsDialog.addEventListener('click', (event) => {
  // A click that lands on the dialog element itself (not its form) is a click on the backdrop area.
  if (event.target === chatSettingsDialog) {
    chatSettingsDialog.close('cancel');
  }
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
networkPreflightPrivacy.addEventListener('change', () => {
  networkPreflightPrivacy.disabled = true;
  void window.controlPanel
    .setNetworkPreflightSettings({
      enhancedPrivacyMode: networkPreflightPrivacy.checked,
    })
    .then(() => runActiveNetworkPreflight(true, networkPreflightDialogProvider))
    .catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : '无法保存网络预检隐私设置。', 'error');
    })
    .finally(() => {
      networkPreflightPrivacy.disabled = false;
    });
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
        renderCodexState(latest);
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
          renderCodexState(latest);
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
  applyPresetUi(claudePreset.value as ClaudePreset, false);
  connectionTestResult.hidden = true;
  connectionRemedy.hidden = true;
});
claudeAuthMode.addEventListener('change', () => {
  credentialField.hidden = claudeAuthMode.value === 'existing' || claudeAuthMode.value === 'none';
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
  void purgeRouter(uninstallRouterButton);
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
      message: '清除当前项目已加密保存的接口凭据？',
      title: '清除接口凭据',
      tone: 'danger',
    })
  ) {
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
      !(await requestConfirmation({
        confirmLabel: '开启新会话',
        message: '/clear 会结束当前上下文并开启新会话，是否继续？',
        title: '清空当前上下文',
        tone: 'danger',
      }))
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
    handleOperation(await window.controlPanel.stopTerminal(status.id), '终端已停止');
  } else {
    const result = await window.controlPanel.startTerminal(status.id);
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
  unsubscribeAppQuitRequested();
  unsubscribeAppWindowRestored();
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
  for (const [sessionId, view] of terminalViews) {
    if (view.pendingFrame !== 0) {
      cancelAnimationFrame(view.pendingFrame);
    }
    rejectPermissionModeProbes(sessionId, view);
    terminalMasks.get(sessionId)?.overlay.remove();
    view.terminal.dispose();
  }
  terminalMasks.clear();
});

void (async () => {
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
    renderArtifactNetworkLog();
    if (initialSettings.theme !== activeTerminalTheme) {
      applyTerminalTheme(initialSettings.theme, false);
    }
  } catch {
    // The terminal still works without Windows-specific reflow hints; settings can be retried later.
  }
  renderWorkspace(await window.controlPanel.getWorkspace());
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
    handleOperation(await window.controlPanel.startTerminal(status.id));
  }
  void loadConnectionHistory();
  retryTerminalFitUntilMeasured();
  requestComposerFocus(status.id);
})();
