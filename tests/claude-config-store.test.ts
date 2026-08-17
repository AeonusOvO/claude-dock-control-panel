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

  it('keeps the original OpenAI relay fields separate from the effective local Router route', () => {
    const { profilePath, store } = createStore();
    store.save(
      CWD,
      {
        ...gatewayInput,
        authMode: 'authToken',
        baseUrl: 'http://127.0.0.1:3456',
        model: 'relay-example/gpt-5.4',
        preset: 'custom',
      },
      {
        protocol: 'openai',
        routerProviderId: 'relay-example',
        sourceAuthMode: 'authToken',
        sourceBaseUrl: 'https://relay.example.com/v1/chat/completions',
        sourceCredentialConfigured: true,
        sourceModel: 'gpt-5.4',
        sourceModelFast: 'gpt-5-mini',
      },
    );

    const reopened = new ClaudeConfigStore(path.dirname(path.dirname(profilePath)));
    expect(reopened.getView(CWD)).toMatchObject({
      baseUrl: 'http://127.0.0.1:3456',
      model: 'relay-example/gpt-5.4',
      protocol: 'openai',
      routerProviderId: 'relay-example',
      sourceBaseUrl: 'https://relay.example.com/v1/chat/completions',
      sourceCredentialConfigured: true,
      sourceModel: 'gpt-5.4',
    });
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

  it('captures config, credential, and launch switches from one immutable profile', () => {
    const { store } = createStore();
    store.save(CWD, gatewayInput);
    store.setAllowBypassPermissions(CWD, false);

    const first = store.createLaunchSnapshot(CWD);
    expect(first).toMatchObject({
      allowBypassPermissions: false,
      config: {
        baseUrl: 'https://gateway.example.com',
        model: 'deepseek-chat',
      },
      credential: 'secret-token',
    });
    expect(store.launchSnapshotIsCurrent(CWD, first)).toBe(true);

    store.save(CWD, {
      ...gatewayInput,
      baseUrl: 'https://replacement.example.com',
      credential: 'replacement-token',
      model: 'replacement-model',
    });

    expect(first.config.baseUrl).toBe('https://gateway.example.com');
    expect(first.credential).toBe('secret-token');
    expect(store.launchSnapshotIsCurrent(CWD, first)).toBe(false);
    expect(store.createLaunchSnapshot(CWD)).toMatchObject({
      config: {
        baseUrl: 'https://replacement.example.com',
        model: 'replacement-model',
      },
      credential: 'replacement-token',
    });
  });

  it('keys a project the same way under a Turkish host locale', () => {
    const { store } = createStore();
    store.save('D:\\IDE\\Example', gatewayInput);

    /*
     * Turkish/Azeri collation lowercases ASCII "I" to a dotless "ı", so a locale-sensitive project
     * key would file D:\IDE under a different entry than d:\ide and the saved provider profile
     * would look like it had vanished. Simulate that collation for every unqualified call.
     */
    const original = String.prototype.toLocaleLowerCase;
    const spy = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
      this: string,
      ...args: Parameters<string['toLocaleLowerCase']>
    ) {
      if (args[0] === undefined) {
        return original.call(this).replace(/i/g, '\u0131');
      }
      return original.apply(this, args);
    });

    try {
      expect(store.getConfig('d:\\ide\\example').baseUrl).toBe('https://gateway.example.com');
      expect(store.getCredential('d:\\ide\\example')).toBe('secret-token');
    } finally {
      spy.mockRestore();
    }
  });
});
