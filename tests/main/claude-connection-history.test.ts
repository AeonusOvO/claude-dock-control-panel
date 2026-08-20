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
  await import('../../src/main/claude/connection-history');

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
      apiKeyHelperPolicy: 'prefer-claudedock',
      baseUrl: 'http://127.0.0.1:3456',
      credentialConfigured: true,
      gatewayEndpoint: 'http://127.0.0.1:3456',
      gatewayState: 'running',
      model: 'glm-4.6',
      preset: 'gateway',
      protocol: 'anthropic',
    });
  });

  it('preserves an OpenAI router provider name and protocol when replaying it', () => {
    const { store } = createStore();

    const [entry] = store.record(CWD, {
      ...gatewayConfig(),
      name: 'yunmai-openai',
      protocol: 'openai',
    });

    expect(entry).toMatchObject({ name: 'yunmai-openai', protocol: 'openai' });
    expect(store.toReplayInput(CWD, entry?.id ?? '')).toMatchObject({
      name: 'yunmai-openai',
      protocol: 'openai',
    });
  });

  it('replays an OpenAI history entry with its original relay fields instead of the local route', () => {
    const { store } = createStore();
    const sourceConfig = {
      authMode: 'authToken' as const,
      baseUrl: 'https://relay.example.com/v1/chat/completions',
      credentialAction: 'keep' as const,
      model: 'gpt-5.4',
      modelFast: 'gpt-5-mini',
      preset: 'custom' as const,
      protocol: 'openai' as const,
      provider: 'gateway' as const,
      routerProviderId: 'relay-example',
    };
    const [entry] = store.record(CWD, {
      ...gatewayConfig({
        authMode: 'authToken',
        model: 'relay-example/gpt-5.4',
        modelFast: 'relay-example/gpt-5-mini',
        preset: 'custom',
      }),
      credential: undefined,
      protocol: 'openai',
      routerProviderId: 'relay-example',
      sourceConfig,
      sourceCredentialConfigured: true,
    });

    expect(entry).toMatchObject({
      sourceBaseUrl: sourceConfig.baseUrl,
      sourceCredentialConfigured: true,
      sourceModel: 'gpt-5.4',
    });
    expect(store.toSaveInput(CWD, entry?.id ?? '')).toMatchObject(sourceConfig);
  });

  it('inherits a kept OpenAI upstream key for deduplication and records a rotation', () => {
    const { historyPath, store } = createStore();
    const sourceConfig = {
      authMode: 'authToken' as const,
      baseUrl: 'https://relay.example.com/v1/chat/completions',
      credentialAction: 'keep' as const,
      model: 'gpt-5.4',
      preset: 'custom' as const,
      protocol: 'openai' as const,
      provider: 'gateway' as const,
      routerProviderId: 'relay-example',
    };
    const input = {
      ...gatewayConfig({ model: 'relay-example/gpt-5.4', preset: 'custom' }),
      protocol: 'openai' as const,
      routerProviderId: 'relay-example',
      sourceConfig,
      sourceCredentialConfigured: true,
    };

    store.record(CWD, { ...input, credential: 'sk-openai-one' });
    expect(store.record(CWD, { ...input, credential: undefined })).toHaveLength(1);
    const entries = store.record(CWD, { ...input, credential: 'sk-openai-two' });

    expect(entries).toHaveLength(2);
    expect(store.toSaveInput(CWD, entries[0]?.id ?? '')).toMatchObject({
      credential: 'sk-openai-two',
      credentialAction: 'replace',
    });
    expect(readFileSync(historyPath, 'utf8')).not.toContain('sk-openai-one');
    expect(readFileSync(historyPath, 'utf8')).not.toContain('sk-openai-two');
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

  /*
   * Restoring an older record is what the list is for. Comparing only against the newest record
   * turned every such click into a duplicate, so the list filled up with the same few setups.
   */
  it('moves an older record back to the top instead of duplicating it', () => {
    const { store } = createStore();
    store.record(CWD, gatewayConfig());
    store.record(CWD, gatewayConfig({ model: 'glm-4.6-air' }));
    const [, older] = store.list(CWD);
    const replay = store.toSaveInput(CWD, older?.id ?? '');

    const entries = store.record(CWD, {
      config: replay,
      credential: replay.credential,
      gatewayEndpoint: 'http://127.0.0.1:3456',
      gatewayState: 'running',
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.id).toBe(older?.id);
    expect(entries.map((entry) => entry.model)).toEqual(['glm-4.6', 'glm-4.6-air']);
  });

  it('keeps a blank fast model from looking like a different setup on replay', () => {
    const { store } = createStore();
    const [entry] = store.record(CWD, gatewayConfig({ modelFast: '' }));
    const replay = store.toSaveInput(CWD, entry?.id ?? '');

    const entries = store.record(CWD, {
      config: replay,
      credential: replay.credential,
      gatewayEndpoint: 'http://127.0.0.1:3456',
      gatewayState: 'running',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.modelFast).toBe('glm-4.6');
  });

  it('treats the upstream protocol as part of the saved connection', () => {
    const { store } = createStore();

    store.record(CWD, { ...gatewayConfig(), protocol: 'anthropic' });
    const entries = store.record(CWD, { ...gatewayConfig(), protocol: 'openai' });

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.protocol)).toEqual(['openai', 'anthropic']);
  });

  it('records and restores a changed apiKeyHelper policy as a distinct setup', () => {
    const { store } = createStore();

    store.record(CWD, gatewayConfig());
    const entries = store.record(CWD, gatewayConfig({ apiKeyHelperPolicy: 'inherit' as const }));

    expect(entries).toHaveLength(2);
    expect(entries[0]?.apiKeyHelperPolicy).toBe('inherit');
    expect(store.toSaveInput(CWD, entries[0]?.id ?? '')).toMatchObject({
      apiKeyHelperPolicy: 'inherit',
    });
  });

  it('migrates version 1 gateway history with safe defaults and an unknown protocol', () => {
    const { fixtureRoot, historyPath, store } = createStore();
    store.record(CWD, gatewayConfig());
    const persisted = JSON.parse(readFileSync(historyPath, 'utf8')) as {
      projects: Record<string, Array<Record<string, unknown>>>;
      version: number;
    };
    const [entries] = Object.values(persisted.projects);
    delete entries?.[0]?.apiKeyHelperPolicy;
    delete entries?.[0]?.protocol;
    persisted.version = 1;
    writeFileSync(historyPath, JSON.stringify(persisted), 'utf8');

    const migratedStore = new ClaudeConnectionHistoryStore(fixtureRoot);
    const [migrated] = migratedStore.list(CWD);
    expect(migrated).toMatchObject({
      apiKeyHelperPolicy: 'prefer-claudedock',
      protocol: 'unknown',
    });

    migratedStore.rename(CWD, migrated?.id ?? '', '旧中转连接');
    expect(JSON.parse(readFileSync(historyPath, 'utf8'))).toMatchObject({ version: 3 });
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
      apiKeyHelperPolicy: 'prefer-claudedock',
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

  it('renames a record without changing its connection metadata', () => {
    const { fixtureRoot, store } = createStore();
    const [entry] = store.record(CWD, { ...gatewayConfig(), protocol: 'openai' });

    const renamed = store.rename(CWD, entry?.id ?? '', '  生产 OpenAI 中转  ');

    expect(renamed[0]).toMatchObject({
      name: '生产 OpenAI 中转',
      protocol: 'openai',
    });
    expect(new ClaudeConnectionHistoryStore(fixtureRoot).list(CWD)[0]).toMatchObject({
      name: '生产 OpenAI 中转',
      protocol: 'openai',
    });
    expect(() => store.rename(CWD, entry?.id ?? '', '   ')).toThrow(/1-60/);
    expect(() => store.rename(CWD, entry?.id ?? '', `坏名称${String.fromCharCode(7)}`)).toThrow(
      /控制字符/,
    );
    expect(() => store.rename(CWD, entry?.id ?? '', '名'.repeat(61))).toThrow(/1-60/);
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
