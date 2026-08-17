import { describe, expect, it, vi } from 'vitest';
import {
  nativeConversationHasRunningWork,
  runConfirmableConversationSurfaceSwitch,
  selectReusableConversationSurfaceSession,
  terminalConversationHasRunningWork,
} from '../src/shared/conversation-surface-switch';
import type {
  RuntimeActivityPhase,
  RuntimeActivitySnapshot,
  RuntimeTaskStatus,
  RuntimeTaskView,
  RuntimeWebProcessView,
} from '../src/shared/contracts';
import type {
  ConversationPhase,
  ConversationSnapshot,
  ConversationTaskView,
} from '../src/shared/native-conversation';

const terminalActivity = (
  overrides: Partial<RuntimeActivitySnapshot> = {},
): RuntimeActivitySnapshot => ({
  launchGeneration: 1,
  observedAt: 1,
  phase: 'cli-idle',
  ptyGeneration: 1,
  sessionId: 'session-1',
  subagentCount: 0,
  tasks: [],
  webProcesses: [],
  willResumeConversation: false,
  ...overrides,
});

const terminalTask = (status: RuntimeTaskStatus): RuntimeTaskView => ({
  description: `terminal task ${status}`,
  id: `terminal-task-${status}`,
  kind: 'workflow',
  status,
  tokenUse: 'unknown',
  updatedAt: 1,
  willWakeParent: false,
});

const webProcess = (status: RuntimeWebProcessView['status']): RuntimeWebProcessView => ({
  commandSummary: 'npm run dev',
  name: `web-${status}`,
  pid: 42,
  ports: [5173],
  processKey: `web-${status}-42`,
  startedAt: 1,
  status,
  urls: [{ confirmed: true, url: 'http://127.0.0.1:5173' }],
});

