import type { TerminalThemeId } from '../ui/terminal-themes';
import type { ChatIdleTimeoutMinutes } from './chat';

export type CloseBehavior = 'exit' | 'tray';

export type BusyKind =
  'configure' | 'conversation' | 'download' | 'install' | 'proxy' | 'uninstall';

export type BusySeverity = 'blocking' | 'resumable';

export interface BusyLease {
  readonly action?:
    'configure' | 'disable' | 'enable' | 'install' | 'refresh' | 'remove' | 'uninstall' | 'update';
  readonly cancellable: boolean;
  readonly domain?:
    'claude-code' | 'conversation' | 'gateway' | 'mcp' | 'plugin' | 'router' | 'system';
  readonly id: string;
  readonly kind: BusyKind;
  readonly label: string;
  readonly logTail?: string[];
  readonly queuePosition?: number;
  readonly queueTotal?: number;
  readonly severity: BusySeverity;
  readonly stage?: string;
  readonly startedAt?: number;
  readonly target?: string;
}

export interface AppQuitRequest {
  hasBlocking: boolean;
  leases: BusyLease[];
  /** Cleanup could not prove that every verified PTY descendant stopped; only retry/force are safe. */
  runtimeCleanupFailed?: boolean;
}

export type AppQuitDecision = boolean | 'retry';

/**
 * Opt-in workarounds for relay-side protocol quirks. Every switch is off by default: a relay that
 * behaves correctly must not carry the cost of a fix it does not need.
 */
export interface AdvancedSettings {
  /** Zero leaves slow conversations running until the user stops them. */
  chatIdleTimeoutMinutes: ChatIdleTimeoutMinutes;
  /**
   * Routes WebSearch and WebFetch through a dedicated subagent instead of the main conversation.
   * Turn this on when the relay refuses web search once the model is raised to high effort.
   */
  webResearchIsolation: boolean;
}

export type FooterResourcePreference = 'auto' | 'context' | 'quota';

export type ManagedChatGptContextWindowMode = 'extended' | 'standard';

/**
 * Claude Code derives its context window from the model id, so a gateway that serves a 1M window
 * behind a plain `claude-opus-5` name is held to 200k and auto-compacts far too early. This mode
 * lets the user state the intended window explicitly. `auto` keeps Claude Code's own judgement,
 * which is the only safe default for official subscriptions without 1M entitlement. An explicit
 * value is a user declaration, not proof that the configured endpoint supports that capacity.
 */
export type ClaudeContextWindowMode = 'auto' | 'custom' | 'extended' | 'standard';

export interface AppSettingsView {
  advanced: AdvancedSettings;
  artifactNetworkAllowed?: boolean;
  claudeContextWindowCustomTokens?: number;
  claudeContextWindowMode: ClaudeContextWindowMode;
  closeBehavior: CloseBehavior;
  footerResourcePreference: FooterResourcePreference;
  managedChatGptContextWindowMode: ManagedChatGptContextWindowMode;
  language: 'zh-CN';
  launchAtLogin: boolean;
  theme: TerminalThemeId;
  version: string;
  /** Windows kernel build passed to xterm's ConPTY compatibility layer. */
  windowsBuildNumber?: number;
}
