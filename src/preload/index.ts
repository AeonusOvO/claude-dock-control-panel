import { contextBridge } from 'electron';
import type { ControlPanelApi } from '../shared/contracts';
import { appBridge } from './bridges/app';
import { workspaceBridge } from './bridges/workspace';
import { terminalBridge } from './bridges/terminal';
import { busyBridge } from './bridges/busy';
import { runtimeBridge } from './bridges/runtime';
import { downloadBridge } from './bridges/download';
import { applicationProxyBridge } from './bridges/application-proxy';
import { artifactBridge } from './bridges/artifact';
import { chatBridge } from './bridges/chat';
import { networkPreflightBridge } from './bridges/network-preflight';
import { onboardingBridge } from './bridges/onboarding';
import { nativeConversationBridge } from './bridges/native-conversation';
import { nativeAttachmentBridge } from './bridges/native-attachment';
import { claudeBridge } from './bridges/claude';
import { claudeExecutionSettingsBridge } from './bridges/claude-execution-settings';
import { claudePluginBridge } from './bridges/claude-plugin';
import { managedChatgptBridge } from './bridges/managed-chatgpt';
import { routerBridge } from './bridges/router';
import { codexBridge } from './bridges/codex';
import { mcpBridge } from './bridges/mcp';
import { softwareUpdateBridge } from './bridges/software-update';

const api = {
  ...appBridge,
  ...workspaceBridge,
  ...terminalBridge,
  ...busyBridge,
  ...runtimeBridge,
  ...downloadBridge,
  ...applicationProxyBridge,
  ...artifactBridge,
  ...chatBridge,
  ...networkPreflightBridge,
  ...onboardingBridge,
  ...nativeConversationBridge,
  ...nativeAttachmentBridge,
  ...claudeBridge,
  ...claudeExecutionSettingsBridge,
  ...claudePluginBridge,
  ...managedChatgptBridge,
  ...routerBridge,
  ...codexBridge,
  ...mcpBridge,
  ...softwareUpdateBridge,
} satisfies ControlPanelApi;

contextBridge.exposeInMainWorld('controlPanel', api);
