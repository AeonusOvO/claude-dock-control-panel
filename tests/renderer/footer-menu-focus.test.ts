import { describe, expect, it } from 'vitest';
import type { ConversationSnapshot } from '../../src/shared/conversation/native';
import type {
  AppSettingsView,
  ClaudeProjectState,
  ControlPanelApi,
} from '../../src/shared/contracts';
import { clampPercentage } from '../../src/renderer/platform/percentage-utils';
import { rendererStyles } from '../helpers/renderer-css';
import { createRendererHarness, type RendererHarness } from '../helpers/renderer-harness';
import {
  claudeProjectState,
  installFakeTerminalModules,
  nativeSnapshot,
  terminalWorkspace,
  type FakeTerminalControl,
} from '../helpers/renderer-terminal-fixture';

const appSettings = (overrides: Partial<AppSettingsView> = {}): AppSettingsView => ({
  advanced: {
    chatIdleTimeoutMinutes: 0,
    networkPreflight: { checkOnNewSession: true, checkOnProviderLogin: true },
    webResearchIsolation: false,
  },
  artifactNetworkAllowed: true,
  claudeContextWindowMode: 'auto',
  closeBehavior: 'tray',
  conversationResume: {
    autoLoadLastConversationModelOnStartup: true,
    autoLoadLastConversationOnStartup: true,
    modelMismatchBehavior: 'ask',
  },
  footerResourcePreference: 'auto',
  language: 'zh-CN',
  launchAtLogin: false,
  managedChatGptContextWindowMode: 'standard',
  theme: 'claude',
  version: 'test',
  ...overrides,
});

const settle = async (harness: RendererHarness): Promise<void> => {
  await new Promise<void>((resolve) => harness.dom.window.setTimeout(resolve, 20));
  await harness.flush();
};

