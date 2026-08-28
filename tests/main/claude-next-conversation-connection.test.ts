import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import type { SaveClaudeConfigInput } from '../../src/shared/contracts';
import {
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_UPSTREAM_URLS,
} from '../../src/shared/claude/subscriptions';

vi.mock('electron', () => ({
  safeStorage: {
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    isEncryptionAvailable: () => true,
  },
}));

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const createRuntime = (): ClaudeRuntime => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-next-connection-'));
  temporaryRoots.push(root);
  return new ClaudeRuntime(
    root,
    path.join(root, 'statusline.ps1'),
    path.join(root, 'signal.ps1'),
    path.join(root, 'guard.ps1'),
    () => false,
    () => 'standard',
    () => ({ mode: 'auto' }),
    () => undefined,
    () => true,
    async () => undefined,
    async () => undefined,
    () => undefined,
  );
};

const localInput = (model: string): SaveClaudeConfigInput => ({
  apiKeyHelperPolicy: 'inherit',
  authMode: 'none',
  baseUrl: 'http://127.0.0.1:11434',
  credentialAction: 'clear',
  model,
  preset: 'ollama',
  protocol: 'anthropic',
  provider: 'gateway',
});

describe('Claude next-conversation connection', () => {
  it.each(SUBSCRIPTION_PROVIDERS)(
    'preflights the real upstream without rewriting the local account binding: %s',
    async (preset) => {
      const runtime = createRuntime();
      const baseUrl = 'http://127.0.0.1:18520/s/' + 'a'.repeat(32);
      const input: SaveClaudeConfigInput = {
        ...localInput('test-model'),
        preset,
        baseUrl,
        authMode: 'authToken',
        credentialAction: 'replace',
        credential: 'b'.repeat(64),
      };
      const expected = {
        provider: 'anthropic-claude',
        target: { process: 'claude-cli', url: SUBSCRIPTION_UPSTREAM_URLS[preset] + '/v1/messages' },
      };
      expect(runtime.networkAccessForConfigInput(input)).toEqual(expected);
      runtime.setSubscriptionAccountIdentityResolver((config) =>
        config.baseUrl === baseUrl ? 'member@example.test' : undefined,
      );
      const saved = await runtime.saveNextConversationConfig(input);
      expect(saved.accountIdentity).toBe('member@example.test');
      expect(saved.config?.baseUrl).toBe(baseUrl);
      expect(runtime.networkAccess(runtime.nextConversationConnectionScope())).toEqual(expected);
      expect(JSON.stringify(saved)).not.toContain('b'.repeat(64));
      expect(runtime.networkAccessForConfigInput({ ...input, preset: 'custom' })?.target?.url).toBe(
        baseUrl + '/v1/messages',
      );
      await runtime.saveNextConversationConfig(localInput('another'));
      expect((await runtime.getNextConversationConnection()).accountIdentity).toBeUndefined();
    },
  );

  it('reserves configuration across browser login and rejects competing writes, clear and promotion', async () => {
    const runtime = createRuntime();
    await runtime.saveNextConversationConfig(localInput('old'));
    const reservation = runtime.reserveNextConversationConnection();
    await expect(runtime.saveNextConversationConfig(localInput('competing'))).rejects.toThrow(
      '订阅接入',
    );
    expect(() => runtime.clearNextConversationConnection()).toThrow('订阅接入');
    expect(() => runtime.promoteConversationConnectionToNext('session-1', 'D:\\Project')).toThrow(
      '订阅接入',
    );
    expect(() => runtime.reserveNextConversationConnection()).toThrow('已有接入');
    reservation.release();
    const newer = runtime.reserveNextConversationConnection();
    reservation.release();
    await expect(runtime.saveNextConversationConfig(localInput('late'))).rejects.toThrow(
      '订阅接入',
    );
    newer.release();
    await runtime.saveNextConversationConfig(localInput('new'));
    expect((await runtime.getNextConversationConnection()).config?.model).toBe('new');
  });

  it('fences a late successful test after login cancellation before credentials or config can commit', async () => {
    const runtime = createRuntime();
    await runtime.saveNextConversationConfig(localInput('old'));
    const reservation = runtime.reserveNextConversationConnection();
    const controller = new AbortController();
    const test = deferred<Awaited<ReturnType<ClaudeRuntime['testPreparedConnection']>>>();
    const probe = vi.spyOn(runtime, 'testPreparedConnection').mockReturnValueOnce(test.promise);
    const beforeCommit = vi.fn();
    const operation = runtime.verifyAndSaveNextConversationConfig(localInput('new'), undefined, {
      reservation: reservation.token,
      signal: controller.signal,
      beforeCommit,
    });
    const rejected = expect(operation).rejects.toThrow();
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    controller.abort();
    test.resolve({ ok: true, testedAt: 1, stages: [], message: '', tone: 'success' });
    await rejected;
    expect(beforeCommit).not.toHaveBeenCalled();
    expect((await runtime.getNextConversationConnection()).config?.model).toBe('old');
    reservation.release();
  });
  const automaticInput = (patch: Partial<SaveClaudeConfigInput> = {}): SaveClaudeConfigInput => ({
    autoDetect: true,
    authMode: 'apiKey',
    baseUrl: 'relay.example.com',
    credential: 'private-test-key',
    credentialAction: 'replace',
    model: 'hidden-default',
    preset: 'custom',
    protocol: 'anthropic',
    provider: 'gateway',
    ...patch,
  });
  const automaticFetch = () =>
    vi.fn<typeof fetch>(async (_url, options) =>
      options?.method
        ? Response.json({ id: 'msg-test', content: [{ type: 'text', text: '1' }] })
        : Response.json({ data: [{ id: 'discovered-model' }] }),
    );

  it('saves only the automatically proven settings and does not charge a duplicate direct probe', async () => {
    const runtime = createRuntime();
    const fetchMock = automaticFetch();
    const duplicateProbe = vi.spyOn(runtime, 'testPreparedConnection');
    const result = await runtime.verifyAndSaveNextConversationConfig(automaticInput(), undefined, {
      automaticFetch: fetchMock,
    });
    expect(result.connectionTest.ok).toBe(true);
    expect(result.state.config).toMatchObject({
      authMode: 'authToken',
      baseUrl: 'https://relay.example.com',
      model: 'discovered-model',
      modelFast: 'discovered-model',
      preset: 'custom',
      credentialConfigured: true,
    });
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
      1,
    );
    expect(duplicateProbe).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-test-key');
  });

  it('makes Test Connection read-only and preserves the previous profile on failure', async () => {
    const runtime = createRuntime();
    await runtime.saveNextConversationConfig(localInput('stable-model'));
    const before = await runtime.getNextConversationConnection();
    const test = await runtime.verifyAndSaveNextConversationConfig(automaticInput(), undefined, {
      automaticFetch: automaticFetch(),
      testOnly: true,
    });
    expect(test.connectionTest.ok).toBe(true);
    expect(test.state).toEqual(before);
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) =>
      options?.method
        ? new Response('', { status: 401 })
        : Response.json({ data: [{ id: 'discovered-model' }] }),
    );
    await expect(
      runtime.verifyAndSaveNextConversationConfig(automaticInput(), undefined, {
        automaticFetch: fetchMock,
      }),
    ).rejects.toThrow('检查网址和密钥');
    expect(await runtime.getNextConversationConnection()).toEqual(before);
  });

  it('requires guarded network access and never borrows a key after changing a relay host', async () => {
    const runtime = createRuntime();
    await expect(runtime.verifyAndSaveNextConversationConfig(automaticInput())).rejects.toThrow(
      '网络授权',
    );
    await runtime.verifyAndSaveNextConversationConfig(automaticInput(), undefined, {
      automaticFetch: automaticFetch(),
    });
    const fetchMock = automaticFetch();
    await expect(
      runtime.verifyAndSaveNextConversationConfig(
        automaticInput({
          baseUrl: 'another.example.com',
          credential: undefined,
          credentialAction: 'keep',
        }),
        undefined,
        { automaticFetch: fetchMock },
      ),
    ).rejects.toThrow('请填写密钥');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await runtime.getNextConversationConnection()).config?.baseUrl).toBe(
      'https://relay.example.com',
    );
  });

  it('does not accept hidden renderer models when a new relay cannot discover any', async () => {
    const runtime = createRuntime();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
    await expect(
      runtime.verifyAndSaveNextConversationConfig(automaticInput(), undefined, {
        automaticFetch: fetchMock,
      }),
    ).rejects.toThrow('未能获取模型');
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    expect((await runtime.getNextConversationConnection()).config).toBeUndefined();
  });

  it('keeps DeepSeek and ChatGPT credentials and routes isolated in the same project', async () => {
    const runtime = createRuntime();
    await runtime.saveNextConversationConfig({
      authMode: 'apiKey',
      baseUrl: 'https://api.deepseek.com/anthropic',
      credential: 'fixture-deepseek-key',
      credentialAction: 'replace',
      model: 'deepseek-chat',
      preset: 'deepseek',
      protocol: 'anthropic',
      provider: 'gateway',
    });
    runtime.bindNextConversationConnection('deepseek-session', 'D:\\Project');
    const deepseek = runtime.captureLaunchAuthorization('D:\\Project', 'deepseek-session');

    await runtime.saveNextConversationConfig({
      apiKeyHelperPolicy: 'prefer-claudedock',
      authMode: 'authToken',
      baseUrl: 'http://127.0.0.1:8317/v1',
      credential: 'fixture-managed-gateway-key',
      credentialAction: 'replace',
      model: 'gpt-conversation-test',
      preset: 'chatgpt-subscription',
      protocol: 'anthropic',
      provider: 'gateway',
    });
    runtime.bindNextConversationConnection('chatgpt-session', 'D:\\Project');

    expect(runtime.captureLaunchAuthorization('D:\\Project', 'deepseek-session')).toEqual(deepseek);
    expect(runtime.captureLaunchAuthorization('D:\\Project', 'chatgpt-session')).toMatchObject({
      launchSnapshot: {
        config: { model: 'gpt-conversation-test', preset: 'chatgpt-subscription' },
        credential: 'fixture-managed-gateway-key',
      },
      officialNetworkProvider: 'openai-codex',
    });
    expect(deepseek.launchSnapshot.credential).toBe('fixture-deepseek-key');
    runtime.releaseConversationConnection('chatgpt-session');
    expect(runtime.captureLaunchAuthorization('D:\\Project', 'deepseek-session')).toEqual(deepseek);
  });

  it('captures an immutable profile for each conversation before the global choice changes', async () => {
    const runtime = createRuntime();
    await runtime.saveNextConversationConfig(localInput('model-a'));

    runtime.bindNextConversationConnection('session-a', 'D:\\Project');
    await runtime.saveNextConversationConfig(localInput('model-b'));
    runtime.bindNextConversationConnection('session-b', 'D:\\Project');

    expect(
      runtime.captureLaunchAuthorization('D:\\Project', 'session-a').launchSnapshot.config,
    ).toMatchObject({ model: 'model-a', preset: 'ollama' });
    expect(
      runtime.captureLaunchAuthorization('D:\\Project', 'session-b').launchSnapshot.config,
    ).toMatchObject({ model: 'model-b', preset: 'ollama' });
    await expect(runtime.getNextConversationConnection()).resolves.toMatchObject({
      config: { model: 'model-b' },
    });
  });

  it('serializes rapid global saves and leaves the latest accepted click as the next choice', async () => {
    const runtime = createRuntime();
    const firstGate = deferred<void>();
    const originalPrepare = runtime.prepareConnectionConfig.bind(runtime);
    let activePreparations = 0;
    let maximumActivePreparations = 0;
    let call = 0;
    const prepare = vi
      .spyOn(runtime, 'prepareConnectionConfig')
      .mockImplementation(async (...args) => {
        call += 1;
        activePreparations += 1;
        maximumActivePreparations = Math.max(maximumActivePreparations, activePreparations);
        try {
          if (call === 1) await firstGate.promise;
          return await originalPrepare(...args);
        } finally {
          activePreparations -= 1;
        }
      });

    const first = runtime.saveNextConversationConfig(localInput('model-a'));
    const second = runtime.saveNextConversationConfig(localInput('model-b'));
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(maximumActivePreparations).toBe(1);
    await expect(runtime.getNextConversationConnection()).resolves.toMatchObject({
      config: { model: 'model-b' },
    });
  });

  it('restores the previous global profile when a post-commit read fails', async () => {
    const runtime = createRuntime();
    await runtime.saveNextConversationConfig(localInput('stable-model'));
    const failure = new Error('simulated post-commit failure');
    const read = vi.spyOn(runtime, 'getNextConversationConnection').mockRejectedValueOnce(failure);

    await expect(runtime.saveNextConversationConfig(localInput('tentative-model'))).rejects.toBe(
      failure,
    );
    read.mockRestore();

    await expect(runtime.getNextConversationConnection()).resolves.toMatchObject({
      config: { model: 'stable-model' },
    });
  });

  it('prepares a native conversation from its bound terminal profile, not a later global change', async () => {
    const runtime = createRuntime();
    const internals = runtime as unknown as {
      diagnoseInstallation: () => Promise<{
        executable: string;
        installationKind: 'native';
        installed: true;
        message: string;
        security: 'ready';
        version: string;
      }>;
      prepareRouteServices: (...args: unknown[]) => Promise<void>;
    };
    internals.diagnoseInstallation = vi.fn(
      async () =>
        ({
          executable: 'C:\\Tools\\claude.exe',
          installationKind: 'native',
          installed: true,
          message: 'Claude Code 已就绪。',
          security: 'ready',
          version: '2.1.221',
        }) as const,
    );
    internals.prepareRouteServices = vi.fn(async () => undefined);
    await runtime.saveNextConversationConfig(localInput('model-a'));
    runtime.bindNextConversationConnection('session-a', 'D:\\Project');
    const authorization = runtime.captureNativeConversationAuthorization(
      'D:\\Project',
      'session-a',
    );
    await runtime.saveNextConversationConfig(localInput('model-b'));

    const prepared = await runtime.prepareNativeConversation(
      'native-a',
      'D:\\Project',
      undefined,
      authorization,
    );

    expect(prepared.model).toBe('model-a');
    expect(prepared.endpointIdentity).toContain('ollama');
    runtime.releaseNativeConversation('native-a');
  });

  it('captures an independent profile for a new native conversation before the next choice changes', async () => {
    const runtime = createRuntime();
    const internals = runtime as unknown as {
      diagnoseInstallation: () => Promise<{
        executable: string;
        installationKind: 'native';
        installed: true;
        message: string;
        security: 'ready';
        version: string;
      }>;
      prepareRouteServices: (...args: unknown[]) => Promise<void>;
    };
    internals.diagnoseInstallation = vi.fn(
      async () =>
        ({
          executable: 'C:\\Tools\\claude.exe',
          installationKind: 'native',
          installed: true,
          message: 'Claude Code 已就绪。',
          security: 'ready',
          version: '2.1.221',
        }) as const,
    );
    internals.prepareRouteServices = vi.fn(async () => undefined);
    await runtime.saveNextConversationConfig(localInput('model-a'));
    const authorization = runtime.captureNextNativeConversationAuthorization(
      'native-route:native-a',
      'D:\\Project',
    );
    await runtime.saveNextConversationConfig(localInput('model-b'));

    const prepared = await runtime.prepareNativeConversation(
      'native-route:native-a',
      'D:\\Project',
      undefined,
      authorization,
    );

    expect(prepared.model).toBe('model-a');
    runtime.releaseNativeConversation('native-route:native-a');
  });
});
