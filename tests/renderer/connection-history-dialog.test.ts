import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionHistoryResult,
} from '../../src/shared/contracts';
import { settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';
import {
  claudeProjectState,
  terminalStatus,
  terminalWorkspace,
} from '../helpers/renderer-terminal-fixture';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settlePromise) => {
    resolve = settlePromise;
  });
  return { promise, resolve };
};

const historyEntry = (
  id: string,
  preset: ClaudeConnectionHistoryEntry['preset'],
): ClaudeConnectionHistoryEntry => ({
  apiKeyHelperPolicy: 'inherit',
  authMode: preset === 'anthropic' ? 'existing' : 'authToken',
  baseUrl: preset === 'anthropic' ? '' : `https://${id}.example.test`,
  credentialConfigured: preset !== 'anthropic',
  gatewayState: 'unknown',
  id,
  model: `${id}-model`,
  preset,
  protocol: 'anthropic',
  provider: preset === 'anthropic' || preset === 'anthropic-api' ? 'anthropic' : 'gateway',
  savedAt: 1,
});

describe('connection history dialog', () => {
  it('groups the full history into four directional, keyboard-accessible tabs', async () => {
    const entries = [
      historyEntry('claude', 'anthropic'),
      historyEntry('chatgpt', 'chatgpt-subscription'),
      historyEntry('deepseek', 'deepseek'),
      historyEntry('glm', 'glm-cn'),
      historyEntry('relay', 'custom'),
    ];
    await withTerminalRenderer(
      { getClaudeConnectionHistory: async () => entries },
      async (harness) => {
        harness.click('#open-connection-history');
        await harness.flush();

        const dialog = harness.query<HTMLDialogElement>('#connection-history-dialog');
        expect(dialog.open).toBe(true);
        expect(harness.document.activeElement?.id).toBe('connection-history-tab-claude');
        expect(harness.query('[data-history-dialog-count="claude-subscription"]').textContent).toBe(
          '1 条',
        );
        expect(harness.query('[data-history-dialog-count="domestic"]').textContent).toBe('2 条');
        expect(harness.query('[data-history-dialog-count="api"]').textContent).toBe('1 条');
        expect(
          harness.document.querySelectorAll(
            '[data-history-dialog-list="domestic"] [data-history-id]',
          ),
        ).toHaveLength(2);

        harness.click('#connection-history-tab-domestic');
        expect(harness.query('#connection-history-dialog-track').style.transform).toBe(
          'translate3d(-200%, 0, 0)',
        );
        expect(
          harness.query('#connection-history-tab-domestic').getAttribute('aria-selected'),
        ).toBe('true');
        expect(harness.query('#connection-history-panel-domestic').hasAttribute('inert')).toBe(
          false,
        );
        expect(harness.query('#connection-history-panel-claude').hasAttribute('inert')).toBe(true);

        harness
          .query('#connection-history-tab-domestic')
          .dispatchEvent(
            new harness.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'End' }),
          );
        expect(harness.document.activeElement?.id).toBe('connection-history-tab-api');
        expect(harness.query('#connection-history-dialog-track').style.transform).toBe(
          'translate3d(-300%, 0, 0)',
        );
      },
    );
  });

  it('keeps the history menu in the modal top layer and restores trigger focus on close', async () => {
    await withTerminalRenderer(
      { getClaudeConnectionHistory: async () => [historyEntry('claude', 'anthropic')] },
      async (harness) => {
        harness.click('#open-connection-history');
        await harness.flush();
        const dialog = harness.query<HTMLDialogElement>('#connection-history-dialog');
        const restore = harness.query(
          '[data-history-dialog-list="claude-subscription"] .connection-history__restore',
        );
        restore.dispatchEvent(
          new harness.dom.window.MouseEvent('contextmenu', {
            bubbles: true,
            clientX: 30,
            clientY: 40,
          }),
        );
        const menu = harness.query('#history-context-menu');
        expect(dialog.contains(menu)).toBe(true);
        expect(menu.hasAttribute('hidden')).toBe(false);

        harness.click('#finish-connection-history');
        await harness.flush();
        expect(dialog.open).toBe(false);
        expect(harness.document.body.contains(menu)).toBe(true);
        expect(harness.document.activeElement?.id).toBe('open-connection-history');
      },
    );
  });

  it('returns focus to the stable history launcher when the source entry is inactive', async () => {
    await withTerminalRenderer(
      { getClaudeConnectionHistory: async () => [historyEntry('claude', 'anthropic')] },
      async (harness) => {
        const source = harness.query<HTMLButtonElement>(
          '#connection-history-list .connection-history__restore',
        );
        source.focus();
        source.click();
        await settle(harness);
        expect(harness.query<HTMLDialogElement>('#connection-history-dialog').open).toBe(true);

        harness.click('#close-connection-history');
        await settle(harness);

        expect(harness.document.activeElement?.id).toBe('open-connection-history');
      },
    );
  });

  it('requires an explicit selection before completion and clears it when categories change', async () => {
    const apply = vi.fn();
    await withTerminalRenderer(
      {
        applyClaudeConnectionHistory: apply,
        getClaudeConnectionHistory: async () => [
          historyEntry('claude', 'anthropic'),
          historyEntry('deepseek', 'deepseek'),
        ],
      },
      async (harness) => {
        harness.click('#open-connection-history');
        await harness.flush();

        const finish = harness.query<HTMLButtonElement>('#finish-connection-history');
        expect(finish.textContent?.trim()).toBe('取消');
        expect(finish.dataset.mode).toBe('cancel');
        expect(finish.classList.contains('button--primary')).toBe(false);
        expect(harness.query('#connection-history-dialog-selection').hasAttribute('hidden')).toBe(
          true,
        );

        harness.click(
          '[data-history-dialog-list="claude-subscription"] .connection-history__restore',
        );
        await settle(harness);

        expect(apply).not.toHaveBeenCalled();
        expect(finish.textContent?.trim()).toBe('完成');
        expect(finish.dataset.mode).toBe('confirm');
        expect(finish.classList.contains('button--primary')).toBe(true);
        expect(harness.query('#connection-history-dialog-selection').textContent).toContain(
          '当前选择：',
        );
        expect(
          harness
            .query('[data-history-dialog-list="claude-subscription"] .connection-history__restore')
            .getAttribute('aria-pressed'),
        ).toBe('true');

        harness.click('#connection-history-tab-domestic');
        expect(finish.textContent?.trim()).toBe('取消');
        expect(finish.dataset.mode).toBe('cancel');
      },
    );
  });

  it('shows a dedicated tested recovery state and returns to the normal page after success', async () => {
    const entry = { ...historyEntry('relay', 'custom'), name: '北美中转站' };
    const pending = deferred<ClaudeConnectionHistoryResult>();
    const apply = vi.fn(() => pending.promise);
    await withTerminalRenderer(
      {
        applyClaudeConnectionHistory: apply,
        getClaudeConnectionHistory: async () => [entry],
      },
      async (harness) => {
        harness.click('#open-connection-history');
        harness.click('#connection-history-tab-api');
        harness.click('[data-history-dialog-list="api"] .connection-history__restore');
        await settle(harness);
        harness.click('#finish-connection-history');
        await harness.flush();

        expect(apply).toHaveBeenCalledWith('session-1', 'relay');
        expect(harness.query<HTMLButtonElement>('#finish-connection-history').disabled).toBe(true);
        expect(harness.query('#connection-history-dialog-selection').hasAttribute('hidden')).toBe(
          true,
        );
        expect(harness.query<HTMLDialogElement>('#connection-history-dialog').open).toBe(false);
        expect(harness.query('#connection-history-recovery').hasAttribute('hidden')).toBe(false);
        expect(harness.query('#connection-history-recovery-title').textContent).toContain(
          '当前正在接入 北美中转站',
        );
        expect(harness.query('#connection-wizard-progress').hasAttribute('hidden')).toBe(true);
        expect(harness.query('#connection-wizard-viewport').hasAttribute('inert')).toBe(true);

        const state = claudeProjectState({
          active: true,
          config: {
            ...claudeProjectState().config,
            authMode: 'authToken',
            baseUrl: entry.baseUrl,
            credentialConfigured: true,
            model: entry.model,
            preset: 'custom',
            provider: 'gateway',
          },
          ptyGeneration: 1,
          stateRevision: 3,
        });
        pending.resolve({
          connectionTest: {
            message: '端点、认证和模型响应全部通过。',
            ok: true,
            stages: [
              { detail: '200 · 已收到响应', id: 'endpoint', label: '接口地址', status: 'passed' },
            ],
            testedAt: 1,
            tone: 'success',
          },
          entries: [entry],
          ok: true,
          state,
        });
        await settle(harness);

        expect(harness.query('#connection-history-recovery').dataset.phase).toBe('success');
        expect(harness.query('#connection-history-recovery-title').textContent).toContain(
          '已完成接入',
        );
        expect(harness.query('#current-connection-name').textContent).toBe('北美中转站');

        await new Promise<void>((resolve) => harness.dom.window.setTimeout(resolve, 1_550));
        expect(harness.query('#connection-history-recovery').hasAttribute('hidden')).toBe(true);
        expect(harness.query('#connection-wizard-progress').hasAttribute('hidden')).toBe(false);
        expect(harness.query('#connection-wizard-viewport').hasAttribute('inert')).toBe(false);
      },
    );
  });

  it('restores a stable focus target when failed recovery returns to the normal page', async () => {
    const entry = historyEntry('claude', 'anthropic');
    await withTerminalRenderer(
      {
        applyClaudeConnectionHistory: async () => ({
          entries: [entry],
          error: '认证失败。',
          ok: false,
        }),
        getClaudeConnectionHistory: async () => [entry],
      },
      async (harness) => {
        const source = harness.query<HTMLButtonElement>(
          '#connection-history-list .connection-history__restore',
        );
        source.focus();
        source.click();
        await settle(harness);
        harness.click('#finish-connection-history');
        await settle(harness);
        expect(harness.query('#connection-history-recovery').dataset.phase).toBe('failure');

        harness.click('#return-from-connection-history-recovery');
        await settle(harness);

        expect(harness.document.activeElement?.id).toBe('open-connection-history');
      },
    );
  });

  it('drops a late history load after the active project changes', async () => {
    const staleLoad = deferred<ClaudeConnectionHistoryEntry[]>();
    const staleEntry = historyEntry('stale-a', 'custom');
    const currentEntry = historyEntry('current-b', 'custom');
    await withTerminalRenderer(
      {
        getClaudeConnectionHistory: (sessionId) =>
          sessionId === 'session-1' ? staleLoad.promise : Promise.resolve([currentEntry]),
        getClaudeProjectState: async (sessionId) =>
          claudeProjectState({
            active: true,
            cwd: sessionId === 'session-1' ? 'D:\\ProjectA' : 'D:\\ProjectB',
            sessionId,
          }),
      },
      async (harness) => {
        harness.emit(
          'onWorkspaceState',
          terminalWorkspace(
            terminalStatus(1, { cwd: 'D:\\ProjectB', id: 'session-2', title: 'Project B' }),
          ),
        );
        await settle(harness);

        expect(
          harness.document.querySelector(
            '[data-history-dialog-list="api"] [data-history-id="current-b"]',
          ),
        ).not.toBeNull();
        staleLoad.resolve([staleEntry]);
        await settle(harness);

        expect(
          harness.document.querySelector(
            '[data-history-dialog-list="api"] [data-history-id="current-b"]',
          ),
        ).not.toBeNull();
        expect(
          harness.document.querySelector(
            '[data-history-dialog-list="api"] [data-history-id="stale-a"]',
          ),
        ).toBeNull();
      },
    );
  });

  it('does not let a stale apply repaint configuration or clear a newer busy owner', async () => {
    const entryA = { ...historyEntry('relay-a', 'custom'), name: '中转站 A' };
    const entryB = { ...historyEntry('relay-b', 'custom'), name: '中转站 B' };
    const applyA = deferred<ClaudeConnectionHistoryResult>();
    const applyB = deferred<ClaudeConnectionHistoryResult>();
    const projectState = (sessionId: string, entry: ClaudeConnectionHistoryEntry) =>
      claudeProjectState({
        active: true,
        config: {
          ...claudeProjectState().config,
          authMode: 'authToken',
          baseUrl: entry.baseUrl,
          credentialConfigured: true,
          model: entry.model,
          preset: 'custom',
          provider: 'gateway',
        },
        cwd: sessionId === 'session-1' ? 'D:\\ProjectA' : 'D:\\ProjectB',
        sessionId,
      });
    await withTerminalRenderer(
      {
        applyClaudeConnectionHistory: (sessionId) =>
          sessionId === 'session-1' ? applyA.promise : applyB.promise,
        getClaudeConnectionHistory: async (sessionId) =>
          sessionId === 'session-1' ? [entryA] : [entryB],
        getClaudeProjectState: async (sessionId) =>
          projectState(sessionId, sessionId === 'session-1' ? entryA : entryB),
      },
      async (harness) => {
        harness.click('#open-connection-history');
        harness.click('#connection-history-tab-api');
        harness.click('[data-history-dialog-list="api"] .connection-history__restore');
        await settle(harness);
        harness.click('#finish-connection-history');
        await harness.flush();

        harness.emit(
          'onWorkspaceState',
          terminalWorkspace(
            terminalStatus(1, { cwd: 'D:\\ProjectB', id: 'session-2', title: 'Project B' }),
          ),
        );
        await settle(harness);
        harness.click('#open-connection-history');
        harness.click('#connection-history-tab-api');
        harness.click('[data-history-dialog-list="api"] .connection-history__restore');
        await settle(harness);
        harness.click('#finish-connection-history');
        await harness.flush();

        applyA.resolve({ entries: [entryA], ok: true, state: projectState('session-1', entryA) });
        await settle(harness);

        expect(harness.query('#connection-history-recovery').dataset.phase).toBe('running');
        expect(harness.query('#connection-history-recovery-title').textContent).toContain(
          '中转站 B',
        );
        expect(harness.query<HTMLButtonElement>('#finish-connection-history').disabled).toBe(true);
        expect(harness.query('#current-connection-name').textContent).not.toBe('中转站 A');
        expect(
          harness.document.querySelector(
            '[data-history-dialog-list="api"] [data-history-id="relay-a"]',
          ),
        ).toBeNull();

        applyB.resolve({ entries: [entryB], ok: true, state: projectState('session-2', entryB) });
        await settle(harness);
        expect(harness.query('#connection-history-recovery').dataset.phase).toBe('success');
        expect(harness.query('#current-connection-name').textContent).toBe('中转站 B');
      },
    );
  });

  it('drops a late delete result after the active project changes', async () => {
    const entryA = historyEntry('delete-a', 'custom');
    const entryB = historyEntry('keep-b', 'custom');
    const pendingDelete = deferred<ClaudeConnectionHistoryResult>();
    await withTerminalRenderer(
      {
        deleteClaudeConnectionHistory: () => pendingDelete.promise,
        getClaudeConnectionHistory: async (sessionId) =>
          sessionId === 'session-1' ? [entryA] : [entryB],
        getClaudeProjectState: async (sessionId) =>
          claudeProjectState({
            active: true,
            cwd: sessionId === 'session-1' ? 'D:\\ProjectA' : 'D:\\ProjectB',
            sessionId,
          }),
      },
      async (harness) => {
        harness.click('#open-connection-history');
        harness.click('#connection-history-tab-api');
        harness.click('[data-history-dialog-list="api"] .connection-history__delete');
        await harness.flush();
        expect(harness.query<HTMLButtonElement>('#finish-connection-history').disabled).toBe(true);

        harness.emit(
          'onWorkspaceState',
          terminalWorkspace(
            terminalStatus(1, { cwd: 'D:\\ProjectB', id: 'session-2', title: 'Project B' }),
          ),
        );
        await settle(harness);
        pendingDelete.resolve({ entries: [entryA], ok: true });
        await settle(harness);

        expect(
          harness.document.querySelector(
            '[data-history-dialog-list="api"] [data-history-id="keep-b"]',
          ),
        ).not.toBeNull();
        expect(
          harness.document.querySelector(
            '[data-history-dialog-list="api"] [data-history-id="delete-a"]',
          ),
        ).toBeNull();
        expect(harness.query<HTMLButtonElement>('#finish-connection-history').disabled).toBe(false);
      },
    );
  });

  it('drops a late rename result after the active project changes', async () => {
    const entryA = historyEntry('rename-a', 'anthropic');
    const entryB = historyEntry('keep-b', 'anthropic');
    const pendingRename = deferred<ClaudeConnectionHistoryResult>();
    const rename = vi.fn(() => pendingRename.promise);
    await withTerminalRenderer(
      {
        getClaudeConnectionHistory: async (sessionId) =>
          sessionId === 'session-1' ? [entryA] : [entryB],
        getClaudeProjectState: async (sessionId) =>
          claudeProjectState({
            active: true,
            cwd: sessionId === 'session-1' ? 'D:\\ProjectA' : 'D:\\ProjectB',
            sessionId,
          }),
        renameClaudeConnectionHistory: rename,
      },
      async (harness) => {
        harness.click('#open-connection-history');
        const restore = harness.query(
          '[data-history-dialog-list="claude-subscription"] .connection-history__restore',
        );
        restore.dispatchEvent(
          new harness.dom.window.MouseEvent('contextmenu', {
            bubbles: true,
            clientX: 20,
            clientY: 20,
          }),
        );
        harness.click('[data-history-context-action="rename"]');
        await harness.flush();
        harness.query<HTMLInputElement>('#conversation-rename-input').value = '新的 A';
        harness.query<HTMLDialogElement>('#conversation-rename-dialog').close('confirm');
        await settle(harness);
        expect(rename).toHaveBeenCalledWith('session-1', 'rename-a', '新的 A');

        harness.emit(
          'onWorkspaceState',
          terminalWorkspace(
            terminalStatus(1, { cwd: 'D:\\ProjectB', id: 'session-2', title: 'Project B' }),
          ),
        );
        await settle(harness);
        pendingRename.resolve({ entries: [{ ...entryA, name: '新的 A' }], ok: true });
        await settle(harness);

        expect(
          harness.document.querySelector(
            '[data-history-dialog-list="claude-subscription"] [data-history-id="keep-b"]',
          ),
        ).not.toBeNull();
        expect(
          harness.document.querySelector(
            '[data-history-dialog-list="claude-subscription"] [data-history-id="rename-a"]',
          ),
        ).toBeNull();
      },
    );
  });

  it('keeps failures visible for retry and cancels only after the backend confirms interruption', async () => {
    const entry = historyEntry('deepseek', 'deepseek');
    const pending = deferred<ClaudeConnectionHistoryResult>();
    const cancel = vi.fn(async () => true);
    await withTerminalRenderer(
      {
        applyClaudeConnectionHistory: () => pending.promise,
        cancelClaudeConnectionHistoryApply: cancel,
        getClaudeConnectionHistory: async () => [entry],
      },
      async (harness) => {
        harness.click('#open-connection-history');
        harness.click('#connection-history-tab-domestic');
        harness.click('[data-history-dialog-list="domestic"] .connection-history__restore');
        await settle(harness);
        harness.click('#finish-connection-history');
        await harness.flush();
        harness.click('#cancel-connection-history-recovery');
        await harness.flush();

        expect(cancel).toHaveBeenCalledWith('session-1');
        expect(harness.query('#connection-history-recovery').dataset.phase).toBe('cancelling');
        expect(harness.query('#connection-history-recovery').hasAttribute('hidden')).toBe(false);

        pending.resolve({ entries: [entry], error: '接入测试已取消。', ok: false });
        await settle(harness);
        expect(harness.query('#connection-history-recovery').hasAttribute('hidden')).toBe(true);
        expect(harness.query('#connection-wizard-progress').hasAttribute('hidden')).toBe(false);
      },
    );
  });

  it('accepts an exact cancellation acknowledgement that arrives after the apply result', async () => {
    const entry = historyEntry('deepseek-cancel-race', 'deepseek');
    const pendingApply = deferred<ClaudeConnectionHistoryResult>();
    const pendingCancel = deferred<boolean>();
    await withTerminalRenderer(
      {
        applyClaudeConnectionHistory: () => pendingApply.promise,
        cancelClaudeConnectionHistoryApply: () => pendingCancel.promise,
        getClaudeConnectionHistory: async () => [entry],
      },
      async (harness) => {
        harness.click('#open-connection-history');
        harness.click('#connection-history-tab-domestic');
        harness.click('[data-history-dialog-list="domestic"] .connection-history__restore');
        await settle(harness);
        harness.click('#finish-connection-history');
        await harness.flush();
        harness.click('#cancel-connection-history-recovery');
        await harness.flush();

        pendingApply.resolve({ entries: [entry], error: '接入测试已取消。', ok: false });
        await settle(harness);
        expect(harness.query('#connection-history-recovery').dataset.phase).toBe('cancelling');

        pendingCancel.resolve(true);
        await settle(harness);
        expect(harness.query('#connection-history-recovery').hasAttribute('hidden')).toBe(true);
        expect(harness.query('#connection-wizard-progress').hasAttribute('hidden')).toBe(false);
      },
    );
  });

  it('keeps a failed connectivity result on the page and offers a real retry', async () => {
    const entry = historyEntry('relay-failure', 'custom');
    const apply = vi.fn(async (): Promise<ClaudeConnectionHistoryResult> => ({
      connectionTest: {
        failureKind: 'network',
        message: '无法建立网络连接。',
        ok: false,
        stages: [
          {
            detail: '15 秒内没有收到响应。',
            id: 'endpoint',
            label: '接口地址',
            status: 'failed',
          },
        ],
        testedAt: 1,
        tone: 'error',
      },
      entries: [entry],
      error: '无法建立网络连接。',
      ok: false,
    }));
    await withTerminalRenderer(
      {
        applyClaudeConnectionHistory: apply,
        getClaudeConnectionHistory: async () => [entry],
      },
      async (harness) => {
        harness.click('#open-connection-history');
        harness.click('#connection-history-tab-api');
        harness.click('[data-history-dialog-list="api"] .connection-history__restore');
        await settle(harness);
        harness.click('#finish-connection-history');
        await settle(harness);

        expect(harness.query('#connection-history-recovery').dataset.phase).toBe('failure');
        expect(harness.query('#retry-connection-history-recovery').hasAttribute('hidden')).toBe(
          false,
        );
        expect(harness.query('#connection-history-recovery-details').textContent).toContain(
          '15 秒内没有收到响应',
        );

        harness.click('#retry-connection-history-recovery');
        await settle(harness);
        expect(apply).toHaveBeenCalledTimes(2);
        expect(harness.query('#connection-history-recovery').dataset.phase).toBe('failure');
      },
    );
  });
});
