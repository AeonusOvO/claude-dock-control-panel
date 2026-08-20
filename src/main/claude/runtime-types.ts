import type {
  ClaudeConnectionTestResult,
  ClaudeContextWindowMode,
  ClaudeEffortCompatibility,
  ClaudeEffortRequest,
  ClaudeEndpointProtocol,
  ClaudeMetrics,
  ClaudePermissionMode,
  ManagedChatGptContextWindowMode,
  ModelSpeedMode,
  PtyGeneration,
  SaveClaudeConfigInput,
} from '../../shared/contracts';
import type { ClaudeConfigPresentation } from './config-store';
import type { ClaudeEnvironmentOverrides, ClaudeServingSpeedProfile } from './configuration';
import type { ModelSpeedCapability } from './model-speed-capabilities';
import type { ClaudeRouteKind } from '../coordination/route-lifecycle';

interface RuntimeSession {
  active: boolean;
  activityEventsPath?: string;
  /** Directory containing only this launch's settings and filesystem side-channel artifacts. */
  artifactDirectory?: string;
  /** Claude Code conversation this PTY is attached to, once the status line has reported it. */
  conversationId?: string;
  /** Generic Claude window selection captured for this launch and reused by live `/model`. */
  claudeContextWindowCustomTokens?: number;
  claudeContextWindowMode?: ClaudeContextWindowMode;
  contextWindowMode?: ManagedChatGptContextWindowMode;
  cwd: string;
  diagnosticBuffer: string;
  /** Temporary retry cap installed after Claude Code combines high effort with disabled thinking. */
  effortCompatibility?: ClaudeEffortCompatibility;
  /** Main-conversation effort restored after one successful compatibility retry finishes. */
  effortRestoreAfterTurn?: ClaudeEffortRequest;
  effortRestoreInProgress: boolean;
  /** Effort last requested from the status bar, until the status line reports what was applied. */
  effortRequest?: ClaudeEffortRequest;
  exitMarker?: string;
  expectedModel?: string;
  lastApiError?: {
    category: 'context-window-exceeded' | 'effort-thinking-disabled' | 'general';
    detectedAt: number;
    detail: string;
  };
  launchedConfigFingerprint?: string;
  launchedAt?: number;
  launchedCliVersion?: string;
  /** Monotonic owner of the settings, hooks, status line, and artifacts for this launch. */
  launchGeneration?: number;
  /** Serving-speed preference baked into this PTY launch, before any manual TUI changes. */
  launchedSpeedPreference?: ModelSpeedMode;
  launchedSpeedSignature?: string;
  launchedSpeedTargetKey?: string;
  markerRemainder: string;
  metrics?: ClaudeMetrics;
  metricsPath?: string;
  /** Model id passed only to Claude Code; persisted identity remains `expectedModel`. */
  runtimeModel?: string;
  /** Depth remembered for the resumed conversation, replayed once its TUI accepts commands. */
  pendingEffortRestore?: ClaudeEffortRequest;
  /** Earliest moment `pendingEffortRestore` may be submitted; a fresh TUI ignores instant input. */
  pendingEffortRestoreAt?: number;
  /** Live mode read off the TUI badge; undefined until the badge has been painted once. */
  permissionMode?: ClaudePermissionMode;
  /** Last ClaudeDock request, kept separate while the TUI still reports the previous mode. */
  permissionModeRequest?: ClaudePermissionMode;
  /** Modes this session has actually shown, in first-seen order. */
  permissionModeCycle: ClaudePermissionMode[];
  /** Exact PowerShell/ConPTY instance this runtime may observe or mutate. */
  ptyGeneration?: PtyGeneration;
  routeKind?: ClaudeRouteKind;
  sessionId: string;
  /** Latest `signaledAt` consumed from signal.json, so each signal is only acted on once. */
  signalSeenAt?: number;
  signalPath?: string;
  settingsPath?: string;
  thinkingEnabledForHighEffort: boolean;
  /** Top-level Stop hook signal; subagent completions are deliberately filtered by the helper. */
  turnStopPath?: string;
  turnStopSeenAt?: number;
  /** Resolved by the next PostCompact signal; lets a relaunch wait for compaction to finish. */
  waitingForCompact?: (signaledAt: number) => void;
}

export interface PreparedNativeClaudeConversation {
  allowBypassPermissions: boolean;
  cliVersion?: string;
  configFingerprint: string;
  endpointIdentity: string;
  environment: ClaudeEnvironmentOverrides;
  model: string;
  runtimeModel: string;
  settingsEnvironment: Record<string, string>;
}

interface ConnectionHistoryMetadata {
  name?: string;
  protocol: ClaudeEndpointProtocol;
  routerProviderId?: string;
  sourceConfig?: SaveClaudeConfigInput;
  sourceCredential?: string;
  sourceCredentialConfigured?: boolean;
}

export interface PreparedClaudeConfigSave {
  historyMetadata?: ConnectionHistoryMetadata;
  input: SaveClaudeConfigInput;
  presentation?: ClaudeConfigPresentation;
}

interface PreparedOpenAiConnection {
  effectiveInput: SaveClaudeConfigInput;
  historyMetadata: ConnectionHistoryMetadata;
  presentation: ClaudeConfigPresentation;
}

interface ConnectionCheckRecord {
  fingerprint: string;
  result: ClaudeConnectionTestResult;
}

export interface PreparedClaudeLaunch {
  command: string;
  environment: ClaudeEnvironmentOverrides;
  /** Bound PTY replaced by this prepared launch, if one still owned the runtime at commit time. */
  predecessorPtyGeneration?: PtyGeneration;
}

export interface PreparedClaudeSpeedRelaunch extends PreparedClaudeLaunch {
  preference: ModelSpeedMode;
  targetKey: string;
}

interface ResolvedModelSpeed {
  capability: ModelSpeedCapability;
  preference: ModelSpeedMode;
  profile: ClaudeServingSpeedProfile;
  signature: string;
  targetKey: string;
}

interface ClaudeLaunchOverrides {
  model?: string;
  speed?: ModelSpeedMode;
}

export type {
  ClaudeLaunchOverrides,
  ConnectionCheckRecord,
  ConnectionHistoryMetadata,
  PreparedOpenAiConnection,
  ResolvedModelSpeed,
  RuntimeSession,
};
