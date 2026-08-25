import { ipcRenderer } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeExecutionSettingsDto, ControlPanelApi } from '../../src/shared/contracts';
import {
  CHANNELS,
  EVENT_CHANNELS,
  IPC_CHANNELS,
  REQUEST_CHANNELS,
  SEND_CHANNELS,
} from '../../src/shared/ipc/channels';
import { IPC_EVENT_METHODS, IPC_REQUESTS, IPC_SEND_METHODS } from '../../src/shared/ipc/schema';
import { appBridge } from '../../src/preload/bridges/app';
import { applicationProxyBridge } from '../../src/preload/bridges/application-proxy';
import { artifactBridge } from '../../src/preload/bridges/artifact';
import { busyBridge } from '../../src/preload/bridges/busy';
import { chatBridge } from '../../src/preload/bridges/chat';
import { claudeBridge } from '../../src/preload/bridges/claude';
import { claudeExecutionSettingsBridge } from '../../src/preload/bridges/claude-execution-settings';
import { claudePluginBridge } from '../../src/preload/bridges/claude-plugin';
import { codexBridge } from '../../src/preload/bridges/codex';
import { downloadBridge } from '../../src/preload/bridges/download';
import { managedChatgptBridge } from '../../src/preload/bridges/managed-chatgpt';
import { mcpBridge } from '../../src/preload/bridges/mcp';
import { nativeAttachmentBridge } from '../../src/preload/bridges/native-attachment';
import { nativeConversationBridge } from '../../src/preload/bridges/native-conversation';
import { networkPreflightBridge } from '../../src/preload/bridges/network-preflight';
import { onboardingBridge } from '../../src/preload/bridges/onboarding';
import { routerBridge } from '../../src/preload/bridges/router';
import { runtimeBridge } from '../../src/preload/bridges/runtime';
import { softwareUpdateBridge } from '../../src/preload/bridges/software-update';
import { terminalBridge } from '../../src/preload/bridges/terminal';
import { workspaceBridge } from '../../src/preload/bridges/workspace';
import { createMainHarness } from '../helpers/main-harness';

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}));

const bridgeFragments = [
  appBridge,
  workspaceBridge,
  terminalBridge,
  busyBridge,
  runtimeBridge,
  downloadBridge,
  applicationProxyBridge,
  artifactBridge,
  chatBridge,
  networkPreflightBridge,
  onboardingBridge,
  nativeConversationBridge,
  nativeAttachmentBridge,
  claudeBridge,
  claudeExecutionSettingsBridge,
  claudePluginBridge,
  managedChatgptBridge,
  routerBridge,
  codexBridge,
  mcpBridge,
  softwareUpdateBridge,
] as const;

const api = Object.assign({}, ...bridgeFragments) satisfies ControlPanelApi;

const executionValues = {
  concurrentSubagents: 8,
  spawnDepth: 2,
  toolSearch: 'auto:25' as const,
  toolUseConcurrency: 8,
};

const executionSettingsDto: ClaudeExecutionSettingsDto = {
  catalogVersion: 1,
  effective: {
    concurrentSubagents: {
      defaultValue: 4,
      effectiveValue: 8,
      reason: '并发子代理设置已应用。',
      requestedValue: 8,
      source: { kind: 'version-matrix' },
      status: 'supported',
    },
    spawnDepth: {
      defaultValue: 1,
      effectiveValue: 2,
      reason: '子代理深度设置已应用。',
      requestedValue: 2,
      source: { kind: 'version-matrix' },
      status: 'supported',
    },
    toolSearch: {
      defaultValue: 'auto',
      effectiveValue: 'auto:25',
      reason: '工具搜索设置已应用。',
      requestedValue: 'auto:25',
      source: { kind: 'verified-evidence', verifiedAt: 1 },
      status: 'supported',
    },
    toolUseConcurrency: {
      defaultValue: 4,
      effectiveValue: 8,
      reason: '工具并发设置已应用。',
      requestedValue: 8,
      source: { kind: 'version-matrix' },
      status: 'supported',
    },
  },
  installation: { installed: true, version: '2.1.0' },
  profiles: [
    { id: 'token-saver', label: '最省 Token', values: executionValues },
    { id: 'restrained', label: '节制', values: executionValues },
    { id: 'balanced', label: '均衡（推荐）', values: executionValues },
    { id: 'high-throughput', label: '高吞吐', values: executionValues },
    { id: 'best-performance', label: '最佳性能', values: executionValues },
  ],
  requested: { mode: 'profile', profileId: 'balanced' },
  version: 1,
};