const nativeSnapshot = (overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({
  commands: [],
  conversationId: '11111111-1111-4111-8111-111111111111',
  interactions: [],
  messages: [],
  ownerKind: 'native',
  phase: 'idle',
  projectPath: 'D:\\Projects\\Native',
  revision: 1,
  runtime: 'claude',
  sequence: 1,
  tasks: [],
  usage: {},
  ...overrides,
});

const nativeTask = (status: ConversationTaskView['status']): ConversationTaskView => ({
  cancellable: true,
  description: `native task ${status}`,
  id: `native-task-${status}`,
  kind: 'background',
  status,
  updatedAt: 1,
});

describe('terminalConversationHasRunningWork', () => {
  it.each([
    { expected: false, phase: 'cli-idle' },
    { expected: true, phase: 'foreground-running' },
    { expected: true, phase: 'waiting-background' },
    { expected: true, phase: 'resuming' },
    { expected: false, phase: 'stopped' },
    { expected: false, phase: 'failed' },
  ] satisfies ReadonlyArray<{ expected: boolean; phase: RuntimeActivityPhase }>)(
    'returns $expected for a terminal in $phase',
    ({ expected, phase }) => {
      expect(terminalConversationHasRunningWork(terminalActivity({ phase }))).toBe(expected);
    },
  );

  it.each(['queued', 'running', 'waiting'] satisfies readonly RuntimeTaskStatus[])(
    'treats an idle terminal task in %s as running work',
    (status) => {
      expect(
        terminalConversationHasRunningWork(
          terminalActivity({ phase: 'cli-idle', tasks: [terminalTask(status)] }),
        ),
      ).toBe(true);
    },
  );

  it.each(['completed', 'failed', 'orphaned'] satisfies readonly RuntimeTaskStatus[])(
    'does not treat an idle terminal task in %s as running work',
    (status) => {
      expect(
        terminalConversationHasRunningWork(
          terminalActivity({ phase: 'cli-idle', tasks: [terminalTask(status)] }),
        ),
      ).toBe(false);
    },
  );

  it.each(['running', 'stopping'] satisfies readonly RuntimeWebProcessView['status'][])(
    'treats an idle terminal Web process in %s as running work',
    (status) => {
      expect(
        terminalConversationHasRunningWork(
          terminalActivity({ phase: 'cli-idle', webProcesses: [webProcess(status)] }),
        ),
      ).toBe(true);
    },
  );

  it('does not invent running work when no activity snapshot exists', () => {
    expect(terminalConversationHasRunningWork(undefined)).toBe(false);
  });
});

describe('nativeConversationHasRunningWork', () => {
  it.each([
    { expected: false, phase: 'idle' },
    { expected: true, phase: 'starting' },
    { expected: true, phase: 'running' },
    { expected: true, phase: 'requires-action' },
    { expected: true, phase: 'stopping' },
    { expected: false, phase: 'stopped' },
    { expected: false, phase: 'failed' },
  ] satisfies ReadonlyArray<{ expected: boolean; phase: ConversationPhase }>)(
    'returns $expected for a native conversation in $phase',
    ({ expected, phase }) => {
      expect(nativeConversationHasRunningWork(nativeSnapshot({ phase }))).toBe(expected);
    },
  );

  it.each(['queued', 'running', 'waiting'] satisfies readonly ConversationTaskView['status'][])(
    'treats an idle native background task in %s as running work',
    (status) => {
      expect(
        nativeConversationHasRunningWork(
          nativeSnapshot({ phase: 'idle', tasks: [nativeTask(status)] }),
        ),
      ).toBe(true);
    },
  );

  it.each([
    'completed',
    'failed',
    'stopped',
    'lost',
  ] satisfies readonly ConversationTaskView['status'][])(
    'does not treat an idle native background task in %s as running work',
    (status) => {
      expect(
        nativeConversationHasRunningWork(
          nativeSnapshot({ phase: 'idle', tasks: [nativeTask(status)] }),
        ),
      ).toBe(false);
    },
  );

  it('does not invent running work when no native snapshot exists', () => {
    expect(nativeConversationHasRunningWork(undefined)).toBe(false);
  });
});

describe('runConfirmableConversationSurfaceSwitch', () => {
  it('switches an idle conversation directly with one non-interrupting IPC', async () => {
    const confirm = vi.fn(async () => true);
    const invoke = vi.fn(async (allowInterrupt: boolean) => ({ allowInterrupt, ok: true }));

    const attempt = await runConfirmableConversationSurfaceSwitch(false, confirm, invoke);

    expect(attempt).toEqual({
      cancelled: false,
      result: { allowInterrupt: false, ok: true },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(false);
  });

  it('cancels locally known running work before any destructive IPC', async () => {
    const confirm = vi.fn(async () => false);
    const invoke = vi.fn(async (allowInterrupt: boolean) => ({ allowInterrupt, ok: true }));

    await expect(runConfirmableConversationSurfaceSwitch(true, confirm, invoke)).resolves.toEqual({
      cancelled: true,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('confirms locally known running work exactly once and authorizes one IPC', async () => {
    const confirm = vi.fn(async () => true);
    const invoke = vi.fn(async (allowInterrupt: boolean) => ({ allowInterrupt, ok: true }));

    const attempt = await runConfirmableConversationSurfaceSwitch(true, confirm, invoke);

    expect(attempt).toMatchObject({ cancelled: false, result: { ok: true } });
    expect(confirm).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(true);
  });

  it('lets the authoritative process request confirmation without interrupting on cancel', async () => {
    const confirm = vi.fn(async () => false);
    const invoke = vi.fn(async (allowInterrupt: boolean) => ({
      ok: false,
      requiresConfirmation: !allowInterrupt,
    }));

    await expect(runConfirmableConversationSurfaceSwitch(false, confirm, invoke)).resolves.toEqual({
      cancelled: true,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(false);
    expect(invoke.mock.calls.some(([allowInterrupt]) => allowInterrupt)).toBe(false);
  });

  it('retries an authoritative busy response once after one confirmation', async () => {
    const confirm = vi.fn(async () => true);
    const invoke = vi.fn(async (allowInterrupt: boolean) =>
      allowInterrupt ? { ok: true } : { ok: false, requiresConfirmation: true },
    );

    const attempt = await runConfirmableConversationSurfaceSwitch(false, confirm, invoke);

    expect(attempt).toEqual({ cancelled: false, result: { ok: true } });
    expect(confirm).toHaveBeenCalledOnce();
    expect(invoke.mock.calls).toEqual([[false], [true]]);
  });
});

describe('selectReusableConversationSurfaceSession', () => {
  it('keeps a surface switch on the tab already bound to that conversation', () => {
    const usable = new Set(['bound-tab', 'active-tab']);

    expect(
      selectReusableConversationSurfaceSession(['bound-tab', 'active-tab'], (sessionId) =>
        usable.has(sessionId),
      ),
    ).toBe('bound-tab');
  });

  it('falls back to a compatible active tab without choosing an unrelated tab', () => {
    expect(
      selectReusableConversationSurfaceSession(
        ['stale-bound-tab', 'active-tab'],
        (sessionId) => sessionId === 'active-tab',
      ),
    ).toBe('active-tab');
    expect(
      selectReusableConversationSurfaceSession(['stale-bound-tab', 'unrelated-tab'], () => false),
    ).toBeUndefined();
  });
});
