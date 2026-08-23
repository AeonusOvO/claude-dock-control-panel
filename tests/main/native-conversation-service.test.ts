import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationOwnerRegistry } from '../../src/main/conversation/owner-registry';
import {
  ConversationRecoveryStore,
  type RecoveryEncryption,
} from '../../src/main/conversation/recovery-store';
import { FakeConversationAdapter } from '../../src/main/conversation/fake-adapter';
import { NativeConversationService } from '../../src/main/conversation/service';
import type { ConversationEvent } from '../../src/shared/conversation/native';

type ConversationEventWithoutEnvelope = ConversationEvent extends infer Event
  ? Event extends ConversationEvent
    ? Omit<
        Event,
        'conversationId' | 'emittedAt' | 'projectPath' | 'revision' | 'runtime' | 'sequence'
      >
    : never
  : never;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const root = (): string => {
  const value = mkdtempSync(path.join(tmpdir(), 'claudedock-native-service-'));
  roots.push(value);
  return value;
};

const encryption = (available = true): RecoveryEncryption => ({
  decryptString: (value) => Buffer.from(value.toString('utf8'), 'base64').toString('utf8'),
  encryptString: (value) => Buffer.from(Buffer.from(value).toString('base64')),
  isEncryptionAvailable: () => available,
});

