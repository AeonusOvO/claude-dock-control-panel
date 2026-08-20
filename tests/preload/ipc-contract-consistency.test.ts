import { ipcRenderer } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPanelApi } from '../../src/shared/contracts';
import {
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
import { claudePluginBridge } from '../../src/preload/bridges/claude-plugin';
import { codexBridge } from '../../src/preload/bridges/codex';
import { downloadBridge } from '../../src/preload/bridges/download';
import { managedChatgptBridge } from '../../src/preload/bridges/managed-chatgpt';
import { mcpBridge } from '../../src/preload/bridges/mcp';
import { nativeAttachmentBridge } from '../../src/preload/bridges/native-attachment';
import { nativeConversationBridge } from '../../src/preload/bridges/native-conversation';
import { networkPreflightBridge } from '../../src/preload/bridges/network-preflight';
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
  nativeConversationBridge,
  nativeAttachmentBridge,
  claudeBridge,
  claudePluginBridge,
  managedChatgptBridge,
  routerBridge,
  codexBridge,
  mcpBridge,
  softwareUpdateBridge,
] as const;

const api = Object.assign({}, ...bridgeFragments) satisfies ControlPanelApi;

describe('IPC contract consistency', () => {
  it('keeps the channel partitions complete and disjoint', () => {
    expect(REQUEST_CHANNELS).toHaveLength(159);
    expect(SEND_CHANNELS).toHaveLength(7);
    expect(EVENT_CHANNELS).toHaveLength(22);
    expect(IPC_CHANNELS).toHaveLength(188);
    expect(new Set(IPC_CHANNELS).size).toBe(188);
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

    for (const { method } of Object.values(IPC_REQUESTS)) {
      const endpoint = api[method] as (...args: unknown[]) => unknown;
      Reflect.apply(endpoint, api, []);
    }

    const invokedChannels = invoke.mock.calls.map(([channel]) => channel);
    expect(invokedChannels).toHaveLength(REQUEST_CHANNELS.length);
    expect(invokedChannels).toEqual(REQUEST_CHANNELS);
    expect(new Set(invokedChannels)).toEqual(new Set(REQUEST_CHANNELS));
  });

  it('assembles all 188 API members without duplicate bridge ownership', () => {
    const declaredMembers = bridgeFragments.flatMap((fragment) => Object.keys(fragment));
    expect(declaredMembers).toHaveLength(188);
    expect(new Set(declaredMembers).size).toBe(188);
    expect(Object.keys(api)).toHaveLength(188);
  });

  it('maps every IPC-backed member and records the local and auxiliary exceptions', () => {
    const requestMethods = Object.values(IPC_REQUESTS).map(({ method }) => method);
    const sendMethods = Object.values(IPC_SEND_METHODS);
    const eventMethods = Object.values(IPC_EVENT_METHODS);
    expect(new Set(requestMethods).size).toBe(159);
    expect(new Set(sendMethods).size).toBe(7);
    expect(new Set(eventMethods).size).toBe(22);

    const mappedMethods = new Set<keyof ControlPanelApi>([
      ...requestMethods,
      ...sendMethods,
      ...eventMethods,
    ]);
    expect(mappedMethods.size).toBe(187);
    expect(
      Object.keys(api).filter((method) => !mappedMethods.has(method as keyof ControlPanelApi)),
    ).toEqual(['getDroppedPath']);
    expect([...sendMethods].filter((method) => eventMethods.includes(method as never))).toEqual([
      'onAppQuitRequested',
    ]);
  });
});
