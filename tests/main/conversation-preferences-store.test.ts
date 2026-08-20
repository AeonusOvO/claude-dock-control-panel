import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationPreferencesStore } from '../../src/main/conversation/preferences-store';

const CONVERSATION = '9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

describe('conversation preferences store', () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-conversation-'));
  });

  afterEach(() => {
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('round-trips a conversation through a fresh store instance', () => {
    new ConversationPreferencesStore(userDataPath).record(CONVERSATION, {
      effort: 'xhigh',
      model: 'claude-opus-5',
      permissionMode: 'acceptEdits',
    });

    expect(new ConversationPreferencesStore(userDataPath).get(CONVERSATION)).toMatchObject({
      effort: 'xhigh',
      model: 'claude-opus-5',
      permissionMode: 'acceptEdits',
    });
  });

  it('merges partial observations instead of erasing what is already known', () => {
    const store = new ConversationPreferencesStore(userDataPath);
    store.record(CONVERSATION, { effort: 'high', model: 'claude-opus-5' });
    store.record(CONVERSATION, { permissionMode: 'plan' });

    expect(store.get(CONVERSATION)).toMatchObject({
      effort: 'high',
      model: 'claude-opus-5',
      permissionMode: 'plan',
    });
  });

  it('rejects ids and values that could reach a shell or a filename', () => {
    const store = new ConversationPreferencesStore(userDataPath);
    store.record('../../etc/passwd', { model: 'claude-opus-5' });
    store.record(CONVERSATION, {
      effort: 'turbo' as never,
      model: 'claude-opus-5; rm -rf /',
      permissionMode: 'root' as never,
    });

    expect(store.get('../../etc/passwd')).toBeUndefined();
    expect(store.get(CONVERSATION)).toBeUndefined();
  });

  it('forgets a conversation on request', () => {
    const store = new ConversationPreferencesStore(userDataPath);
    store.record(CONVERSATION, { effort: 'low' });
    store.remove(CONVERSATION);

    expect(store.get(CONVERSATION)).toBeUndefined();
  });
});
