import { expect } from 'vitest';
import type { ConversationSnapshot } from '../../src/shared/conversation/native';
import type { ClaudePluginCatalog, ControlPanelApi, McpCatalog } from '../../src/shared/contracts';
import { rendererStyles } from './renderer-css';
import { createRendererHarness, type RendererHarness } from './renderer-harness';
import {
  claudeProjectState,
  installFakeTerminalModules,
  terminalWorkspace,
  type FakeTerminalControl,
} from './renderer-terminal-fixture';

export const settle = async (harness: RendererHarness): Promise<void> => {
  await new Promise<void>((resolve) => harness.dom.window.setTimeout(resolve, 20));
  await harness.flush();
};

export const withRenderer = async (
  overrides: Partial<ControlPanelApi>,
  run: (harness: RendererHarness) => Promise<void> | void,
): Promise<void> => {
  const harness = await createRendererHarness(overrides);
  try {
    await run(harness);
  } finally {
    await harness.cleanup();
  }
};

export const withTerminalRenderer = async (
  overrides: Partial<ControlPanelApi>,
  run: (harness: RendererHarness, control: FakeTerminalControl) => Promise<void> | void,
): Promise<void> => {
  const control = installFakeTerminalModules();
  let harness: RendererHarness | undefined;
  try {
    harness = await createRendererHarness({
      getClaudeProjectState: async () => claudeProjectState({ active: true, ptyGeneration: 1 }),
      getWorkspace: async () => terminalWorkspace(),
      ...overrides,
    });
    await settle(harness);
    await run(harness, control);
  } finally {
    await harness?.cleanup();
    control.uninstall();
  }
};

export const withNativeRenderer = async (
  snapshot: ConversationSnapshot,
  overrides: Partial<ControlPanelApi>,
  run: (harness: RendererHarness) => Promise<void> | void,
): Promise<void> =>
  withTerminalRenderer(
    {
      adoptTerminalConversation: async () => ({
        conversationId: snapshot.conversationId,
        ok: true,
        snapshot,
      }),
      ...overrides,
    },
    async (harness) => {
      harness.emit('onWorkspaceState', terminalWorkspace());
      await settle(harness);
      harness.emit(
        'onClaudeState',
        claudeProjectState({ active: true, ptyGeneration: 1, stateRevision: 2 }),
      );
      await harness.flush();
      harness.click('#native-terminal-toggle');
      await settle(harness);
      await run(harness);
    },
  );

export const change = (element: HTMLInputElement | HTMLSelectElement, value?: string): void => {
  if (value !== undefined) element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
};

export const input = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

export const expectCss = (pattern: RegExp): void => {
  expect(rendererStyles).toMatch(pattern);
};

export const plugin = (
  name: string,
  overrides: Partial<ClaudePluginCatalog['available'][number]> = {},
): ClaudePluginCatalog['available'][number] => ({
  description: `${name} description`,
  enabled: false,
  installed: false,
  marketplaceName: 'official',
  name,
  pluginId: `${name}@official`,
  sourceLabel: `official/${name}`,
  updateAvailable: false,
  ...overrides,
});

export const pluginCatalog = (
  available: ClaudePluginCatalog['available'],
  installed: ClaudePluginCatalog['installed'] = [],
): ClaudePluginCatalog => ({
  available,
  checkedAt: 1,
  cliAvailable: true,
  installed,
  marketplaces: [],
  message: '插件列表已加载。',
  updatesAvailable: 0,
});

export const mcpCatalog = (names: readonly string[]): McpCatalog => ({
  available: names.map((name) => ({
    config: { command: 'node' },
    description: `${name} description`,
    featured: true,
    id: name,
    name,
    requiresCredential: false,
    transport: 'stdio',
  })),
  checkedAt: 1,
  installed: [],
  message: 'MCP 已加载。',
  registryAvailable: true,
});