describe('IPC contract consistency', () => {
  it('keeps the channel partitions complete and disjoint', () => {
    expect(REQUEST_CHANNELS).toHaveLength(171);
    expect(SEND_CHANNELS).toHaveLength(7);
    expect(EVENT_CHANNELS).toHaveLength(23);
    expect(IPC_CHANNELS).toHaveLength(201);
    expect(new Set(IPC_CHANNELS).size).toBe(201);
    expect(new Set([...REQUEST_CHANNELS, ...SEND_CHANNELS, ...EVENT_CHANNELS])).toEqual(
      new Set(IPC_CHANNELS),
    );
    expect(Object.keys(IPC_REQUESTS)).toEqual(REQUEST_CHANNELS);
    expect(Object.keys(IPC_SEND_METHODS)).toEqual(SEND_CHANNELS);
    expect(Object.keys(IPC_EVENT_METHODS)).toEqual(EVENT_CHANNELS);
  });

  it('registers every renderer-to-main channel exactly once in the real composition', async () => {
    const harness = await createMainHarness();
    try {
      const requests = harness.ipc.registrations
        .filter(({ kind }) => kind === 'handle')
        .map(({ channel }) => channel);
      expect(requests).toHaveLength(REQUEST_CHANNELS.length);
      expect(new Set(requests)).toEqual(new Set(REQUEST_CHANNELS));
      expect(new Set(harness.ipc.handlers.keys())).toEqual(new Set(REQUEST_CHANNELS));

      const sends = harness.ipc.registrations
        .filter(({ kind }) => kind === 'main-listener')
        .map(({ channel }) => channel);
      expect(sends).toHaveLength(SEND_CHANNELS.length);
      expect(new Set(sends)).toEqual(new Set(SEND_CHANNELS));
    } finally {
      harness.restore();
    }
  });

  it('invokes every shared request channel exactly once through the real preload fragments', () => {
    const invoke = vi.mocked(ipcRenderer.invoke);
    invoke.mockClear();
    invoke.mockResolvedValue(executionSettingsDto);

    for (const { method } of Object.values(IPC_REQUESTS)) {
      const endpoint = api[method] as (...args: unknown[]) => unknown;
      Reflect.apply(endpoint, api, []);
    }

    const invokedChannels = invoke.mock.calls.map(([channel]) => channel);
    expect(invokedChannels).toHaveLength(REQUEST_CHANNELS.length);
    expect(invokedChannels).toEqual(REQUEST_CHANNELS);
    expect(new Set(invokedChannels)).toEqual(new Set(REQUEST_CHANNELS));
  });

  it('forwards application refresh intent without invoking the download route', async () => {
    const invoke = vi.mocked(ipcRenderer.invoke);
    invoke.mockClear();

    await api.getApplicationUpdaterState();
    await api.getApplicationUpdaterState(false);
    await api.getApplicationUpdaterState(true);

    expect(invoke.mock.calls).toEqual([
      [CHANNELS.SOFTWARE_APPLICATION_UPDATER_GET, false],
      [CHANNELS.SOFTWARE_APPLICATION_UPDATER_GET, false],
      [CHANNELS.SOFTWARE_APPLICATION_UPDATER_GET, true],
    ]);
    expect(invoke).not.toHaveBeenCalledWith(CHANNELS.SOFTWARE_APPLICATION_UPDATER_DOWNLOAD);
  });

  it('parses Claude execution-settings responses before exposing them to the renderer', async () => {
    const invoke = vi.mocked(ipcRenderer.invoke);
    invoke.mockResolvedValueOnce(executionSettingsDto);
    await expect(api.getClaudeExecutionSettings()).resolves.toEqual(executionSettingsDto);

    invoke.mockResolvedValueOnce({
      ...executionSettingsDto,
      environment: { ANTHROPIC_AUTH_TOKEN: 'secret' },
    });
    await expect(api.useRecommendedClaudeExecutionSettings()).rejects.toThrow();

    invoke.mockResolvedValueOnce({
      ...executionSettingsDto,
      effective: {
        ...executionSettingsDto.effective,
        concurrentSubagents: {
          ...executionSettingsDto.effective.concurrentSubagents,
          operation: { kind: 'set', value: '8' },
        },
      },
    });
    await expect(api.restoreClaudeExecutionSettingsDefault()).rejects.toThrow();
  });

  it('assembles all 201 API members without duplicate bridge ownership', () => {
    const declaredMembers = bridgeFragments.flatMap((fragment) => Object.keys(fragment));
    expect(declaredMembers).toHaveLength(201);
    expect(new Set(declaredMembers).size).toBe(201);
    expect(Object.keys(api)).toHaveLength(201);
  });

  it('maps every IPC-backed member and records the local and auxiliary exceptions', () => {
    const requestMethods = Object.values(IPC_REQUESTS).map(({ method }) => method);
    const sendMethods = Object.values(IPC_SEND_METHODS);
    const eventMethods = Object.values(IPC_EVENT_METHODS);
    expect(new Set(requestMethods).size).toBe(171);
    expect(new Set(sendMethods).size).toBe(7);
    expect(new Set(eventMethods).size).toBe(23);

    const mappedMethods = new Set<keyof ControlPanelApi>([
      ...requestMethods,
      ...sendMethods,
      ...eventMethods,
    ]);
    expect(mappedMethods.size).toBe(200);
    expect(
      Object.keys(api).filter((method) => !mappedMethods.has(method as keyof ControlPanelApi)),
    ).toEqual(['getDroppedPath']);
    expect([...sendMethods].filter((method) => eventMethods.includes(method as never))).toEqual([
      'onAppQuitRequested',
    ]);
  });
});
