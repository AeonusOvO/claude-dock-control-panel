import { describe, expect, it } from 'vitest';
import { ClaudeLaunchAttemptRegistry } from '../../src/renderer/platform/claude-launch-attempt';
import { FolderHistoryLoadCoordinator } from '../../src/renderer/features/projects/folder-history-load';
import {
  orchestrateSessionOperation,
  SessionGenerationRegistry,
} from '../../src/renderer/platform/session-generation';
import { claudeStateOwnershipIsCurrent } from '../../src/shared/claude/state-ownership';
import type { ControlPanelApi } from '../../src/shared/contracts';
import {
  expectCss,
  settle,
  withRenderer,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';
import {
  claudeProjectState,
  terminalStatus,
  terminalWorkspace,
} from '../helpers/renderer-terminal-fixture';

describe('renderer interaction lifecycle behavior', () => {
  it('always releases resize pointer capture across interrupted window lifecycles', async () => {
    await withRenderer({}, async (harness) => {
      const event = new harness.dom.window.MouseEvent('pointerdown', { button: 0, clientX: 100 });
      Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 7 } });
      harness.query('#panel-resizer').dispatchEvent(event);
      expect(harness.document.body.classList.contains('is-resizing')).toBe(true);
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('blur'));
      expect(harness.document.body.classList.contains('is-resizing')).toBe(false);
    });
  });

  it('opens the active xterm visibly, retries cold fits and coalesces live resizes per frame', async () => {
    await withTerminalRenderer({}, async (harness, control) => {
      expect(harness.query<HTMLElement>('.project-terminal--active').hidden).toBe(false);
      expect(control.terminals[0]?.options).toMatchObject({ allowProposedApi: true });
      expect(harness.method('resizeTerminal')).toHaveBeenCalledWith('session-1', 1, 1, 100, 30);
      expectCss(/\.project-terminal--active:focus-within\s*\{[^}]*--accent/u);
    });
  });

  it('owns xterm views and asynchronous terminal work by exact PTY generation', async () => {
    await withTerminalRenderer({}, async (harness, control) => {
      const first = control.terminals[0]!;
      harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
      await settle(harness);
      expect(first.disposed).toBe(true);
      harness.emit('onTerminalData', 'session-1', 1, 'stale');
      harness.emit('onTerminalData', 'session-1', 2, 'fresh');
      await settle(harness);
      expect(first.writes).not.toContain('stale');
      expect(control.terminals[1]?.writes).toContain('fresh');
    });
  });

  it('fences terminal interaction and permission probes after generation replacement', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
      await settle(harness);
      harness.clearCalls();
      harness.emit('onClaudePermissionModeProbe', 'session-1', 1, 8);
      expect(harness.method('reportClaudePermissionModeProbe')).toHaveBeenCalledWith(
        'session-1',
        1,
        8,
      );
      expect(harness.method('observeClaudePermissionMode')).not.toHaveBeenCalled();
    });
  });

  it('defers composer focus until the matching terminal is running', async () => {
    const stopped = terminalStatus(1, { phase: 'stopped' });
    const running = terminalStatus(1);
    type StartResult = Awaited<ReturnType<ControlPanelApi['startTerminal']>>;
    let resolveStart: ((result: StartResult) => void) | undefined;
    const pendingStart = new Promise<StartResult>((resolve) => {
      resolveStart = resolve;
    });
    await withTerminalRenderer(
      {
        getWorkspace: async () => terminalWorkspace(stopped),
        startTerminal: () => pendingStart,
      },
      async (harness) => {
        harness.query<HTMLButtonElement>('#clear-terminal').focus();
        expect(harness.document.activeElement).toBe(harness.query('#clear-terminal'));
        resolveStart?.({ ok: true, status: running });
        await settle(harness);
        expect(harness.document.activeElement).toBe(harness.query('#composer-input'));
      },
    );
  });

  it('keeps the shell interactive while a real connection test runs in the background', async () => {
    const pending = new Promise<never>(() => undefined);
    await withTerminalRenderer({ testClaudeConnection: () => pending }, async (harness) => {
      harness.click('#footer-connection');
      await harness.flush();
      expect(harness.query('#footer-connection').getAttribute('aria-busy')).toBe('true');
      harness.click('#clear-terminal');
      expect(harness.query<HTMLButtonElement>('#clear-terminal').disabled).toBe(false);
    });
  });

  it('treats provider selection, grouping and follow-up steps as explicit UI state', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.click('[data-rail-tab="connection"]');
      harness.query<HTMLButtonElement>('[data-provider-id="deepseek"]').click();
      expect(
        harness
          .query<HTMLButtonElement>('[data-provider-id="deepseek"]')
          .getAttribute('aria-pressed'),
      ).toBe('true');
      harness.query<HTMLButtonElement>('[data-provider-id="deepseek"]').click();
      expect(harness.query('#connection-provider-setup').hasAttribute('hidden')).toBe(true);
    });
  });

  it('keeps managed gateway operations behind the isolated main-process bridge', async () => {
    await withRenderer({}, async (harness) => {
      await harness.api.setupManagedChatGptGateway(undefined, true);
      await harness.api.setManagedChatGptGatewayModel('session-1', 'gpt-5.6-sol');
      expect(harness.method('setupManagedChatGptGateway')).toHaveBeenCalledWith(undefined, true);
      expect(harness.method('setManagedChatGptGatewayModel')).toHaveBeenCalledWith(
        'session-1',
        'gpt-5.6-sol',
      );
    });
  });

  it('generation-fences folder history refreshes across forget and re-add', () => {
    const coordinator = new FolderHistoryLoadCoordinator();
    const stale = coordinator.request('d:/project', false)!;
    coordinator.invalidate('d:/project');
    const current = coordinator.request('d:/project', false)!;
    expect(coordinator.finish(stale)).toEqual({ current: false, reloadRequested: false });
    expect(coordinator.finish(current)).toEqual({ current: true, reloadRequested: false });
  });

  it('keeps official preflight separate while the footer runs the saved real connection test', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.clearCalls();
      harness.click('#footer-connection');
      await settle(harness);
      expect(harness.method('testClaudeConnection')).toHaveBeenCalled();
      expect(harness.method('runNetworkPreflight')).not.toHaveBeenCalled();
    });
  });

  it('runs one real test for the active saved Claude connection on each app opening', async () => {
    await withTerminalRenderer({}, async (harness) => {
      await settle(harness);
      const initial = harness.method('testClaudeConnection').mock.calls.length;
      harness.emit('onAppWindowRestored');
      await settle(harness);
      expect(harness.method('testClaudeConnection').mock.calls.length).toBe(initial + 1);
    });
  });

  it('shows the correlation code returned by a failed connection test', async () => {
    await withTerminalRenderer(
      {
        testClaudeConnection: async () => ({
          authMode: 'apiKey',
          code: 'CD-CLAUDECONNECTION-TEST-1',
          detail: 'connect ECONNREFUSED',
          failureKind: 'network',
          kind: 'external-service',
          latencyMs: 25,
          message: '无法建立网络连接。',
          ok: false,
          stages: [
            {
              detail: '接口尚未连通。',
              id: 'endpoint',
              label: '接口地址',
              status: 'failed',
            },
          ],
          testedAt: 1,
          tone: 'error',
        }),
      },
      async (harness) => {
        expect(harness.query('#connection-test-summary').textContent).toContain(
          '无法建立网络连接。（诊断码：CD-CLAUDECONNECTION-TEST-1）',
        );
      },
    );
  });

  it('turns the footer model, speed, mode and effort readouts into real menu triggers', async () => {
    await withTerminalRenderer({}, async (harness) => {
      for (const id of ['model', 'speed', 'mode', 'effort']) {
        harness.click(`#footer-${id}`);
        await settle(harness);
        expect(harness.query(`#footer-${id}-menu`).hasAttribute('hidden')).toBe(false);
        harness.dom.window.dispatchEvent(new harness.dom.window.Event('blur'));
        expect(harness.query(`#footer-${id}-menu`).hasAttribute('hidden')).toBe(true);
      }
    });
  });

  it('keeps serving speed model-specific and truthful across Claude, GPT and native Codex', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.emit(
        'onClaudeState',
        claudeProjectState({
          active: true,
          speed: {
            availability: 'available',
            canSelectFast: true,
            detail: '上游已确认。',
            mechanism: 'claude-native-fast',
            model: 'claude-sonnet-5',
            preference: 'fast',
            status: 'active',
          },
        }),
      );
      expect(harness.query('#footer-speed').textContent).toContain('Claude Fast');
    });
  });

  it('always releases the model switch trigger after the IPC operation settles', async () => {
    await withTerminalRenderer(
      {
        getClaudeModelOptions: async () => ({
          activeModel: 'claude-sonnet-5',
          currentOptionId: 'current',
          options: [
            {
              id: 'next',
              label: 'Next',
              model: 'claude-opus-5',
              providerLabel: 'Anthropic',
              requiresRelaunch: false,
              sameEndpoint: true,
            },
          ],
        }),
        switchClaudeModel: async () => {
          throw new Error('synthetic failure');
        },
      },
      async (harness) => {
        harness.click('#footer-model');
        await settle(harness);
        harness.query<HTMLButtonElement>('#footer-model-menu button').click();
        await settle(harness);
        expect(harness.method('switchClaudeModel')).toHaveBeenCalledWith('session-1', 'next');
        expect(harness.query<HTMLButtonElement>('#footer-model').disabled).toBe(false);
      },
    );
  });

  it('keeps Claude launch locks and speed settlement under independent generations', () => {
    const launches = new ClaudeLaunchAttemptRegistry();
    const speeds = new SessionGenerationRegistry();
    const launch = launches.begin('session-1', { terminalPtyGeneration: 1 });
    const speed = speeds.begin('session-1');
    expect(launches.observeTerminal(terminalStatus(2))).toMatchObject({ reason: 'powershell' });
    expect(speeds.isCurrent(speed)).toBe(true);
    expect(launches.isCurrent(launch)).toBe(false);
  });

  it('fences state loads and Codex launches with per-session generations', async () => {
    const registry = new SessionGenerationRegistry();
    const stale = registry.begin('session-1');
    const current = registry.begin('session-1');
    const outcome = await orchestrateSessionOperation({
      applyResult: () => true,
      registry,
      start: async () => 'late',
      token: stale,
    });
    expect(outcome).toEqual({ status: 'stale' });
    expect(registry.isCurrent(current)).toBe(true);
  });

  it('rejects delayed Claude state across runtime and PTY generations', () => {
    expect(claudeStateOwnershipIsCurrent({ ptyGeneration: 1, stateRevision: 3 }, 2, 2)).toBe(false);
    expect(claudeStateOwnershipIsCurrent({ ptyGeneration: 2, stateRevision: 3 }, 2, 2)).toBe(true);
  });

  it('lists every permission mode and routes the un-cyclable one through a relaunch', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.click('#footer-mode');
      const labels = harness.query('#footer-mode-menu').textContent ?? '';
      for (const label of [
        '手动确认',
        '自动接受编辑',
        '计划模式',
        '自动选择',
        '完全允许',
        '仅预批准',
      ]) {
        expect(labels).toContain(label);
      }
    });
  });

  it('forwards Shift+Tab from the composer so the shortcut does not depend on terminal focus', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.clearCalls();
      harness.query('#composer-input').dispatchEvent(
        new harness.dom.window.KeyboardEvent('keydown', {
          bubbles: true,
          key: 'Tab',
          shiftKey: true,
        }),
      );
      expect(harness.method('writeTerminal')).toHaveBeenCalledWith('session-1', 1, '\u001b[Z');
    });
  });

  it('does not let an official-network preflight overwrite Claude gateway launch controls', async () => {
    const gatewayState = claudeProjectState();
    gatewayState.config = {
      ...gatewayState.config,
      baseUrl: 'https://gateway.example.test',
      provider: 'gateway',
    };
    await withTerminalRenderer(
      {
        getClaudeProjectState: async () => gatewayState,
      },
      async (harness) => {
        const run = harness.query<HTMLButtonElement>('#run-claude');
        const before = run.disabled;
        harness.emit('onNetworkPreflight', {
          checkedAt: 1,
          featureAccess: [],
          paths: [],
          probes: [],
          provider: 'anthropic-claude',
          providerLabel: 'Anthropic Claude Code',
          reasons: ['synthetic offline result'],
          riskLevel: 'high',
          riskScore: 90,
          signals: [],
          startedAt: 1,
          status: 'blocked',
          summary: 'synthetic offline result',
        });
        expect(run.disabled).toBe(before);
      },
    );
  });

  it('types Claude-generated titles in place and skips the animation for manual renames', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.emit(
        'onWorkspaceState',
        terminalWorkspace(terminalStatus(1, { title: 'Generated title' })),
      );
      await harness.flush();
      const label = harness.query<HTMLElement>('.conversation-item__label');
      expect(label.dataset.titleTyping).toBe('true');
    });
  });

  it('reads permission badges from xterm after screen deltas have been applied', async () => {
    await withTerminalRenderer({}, async (harness, control) => {
      control.autoAcknowledgeWrites = false;
      control.terminals[0]!.setScreen(['Claude Code', 'accept edits on']);
      harness.emit('onTerminalData', 'session-1', 1, 'delta');
      await settle(harness);
      harness.emit('onClaudePermissionModeProbe', 'session-1', 1, 9);
      expect(harness.method('reportClaudePermissionModeProbe')).not.toHaveBeenCalledWith(
        'session-1',
        1,
        9,
        expect.anything(),
      );
      control.acknowledgeNextWrite();
      await harness.flush();
      expect(harness.method('reportClaudePermissionModeProbe')).toHaveBeenCalledWith(
        'session-1',
        1,
        9,
        'acceptEdits',
      );
    });
  });

  it('answers every quit request and only questions the ones that would lose work', async () => {
    await withRenderer({}, async (harness) => {
      harness.emit('onAppQuitRequested', { hasBlocking: false, leases: [] });
      harness.click('#quit-cancel');
      expect(harness.method('confirmQuit')).toHaveBeenLastCalledWith(false);
      harness.emit('onAppQuitRequested', { hasBlocking: false, leases: [] });
      harness.click('#quit-force');
      expect(harness.method('confirmQuit')).toHaveBeenLastCalledWith(true);
      harness.emit('onAppQuitRequested', { hasBlocking: false, leases: [] });
      harness.click('#quit-minimize');
      expect(harness.method('minimizeToTray')).toHaveBeenCalled();
    });
  });
});
