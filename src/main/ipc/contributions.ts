import { registerAppIpc } from './app';
import { registerArtifactIpc } from './artifact';
import { registerBusyIpc } from './busy';
import { registerChatIpc } from './chat';
import { registerClaudeConnectionIpc } from './claude-connection';
import { registerClaudeControlsIpc } from './claude-controls';
import { registerClaudeExecutionSettingsIpc } from './claude-execution-settings';
import { registerClaudeLaunchIpc } from './claude-launch';
import { registerClaudePluginIpc } from './claude-plugin';
import { registerClaudeStateIpc } from './claude-state';
import { registerCodexIpc } from './codex';
import type { IpcContribution } from './contribution';
import { registerConversationIpc } from './conversation';
import { registerConversationAttachmentIpc } from './conversation-attachment';
import { registerDownloadIpc } from './download';
import { registerManagedChatGptIpc } from './managed-chatgpt';
import { registerSubscriptionIpc } from './subscription';
import { registerMcpIpc } from './mcp';
import { registerNetworkIpc } from './network';
import { registerOnboardingIpc } from './onboarding';
import { registerProjectIpc } from './project';
import { registerProxyIpc } from './proxy';
import { registerRouterIpc } from './router';
import { registerRuntimeIpc } from './runtime';
import { registerSessionIpc } from './session';
import { registerSoftwareIpc } from './software';
import { registerTerminalIpc } from './terminal';

export const MAIN_IPC_CONTRIBUTIONS = [
  registerConversationAttachmentIpc,
  registerConversationIpc,
  registerBusyIpc,
  registerRuntimeIpc,
  registerClaudeControlsIpc,
  registerDownloadIpc,
  registerProxyIpc,
  registerNetworkIpc,
  registerAppIpc,
  registerOnboardingIpc,
  registerArtifactIpc,
  registerChatIpc,
  registerProjectIpc,
  registerTerminalIpc,
  registerClaudeStateIpc,
  registerClaudeExecutionSettingsIpc,
  registerCodexIpc,
  registerManagedChatGptIpc,
  registerSubscriptionIpc,
  registerRouterIpc,
  registerClaudeConnectionIpc,
  registerClaudeLaunchIpc,
  registerSessionIpc,
  registerClaudePluginIpc,
  registerMcpIpc,
  registerSoftwareIpc,
] as const satisfies readonly IpcContribution<never>[];
