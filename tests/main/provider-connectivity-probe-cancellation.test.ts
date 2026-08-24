import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectivityProbe } from '../../src/main/network/provider-connectivity-probe';
import { deferred } from '../helpers/provider-connectivity-probe-fixture';

describe('ProviderConnectivityProbe cancellation', () => {
  it('forwards one authoritative signal to every probe branch and removes its deadline listener', async () => {
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const applicationRequest = vi.fn(async (_url: string, _signal?: AbortSignal) => ({
      contentType: 'application/json',
      redirects: [],
      status: 204,
    }));
    const cliRequest = vi.fn(
      async (url: string, websocket: boolean, _cwd?: string, _signal?: AbortSignal) =>
        websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `401|${url}|0|application/json`,
    );
    const clientVersion = vi.fn(
      async (_provider: string, _cwd?: string, _signal?: AbortSignal) => '0.146.0',
    );
    const dnsLookup = vi.fn(async (_host: string, _signal?: AbortSignal) => [
      { address: '203.0.113.10', family: 4 as const },
    ]);
    const resolveProxy = vi.fn(
      async (_url: string, _scope: string, _signal?: AbortSignal) => 'DIRECT',
    );
    const probe = new ProviderConnectivityProbe({
      applicationRequest,
      cliRequest,
      clientVersion,
      dnsLookup,
      resolveProxy,
    });

    await probe.run(
      'openai-codex',
      'background',
      undefined,
      'conversation',
      undefined,
      controller.signal,
    );

    expect(applicationRequest).toHaveBeenCalled();
    expect(applicationRequest.mock.calls.every(([, signal]) => signal === controller.signal)).toBe(
      true,
    );
    expect(cliRequest).toHaveBeenCalled();
    expect(cliRequest.mock.calls.every(([, , , signal]) => signal === controller.signal)).toBe(
      true,
    );
    expect(clientVersion).not.toHaveBeenCalled();
    expect(dnsLookup).toHaveBeenCalled();
    expect(dnsLookup.mock.calls.every(([, signal]) => signal === controller.signal)).toBe(true);
    expect(resolveProxy).toHaveBeenCalledWith(
      expect.any(String),
      'conversation',
      controller.signal,
    );
    const deadlineListener = addEventListener.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(deadlineListener).toBeDefined();
    expect(removeEventListener).toHaveBeenCalledWith('abort', deadlineListener);
  });

  it('rejects authoritative cancellation instead of converting it into a probe verdict', async () => {
    const controller = new AbortController();
    const abortError = new Error('obsolete preflight');
    let forwardedSignal: AbortSignal | undefined;
    const applicationRequest = vi.fn(
      (_url: string, signal?: AbortSignal): Promise<never> =>
        new Promise((_resolve, reject) => {
          forwardedSignal = signal;
          if (!signal) {
            reject(new Error('authoritative signal missing'));
            return;
          }
          const rejectAbort = (): void => reject(signal.reason);
          if (signal.aborted) {
            rejectAbort();
          } else {
            signal.addEventListener('abort', rejectAbort, { once: true });
          }
        }),
    );
    const probe = new ProviderConnectivityProbe({
      applicationRequest,
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    });
    const operation = probe.run(
      'openai-api',
      'first-request',
      undefined,
      'application',
      {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      },
      controller.signal,
    );

    await vi.waitFor(() => expect(applicationRequest).toHaveBeenCalledOnce());
    controller.abort(abortError);

    await expect(operation).rejects.toBe(abortError);
    expect(forwardedSignal).toBe(controller.signal);
  });

  it('waits for cancellable leaf cleanup before authoritative cancellation settles', async () => {
    const controller = new AbortController();
    const abortError = new Error('obsolete preflight');
    const cleanup = deferred<void>();
    const cleanupStarted = vi.fn();
    const applicationRequest = vi.fn(
      (_url: string, signal?: AbortSignal): Promise<never> =>
        new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            cleanupStarted();
            void cleanup.promise.then(() => reject(signal?.reason));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        }),
    );
    const probe = new ProviderConnectivityProbe({
      applicationRequest,
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    });
    const operation = probe.run(
      'openai-api',
      'first-request',
      undefined,
      'application',
      {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      },
      controller.signal,
    );
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => expect(applicationRequest).toHaveBeenCalledOnce());
    controller.abort(abortError);
    await vi.waitFor(() => expect(cleanupStarted).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    cleanup.resolve();

    await expect(operation).rejects.toBe(abortError);
  });
});
