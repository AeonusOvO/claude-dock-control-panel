import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * `safeStorage` needs a running Electron app, so the encryption is stubbed with a reversible
 * transform. That still exercises the thing worth testing here: whether the credential ever reaches
 * disk in a form the file itself reveals.
 */
vi.mock('electron', () => ({
  safeStorage: {
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    isEncryptionAvailable: () => true,
  },
}));

const { ClaudeConnectionHistoryStore, MAX_HISTORY_ENTRIES } =
  await import('../src/main/claude-connection-history');

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createStore = () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-history-'));
  fixtureRoots.push(fixtureRoot);
  return {
    fixtureRoot,
    historyPath: path.join(fixtureRoot, 'claude', 'connection-history.json'),
    store: new ClaudeConnectionHistoryStore(fixtureRoot),
  };
};

const CWD = 'D:\\Projects\\Example';

const gatewayConfig = (overrides: Record<string, unknown> = {}) => ({
  config: {
    authMode: 'apiKey' as const,
    baseUrl: 'http://127.0.0.1:3456',
    credentialAction: 'replace' as const,
    model: 'glm-4.6',
    preset: 'gateway' as const,
    provider: 'gateway' as const,
    ...overrides,
  },
  credential: 'sk-secret-value',
  gatewayEndpoint: 'http://127.0.0.1:3456',
  gatewayState: 'running' as const,
});

describe('ClaudeConnectionHistoryStore', () => {
  it('records a save with the gateway state attached', () => {
    const { store } = createStore();

    const entries = store.record(CWD, gatewayConfig());

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      baseUrl: 'http://127.0.0.1:3456',
      credentialConfigured: true,
      gatewayEndpoint: 'http://127.0.0.1:3456',
      gatewayState: 'running',
      model: 'glm-4.6',
      preset: 'gateway',
    });
  });

  it('does not add a record when the save repeats the newest one', () => {
    const { store } = createStore();

    store.record(CWD, gatewayConfig());
    const entries = store.record(CWD, gatewayConfig());

    expect(entries).toHaveLength(1);
  });

  it('adds a record when any entered value differs', () => {
    const { store } = createStore();

    store.record(CWD, gatewayConfig());
    const entries = store.record(CWD, gatewayConfig({ model: 'glm-4.6-air' }));

    expect(entries).toHaveLength(2);
    expect(entries[0]?.model).toBe('glm-4.6-air');
  });

  it('adds a record when only the credential changed', () => {
    const { store } = createStore();

    store.record(CWD, gatewayConfig());
    const entries = store.record(CWD, { ...gatewayConfig(), credential: 'sk-rotated-value' });

    expect(entries).toHaveLength(2);
  });

  /*
   * The router flapping between running and stopped must not manufacture records: the gateway state
   * describes the machine at save time, not the configuration the user typed.
   */
  it('ignores a changed gateway state when deciding whether to add a record', () => {
    const { store } = createStore();

    store.record(CWD, gatewayConfig());
    const entries = store.record(CWD, { ...gatewayConfig(), gatewayState: 'stopped' });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.gatewayState).toBe('running');
  });

  it('never writes the credential to disk in clear text', () => {
    const { historyPath, store } = createStore();

    store.record(CWD, gatewayConfig());

    expect(readFileSync(historyPath, 'utf8')).not.toContain('sk-secret-value');
  });

  it('replays a record as a ready-to-save configuration', () => {
    const { store } = createStore();
    const [entry] = store.record(CWD, gatewayConfig());

    expect(store.toSaveInput(CWD, entry?.id ?? '')).toEqual({
      authMode: 'apiKey',
      baseUrl: 'http://127.0.0.1:3456',
      credential: 'sk-secret-value',
      credentialAction: 'replace',
      model: 'glm-4.6',
      modelFast: 'glm-4.6',
      preset: 'gateway',
      provider: 'gateway',
    });
  });

  it('keeps the stored credential when the record has none', () => {
    const { store } = createStore();
    const [entry] = store.record(CWD, {
      config: {
        authMode: 'existing',
        baseUrl: '',
        credentialAction: 'keep',
        model: 'default',
        preset: 'anthropic',
        provider: 'anthropic',
      },
      gatewayState: 'unknown',
    });

    expect(store.toSaveInput(CWD, entry?.id ?? '')).toMatchObject({
      credential: undefined,
      credentialAction: 'keep',
    });
  });

  it('deletes one record and leaves the rest', () => {
    const { store } = createStore();
    store.record(CWD, gatewayConfig());
    const entries = store.record(CWD, gatewayConfig({ model: 'glm-4.6-air' }));
    const newestId = entries[0]?.id ?? '';

    const remaining = store.remove(CWD, newestId);

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.model).toBe('glm-4.6');
    expect(() => store.toSaveInput(CWD, newestId)).toThrow(/已被删除/);
  });

  it('treats Windows paths case-insensitively', () => {
    const { store } = createStore();

    store.record(CWD, gatewayConfig());

    expect(store.list('d:\\projects\\example')).toHaveLength(1);
  });

  it('caps the list so the file cannot grow without bound', () => {
    const { store } = createStore();

    for (let index = 0; index < MAX_HISTORY_ENTRIES + 5; index += 1) {
      store.record(CWD, gatewayConfig({ model: `model-${index}` }));
    }

    const entries = store.list(CWD);
    expect(entries).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(entries[0]?.model).toBe(`model-${MAX_HISTORY_ENTRIES + 4}`);
  });

  it('recovers from a corrupted history file instead of throwing', () => {
    const { fixtureRoot, historyPath, store } = createStore();
    store.record(CWD, gatewayConfig());
    writeFileSync(historyPath, '{ not json', 'utf8');

    expect(new ClaudeConnectionHistoryStore(fixtureRoot).list(CWD)).toEqual([]);
  });
});
