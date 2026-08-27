import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import type { SaveClaudeConfigInput } from '../../src/shared/contracts';

vi.mock('electron', () => ({
  safeStorage: {
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    isEncryptionAvailable: () => true,
  },
}));

const temporaryRoots: string[] = [];

afterEach(() => {
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
