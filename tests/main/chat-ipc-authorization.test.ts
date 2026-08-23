import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatConfigStore, ChatRuntimeSnapshot } from '../../src/main/chat/config-store';
import { ChatService } from '../../src/main/chat/service';
import type { MainGuards } from '../../src/main/ipc/guards';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';

const installElectronMock = () => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({
    clipboard: { readImage: vi.fn() },
    ipcMain: ipc.ipcMain,
    nativeImage: { createFromPath: vi.fn() },
  }));
  return ipc;
};

const streamResponse = (): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' }, status: 200 },
  );
};

const runtime = (patch: Partial<ChatRuntimeSnapshot> = {}): ChatRuntimeSnapshot => ({
  authMode: 'apiKey',
  baseUrl: 'https://api.anthropic.com',
  credential: 'anthropic-secret',
  model: 'claude-test',
  protocol: 'anthropic',
  ...patch,
});

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('direct-chat IPC authorization', () => {
  it('classifies official API origins and rejects protocol mismatches', async () => {
    installElectronMock();
    const { officialTargetForChat } = await import('../../src/main/ipc/chat');

    expect(officialTargetForChat(runtime())).toEqual({
      provider: 'anthropic-claude',
      target: {
        process: 'application',
        url: 'https://api.anthropic.com/v1/messages',
      },
    });
    expect(
      officialTargetForChat(
        runtime({
          authMode: 'bearer',
          baseUrl: 'https://api.openai.com/v1',
          credential: 'openai-secret',
          protocol: 'openai',
        }),
      ),
    ).toEqual({
      provider: 'openai-api',
      target: {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      },
    });
    expect(() =>
      officialTargetForChat(
        runtime({
          baseUrl: 'https://api.openai.com',
          protocol: 'anthropic',
        }),
      ),
    ).toThrow('官方接口地址与所选对话协议不一致');
    expect(() =>
      officialTargetForChat(
        runtime({
          baseUrl: 'https://api.anthropic.com',
          protocol: 'openai',
        }),
      ),
    ).toThrow('官方接口地址与所选对话协议不一致');
    expect(
      officialTargetForChat(
        runtime({
          baseUrl: 'https://chatgpt.com',
          protocol: 'openai',
        }),
      ),
    ).toBeUndefined();
    expect(
      officialTargetForChat(
        runtime({
          baseUrl: 'https://api.openai.com.evil.example',
          protocol: 'openai',
        }),
      ),
    ).toBeUndefined();
    expect(
      officialTargetForChat(
        runtime({
          baseUrl: 'https://user:password@api.anthropic.com',
        }),
      ),
    ).toBeUndefined();
    expect(
      officialTargetForChat(
        runtime({
          baseUrl: 'http://api.anthropic.com',
        }),
      ),
    ).toBeUndefined();
  });

  it('keeps one runtime snapshot and the provider lease through the streamed request', async () => {
    const ipc = installElectronMock();
    const { registerChatIpc } = await import('../../src/main/ipc/chat');
    let selectedRuntime = runtime();
    const getRuntimeConfig = vi.fn(() => selectedRuntime);
    const store = { getRuntimeConfig } as unknown as ChatConfigStore;
    const events: unknown[] = [];
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(() => pendingFetch);
    const service = new ChatService(store, (event) => events.push(event), fetchMock);
    let allowGuard: (() => void) | undefined;
    let providerAccessActive = false;
    const withOfficialProviderAccess = vi.fn(
      async <T>(
        _request: Parameters<MainGuards['withOfficialProviderAccess']>[0],
        operation: () => Promise<T> | T,
      ): Promise<T> => {
        await new Promise<void>((resolve) => {
          allowGuard = resolve;
        });
        providerAccessActive = true;
        try {
          return await operation();
        } finally {
          providerAccessActive = false;
        }
      },
    ) as unknown as MainGuards['withOfficialProviderAccess'];
    const originalStart = service.startWithCompletion.bind(service);
    const start = vi.spyOn(service, 'startWithCompletion').mockImplementation((...args) => {
      expect(providerAccessActive).toBe(true);
      return originalStart(...args);
    });
    const commitDraft = vi.fn();

    registerChatIpc({
      chatAttachmentStore: {
        commitDraft,
      } as never,
      chatConfigStore: store,
      chatHistoryStore: {} as never,
      chatService: service,
      guards: {
        validateSender: vi.fn(),
        withOfficialProviderAccess,
      },
    });

    const operation = ipc.invoke(CHANNELS.CHAT_START, {
      messages: [{ content: '你好', role: 'user' }],
      requestId: 'request-snapshot-guard',
    });
    await vi.waitFor(() => expect(withOfficialProviderAccess).toHaveBeenCalledOnce());
    expect(withOfficialProviderAccess).toHaveBeenCalledWith(
      {
        action: 'first-request',
        networkScope: 'conversation',
        provider: 'anthropic-claude',
        target: {
          process: 'application',
          url: 'https://api.anthropic.com/v1/messages',
        },
      },
      expect.any(Function),
    );
    expect(start).not.toHaveBeenCalled();
    expect(commitDraft).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    selectedRuntime = runtime({
      authMode: 'bearer',
      baseUrl: 'https://api.openai.com',
      credential: 'replacement-secret',
      model: 'gpt-test',
      protocol: 'openai',
    });
    allowGuard?.();
    await operation;

    expect(start).toHaveBeenCalledOnce();
    expect(commitDraft).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(providerAccessActive).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(providerAccessActive).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('anthropic-secret');
    expect(JSON.stringify(init)).not.toContain('replacement-secret');
    expect(getRuntimeConfig).toHaveBeenCalledOnce();

    resolveFetch(streamResponse());
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'done' }));
    await vi.waitFor(() => expect(providerAccessActive).toBe(false));
  });

  it('uses one immutable runtime for an asynchronously authorized connection test', async () => {
    const ipc = installElectronMock();
    const { registerChatIpc } = await import('../../src/main/ipc/chat');
    let selectedRuntime = runtime();
    const resolveRuntimeConfig = vi.fn(() => selectedRuntime);
    const store = { resolveRuntimeConfig } as unknown as ChatConfigStore;
    let allowGuard: (() => void) | undefined;
    let providerAccessActive = false;
    const withOfficialProviderAccess = vi.fn(
      async <T>(
        _request: Parameters<MainGuards['withOfficialProviderAccess']>[0],
        operation: () => Promise<T> | T,
      ): Promise<T> => {
        await new Promise<void>((resolve) => {
          allowGuard = resolve;
        });
        providerAccessActive = true;
        try {
          return await operation();
        } finally {
          providerAccessActive = false;
        }
      },
    ) as unknown as MainGuards['withOfficialProviderAccess'];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      expect(providerAccessActive).toBe(true);
      return new Response(
        JSON.stringify({
          content: [{ text: '好', type: 'text' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    });
    const service = new ChatService(store, () => undefined, fetchMock);

    registerChatIpc({
      chatAttachmentStore: {} as never,
      chatConfigStore: store,
      chatHistoryStore: {} as never,
      chatService: service,
      guards: {
        validateSender: vi.fn(),
        withOfficialProviderAccess,
      },
    });

    const operation = ipc.invoke(CHANNELS.CHAT_TEST_CONNECTION, {
      authMode: 'apiKey',
      baseUrl: 'https://api.anthropic.com',
      credentialAction: 'keep',
      model: 'claude-test',
      protocol: 'anthropic',
    });
    await vi.waitFor(() => expect(withOfficialProviderAccess).toHaveBeenCalledOnce());
    expect(withOfficialProviderAccess).toHaveBeenCalledWith(
      {
        action: 'first-request',
        networkScope: 'conversation',
        provider: 'anthropic-claude',
        target: {
          process: 'application',
          url: 'https://api.anthropic.com/v1/messages',
        },
      },
      expect.any(Function),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    selectedRuntime = runtime({
      authMode: 'bearer',
      baseUrl: 'https://api.openai.com',
      credential: 'replacement-secret',
      model: 'gpt-test',
      protocol: 'openai',
    });
    allowGuard?.();

    await expect(operation).resolves.toMatchObject({ ok: true });
    expect(resolveRuntimeConfig).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('anthropic-secret');
    expect(JSON.stringify(init)).not.toContain('replacement-secret');
    expect(providerAccessActive).toBe(false);
  });

  it('does not accept or schedule a request when provider access is denied', async () => {
    const ipc = installElectronMock();
    const { registerChatIpc } = await import('../../src/main/ipc/chat');
    const store = {
      getRuntimeConfig: vi.fn(() => runtime()),
    } as unknown as ChatConfigStore;
    const fetchMock = vi.fn<typeof fetch>();
    const service = new ChatService(store, () => undefined, fetchMock);
    const denied = new Error('blocked');
    const withOfficialProviderAccess = vi.fn(async () => Promise.reject(denied));
    const commitDraft = vi.fn();

    registerChatIpc({
      chatAttachmentStore: { commitDraft } as never,
      chatConfigStore: store,
      chatHistoryStore: {} as never,
      chatService: service,
      guards: {
        validateSender: vi.fn(),
        withOfficialProviderAccess,
      },
    });

    await expect(
      ipc.invoke(CHANNELS.CHAT_START, {
        messages: [{ content: '你好', role: 'user' }],
        requestId: 'request-denied-guard',
      }),
    ).rejects.toBe(denied);
    expect(commitDraft).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
