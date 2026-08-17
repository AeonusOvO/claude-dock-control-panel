import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationRecoveryStore,
  recoveryConfigFingerprint,
  type RecoveryEncryption,
} from '../src/main/conversation-recovery-store';

const roots: string[] = [];
const createRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-recovery-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const encryption = (available = true): RecoveryEncryption => ({
  decryptString: (buffer) =>
    Buffer.from(buffer.toString('utf8').slice(4), 'base64').toString('utf8'),
  encryptString: (plainText) => Buffer.from(`enc:${Buffer.from(plainText).toString('base64')}`),
  isEncryptionAvailable: () => available,
});

const identity = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  projectPath: 'D:\\Projects\\Example',
  runtime: 'claude' as const,
};

const reserve = (store: ConversationRecoveryStore): void => {
  store.reserve({
    ...identity,
    launch: {
      configFingerprint: recoveryConfigFingerprint({ endpoint: 'official', model: 'opus' }),
      endpointIdentity: 'official',
      model: 'opus',
    },
    ownerKind: 'native',
  });
};

describe('conversation recovery store', () => {
  it('encrypts prepared prompts and never exposes them in views or journal plaintext', () => {
    const root = createRoot();
    const store = new ConversationRecoveryStore(root, encryption(), () => 100);
    reserve(store);
    const prepared = store.preparePrompt(
      identity.runtime,
      identity.projectPath,
      identity.conversationId,
      'submit-1',
      '绝密提示词',
    );

    expect(prepared).toMatchObject({ sequence: 1, state: 'prepared' });
    expect(JSON.stringify(store.list())).not.toContain('绝密提示词');
    const raw = readFileSync(path.join(root, 'claude', 'recovery-journal.json'), 'utf8');
    expect(raw).not.toContain('绝密提示词');
    expect(
      store.readDraft(identity.runtime, identity.projectPath, identity.conversationId, 'submit-1'),
    ).toBe('绝密提示词');
  });

  it('fails closed before persistence when OS encryption is unavailable', () => {
    const store = new ConversationRecoveryStore(createRoot(), encryption(false));
    reserve(store);
    expect(() =>
      store.preparePrompt(
        identity.runtime,
        identity.projectPath,
        identity.conversationId,
        'submit-1',
        '不能丢失',
      ),
    ).toThrow(/尚未发送/);
    expect(store.list()[0]?.submissions).toEqual([]);
  });

  it('restores prepared input as a draft and marks dispatched input result unknown', () => {
    const store = new ConversationRecoveryStore(createRoot(), encryption(), () => 200);
    reserve(store);
    store.preparePrompt(
      identity.runtime,
      identity.projectPath,
      identity.conversationId,
      'draft',
      '还未发送',
    );
    store.preparePrompt(
      identity.runtime,
      identity.projectPath,
      identity.conversationId,
      'sent',
      '可能已发送',
    );
    store.markSubmission(
      identity.runtime,
      identity.projectPath,
      identity.conversationId,
      'sent',
      'dispatched',
    );

    expect(store.markInterrupted()[0]?.submissions).toMatchObject([
      { clientSubmissionId: 'draft', state: 'interrupted-draft' },
      { clientSubmissionId: 'sent', state: 'result-unknown' },
    ]);
    expect(() =>
      store.markClean(identity.runtime, identity.projectPath, identity.conversationId),
    ).toThrow(/待核对/);
  });

  it('removes encrypted prompt only after the transcript is confirmed', () => {
    const root = createRoot();
    const store = new ConversationRecoveryStore(root, encryption());
    reserve(store);
    store.preparePrompt(
      identity.runtime,
      identity.projectPath,
      identity.conversationId,
      'submit-1',
      '确认后清除',
    );
    store.markSubmission(
      identity.runtime,
      identity.projectPath,
      identity.conversationId,
      'submit-1',
      'transcript-confirmed',
    );
    expect(() =>
      store.readDraft(identity.runtime, identity.projectPath, identity.conversationId, 'submit-1'),
    ).toThrow(/没有可恢复/);
    expect(readFileSync(path.join(root, 'claude', 'recovery-journal.json'), 'utf8')).not.toContain(
      'encryptedPrompt',
    );
  });

  it('uses the last valid backup when the primary journal is truncated', () => {
    const root = createRoot();
    const store = new ConversationRecoveryStore(root, encryption(), () => 300);
    reserve(store);
    store.preparePrompt(
      identity.runtime,
      identity.projectPath,
      identity.conversationId,
      'first',
      '第一条',
    );
    const journalPath = path.join(root, 'claude', 'recovery-journal.json');
    writeFileSync(journalPath, '{"version":1,"records":[', 'utf8');

    const recovered = new ConversationRecoveryStore(root, encryption());
    expect(recovered.list()).toHaveLength(1);
    expect(recovered.list()[0]?.conversationId).toBe(identity.conversationId);
  });

  it('fails safe with an empty journal when primary and backup are both corrupt', () => {
    const root = createRoot();
    const directory = path.join(root, 'claude');
    const initial = new ConversationRecoveryStore(root, encryption());
    reserve(initial);
    writeFileSync(path.join(directory, 'recovery-journal.json'), 'broken', 'utf8');
    writeFileSync(path.join(directory, 'recovery-journal.json.bak'), 'also broken', 'utf8');
    expect(new ConversationRecoveryStore(root, encryption()).list()).toEqual([]);
  });

  it('keeps the encrypted prompt in memory when the confirming save fails', () => {
    const root = createRoot();
    const store = new ConversationRecoveryStore(root, encryption(), () => 400);
    reserve(store);
    store.preparePrompt(
      identity.runtime,
      identity.projectPath,
      identity.conversationId,
      'submission-1',
      '需要保留的草稿',
    );
    const journalPath = path.join(root, 'claude', 'recovery-journal.json');
    const before = readFileSync(journalPath, 'utf8');

    /*
     * `persist` writes its temporary file with the `wx` flag, so pre-creating the exact next
     * temporary path makes the save fail with EEXIST — a stand-in for ENOSPC or EACCES. The
     * mutation must not have been applied to memory yet: marking transcript-confirmed deletes the
     * encrypted prompt, and a later successful save would otherwise flush that deletion to disk
     * even though this confirmation never became durable.
     */
    // reserve() and preparePrompt() have each persisted once, so the next temporary id is 3.
    writeFileSync(`${journalPath}.${process.pid}.3.tmp`, 'blocking', 'utf8');
    expect(() =>
      store.markSubmission(
        identity.runtime,
        identity.projectPath,
        identity.conversationId,
        'submission-1',
        'transcript-confirmed',
      ),
    ).toThrow();

    expect(readFileSync(journalPath, 'utf8')).toBe(before);

    // The in-memory journal must still match what is on disk, so a later save cannot leak the
    // rolled-back deletion.
    const preserved = store.preserveUnsentDraft(
      identity.runtime,
      identity.projectPath,
      identity.conversationId,
      'submission-1',
    );
    expect(preserved.state).toBe('interrupted-draft');
  });
});