const withRenderer = async (
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

const withTerminalRenderer = async (
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

const withNativeRenderer = async (
  snapshot: ConversationSnapshot,
  state: ClaudeProjectState,
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
      getClaudeProjectState: async () => state,
      ...overrides,
    },
    async (harness) => {
      harness.emit('onWorkspaceState', terminalWorkspace());
      await settle(harness);
      harness.emit('onClaudeState', {
        ...state,
        ptyGeneration: 1,
        stateRevision: state.stateRevision + 1,
      });
      await harness.flush();
      harness.click('#native-terminal-toggle');
      await settle(harness);
      await run(harness);
    },
  );

describe('Footer resource percentage clamping', () => {
  it('clamps percentages to the displayable range', () => {
    expect(clampPercentage(150)).toBe(100);
    expect(clampPercentage(99.7)).toBe(99.7);
    expect(clampPercentage(-5)).toBe(0);
    expect(clampPercentage(0)).toBe(0);
    expect(clampPercentage(100)).toBe(100);
    expect(clampPercentage(50.5)).toBe(50.5);
    expect(clampPercentage(undefined)).toBe(undefined);
  });
});

describe('Footer menu CSS and HTML semantics', () => {
  it('paints selected radio controls from their accessible state', () => {
    expect(rendererStyles).toMatch(/button\[role='radio'\]\[aria-checked='true'\]\s*\{/u);
  });

  it('groups resource preferences as accessible radio controls', async () => {
    await withRenderer({}, (harness) => {
      const group = harness.query('[aria-label="资源显示偏好"]');
      expect(group.getAttribute('role')).toBe('radiogroup');
      expect(group.querySelectorAll('[role="radio"][data-resource-preference]')).toHaveLength(3);
    });
  });

  it('connects every footer trigger to the menu it controls', async () => {
    await withRenderer({}, (harness) => {
      for (const id of ['model', 'speed', 'mode', 'effort']) {
        expect(harness.query(`#footer-${id}`).getAttribute('aria-controls')).toBe(
          `footer-${id}-menu`,
        );
      }
    });
  });
});

describe('Footer menu item focus restoration', () => {
  it('closes the selected menu and restores focus to its trigger', async () => {
    await withNativeRenderer(
      nativeSnapshot(),
      claudeProjectState({ active: true, ptyGeneration: 1 }),
      { updateNativeConversationControls: async () => ({ ok: true }) },
      async (harness) => {
        const trigger = harness.query<HTMLButtonElement>('#footer-effort');
        trigger.click();
        harness
          .query<HTMLButtonElement>('#footer-effort-menu button[aria-checked="false"]')
          .click();
        await settle(harness);
        expect(harness.query('#footer-effort-menu').hasAttribute('hidden')).toBe(true);
        expect(harness.document.activeElement).toBe(trigger);
      },
    );
  });
});

describe('Footer menu native conversation refresh logic', () => {
  it('re-renders the native footer after managed-window and resource-preference changes', async () => {
    const baseState = claudeProjectState();
    const state = claudeProjectState({
      active: true,
      config: {
        ...baseState.config,
        model: 'gpt-5.6-sol',
        preset: 'chatgpt-subscription',
      },
      ptyGeneration: 1,
    });
    const baseSnapshot = nativeSnapshot();
    const snapshot = nativeSnapshot({
      capabilities: {
        ...baseSnapshot.capabilities!,
        model: 'gpt-5.6-sol',
      },
      usage: { inputTokens: 27_200 },
    });

    await withNativeRenderer(
      snapshot,
      state,
      {
        setFooterResourcePreference: async () =>
          appSettings({
            footerResourcePreference: 'context',
            managedChatGptContextWindowMode: 'extended',
          }),
        setManagedChatGptContextWindowMode: async () =>
          appSettings({ managedChatGptContextWindowMode: 'extended' }),
      },
      async (harness) => {
        expect(harness.query('#footer-context-label').textContent).toBe('上下文 10%');
        harness.clearCalls();
        harness.click('#footer-resource');
        harness.query<HTMLButtonElement>('[data-context-window-mode="extended"]').click();
        await settle(harness);
        expect(harness.method('setManagedChatGptContextWindowMode')).toHaveBeenCalledWith(
          'extended',
        );
        expect(harness.query('#footer-context-label').textContent).toBe('上下文 3%');
        expect(harness.document.activeElement).toBe(harness.query('#footer-resource'));

        harness.click('#footer-resource');
        const preference = harness.query<HTMLButtonElement>('[data-resource-preference="context"]');
        expect(preference.getAttribute('aria-checked')).toBe('false');
        preference.click();
        await settle(harness);
        expect(harness.method('setFooterResourcePreference')).toHaveBeenCalledWith('context');
        expect(preference.getAttribute('aria-checked')).toBe('true');
        expect(harness.query('#footer-resource-menu').hasAttribute('hidden')).toBe(true);
        expect(harness.document.activeElement).toBe(harness.query('#footer-resource'));
      },
    );
  });

  it('re-renders the native footer after the Claude context-window mode changes', async () => {
    const state = claudeProjectState({ active: true, ptyGeneration: 1 });
    const snapshot = nativeSnapshot({ usage: { inputTokens: 100_000 } });

    await withNativeRenderer(
      snapshot,
      state,
      {
        setClaudeContextWindowMode: async () =>
          appSettings({ claudeContextWindowMode: 'extended' }),
      },
      async (harness) => {
        expect(harness.query('#footer-context-label').textContent).toBe('资源 不可用');
        harness.clearCalls();
        harness.click('#footer-resource');
        expect(harness.query('#claude-context-window-options').hasAttribute('hidden')).toBe(false);
        harness.query<HTMLButtonElement>('[data-claude-context-window-mode="extended"]').click();
        await settle(harness);
        expect(harness.method('setClaudeContextWindowMode')).toHaveBeenCalledWith(
          'extended',
          undefined,
        );
        expect(harness.query('#footer-context-label').textContent).toBe('上下文 10%');
        expect(harness.query('#footer-resource-menu').hasAttribute('hidden')).toBe(true);
        expect(harness.document.activeElement).toBe(harness.query('#footer-resource'));
      },
    );
  });
});
