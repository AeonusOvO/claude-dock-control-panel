import type {
  ClaudeConnectionTestResult,
  ClaudeContextWindowMode,
  ClaudeEffortCompatibility,
  ClaudeEffortRequest,
  ClaudeEndpointProtocol,
  ClaudeMetrics,
  ClaudePermissionMode,
  ClaudeRouteHealth,
  ManagedChatGptContextWindowMode,
  ModelSpeedMode,
  NetworkProviderConnectivityStatus,
  NetworkProviderId,
  PtyGeneration,
  SaveClaudeConfigInput,
} from '../../shared/contracts';
import type { ClaudeConfigPresentation, ClaudeLaunchConfigSnapshot } from './config-store';
import type { ClaudeEnvironmentOverrides, ClaudeServingSpeedProfile } from './configuration';
import type { ModelSpeedCapability } from './model-speed-capabilities';
import type { ClaudeRouteKind } from '../coordination/route-lifecycle';
import type { NetworkPreflightTarget } from '../network/preflight-target';
import type { ConversationConnectionBinding } from '../conversation/preferences-store';

export interface ClaudePreparedLaunchToken {
  readonly generation: number;
  readonly sessionId: string;
}

/** Exact provider route checked before a Claude operation; custom targets are not official capability. */
export interface ClaudeNetworkAccess {
  readonly provider: NetworkProviderId;
  readonly target?: Readonly<NetworkPreflightTarget>;
}

export const captureClaudeNetworkAccess = (
  access: ClaudeNetworkAccess | undefined,
): Readonly<ClaudeNetworkAccess> | undefined =>
  access
    ? Object.freeze({
        provider: access.provider,
        ...(access.target
          ? {
              target: Object.freeze({
                process: access.target.process,
                url: new URL(access.target.url).toString(),
              }),
            }
          : {}),
      })
    : undefined;

export const effectiveClaudeNetworkAccess = (
  access: ClaudeNetworkAccess | undefined,
  officialNetworkProvider: NetworkProviderId | undefined,
  legacyTarget?: Readonly<NetworkPreflightTarget>,
): Readonly<ClaudeNetworkAccess> | undefined =>
  access ??
  (officialNetworkProvider === undefined
    ? undefined
    : captureClaudeNetworkAccess({
        provider: officialNetworkProvider,
        ...(legacyTarget === undefined ? {} : { target: legacyTarget }),
      }));

export const sameClaudeNetworkAccess = (
  left: ClaudeNetworkAccess | undefined,
  right: ClaudeNetworkAccess | undefined,
): boolean =>
  left?.provider === right?.provider &&
  left?.target?.process === right?.target?.process &&
  left?.target?.url === right?.target?.url;

export interface ClaudeLaunchPreflightEvidence {
  readonly checkedAt: number;
  readonly provider: NetworkProviderId;
  readonly status: Exclude<NetworkProviderConnectivityStatus, 'testing'>;
}

export interface ClaudeLaunchAuthorization {
  readonly cwdKey: string;
  readonly launchSnapshot: ClaudeLaunchConfigSnapshot;
  /** Exact route authority, including a main-owned custom gateway target when applicable. */
  readonly networkAccess?: Readonly<ClaudeNetworkAccess>;
  readonly officialNetworkProvider?: NetworkProviderId;
}

interface RuntimeSession {
  active: boolean;
  activityEventsPath?: string;
  /** Directory containing only this launch's settings and filesystem side-channel artifacts. */
  artifactDirectory?: string;
  /** Claude Code conversation this PTY is attached to, once the status line has reported it. */
  conversationId?: string;
  /** Complete main-owned route identity captured before this exact launch was admitted. */
  conversationBinding?: ConversationConnectionBinding;
  /** Generic Claude window selection captured for this launch and reused by live `/model`. */
  claudeContextWindowCustomTokens?: number;
  claudeContextWindowMode?: ClaudeContextWindowMode;
  contextWindowMode?: ManagedChatGptContextWindowMode;
  /** Main-only profile scope captured for this conversation; never exposed as its real cwd. */
  configScope?: string;
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
  /** Display-only network observation owned by this exact live launch object. */
  advisoryRouteHealth?: ClaudeRouteHealth;
  /** Exact provider route bound to the live PTY generation, never inferred from saved config. */
  liveNetworkAccess?: Readonly<ClaudeNetworkAccess>;
  /** Official provider capability bound separately from custom gateway identity. */
  liveOfficialNetworkProvider?: NetworkProviderId;
  /** Minimal successful launch evidence consumed once by exact-generation advisory monitoring. */
  launchPreflightEvidence?: ClaudeLaunchPreflightEvidence;
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
  /** Exact prepared launch that was atomically promoted to this live runtime. */
  launchToken?: ClaudePreparedLaunchToken;
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
  /** Complete route binding retained in main for the native conversation preference store. */
  conversationBinding: ConversationConnectionBinding;
  /** Exact provider route captured with this credential-bearing native launch. */
  networkAccess?: Readonly<ClaudeNetworkAccess>;
  /** Official provider captured separately from custom target identity, when applicable. */
  officialNetworkProvider?: NetworkProviderId;
  /** Legacy exact application target retained for compatible native launch adapters. */
  officialNetworkTarget?: Readonly<NetworkPreflightTarget>;
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
  /** Stops a route service started only for this tentative connection test when the transaction fails. */
  rollbackRouteServices?: () => Promise<void>;
  /** Exact Router compensation retained only until the owning config transaction succeeds. */
  rollbackRouterConfig?: () => Promise<void>;
}

interface PreparedOpenAiConnection {
  effectiveInput: SaveClaudeConfigInput;
  historyMetadata: ConnectionHistoryMetadata;
  presentation: ClaudeConfigPresentation;
  rollbackRouterConfig: () => Promise<void>;
}

interface ConnectionCheckRecord {
  fingerprint: string;
  result: ClaudeConnectionTestResult;
}

export interface PreparedClaudeLaunch {
  command: string;
  environment: ClaudeEnvironmentOverrides;
  /** Exact route derived from the immutable launch snapshot, including custom gateway targets. */
  networkAccess?: Readonly<ClaudeNetworkAccess>;
  /** Exact official provider derived separately from the immutable launch snapshot. */
  officialNetworkProvider?: NetworkProviderId;
  /** Bound PTY that remains live until this exact launch token binds a replacement. */
  predecessorPtyGeneration?: PtyGeneration;
  /** Single-use identity for binding or aborting only this prepared launch. */
  token: ClaudePreparedLaunchToken;
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
