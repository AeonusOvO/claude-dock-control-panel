import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationOwnerRegistry } from '../src/main/conversation-owner-registry';
import {
  ConversationRecoveryStore,
  type RecoveryEncryption,
} from '../src/main/conversation-recovery-store';
import { FakeConversationAdapter } from '../src/main/fake-conversation-adapter';
import { NativeConversationService } from '../src/main/native-conversation-service';

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

describe('native conversation service', () => {
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
    const service = new NativeConversationService({
      adapter,
      onSnapshot: () => undefined,
      ownerRegistry,
      recoveryStore: new ConversationRecoveryStore(root(), encryption()),
      runtime: 'claude',
    });
    const result = await service.start({ projectPath });

    expect(result).toMatchObject({ ok: false, message: 'fake startup failure' });
    expect(ownerRegistry.activeConversationIds('claude', projectPath).size).toBe(0);
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
});
