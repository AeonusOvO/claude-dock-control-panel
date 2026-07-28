import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/* Same reversible stub as the history store test: `safeStorage` needs a running Electron app. */
vi.mock('electron', () => ({
  safeStorage: {
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    isEncryptionAvailable: () => true,
  },
}));

const { ClaudeConfigStore } = await import('../src/main/claude-config-store');

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createStore = () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-profiles-'));
  fixtureRoots.push(fixtureRoot);
  return {
    profilePath: path.join(fixtureRoot, 'claude', 'project-profiles.json'),
    store: new ClaudeConfigStore(fixtureRoot),
  };
};

const CWD = 'D:\\Projects\\Example';

const gatewayInput = {
  authMode: 'apiKey',
  baseUrl: 'https://gateway.example.com',
  credential: 'secret-token',
  credentialAction: 'replace',
  model: 'deepseek-chat',
  preset: 'deepseek',
  provider: 'gateway',
} as const;

describe('Claude project profile store', () => {
  it('arms the bypass cycle for a project that has never been configured', () => {
    const { store } = createStore();

    // Default-on: the mode picker could otherwise never offer 「完全允许」 on a fresh project.
    expect(store.getAllowBypassPermissions(CWD)).toBe(true);
  });

  it('persists the arming switch without touching the stored credential', () => {
    const { profilePath, store } = createStore();
    store.save(CWD, gatewayInput);

    store.setAllowBypassPermissions(CWD, false);

    expect(store.getAllowBypassPermissions(CWD)).toBe(false);
    expect(store.getCredential(CWD)).toBe('secret-token');
    expect(store.getView(CWD).credentialConfigured).toBe(true);
    expect(readFileSync(profilePath, 'utf8')).not.toContain('secret-token');
  });

  it('keeps a disarmed project disarmed when its route is saved again', () => {
    const { store } = createStore();
    store.save(CWD, gatewayInput);
    store.setAllowBypassPermissions(CWD, false);

    store.save(CWD, { ...gatewayInput, credentialAction: 'keep', model: 'deepseek-reasoner' });

    expect(store.getAllowBypassPermissions(CWD)).toBe(false);
    expect(store.getConfig(CWD).model).toBe('deepseek-reasoner');
  });

  it('persists the apiKeyHelper conflict policy and defaults older profiles safely', () => {
    const { store } = createStore();

    expect(store.getConfig(CWD).apiKeyHelperPolicy).toBe('prefer-claudedock');
    store.save(CWD, { ...gatewayInput, apiKeyHelperPolicy: 'inherit' });

    expect(store.getConfig(CWD).apiKeyHelperPolicy).toBe('inherit');
    expect(store.getView(CWD).apiKeyHelperPolicy).toBe('inherit');
  });

  it('remembers the switch for a project that has no saved route yet', () => {
    const { store } = createStore();

    store.setAllowBypassPermissions(CWD, false);

    expect(store.getAllowBypassPermissions(CWD)).toBe(false);
    // A path that was never touched keeps the default rather than inheriting another project's.
    expect(store.getAllowBypassPermissions('D:\\Projects\\Other')).toBe(true);
  });

  it('survives a reopened store and matches the path case-insensitively', () => {
    const { profilePath, store } = createStore();
    store.save(CWD, gatewayInput);
    store.setAllowBypassPermissions(CWD, false);

    const reopened = new ClaudeConfigStore(path.dirname(path.dirname(profilePath)));

    expect(reopened.getAllowBypassPermissions('d:\\projects\\example')).toBe(false);
  });
});