const projectPath = 'D:\\Projects\\Native';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('native conversation service', () => {
  it('passes launch-only runtime settings to the adapter without persisting them', async () => {
    const adapter = new FakeConversationAdapter();
    const recoveryStore = new ConversationRecoveryStore(root(), encryption());
    let receivedModel: string | undefined;
    let receivedRuntimeModel: string | undefined;
    let receivedSettingsEnvironment: Record<string, string> | undefined;
    const start = adapter.start.bind(adapter);
    adapter.start = async (input) => {
      receivedModel = input.model;
      receivedRuntimeModel = input.runtimeModel;
      receivedSettingsEnvironment = input.settingsEnvironment;
      await start(input);
    };
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry: new ConversationOwnerRegistry(),
      recoveryStore,
      runtime: 'claude',
    });

    const started = await service.start({
      model: 'claude-opus-5',
      projectPath,
      runtimeModel: 'claude-opus-5[1m]',
      settingsEnvironment: { CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
    });

    expect(started.ok).toBe(true);
    expect(receivedModel).toBe('claude-opus-5');
    expect(receivedRuntimeModel).toBe('claude-opus-5[1m]');
    expect(receivedSettingsEnvironment).toEqual({ CLAUDE_CODE_ATTRIBUTION_HEADER: '0' });
    expect(recoveryStore.list()[0]?.launch.model).toBe('claude-opus-5');
    expect(recoveryStore.list()[0]?.launch).not.toHaveProperty('runtimeModel');
    expect(recoveryStore.list()[0]?.launch).not.toHaveProperty('settingsEnvironment');
  });

  it('rejects late native adapter admission after quit cleanup begins', async () => {
    const adapter = new FakeConversationAdapter();
    const adapterStart = vi.spyOn(adapter, 'start');
    const ownerRegistry = new ConversationOwnerRegistry();
    const recoveryStore = new ConversationRecoveryStore(root(), encryption());
    let admissionCheck = 0;
    const assertLaunchAdmissionAllowed = vi.fn(() => {
      admissionCheck += 1;
      if (admissionCheck > 1) {
        throw new Error('应用正在退出，无法启动新的 Claude 会话。');
      }
    });
    const service = new NativeConversationService({
      adapter,
      assertLaunchAdmissionAllowed,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore,
      runtime: 'claude',
    });

    const started = await service.start({ projectPath });

    expect(started).toMatchObject({
      message: '应用正在退出，无法启动新的 Claude 会话。',
      ok: false,
      reused: false,
    });
    expect(assertLaunchAdmissionAllowed).toHaveBeenCalledTimes(2);
    expect(adapterStart).not.toHaveBeenCalled();
    expect(service.activeConversationIds(projectPath)).toEqual(new Set());
    expect(recoveryStore.list()).toEqual([]);
  });

  it('tears down an adapter that finishes after quit cleanup starts', async () => {
    const adapter = new FakeConversationAdapter();
    const adapterEntered = deferred<void>();
    const continueAdapter = deferred<void>();
    const startAdapter = adapter.start.bind(adapter);
    adapter.start = async (input) => {
      adapterEntered.resolve();
      await continueAdapter.promise;
      await startAdapter(input);
    };
    let admissionAllowed = true;
    const ownerRegistry = new ConversationOwnerRegistry();
    const recoveryStore = new ConversationRecoveryStore(root(), encryption());
    const service = new NativeConversationService({
      adapter,
      assertLaunchAdmissionAllowed: () => {
        if (!admissionAllowed) throw new Error('应用正在退出，无法启动新的 Claude 会话。');
      },
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore,
      runtime: 'claude',
    });
    const conversationId = '77777777-7777-4777-8777-777777777777';

    const starting = service.start({ conversationId, projectPath });
    await adapterEntered.promise;
    admissionAllowed = false;
    continueAdapter.resolve();

    await expect(starting).resolves.toMatchObject({
      message: '应用正在退出，无法启动新的 Claude 会话。',
      ok: false,
      reused: false,
    });
    expect(service.activeIds()).toEqual([]);
    expect(ownerRegistry.activeConversationIds('claude', projectPath)).toEqual(new Set());
    expect(recoveryStore.list()).toEqual([]);
    await expect(adapter.listCommands(conversationId)).rejects.toThrow('隔离对话不存在。');
  });

  it('does not reactivate an admitted start after closeAll releases its exact owner', async () => {
    const adapter = new FakeConversationAdapter();
    const adapterEntered = deferred<void>();
    const continueAdapter = deferred<void>();
    adapter.start = async () => {
      adapterEntered.resolve();
      await continueAdapter.promise;
    };
    const ownerRegistry = new ConversationOwnerRegistry();
    const recoveryStore = new ConversationRecoveryStore(root(), encryption());
    const service = new NativeConversationService({
      adapter,
      assertLaunchAdmissionAllowed: () => undefined,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore,
      runtime: 'claude',
    });
    const conversationId = '88888888-8888-4888-8888-888888888888';

    const starting = service.start({ conversationId, projectPath });
    await adapterEntered.promise;
    await service.closeAll();
    continueAdapter.resolve();

    await expect(starting).resolves.toMatchObject({
      message: 'Claude 原生会话启动已取消。',
      ok: false,
      reused: false,
    });
    expect(service.activeIds()).toEqual([]);
    expect(ownerRegistry.activeConversationIds('claude', projectPath)).toEqual(new Set());
    expect(recoveryStore.list()).toEqual([]);
  });

  it('passes the project bypass gate to the adapter without persisting a privilege override', async () => {
    const adapter = new FakeConversationAdapter();
    let receivedAllowBypass: boolean | undefined;
    const start = adapter.start.bind(adapter);
    adapter.start = async (input) => {
      receivedAllowBypass = input.allowBypassPermissions;
      await start(input);
    };
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry: new ConversationOwnerRegistry(),
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });

    const started = await service.start({ allowBypassPermissions: true, projectPath });

    expect(started.ok).toBe(true);
    expect(receivedAllowBypass).toBe(true);
    expect(service.getSnapshot(started.conversationId)?.capabilities?.permissionModes).toContain(
      'bypassPermissions',
    );
    expect(service.listRecoveries()[0]?.launch).not.toHaveProperty('allowBypassPermissions');
  });

  it('preallocates a UUID, owns it once, confirms submissions and returns it to history on close', async () => {
    const ownerRegistry = new ConversationOwnerRegistry();
    const recoveryStore = new ConversationRecoveryStore(root(), encryption());
    const snapshots: string[] = [];
    const service = new NativeConversationService({
      adapter: new FakeConversationAdapter(),
      onSnapshot: (snapshot) => snapshots.push(snapshot.phase),
      ownerRegistry,
      recoveryStore,
      runtime: 'claude',
    });
    const started = await service.start({ projectPath });
    expect(started).toMatchObject({ ok: true, reused: false });
    expect(started.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(service.activeConversationIds(projectPath)).toEqual(new Set([started.conversationId]));

    const submitted = await service.submit(started.conversationId, {
      blocks: [{ text: '实现恢复', type: 'text' }],
      clientSubmissionId: 'submit-1',
    });
    expect(submitted.ok).toBe(true);
    expect(recoveryStore.list()[0]?.submissions[0]?.state).toBe('transcript-confirmed');
    expect(snapshots).toContain('running');
    expect(snapshots).toContain('idle');

    expect((await service.close(started.conversationId)).ok).toBe(true);
    expect(service.activeConversationIds(projectPath).size).toBe(0);
    expect(recoveryStore.list()[0]?.clean).toBe(true);
  });

  it('rejects closeAll after a real adapter failure while releasing successful conversations', async () => {
    const adapter = new FakeConversationAdapter();
    const ownerRegistry = new ConversationOwnerRegistry();
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });
    const first = await service.start({ projectPath });
    const second = await service.start({ projectPath });
    const close = adapter.close.bind(adapter);
    adapter.close = async (conversationId) => {
      if (conversationId === second.conversationId) {
        throw new Error('adapter close failed');
      }
      await close(conversationId);
    };

    await expect(service.closeAll()).rejects.toThrow('无法关闭 1 个原生会话。');

    expect(service.activeIds()).toEqual([second.conversationId]);
    expect(service.activeConversationIds(projectPath)).toEqual(new Set([second.conversationId]));
    expect(ownerRegistry.activeConversationIds('claude', projectPath)).toEqual(
      new Set([second.conversationId]),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it('keeps an authorized submit pending through foreground and background turn work', async () => {
    const adapter = new FakeConversationAdapter();
    let publish: ((event: ConversationEvent) => void) | undefined;
    const subscribe = adapter.subscribe.bind(adapter);
    adapter.subscribe = (listener) => {
      publish = listener;
      return subscribe(listener);
    };
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry: new ConversationOwnerRegistry(),
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });
    const started = await service.start({ projectPath });
    let sequence = service.getSnapshot(started.conversationId)!.sequence;
    const emit = (event: ConversationEventWithoutEnvelope): void => {
      sequence += 1;
      publish!({
        ...event,
        conversationId: started.conversationId,
        emittedAt: Date.now(),
        projectPath,
        revision: 1,
        runtime: 'claude',
        sequence,
      } as ConversationEvent);
    };
    adapter.submit = async (_conversationId, input) => {
      emit({
        message: {
          blocks: [{ id: `${input.clientSubmissionId}:0`, text: '保持授权', type: 'text' }],
          createdAt: Date.now(),
          id: input.clientSubmissionId,
          role: 'user',
          status: 'complete',
        },
        type: 'message.upsert',
      });
      emit({ phase: 'running', type: 'conversation.phase' });
    };

    let settled = false;
    const submission = service
      .submitAndWaitForTurn(started.conversationId, {
        blocks: [{ text: '保持授权', type: 'text' }],
        clientSubmissionId: 'authorized-turn-1',
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(service.projectPathForActiveConversation(started.conversationId)).toBe(projectPath);

    emit({ phase: 'requires-action', type: 'conversation.phase' });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit({
      tasks: [
        {
          cancellable: true,
          description: '后台检查',
          id: 'task-1',
          kind: 'background',
          status: 'running',
          updatedAt: Date.now(),
        },
      ],
      type: 'tasks.reconciled',
    });
    emit({ phase: 'idle', type: 'conversation.phase' });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit({
      tasks: [
        {
          cancellable: false,
          description: '后台检查',
          id: 'task-1',
          kind: 'background',
          status: 'completed',
          updatedAt: Date.now(),
        },
      ],
      type: 'tasks.reconciled',
    });
    await expect(submission).resolves.toMatchObject({ ok: true });
    expect(settled).toBe(true);
  });

  it('focuses an existing terminal owner instead of starting a duplicate runtime', async () => {
    const ownerRegistry = new ConversationOwnerRegistry();
    const conversationId = '11111111-1111-4111-8111-111111111111';
    ownerRegistry.claim({
      conversationId,
      generation: 2,
      ownerId: 'terminal-2',
      ownerKind: 'terminal',
      phase: 'active',
      projectPath,
      runtime: 'claude',
    });
    const service = new NativeConversationService({
      adapter: new FakeConversationAdapter(),
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });

    await expect(
      service.start({ conversationId, projectPath, resume: true }),
    ).resolves.toMatchObject({
      existingOwnerKind: 'terminal',
      ok: true,
      reused: true,
    });
  });

  it('blocks send before the adapter when safeStorage is unavailable', async () => {
    const recoveryStore = new ConversationRecoveryStore(root(), encryption(false));
    const service = new NativeConversationService({
      adapter: new FakeConversationAdapter(),
      onSnapshot: () => undefined,
      ownerRegistry: new ConversationOwnerRegistry(),
      recoveryStore,
      runtime: 'claude',
    });
    const started = await service.start({ projectPath });
    const result = await service.submit(started.conversationId, {
      blocks: [{ text: '必须保留在输入框', type: 'text' }],
      clientSubmissionId: 'submit-1',
    });

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/尚未发送/) });
    expect(recoveryStore.list()[0]?.submissions).toEqual([]);
    expect(service.getSnapshot(started.conversationId)?.messages).toEqual([]);
  });

  it('rolls back the owner when adapter startup fails', async () => {
    const adapter = new FakeConversationAdapter();
    adapter.start = async () => {
      throw new Error('fake startup failure');
    };
    const ownerRegistry = new ConversationOwnerRegistry();
    const recoveryStore = new ConversationRecoveryStore(root(), encryption());
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore,
      runtime: 'claude',
    });
    const result = await service.start({ projectPath });

    expect(result).toMatchObject({ ok: false, message: 'fake startup failure' });
    expect(ownerRegistry.activeConversationIds('claude', projectPath).size).toBe(0);
    expect(recoveryStore.list()).toEqual([]);
  });

  it('releases the native owner when the adapter reports a fatal stream error', async () => {
    const adapter = new FakeConversationAdapter();
    let publish: ((event: ConversationEvent) => void) | undefined;
    const subscribe = adapter.subscribe.bind(adapter);
    adapter.subscribe = (listener) => {
      publish = listener;
      return subscribe(listener);
    };
    const ownerRegistry = new ConversationOwnerRegistry();
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });
    const started = await service.start({ projectPath });

    publish!({
      conversationId: started.conversationId,
      emittedAt: Date.now(),
      message: 'SDK transport exited',
      projectPath,
      revision: 1,
      runtime: 'claude',
      sequence: 100,
      type: 'conversation.error',
    });

    expect(service.getSnapshot(started.conversationId)).toBeUndefined();
    expect(ownerRegistry.activeConversationIds('claude', projectPath)).toEqual(new Set());
  });

  it('keeps an existing recovery entry when an exact resume fails to start', async () => {
    const adapter = new FakeConversationAdapter();
    adapter.start = async () => {
      throw new Error('resume failed');
    };
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const recoveryStore = new ConversationRecoveryStore(root(), encryption());
    recoveryStore.reserve({
      conversationId,
      launch: { configFingerprint: 'a'.repeat(64) },
      ownerKind: 'native',
      projectPath,
      runtime: 'claude',
    });
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry: new ConversationOwnerRegistry(),
      recoveryStore,
      runtime: 'claude',
    });

    await expect(
      service.start({ conversationId, projectPath, resume: true }),
    ).resolves.toMatchObject({ ok: false, message: 'resume failed' });
    expect(recoveryStore.list()).toHaveLength(1);
    expect(recoveryStore.list()[0]?.conversationId).toBe(conversationId);
  });

  it('transfers one owner to a terminal and preserves an unsent encrypted draft', async () => {
    const ownerRegistry = new ConversationOwnerRegistry();
    const recoveryStore = new ConversationRecoveryStore(root(), encryption());
    const service = new NativeConversationService({
      adapter: new FakeConversationAdapter(),
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore,
      runtime: 'claude',
    });
    const started = await service.start({ projectPath });
    const result = await service.transferToTerminal(
      started.conversationId,
      {
        blocks: [{ text: '尚未发送的草稿', type: 'text' }],
        clientSubmissionId: 'transfer-draft',
      },
      async ({ conversationId, projectPath: cwd }) => ({
        owner: {
          conversationId,
          generation: 8,
          ownerId: 'terminal:session-8',
          ownerKind: 'terminal',
          phase: 'active',
          projectPath: cwd,
          runtime: 'claude',
        },
        terminalSessionId: 'session-8',
      }),
    );

    expect(result).toMatchObject({ ok: true, terminalSessionId: 'session-8' });
    expect(
      ownerRegistry.ownerFor({
        conversationId: started.conversationId,
        projectPath,
        runtime: 'claude',
      }),
    ).toMatchObject({ ownerKind: 'terminal', ownerId: 'terminal:session-8' });
    expect(recoveryStore.list()[0]?.submissions[0]?.state).toBe('interrupted-draft');
  });

  it('round-trips the same conversation UUID through the same terminal tab', async () => {
    const adapter = new FakeConversationAdapter();
    let lastStartInput: { conversationId?: string; resume?: boolean } | undefined;
    const start = adapter.start.bind(adapter);
    adapter.start = async (input) => {
      lastStartInput = { conversationId: input.conversationId, resume: input.resume };
      await start(input);
    };
    const ownerRegistry = new ConversationOwnerRegistry();
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });
    const started = await service.start({ projectPath });
    const terminalTabId = 'stable-tab';

    const transferred = await service.transferToTerminal(
      started.conversationId,
      undefined,
      async (identity) => {
        expect(identity).toEqual({
          conversationId: started.conversationId,
          projectPath,
        });
        return {
          owner: {
            conversationId: identity.conversationId,
            generation: 10,
            ownerId: `terminal:${terminalTabId}`,
            ownerKind: 'terminal' as const,
            phase: 'active' as const,
            projectPath: identity.projectPath,
            runtime: 'claude' as const,
          },
          terminalSessionId: terminalTabId,
        };
      },
    );

    expect(transferred).toMatchObject({ ok: true, terminalSessionId: terminalTabId });
    const adopted = await service.adoptFromTerminal(
      { conversationId: started.conversationId, projectPath },
      async () => undefined,
      async () => undefined,
    );

    expect(adopted).toMatchObject({ conversationId: started.conversationId, ok: true });
    expect(lastStartInput).toEqual({ conversationId: started.conversationId, resume: true });
    expect(
      ownerRegistry.ownerFor({
        conversationId: started.conversationId,
        projectPath,
        runtime: 'claude',
      }),
    ).toMatchObject({ ownerKind: 'native', phase: 'active' });
  });

  it('requires confirmation before transferring running native work to a terminal', async () => {
    const adapter = new FakeConversationAdapter();
    let publish: ((event: ConversationEvent) => void) | undefined;
    const subscribe = adapter.subscribe.bind(adapter);
    adapter.subscribe = (listener) => {
      publish = listener;
      return subscribe(listener);
    };
    const ownerRegistry = new ConversationOwnerRegistry();
    const beginTransfer = vi.spyOn(ownerRegistry, 'beginTransfer');
    const close = vi.spyOn(adapter, 'close');
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });
    const started = await service.start({ projectPath });
    publish!({
      conversationId: started.conversationId,
      emittedAt: Date.now(),
      phase: 'running',
      projectPath,
      revision: 1,
      runtime: 'claude',
      sequence: 100,
      type: 'conversation.phase',
    });
    const authorizeTerminalLaunch = vi.fn(
      async (
        _identity: { conversationId: string; projectPath: string },
        operation: () => Promise<unknown>,
      ) => operation(),
    );
    const startTerminal = vi.fn(
      async ({
        conversationId,
        projectPath: cwd,
      }: {
        conversationId: string;
        projectPath: string;
      }) => ({
        owner: {
          conversationId,
          generation: 9,
          ownerId: 'terminal:session-9',
          ownerKind: 'terminal' as const,
          phase: 'active' as const,
          projectPath: cwd,
          runtime: 'claude' as const,
        },
        terminalSessionId: 'session-9',
      }),
    );

    const blocked = await service.transferToTerminal(
      started.conversationId,
      undefined,
      startTerminal,
      false,
      authorizeTerminalLaunch as unknown as <T>(
        identity: { conversationId: string; projectPath: string },
        operation: () => Promise<T>,
      ) => Promise<T>,
    );

    expect(blocked).toMatchObject({ ok: false, requiresConfirmation: true });
    expect(authorizeTerminalLaunch).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(startTerminal).not.toHaveBeenCalled();
    expect(beginTransfer).not.toHaveBeenCalled();
    expect(
      ownerRegistry.ownerFor({
        conversationId: started.conversationId,
        projectPath,
        runtime: 'claude',
      }),
    ).toMatchObject({ ownerKind: 'native', phase: 'active' });

    const allowed = await service.transferToTerminal(
      started.conversationId,
      undefined,
      startTerminal,
      true,
      authorizeTerminalLaunch as unknown as <T>(
        identity: { conversationId: string; projectPath: string },
        operation: () => Promise<T>,
      ) => Promise<T>,
    );

    expect(allowed).toMatchObject({ ok: true, terminalSessionId: 'session-9' });
    expect(authorizeTerminalLaunch).toHaveBeenCalledWith(
      {
        conversationId: started.conversationId,
        projectPath,
      },
      expect.any(Function),
    );
    expect(authorizeTerminalLaunch.mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(startTerminal).toHaveBeenCalledTimes(1);
    expect(beginTransfer).toHaveBeenCalledTimes(1);
    expect(
      ownerRegistry.ownerFor({
        conversationId: started.conversationId,
        projectPath,
        runtime: 'claude',
      }),
    ).toMatchObject({ ownerKind: 'terminal', ownerId: 'terminal:session-9' });
  });

  it('keeps the native runtime active when terminal launch authorization fails', async () => {
    const adapter = new FakeConversationAdapter();
    const close = vi.spyOn(adapter, 'close');
    const ownerRegistry = new ConversationOwnerRegistry();
    const beginTransfer = vi.spyOn(ownerRegistry, 'beginTransfer');
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });
    const started = await service.start({ projectPath });
    const startTerminal = vi.fn();

    await expect(
      service.transferToTerminal(
        started.conversationId,
        undefined,
        startTerminal,
        false,
        async () => {
          throw new Error('network blocked');
        },
      ),
    ).rejects.toThrow('network blocked');

    expect(close).not.toHaveBeenCalled();
    expect(beginTransfer).not.toHaveBeenCalled();
    expect(startTerminal).not.toHaveBeenCalled();
    expect(service.getSnapshot(started.conversationId)).toBeDefined();
  });

  it('rolls a failed terminal transfer back to the original native owner', async () => {
    const ownerRegistry = new ConversationOwnerRegistry();
    const service = new NativeConversationService({
      adapter: new FakeConversationAdapter(),
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });
    const started = await service.start({ projectPath });
    const result = await service.transferToTerminal(started.conversationId, undefined, async () => {
      throw new Error('terminal failed');
    });

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('terminal failed'),
    });
    expect(
      ownerRegistry.ownerFor({
        conversationId: started.conversationId,
        projectPath,
        runtime: 'claude',
      }),
    ).toMatchObject({ ownerKind: 'native', phase: 'active' });
    expect(service.getSnapshot(started.conversationId)).toBeDefined();
  });

  it('adopts a terminal-owned conversation by resuming its exact UUID', async () => {
    const adapter = new FakeConversationAdapter();
    let resumedInput: { conversationId?: string; resume?: boolean } | undefined;
    const start = adapter.start.bind(adapter);
    adapter.start = async (input) => {
      resumedInput = { conversationId: input.conversationId, resume: input.resume };
      await start(input);
    };
    const conversationId = '33333333-3333-4333-8333-333333333333';
    const ownerRegistry = new ConversationOwnerRegistry();
    ownerRegistry.claim({
      conversationId,
      generation: 4,
      ownerId: 'terminal:session-4',
      ownerKind: 'terminal',
      phase: 'active',
      projectPath,
      runtime: 'claude',
    });
    const recoveryStore = new ConversationRecoveryStore(root(), encryption());
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore,
      runtime: 'claude',
    });

    let stopped = false;
    let restored = false;
    const result = await service.adoptFromTerminal(
      { conversationId, projectPath },
      async () => {
        stopped = true;
      },
      async () => {
        restored = true;
      },
    );

    expect(result).toMatchObject({ conversationId, ok: true });
    expect(stopped).toBe(true);
    // The terminal must never be restarted on the success path: two consumers on one JSONL.
    expect(restored).toBe(false);
    // Adoption is an exact resume, never a fresh launch that would fork the transcript.
    expect(resumedInput).toMatchObject({ conversationId, resume: true });
    expect(
      ownerRegistry.ownerFor({ conversationId, projectPath, runtime: 'claude' }),
    ).toMatchObject({ ownerKind: 'native', phase: 'active' });
    expect(service.activeConversationIds(projectPath)).toEqual(new Set([conversationId]));
    expect(recoveryStore.list()[0]?.conversationId).toBe(conversationId);
  });

  it('refuses to adopt a conversation the terminal does not own', async () => {
    const service = new NativeConversationService({
      adapter: new FakeConversationAdapter(),
      onSnapshot: () => undefined,
      ownerRegistry: new ConversationOwnerRegistry(),
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });

    let stopped = false;
    const result = await service.adoptFromTerminal(
      { conversationId: '44444444-4444-4444-8444-444444444444', projectPath },
      async () => {
        stopped = true;
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/尚未持有/) });
    // The gate has to run before the PTY is killed, or a refused adopt still ends the user's session.
    expect(stopped).toBe(false);
  });

  it('rolls a failed adoption back to the terminal owner and restarts the terminal', async () => {
    const adapter = new FakeConversationAdapter();
    adapter.start = async () => {
      throw new Error('adopt failed');
    };
    const conversationId = '55555555-5555-4555-8555-555555555555';
    const ownerRegistry = new ConversationOwnerRegistry();
    ownerRegistry.claim({
      conversationId,
      generation: 6,
      ownerId: 'terminal:session-6',
      ownerKind: 'terminal',
      phase: 'active',
      projectPath,
      runtime: 'claude',
    });
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });

    let restored = false;
    const result = await service.adoptFromTerminal(
      { conversationId, projectPath },
      async () => undefined,
      async () => {
        restored = true;
      },
    );

    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('adopt failed') });
    expect(restored).toBe(true);
    expect(
      ownerRegistry.ownerFor({ conversationId, projectPath, runtime: 'claude' }),
    ).toMatchObject({ ownerId: 'terminal:session-6', ownerKind: 'terminal' });
    // The registry still holds the terminal owner, so probe the service's own active map instead.
    expect(service.activeIds()).not.toContain(conversationId);
  });

  it('reports a failed adoption that could not restart the terminal either', async () => {
    const adapter = new FakeConversationAdapter();
    adapter.start = async () => {
      throw new Error('adopt failed');
    };
    const conversationId = '66666666-6666-4666-8666-666666666666';
    const ownerRegistry = new ConversationOwnerRegistry();
    ownerRegistry.claim({
      conversationId,
      generation: 2,
      ownerId: 'terminal:session-2',
      ownerKind: 'terminal',
      phase: 'active',
      projectPath,
      runtime: 'claude',
    });
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });

    const result = await service.adoptFromTerminal(
      { conversationId, projectPath },
      async () => undefined,
      async () => {
        throw new Error('terminal restart failed');
      },
    );

    // Both failures have to reach the user: silently claiming recovery would strand the session.
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/手动重新启动/) });
  });
});
