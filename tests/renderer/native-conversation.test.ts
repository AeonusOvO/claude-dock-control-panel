import { describe, expect, it, vi } from 'vitest';
import { createConversationState } from '../../src/renderer/features/conversation/state';
import { createConversationView } from '../../src/renderer/features/conversation/view';
import type { MarkdownDomRenderer } from '../../src/renderer/platform/markdown';
import { SessionGenerationRegistry } from '../../src/renderer/platform/session-generation';
import type { ConversationMessageView } from '../../src/shared/conversation/native';
import type {
  ClaudeLaunchPreflightDecisionOutcome,
  NetworkPreflightResult,
} from '../../src/shared/contracts';
import {
  expectCss,
  input,
  settle,
  withNativeRenderer,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';
import { launchPauseDiagnostics } from '../helpers/renderer-preflight-fixture';
import {
  claudeProjectState,
  nativeSnapshot,
  terminalStatus,
  terminalWorkspace,
} from '../helpers/renderer-terminal-fixture';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const assistantTextMessage = (
  text: string,
  version: number,
  status: ConversationMessageView['status'] = 'streaming',
): ConversationMessageView => ({
  blocks: [{ id: 'assistant-text', text, type: 'text' }],
  createdAt: 1,
  id: 'assistant-1',
  role: 'assistant',
  status,
  version,
});

const genericPreflightResult = (): NetworkPreflightResult => {
  const providerConnectivity = {
    featureAccess: [],
    probes: [],
    reasons: [],
    signals: [],
    status: 'allowed' as const,
    summary: 'generic preflight completed',
  };
  const advisoryEvidence = {
    paths: [],
    reasons: [],
    riskLevel: 'low' as const,
    riskScore: 0,
    signals: [],
    summary: 'generic advisory evidence',
  };
  return {
    action: 'background',
    advisoryEvidence,
    checkedAt: 200,
    configurationRevision: 'renderer-generic-result',
    featureAccess: providerConnectivity.featureAccess,
    generation: 9,
    mainRunId: 99,
    networkScope: 'application',
    paths: advisoryEvidence.paths,
    probes: providerConnectivity.probes,
    provider: 'anthropic-claude',
    providerConnectivity,
    providerLabel: 'Anthropic Claude Code',
    reasons: providerConnectivity.reasons,
    riskLevel: advisoryEvidence.riskLevel,
    riskScore: advisoryEvidence.riskScore,
    schemaVersion: 2,
    signals: [],
    startedAt: 190,
    status: providerConnectivity.status,
    summary: providerConnectivity.summary,
  };
};

describe('native conversation behavior', () => {
  it('keeps explicit questions usable in strict mode and restores the gated bypass option', async () => {
    const snapshot = nativeSnapshot({
      interactions: [
        { createdAt: 1, id: 'q1', kind: 'question', questions: [], title: 'Choose explicitly' },
      ],
      phase: 'requires-action',
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      expect(harness.query('#native-interaction-stack').textContent).toContain('Choose explicitly');
      harness.click('#footer-mode');
      expect(harness.query('#footer-mode-menu').textContent).toContain('完全允许');
      expect(harness.query('#footer-mode-menu').textContent).toContain('仅预批准');
    });
  });

  it('keeps the redundant primary new-session action removed through route failures', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.emit(
        'onClaudeState',
        claudeProjectState({
          routeHealth: {
            blocking: true,
            checkedAt: 1,
            detail: 'Start router',
            headline: 'Route unavailable',
            source: 'router',
            tone: 'error',
          },
        }),
      );
      const button = harness.query<HTMLButtonElement>('#run-claude');
      expect(button.hidden).toBe(true);
      expect(button.disabled).toBe(false);
      expect(button.dataset.launchBlocked).toBe('true');
      expect(harness.query<HTMLButtonElement>('.project-folder__action').disabled).toBe(false);
    });
  });

  it('routes every primary Claude session action through the safe terminal', async () => {
    await withTerminalRenderer(
      {
        launchClaude: async () => ({
          result: { ok: true, state: claudeProjectState({ active: true }) },
          status: 'completed',
        }),
      },
      async (harness) => {
        harness.click('#run-claude');
        await harness.flush();
        expect(harness.method('launchClaude')).toHaveBeenCalledWith('session-1', 'new');
        expect(harness.method('startNativeConversation')).not.toHaveBeenCalled();
      },
    );
  });

  it('keeps the exact launch attempt paused across recheck replacement and ignores generic preflight events', async () => {
    let decisionCount = 0;
    await withTerminalRenderer(
      {
        decideClaudeLaunchPreflight: async (): Promise<ClaudeLaunchPreflightDecisionOutcome> => {
          decisionCount += 1;
          if (decisionCount === 1) {
            return {
              decisionId: 'decision-replacement',
              diagnostics: launchPauseDiagnostics('重新检查后仍无法连接。'),
              status: 'paused',
            };
          }
          return {
            result: {
              ok: true,
              state: claudeProjectState({ active: true, stateRevision: 10 }),
            },
            status: 'completed',
          };
        },
        launchClaude: async () => ({
          decisionId: 'decision-original',
          diagnostics: launchPauseDiagnostics(),
          status: 'paused',
        }),
      },
      async (harness) => {
        harness.click('#run-claude');
        await settle(harness);

        const dialog = harness.query<HTMLDialogElement>('#claude-launch-preflight-dialog');
        expect(dialog.open).toBe(true);
        expect(harness.query('#claude-launch-preflight-summary').textContent).toBe(
          '网络检查未通过，Claude 启动已暂停。',
        );
        const decisionMeta = harness.query('#claude-launch-preflight-meta').textContent;
        expect(decisionMeta).toContain('Anthropic Claude Code（anthropic-claude）');
        expect(decisionMeta).toContain('CLI 启动预检');
        expect(decisionMeta).toContain('应用网络会话');
        expect(decisionMeta).toContain('采集时间：');
        expect(decisionMeta).toContain('新鲜度：当前缓存有效');
        const failedItems = harness.query('#claude-launch-preflight-failed-items').textContent;
        for (const evidence of [
          'TLS handshake',
          '方法：TLS',
          '进程：Claude CLI',
          '必需提供商证据',
          '目标：https://api.anthropic.com/v1/messages',
          '采集时间：',
          'TLS 证书校验失败',
        ]) {
          expect(failedItems).toContain(evidence);
        }
        expect(harness.query('#claude-launch-preflight-reasons').textContent).toContain(
          '连接被阻止',
        );
        expect(harness.query('#claude-launch-preflight-details').textContent).toContain('查看详情');
        expect(harness.query('#claude-launch-preflight-cancel').textContent).toBe('我再看看');
        expect(harness.query('#claude-launch-preflight-recheck').textContent?.trim()).toBe(
          '检查网络',
        );
        expect(harness.query('#claude-launch-preflight-bypass').textContent?.trim()).toBe(
          '坚持连接',
        );
        expect(document.activeElement).toBe(
          harness.query<HTMLButtonElement>('#claude-launch-preflight-recheck'),
        );

        harness.emit('onNetworkPreflight', genericPreflightResult());
        const blocked = genericPreflightResult();
        const providerConnectivity = {
          ...blocked.providerConnectivity,
          reasons: ['generic blocked event'],
          status: 'blocked' as const,
          summary: 'generic blocked event',
        };
        harness.emit('onNetworkPreflight', {
          ...blocked,
          provider: 'openai-codex',
          providerConnectivity,
          providerLabel: 'OpenAI Codex',
          reasons: providerConnectivity.reasons,
          status: providerConnectivity.status,
          summary: providerConnectivity.summary,
        });
        await harness.flush();
        expect(dialog.open).toBe(true);
        expect(harness.query<HTMLDialogElement>('#network-preflight-dialog').open).toBe(false);
        expect(harness.method('decideClaudeLaunchPreflight')).not.toHaveBeenCalled();

        harness.click('#claude-launch-preflight-recheck');
        await settle(harness);
        expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenNthCalledWith(1, {
          choice: 'recheck',
          decisionId: 'decision-original',
        });
        expect(dialog.open).toBe(true);
        expect(harness.query('#claude-launch-preflight-summary').textContent).toBe(
          '重新检查后仍无法连接。',
        );
        expect(document.activeElement).toBe(
          harness.query<HTMLButtonElement>('#claude-launch-preflight-recheck'),
        );

        harness.click('#claude-launch-preflight-bypass');
        await settle(harness);
        expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenNthCalledWith(2, {
          choice: 'bypass',
          decisionId: 'decision-replacement',
        });
        expect(dialog.open).toBe(false);
        expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenCalledTimes(2);
      },
    );
  });

  it.each(['escape', 'backdrop', 'close'] as const)(
    'routes %s dismissal through exact main cancellation once',
    async (dismissal) => {
      const decision = deferred<ClaudeLaunchPreflightDecisionOutcome>();
      await withTerminalRenderer(
        {
          decideClaudeLaunchPreflight: () => decision.promise,
          launchClaude: async () => ({
            decisionId: `decision-${dismissal}`,
            diagnostics: launchPauseDiagnostics(),
            status: 'paused',
          }),
        },
        async (harness) => {
          harness.click('#run-claude');
          await settle(harness);
          const dialog = harness.query<HTMLDialogElement>('#claude-launch-preflight-dialog');

          if (dismissal === 'escape') {
            dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
          } else if (dismissal === 'backdrop') {
            dialog.click();
          } else {
            dialog.close();
          }
          await harness.flush();
          expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenCalledTimes(1);
          expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenCalledWith({
            choice: 'cancel',
            decisionId: `decision-${dismissal}`,
          });
          for (const duplicate of ['cancel', 'click', 'close'] as const) {
            dialog.dispatchEvent(new Event(duplicate, { cancelable: true }));
          }
          await harness.flush();
          expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenCalledTimes(1);

          decision.resolve({ status: 'cancelled' });
          await settle(harness);
          expect(dialog.open).toBe(false);
          expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenCalledTimes(1);
        },
      );
    },
  );

  it('cancels the exact paused launch when workspace activation changes', async () => {
    await withTerminalRenderer(
      {
        decideClaudeLaunchPreflight: async () => ({ status: 'cancelled' }),
        launchClaude: async () => ({
          decisionId: 'decision-workspace-change',
          diagnostics: launchPauseDiagnostics(),
          status: 'paused',
        }),
      },
      async (harness) => {
        harness.click('#run-claude');
        await settle(harness);
        expect(harness.query<HTMLDialogElement>('#claude-launch-preflight-dialog').open).toBe(true);

        harness.emit('onWorkspaceState', {
          activeSessionId: 'session-2',
          projects: [],
          sessions: [],
        });
        await settle(harness);
        expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenCalledOnce();
        expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenCalledWith({
          choice: 'cancel',
          decisionId: 'decision-workspace-change',
        });
        expect(harness.query<HTMLDialogElement>('#claude-launch-preflight-dialog').open).toBe(
          false,
        );
      },
    );
  });

  it('cancels the exact launch token when activation changes during a recheck', async () => {
    const recheck = deferred<ClaudeLaunchPreflightDecisionOutcome>();
    await withTerminalRenderer(
      {
        decideClaudeLaunchPreflight: (input) =>
          input.choice === 'recheck' ? recheck.promise : Promise.resolve({ status: 'stale' }),
        launchClaude: async () => ({
          decisionId: 'decision-active-recheck',
          diagnostics: launchPauseDiagnostics(),
          status: 'paused',
        }),
      },
      async (harness) => {
        harness.click('#run-claude');
        await settle(harness);
        harness.click('#claude-launch-preflight-recheck');
        await harness.flush();

        harness.emit('onWorkspaceState', {
          activeSessionId: 'session-2',
          projects: [],
          sessions: [],
        });
        await settle(harness);

        expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenNthCalledWith(1, {
          choice: 'recheck',
          decisionId: 'decision-active-recheck',
        });
        expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenNthCalledWith(2, {
          choice: 'cancel',
          decisionId: 'decision-active-recheck',
        });
        expect(harness.query<HTMLDialogElement>('#claude-launch-preflight-dialog').open).toBe(
          false,
        );

        recheck.resolve({
          result: { ok: true, state: claudeProjectState({ active: true }) },
          status: 'completed',
        });
        await settle(harness);
        expect(harness.query<HTMLDialogElement>('#claude-launch-preflight-dialog').open).toBe(
          false,
        );
        expect(harness.method('decideClaudeLaunchPreflight')).toHaveBeenCalledTimes(2);
      },
    );
  });

  it('keeps native conversation behind an explicit toolbar action', async () => {
    await withTerminalRenderer(
      {
        adoptTerminalConversation: async () => ({
          conversationId: 'conversation-1',
          ok: true,
          snapshot: nativeSnapshot(),
        }),
      },
      async (harness) => {
        expect(harness.query('#native-conversation').dataset.state).toBe('closed');
        harness.click('#native-terminal-toggle');
        await settle(harness);
        expect(harness.method('adoptTerminalConversation')).toHaveBeenCalledWith(
          'session-1',
          false,
        );
        expect(harness.query('#native-conversation').dataset.state).toMatch(/opening|open/u);
      },
    );
  });

  it('always leaves the startup status after a native launch failure', async () => {
    const stopped = terminalStatus(1, { phase: 'stopped' });
    await withTerminalRenderer(
      {
        getClaudeProjectState: async () =>
          claudeProjectState({
            active: false,
            config: {
              ...claudeProjectState().config,
              credentialConfigured: true,
            },
            ptyGeneration: 1,
          }),
        getWorkspace: async () => terminalWorkspace(stopped),
        startNativeConversation: async () => {
          throw new Error('synthetic failure');
        },
      },
      async (harness) => {
        harness.click('#native-terminal-toggle');
        await settle(harness);
        expect(harness.query('#native-composer-status').textContent).not.toBe(
          '正在安全启动 Claude…',
        );
        expect(harness.query('#native-composer-status').textContent).toContain('启动失败');
      },
    );
  });

  it('keeps native launch buttons busy only for the owned project startup', () => {
    const registry = new SessionGenerationRegistry();
    const owned = registry.begin('session-1');
    expect(registry.isActive('session-1')).toBe(true);
    expect(registry.isActive('session-2')).toBe(false);
    expect(registry.finish(owned)).toBe(true);
  });

  it('generation-scopes native submission acknowledgement and never drops composer content', async () => {
    const submit = vi.fn(async () => {
      throw new Error('synthetic rejection');
    });
    await withNativeRenderer(
      nativeSnapshot(),
      { submitNativeConversation: submit },
      async (harness) => {
        input(harness.query('#native-composer-input'), 'keep me');
        harness.query<HTMLFormElement>('#native-composer').requestSubmit();
        await settle(harness);
        expect(submit).toHaveBeenCalled();
        expect(harness.query('#native-queued').textContent).toContain('keep me');
      },
    );
  });

  it('keeps and auto-flushes a queued message while the accepted turn IPC remains pending', async () => {
    const runningSnapshot = nativeSnapshot({
      phase: 'running',
      revision: 2,
      sequence: 2,
    });
    const idleSnapshot = nativeSnapshot({
      phase: 'idle',
      revision: 3,
      sequence: 3,
    });
    const pending = deferred<{ ok: true; snapshot: typeof runningSnapshot }>();
    const submit = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ ok: true, snapshot: idleSnapshot });
    await withNativeRenderer(
      nativeSnapshot(),
      { submitNativeConversation: submit },
      async (harness) => {
        input(harness.query('#native-composer-input'), 'first turn');
        harness.query<HTMLFormElement>('#native-composer').requestSubmit();
        await harness.flush();
        expect(submit).toHaveBeenCalledTimes(1);

        harness.emit('onNativeConversation', runningSnapshot);
        await settle(harness);
        expect(harness.query<HTMLButtonElement>('#native-send').disabled).toBe(false);

        input(harness.query('#native-composer-input'), 'queue this next');
        harness.query<HTMLFormElement>('#native-composer').requestSubmit();
        await settle(harness);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(harness.query('#native-queued').hidden).toBe(false);
        expect(harness.query('#native-queued').textContent).toContain('queue this next');

        harness.emit('onNativeConversation', idleSnapshot);
        await settle(harness);
        expect(submit).toHaveBeenCalledTimes(1);

        pending.resolve({ ok: true, snapshot: idleSnapshot });
        await settle(harness);
        expect(submit).toHaveBeenCalledTimes(2);
        expect(submit).toHaveBeenNthCalledWith(2, idleSnapshot.conversationId, {
          blocks: [{ text: 'queue this next', type: 'text' }],
          clientSubmissionId: expect.any(String),
        });
      },
    );
  });

  it('preserves streaming message, shell, and footer DOM across 120 append-only frames', async () => {
    const userMessage: ConversationMessageView = {
      blocks: [{ id: 'user-text', text: 'Hello', type: 'text' }],
      createdAt: 1,
      id: 'user-1',
      role: 'user',
      status: 'complete',
      version: 1,
    };
    const snapshot = nativeSnapshot({
      messages: [userMessage, assistantTextMessage('Working', 1)],
      phase: 'running',
      tasks: [
        {
          cancellable: true,
          description: 'Long native response',
          id: 'task-stream',
          kind: 'subagent',
          status: 'running',
          updatedAt: 1,
        },
      ],
      usage: { contextWindowTokens: 100_000, inputTokens: 1_000 },
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      expect(harness.document.querySelectorAll('.native-message--user')).toHaveLength(1);
      expect(harness.document.querySelectorAll('.native-message--assistant')).toHaveLength(1);
      const article = harness.query<HTMLElement>('.native-message--assistant');
      const label = harness.query<HTMLElement>('.native-message--assistant .native-message__label');
      const body = harness.query<HTMLElement>('.native-message--assistant .native-message__body');
      const textMount = harness.query<HTMLElement>(
        '.native-message--assistant .chat-message__markdown',
      );
      const textNode = textMount.firstChild;
      const caret = harness.query<HTMLElement>(
        '.native-message--assistant .native-message__stream-caret',
      );
      const runtimeTaskRow = harness.query<HTMLElement>('#runtime-task-list .runtime-summary-row');
      const resourceDetail = harness.query<HTMLElement>('#footer-resource-details p');
      const appendData = vi.spyOn(harness.dom.window.Text.prototype, 'appendData');
      let source = 'Working';

      for (let frame = 1; frame <= 120; frame += 1) {
        source += ` ${frame}`;
        harness.emit(
          'onNativeConversation',
          nativeSnapshot({
            ...snapshot,
            messages: [userMessage, assistantTextMessage(source, frame + 1)],
            revision: frame + 1,
            sequence: frame + 1,
          }),
        );
        await settle(harness);

        expect(harness.query('.native-message--assistant')).toBe(article);
        expect(harness.query('.native-message--assistant .native-message__label')).toBe(label);
        expect(harness.query('.native-message--assistant .native-message__body')).toBe(body);
        expect(harness.query('.native-message--assistant .chat-message__markdown')).toBe(textMount);
        expect(textMount.firstChild).toBe(textNode);
        expect(harness.query('.native-message--assistant .native-message__stream-caret')).toBe(
          caret,
        );
        expect(article.querySelectorAll('.native-message__stream-caret')).toHaveLength(1);
        expect(harness.query('#runtime-task-list .runtime-summary-row')).toBe(runtimeTaskRow);
        expect(harness.query('#footer-resource-details p')).toBe(resourceDetail);
        expect(textNode?.textContent).toBe(source);
      }

      expect(appendData).toHaveBeenCalledTimes(120);
      appendData.mockRestore();
    });
  });

  it('invalidates task, usage, capability, and permission presentations without replacing messages', async () => {
    const task = {
      cancellable: true,
      description: 'Initial task',
      id: 'task-1',
      kind: 'subagent' as const,
      status: 'running' as const,
      updatedAt: 1,
    };
    const snapshot = nativeSnapshot({
      messages: [assistantTextMessage('Stable message', 1)],
      phase: 'running',
      tasks: [task],
      usage: { contextWindowTokens: 100_000, inputTokens: 10_000 },
    });
    await withNativeRenderer(
      snapshot,
      { updateNativeConversationControls: async () => ({ ok: true }) },
      async (harness) => {
        const article = harness.query<HTMLElement>('.native-message--assistant');
        const textMount = harness.query<HTMLElement>(
          '.native-message--assistant .chat-message__markdown',
        );
        const initialTaskRow = harness.query<HTMLElement>(
          '#runtime-task-list .runtime-summary-row',
        );
        const initialResourceDetail = harness.query<HTMLElement>('#footer-resource-details p');
        const changedTask = { ...task, description: 'Updated task', updatedAt: 2 };

        harness.emit(
          'onNativeConversation',
          nativeSnapshot({
            ...snapshot,
            revision: 2,
            sequence: 2,
            tasks: [changedTask],
          }),
        );
        await settle(harness);
        const changedTaskRow = harness.query<HTMLElement>(
          '#runtime-task-list .runtime-summary-row',
        );
        expect(changedTaskRow).not.toBe(initialTaskRow);
        expect(changedTaskRow.textContent).toContain('Updated task');
        expect(harness.query('#footer-resource-details p')).toBe(initialResourceDetail);
        expect(harness.query('.native-message--assistant')).toBe(article);
        expect(harness.query('.native-message--assistant .chat-message__markdown')).toBe(textMount);

        harness.emit(
          'onNativeConversation',
          nativeSnapshot({
            ...snapshot,
            revision: 3,
            sequence: 3,
            tasks: [changedTask],
            usage: { contextWindowTokens: 100_000, inputTokens: 50_000 },
          }),
        );
        await settle(harness);
        expect(harness.query('#runtime-task-list .runtime-summary-row')).toBe(changedTaskRow);
        expect(harness.query('#footer-resource-details p')).not.toBe(initialResourceDetail);
        expect(harness.query('#footer-context-label').textContent).toContain('50');

        const capabilities = snapshot.capabilities;
        if (!capabilities) throw new Error('Expected native capabilities.');
        harness.emit(
          'onNativeConversation',
          nativeSnapshot({
            ...snapshot,
            capabilities: {
              ...capabilities,
              model: 'claude-opus-5',
              models: [
                {
                  ...capabilities.models![0]!,
                  id: 'claude-opus-5',
                  label: 'Claude Opus 5',
                },
              ],
              revision: 2,
            },
            revision: 4,
            sequence: 4,
            tasks: [changedTask],
            usage: { contextWindowTokens: 100_000, inputTokens: 50_000 },
          }),
        );
        await settle(harness);
        expect(harness.query('#footer-model').textContent).toContain('Claude Opus 5');
        expect(harness.query('.native-message--assistant')).toBe(article);

        harness.click('#footer-mode');
        const permissionButton = [
          ...harness.document.querySelectorAll<HTMLButtonElement>('#footer-mode-menu button'),
        ].find((button) => button.textContent?.includes('自动接受修改'));
        if (!permissionButton) throw new Error('Expected the accept-edits permission option.');
        permissionButton.click();
        await settle(harness);
        expect(harness.method('updateNativeConversationControls')).toHaveBeenCalledWith(
          snapshot.conversationId,
          { expectedCapabilityRevision: 2, permissionMode: 'acceptEdits' },
        );
        expect(harness.query('#footer-mode').textContent).toContain('自动接受修改');
        expect(harness.query('.native-message--assistant')).toBe(article);
      },
    );
  });

  it('keeps the streaming Text node through same-length corrections and truncation', async () => {
    const snapshot = nativeSnapshot({
      messages: [assistantTextMessage('abc', 1)],
      phase: 'running',
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      const mount = harness.query<HTMLElement>(
        '.native-message--assistant .chat-message__markdown',
      );
      const text = mount.firstChild;

      harness.emit(
        'onNativeConversation',
        nativeSnapshot({
          ...snapshot,
          messages: [assistantTextMessage('abX', 2)],
          revision: 2,
          sequence: 2,
        }),
      );
      await settle(harness);
      expect(mount.firstChild).toBe(text);
      expect(text?.textContent).toBe('abX');

      harness.emit(
        'onNativeConversation',
        nativeSnapshot({
          ...snapshot,
          messages: [assistantTextMessage('a', 3)],
          revision: 3,
          sequence: 3,
        }),
      );
      await settle(harness);
      expect(mount.firstChild).toBe(text);
      expect(text?.textContent).toBe('a');
    });
  });

  it('reorders stable block mounts and replaces only an ID whose block type changes', async () => {
    const initialMessage: ConversationMessageView = {
      blocks: [
        { id: 'assistant-text', text: 'Answer', type: 'text' },
        { id: 'assistant-thinking', text: 'Reasoning', type: 'thinking' },
        {
          id: 'assistant-tool',
          input: { command: 'pwd' },
          name: 'Bash',
          status: 'running',
          summary: 'Check directory',
          type: 'tool',
        },
        {
          id: 'assistant-image',
          mediaType: 'image/png',
          name: 'capture.png',
          source: 'attachment://capture',
          type: 'image',
        },
      ],
      createdAt: 1,
      id: 'assistant-1',
      role: 'assistant',
      status: 'streaming',
      version: 1,
    };
    const snapshot = nativeSnapshot({ messages: [initialMessage], phase: 'running' });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      const body = harness.query<HTMLElement>('.native-message--assistant .native-message__body');
      const text = harness.query<HTMLElement>('.native-message--assistant .chat-message__markdown');
      const thinking = harness.query<HTMLElement>('.native-message--assistant .native-thinking');
      const tool = harness.query<HTMLDetailsElement>('.native-message--assistant .native-tool');
      const image = harness.query<HTMLElement>(
        '.native-message--assistant .chat-attachment-card--image',
      );
      const caret = harness.query<HTMLElement>(
        '.native-message--assistant .native-message__stream-caret',
      );
      const reorderedMessage: ConversationMessageView = {
        ...initialMessage,
        blocks: [
          initialMessage.blocks[3]!,
          {
            id: 'assistant-tool',
            input: { command: 'pwd' },
            name: 'Bash',
            output: 'D:\\Project',
            status: 'succeeded',
            summary: 'Check directory',
            type: 'tool',
          },
          initialMessage.blocks[1]!,
          { id: 'assistant-text', text: 'Answer complete', type: 'text' },
        ],
        version: 2,
      };

      harness.emit(
        'onNativeConversation',
        nativeSnapshot({
          ...snapshot,
          messages: [reorderedMessage],
          revision: 2,
          sequence: 2,
        }),
      );
      await settle(harness);

      expect(Array.from(body.children)).toEqual([image, tool, thinking, text]);
      expect(text.lastChild).toBe(caret);
      expect(tool.dataset.status).toBe('succeeded');
      expect(tool.querySelectorAll('pre')[1]?.textContent).toBe('"D:\\\\Project"');

      const changedTypeMessage: ConversationMessageView = {
        ...reorderedMessage,
        blocks: [
          reorderedMessage.blocks[0]!,
          reorderedMessage.blocks[1]!,
          reorderedMessage.blocks[2]!,
          {
            id: 'assistant-text',
            input: { path: 'README.md' },
            name: 'Read',
            status: 'running',
            type: 'tool',
          },
        ],
        version: 3,
      };
      harness.emit(
        'onNativeConversation',
        nativeSnapshot({
          ...snapshot,
          messages: [changedTypeMessage],
          revision: 3,
          sequence: 3,
        }),
      );
      await settle(harness);

      expect(body.children[0]).toBe(image);
      expect(body.children[1]).toBe(tool);
      expect(body.children[2]).toBe(thinking);
      expect(body.children[3]).not.toBe(text);
      expect(body.children[3]?.classList.contains('native-tool')).toBe(true);
      expect(body.lastChild).toBe(caret);
      expect(text.isConnected).toBe(false);
    });
  });

  it('rejects stale Markdown completions and does not reparse unchanged text for tool ticks', async () => {
    await withTerminalRenderer({}, async (harness) => {
      const pending: Array<{ render: Deferred<DocumentFragment>; source: string }> = [];
      const renderFragment = vi.fn((source: string) => {
        const render = deferred<DocumentFragment>();
        pending.push({ render, source });
        return render.promise;
      });
      const markdownRenderer = { renderFragment } as unknown as MarkdownDomRenderer;
      const state = createConversationState();
      const view = createConversationView(state, {
        footerEffort: harness.query<HTMLButtonElement>('#footer-effort'),
        footerMode: harness.query<HTMLButtonElement>('#footer-mode'),
        footerModel: harness.query<HTMLButtonElement>('#footer-model'),
        footerSpeed: harness.query<HTMLButtonElement>('#footer-speed'),
        getMarkdownRenderer: () => markdownRenderer,
      });
      const article = view.renderNativeMessage(
        assistantTextMessage('**old source**', 1, 'complete'),
      );
      const mount = article.querySelector<HTMLElement>('.chat-message__markdown');
      if (!mount) throw new Error('Expected a Markdown mount.');

      view.updateNativeMessage(article, assistantTextMessage('**new source**', 2, 'complete'));
      expect(renderFragment).toHaveBeenCalledTimes(2);
      const oldFragment = harness.document.createDocumentFragment();
      const oldStrong = harness.document.createElement('strong');
      oldStrong.textContent = 'stale old render';
      oldFragment.append(oldStrong);
      pending[0]?.render.resolve(oldFragment);
      await harness.flush();
      expect(mount.textContent).toBe('**new source**');
      expect(mount.querySelector('strong')).toBeNull();

      const newFragment = harness.document.createDocumentFragment();
      const newStrong = harness.document.createElement('strong');
      newStrong.textContent = 'current new render';
      newFragment.append(newStrong);
      pending[1]?.render.resolve(newFragment);
      await harness.flush();
      expect(mount.querySelector('strong')).toBe(newStrong);

      const withTool: ConversationMessageView = {
        ...assistantTextMessage('**new source**', 3, 'complete'),
        blocks: [
          { id: 'assistant-text', text: '**new source**', type: 'text' },
          {
            id: 'tool-1',
            input: { command: 'pwd' },
            name: 'Bash',
            status: 'running',
            type: 'tool',
          },
        ],
      };
      view.updateNativeMessage(article, withTool);
      view.updateNativeMessage(article, {
        ...withTool,
        blocks: [
          withTool.blocks[0]!,
          {
            id: 'tool-1',
            input: { command: 'pwd' },
            name: 'Bash',
            output: 'D:\\Project',
            status: 'succeeded',
            type: 'tool',
          },
        ],
        version: 4,
      });
      expect(renderFragment).toHaveBeenCalledTimes(2);
      expect(mount.querySelector('strong')).toBe(newStrong);
    });
  });

  it('keeps safe plain text when final Markdown rendering fails', async () => {
    await withTerminalRenderer({}, async (harness) => {
      const markdownRenderer = {
        renderFragment: vi.fn(() => Promise.reject(new Error('synthetic Markdown failure'))),
      } as unknown as MarkdownDomRenderer;
      const state = createConversationState();
      const view = createConversationView(state, {
        footerEffort: harness.query<HTMLButtonElement>('#footer-effort'),
        footerMode: harness.query<HTMLButtonElement>('#footer-mode'),
        footerModel: harness.query<HTMLButtonElement>('#footer-model'),
        footerSpeed: harness.query<HTMLButtonElement>('#footer-speed'),
        getMarkdownRenderer: () => markdownRenderer,
      });
      const article = view.renderNativeMessage(
        assistantTextMessage('<script>unsafe()</script>', 1, 'complete'),
      );

      await harness.flush();
      const mount = article.querySelector<HTMLElement>('.chat-message__markdown');
      expect(mount?.textContent).toBe('<script>unsafe()</script>');
      expect(mount?.querySelector('script')).toBeNull();
    });
  });

  it('gives the native composer exactly one action button that hands over to stop', async () => {
    await withNativeRenderer(nativeSnapshot({ phase: 'running' }), {}, async (harness) => {
      expect(harness.document.querySelectorAll('#native-send')).toHaveLength(1);
      expect(harness.document.querySelector('#native-stop')).toBeNull();
      expect(harness.query('#native-send').getAttribute('data-action')).toBe('stop');
      input(harness.query('#native-composer-input'), 'next');
      expect(harness.query('#native-send').getAttribute('data-action')).toBe('send');
    });
  });

  it('keeps the status footer mounted and native-aware while a native conversation is open', async () => {
    await withNativeRenderer(nativeSnapshot(), {}, async (harness) => {
      const footer = harness.query('.terminal-footer');
      harness.emit(
        'onClaudeState',
        claudeProjectState({ metrics: { capturedAt: 1, modelDisplayName: 'stale' } }),
      );
      expect(harness.query('.terminal-footer')).toBe(footer);
      expect(harness.query('#footer-model').textContent).toContain('Claude Sonnet 5');
    });
  });

  it('renders the interaction queue one item at a time', async () => {
    const snapshot = nativeSnapshot({
      interactions: [
        { createdAt: 1, id: 'q1', kind: 'question', questions: [], title: 'First' },
        { createdAt: 2, id: 'q2', kind: 'question', questions: [], title: 'Second' },
      ],
      phase: 'requires-action',
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      const stack = harness.query('#native-interaction-stack');
      expect(stack.dataset.pendingCount).toBe('2');
      expect(stack.querySelectorAll('.native-interaction')).toHaveLength(1);
      expect(stack.textContent).toContain('First');
      expect(stack.textContent).not.toContain('Second');
    });
  });

  it('keeps summary actions inside the shared button component suite', async () => {
    const snapshot = nativeSnapshot({
      tasks: [
        {
          cancellable: true,
          description: 'Running task',
          id: 'task-1',
          kind: 'subagent',
          status: 'running',
          updatedAt: 1,
        },
      ],
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      harness.click('#runtime-activity-trigger');
      const action = harness.query('.runtime-summary-row__action');
      expect(Array.from(action.classList)).toEqual(
        expect.arrayContaining(['button', 'button--compact', 'button--quiet']),
      );
    });
  });

  it('places compact, semantically colored status tags beside task titles', async () => {
    const snapshot = nativeSnapshot({
      tasks: [
        {
          cancellable: false,
          description: 'Waiting task',
          id: 'task-1',
          kind: 'workflow',
          status: 'waiting',
          updatedAt: 1,
        },
      ],
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      harness.click('#runtime-activity-trigger');
      const row = harness.query('.runtime-summary-row[data-status="waiting"]');
      expect(
        row.querySelector('.runtime-summary-row__title .runtime-summary-row__tag'),
      ).not.toBeNull();
      expectCss(/\[data-status='waiting'\] \.runtime-summary-row__tag/u);
    });
  });
});
