import { EventEmitter } from 'node:events';
import type {
  AuthInfo,
  ClientRequest,
  ClientRequestConstructorOptions,
  IncomingMessage,
  Session,
} from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  createElectronApplicationRequest,
  createElectronSessionFetch,
  type ElectronProxyCredentialResolver,
} from '../../src/main/network/electron-request';

const proxyAuth = (overrides: Partial<AuthInfo> = {}): AuthInfo =>
  ({
    host: 'proxy.example.com',
    isProxy: true,
    port: 7890,
    ...overrides,
  }) as AuthInfo;

const incomingResponse = (
  statusCode: number,
  headers: Record<string, string | string[]> = {},
): IncomingMessage =>
  Object.assign(new EventEmitter(), {
    headers,
    rawHeaders: Object.entries(headers).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).flatMap((item) => [name, item]),
    ),
    pause: vi.fn(),
    resume: vi.fn(),
    statusCode,
    statusMessage: statusCode === 200 ? 'OK' : '',
  }) as unknown as IncomingMessage;

interface RequestHarness {
  readonly emitter: EventEmitter;
  readonly request: ClientRequest;
}

const clientRequest = (
  onEnd: (harness: RequestHarness) => void,
  onFollowRedirect?: (harness: RequestHarness) => void,
): RequestHarness => {
  const emitter = new EventEmitter();
  const harness = {} as RequestHarness;
  const request = Object.assign(emitter, {
    abort: vi.fn(() => {
      emitter.emit('abort');
      emitter.emit('close');
    }),
    chunkedEncoding: false,
    end: vi.fn(() => onEnd(harness)),
    followRedirect: vi.fn(() => onFollowRedirect?.(harness)),
    write: vi.fn((_chunk, _encoding, callback?: () => void) => callback?.()),
  }) as unknown as ClientRequest;
  Object.assign(harness, { emitter, request });
  return harness;
};

const adapter = (
  factory: (options: ClientRequestConstructorOptions) => ClientRequest,
  session: Session,
  resolver: ElectronProxyCredentialResolver = () => undefined,
): typeof fetch =>
  createElectronSessionFetch({
    requestFactory: factory,
    resolveProxyCredentials: resolver,
    session,
  });

describe('Electron main-process request adapter', () => {
  it('answers only an exact proxy login with credentials from the bound Session resolver', async () => {
    const session = {} as Session;
    const callback = vi.fn();
    const resolver = vi.fn<ElectronProxyCredentialResolver>(({ authInfo, session: candidate }) =>
      candidate === session &&
      authInfo.host.toLowerCase() === 'proxy.example.com' &&
      authInfo.port === 7890
        ? { password: 'candidate-secret', username: 'proxy-user' }
        : undefined,
    );
    const harness = clientRequest(({ emitter }) => {
      emitter.emit('login', proxyAuth({ host: 'PrOxY.Example.Com' }), callback);
      const response = incomingResponse(204);
      emitter.emit('response', response);
      response.emit('end');
      emitter.emit('close');
    });
    const requestFactory = vi.fn(() => harness.request);

    const response = await adapter(requestFactory, session, resolver)('https://example.test/');

    expect(response.status).toBe(204);
    expect(requestFactory).toHaveBeenCalledWith(
      expect.objectContaining({ session, url: 'https://example.test/' }),
    );
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        authInfo: expect.objectContaining({ host: 'PrOxY.Example.Com', port: 7890 }),
        requestUrl: new URL('https://example.test/'),
        session,
      }),
    );
    expect(callback).toHaveBeenCalledWith('proxy-user', 'candidate-secret');
  });

  it('cancels origin, wrong-endpoint, and credential-less login challenges', async () => {
    const session = {} as Session;
    const challenges = [
      proxyAuth({ isProxy: false }),
      proxyAuth({ host: 'other.example.com' }),
      proxyAuth({ port: 8080 }),
      proxyAuth(),
    ];
    const callbacks = challenges.map(() => vi.fn());
    let challengeIndex = 0;
    const resolver = vi.fn<ElectronProxyCredentialResolver>(({ authInfo }) =>
      authInfo.host.toLowerCase() === 'proxy.example.com' &&
      authInfo.port === 7890 &&
      challengeIndex < 3
        ? { password: 'should-not-be-used', username: 'proxy-user' }
        : undefined,
    );
    const harness = clientRequest(({ emitter }) => {
      for (const [index, challenge] of challenges.entries()) {
        challengeIndex = index;
        emitter.emit('login', challenge, callbacks[index]);
      }
      const response = incomingResponse(204);
      emitter.emit('response', response);
      response.emit('end');
      emitter.emit('close');
    });

    await adapter(() => harness.request, session, resolver)('https://example.test/');

    for (const callback of callbacks) {
      expect(callback).toHaveBeenCalledWith();
    }
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it('returns HTTP 407 as a failed fetch response, never as success', async () => {
    const harness = clientRequest(({ emitter }) => {
      const response = incomingResponse(407, { 'content-type': 'text/plain' });
      emitter.emit('response', response);
      response.emit('data', Buffer.from('proxy authentication required'));
      response.emit('end');
    });

    const response = await adapter(() => harness.request, {} as Session)('https://example.test/');

    expect(response.status).toBe(407);
    expect(response.ok).toBe(false);
    await expect(response.text()).resolves.toBe('proxy authentication required');
  });

  it('streams request bodies, follows redirects, and exposes the final streaming response', async () => {
    const writes: Buffer[] = [];
    const harness = clientRequest(
      ({ emitter }) => {
        emitter.emit('redirect', 307, 'POST', 'https://example.test/final', {
          location: ['https://example.test/final'],
        });
      },
      ({ emitter }) => {
        const response = incomingResponse(200, { 'content-type': 'text/plain' });
        emitter.emit('response', response);
        response.emit('data', Buffer.from('hello '));
        response.emit('data', Buffer.from('world'));
        response.emit('end');
      },
    );
    vi.mocked(harness.request.write).mockImplementation((chunk, _encoding, callback) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback?.();
    });
    const requestFactory = vi.fn(() => harness.request);

    const response = await adapter(requestFactory, {} as Session)('https://example.test/start', {
      body: 'payload',
      headers: { authorization: 'Bearer token', 'x-test': 'yes' },
      method: 'POST',
      redirect: 'follow',
    });

    expect(harness.request.chunkedEncoding).toBe(true);
    expect(Buffer.concat(writes).toString('utf8')).toBe('payload');
    expect(harness.request.followRedirect).toHaveBeenCalledOnce();
    expect(requestFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer token',
          'x-test': 'yes',
        }),
        method: 'POST',
        redirect: 'manual',
      }),
    );
    expect(response.redirected).toBe(true);
    expect(response.url).toBe('https://example.test/final');
    expect(response.headers.get('content-type')).toBe('text/plain');
    await expect(response.text()).resolves.toBe('hello world');
  });

  it('waits for each Electron write callback before reading the next upload chunk', async () => {
    const writeCallbacks: Array<() => void> = [];
    const harness = clientRequest(({ emitter }) => {
      const response = incomingResponse(204);
      emitter.emit('response', response);
      response.emit('end');
      emitter.emit('close');
    });
    vi.mocked(harness.request.write).mockImplementation((_chunk, _encoding, callback) => {
      if (callback) writeCallbacks.push(callback);
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first'));
        controller.enqueue(new TextEncoder().encode('second'));
        controller.close();
      },
    });

    const operation = adapter(() => harness.request, {} as Session)('https://example.test/upload', {
      body,
      duplex: 'half',
      method: 'POST',
    } as RequestInit);

    await vi.waitFor(() => expect(harness.request.write).toHaveBeenCalledTimes(1));
    expect(harness.request.end).not.toHaveBeenCalled();
    writeCallbacks.shift()?.();
    await vi.waitFor(() => expect(harness.request.write).toHaveBeenCalledTimes(2));
    expect(harness.request.end).not.toHaveBeenCalled();
    writeCallbacks.shift()?.();

    await expect(operation).resolves.toMatchObject({ status: 204 });
    expect(harness.request.end).toHaveBeenCalledOnce();
  });

  it('cancels an upload producer when a manual redirect terminates the request', async () => {
    const cancel = vi.fn();
    const harness = clientRequest(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new TextEncoder().encode('pending'));
      },
    });
    const operation = adapter(() => harness.request, {} as Session)(
      'https://example.test/manual-redirect',
      {
        body,
        duplex: 'half',
        method: 'POST',
        redirect: 'manual',
      } as RequestInit,
    );

    await vi.waitFor(() => expect(harness.request.write).toHaveBeenCalledOnce());
    harness.emitter.emit('redirect', 307, 'POST', 'https://example.test/next', {
      location: ['https://example.test/next'],
    });

    await expect(operation).resolves.toMatchObject({ status: 307 });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(harness.request.abort).toHaveBeenCalledOnce();
  });

  it('cancels an upload producer when the request fails with a write pending', async () => {
    const cancel = vi.fn();
    const harness = clientRequest(() => undefined);
    vi.mocked(harness.request.write).mockImplementation(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new TextEncoder().encode('pending'));
      },
    });
    const operation = adapter(() => harness.request, {} as Session)(
      'https://example.test/upload-error',
      {
        body,
        duplex: 'half',
        method: 'POST',
      } as RequestInit,
    );

    await vi.waitFor(() => expect(harness.request.write).toHaveBeenCalledOnce());
    harness.emitter.emit('error', new Error('request failed during upload'));
    harness.emitter.emit('close');

    await expect(operation).rejects.toThrow('request failed during upload');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('waits for upload cancellation and ClientRequest close before rejecting', async () => {
    let releaseProducerCancellation!: () => void;
    const producerCancellation = new Promise<void>((resolve) => {
      releaseProducerCancellation = resolve;
    });
    const cancel = vi.fn(() => producerCancellation);
    const harness = clientRequest(() => undefined);
    vi.mocked(harness.request.abort).mockImplementation(() => {
      harness.emitter.emit('abort');
    });
    vi.mocked(harness.request.write).mockImplementation(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new TextEncoder().encode('pending'));
      },
    });
    const controller = new AbortController();
    const abortError = new Error('authoritative preflight changed');
    let settled = false;
    const outcome = adapter(() => harness.request, {} as Session)(
      'https://example.test/cleanup-barrier',
      {
        body,
        duplex: 'half',
        method: 'POST',
        signal: controller.signal,
      } as RequestInit,
    )
      .then(
        (response) => ({ ok: true as const, response }),
        (error: unknown) => ({ error, ok: false as const }),
      )
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => expect(harness.request.write).toHaveBeenCalledOnce());
    controller.abort(abortError);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    harness.emitter.emit('close');
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseProducerCancellation();
    await expect(outcome).resolves.toEqual({ error: abortError, ok: false });
  });

  it('keeps response-body cancellation pending through request and upload cleanup', async () => {
    let releaseProducerCancellation!: () => void;
    const producerCancellation = new Promise<void>((resolve) => {
      releaseProducerCancellation = resolve;
    });
    const cancelProducer = vi.fn(() => producerCancellation);
    const harness = clientRequest(() => undefined);
    vi.mocked(harness.request.abort).mockImplementation(() => {
      harness.emitter.emit('abort');
    });
    vi.mocked(harness.request.write).mockImplementation(() => undefined);
    const requestBody = new ReadableStream<Uint8Array>({
      cancel: cancelProducer,
      start(controller) {
        controller.enqueue(new TextEncoder().encode('pending'));
      },
    });
    const operation = adapter(() => harness.request, {} as Session)(
      'https://example.test/body-cancel-cleanup',
      {
        body: requestBody,
        duplex: 'half',
        method: 'POST',
      } as RequestInit,
    );

    await vi.waitFor(() => expect(harness.request.write).toHaveBeenCalledOnce());
    const incoming = incomingResponse(200, { 'content-type': 'text/plain' });
    harness.emitter.emit('response', incoming);
    const response = await operation;
    let settled = false;
    const cancellation = response.body!.cancel(new Error('consumer stopped')).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(cancelProducer).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    harness.emitter.emit('close');
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseProducerCancellation();
    await expect(cancellation).resolves.toBeUndefined();
  });

  it('bounds response-body cancellation when ClientRequest never closes', async () => {
    vi.useFakeTimers();
    try {
      const incoming = incomingResponse(200, { 'content-type': 'text/plain' });
      const harness = clientRequest(({ emitter }) => {
        emitter.emit('response', incoming);
      });
      vi.mocked(harness.request.abort).mockImplementation(() => {
        harness.emitter.emit('abort');
      });
      const response = await adapter(
        () => harness.request,
        {} as Session,
      )('https://example.test/body-cancel-timeout');
      let settled = false;
      const cancellation = response.body!.cancel(new Error('consumer stopped')).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(cancellation).resolves.toBeUndefined();

      expect(() => incoming.emit('error', new Error('late incoming error'))).not.toThrow();
      expect(() => harness.emitter.emit('error', new Error('late request error'))).not.toThrow();
      harness.emitter.emit('close');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a hard cleanup deadline without exposing late EventEmitter errors', async () => {
    vi.useFakeTimers();
    try {
      const harness = clientRequest(() => undefined);
      vi.mocked(harness.request.abort).mockImplementation(() => {
        harness.emitter.emit('abort');
      });
      const controller = new AbortController();
      const abortError = new Error('obsolete preflight');
      let settled = false;
      const outcome = adapter(() => harness.request, {} as Session)(
        'https://example.test/cleanup-timeout',
        { signal: controller.signal },
      )
        .then(
          (response) => ({ ok: true as const, response }),
          (error: unknown) => ({ error, ok: false as const }),
        )
        .finally(() => {
          settled = true;
        });

      controller.abort(abortError);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toEqual({ error: abortError, ok: false });

      expect(() => harness.emitter.emit('error', new Error('late transport error'))).not.toThrow();
      harness.emitter.emit('close');
      expect(harness.emitter.listenerCount('error')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for ClientRequest close before resolving a final HEAD response', async () => {
    const incoming = incomingResponse(200);
    const harness = clientRequest(({ emitter }) => {
      emitter.emit('response', incoming);
      incoming.emit('end');
    });
    let settled = false;
    const outcome = adapter(() => harness.request, {} as Session)(
      'https://example.test/head-cleanup',
      { method: 'HEAD' },
    ).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(harness.request.end).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    harness.emitter.emit('close');
    await expect(outcome).resolves.toMatchObject({ status: 200 });
  });

  it('rejects a final HEAD response when its cleanup deadline expires without close', async () => {
    vi.useFakeTimers();
    try {
      const incoming = incomingResponse(200);
      const harness = clientRequest(({ emitter }) => {
        emitter.emit('response', incoming);
        incoming.emit('end');
      });
      let settled = false;
      const outcome = adapter(() => harness.request, {} as Session)(
        'https://example.test/head-cleanup-timeout',
        { method: 'HEAD' },
      )
        .then(
          (response) => ({ ok: true as const, response }),
          (error: unknown) => ({ error, ok: false as const }),
        )
        .finally(() => {
          settled = true;
        });

      expect(harness.request.end).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({
        error: expect.objectContaining({ message: 'Network request cleanup timed out' }),
        ok: false,
      });

      expect(() => incoming.emit('error', new Error('late incoming error'))).not.toThrow();
      harness.emitter.emit('close');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains an incoming error sink when the request closes before the body completes', async () => {
    const incoming = incomingResponse(200, { 'content-type': 'text/plain' });
    const harness = clientRequest(({ emitter }) => {
      emitter.emit('response', incoming);
      incoming.emit('data', Buffer.from('partial'));
    });

    const response = await adapter(
      () => harness.request,
      {} as Session,
    )('https://example.test/incomplete-body');
    const body = response.text();
    harness.emitter.emit('close');

    await expect(body).rejects.toThrow('Network response closed before the body completed');
    expect(() => incoming.emit('error', new Error('late incoming error'))).not.toThrow();
  });

  it('pauses a response at the Web-stream high-water mark and resumes on pull', async () => {
    let incoming: IncomingMessage | undefined;
    const harness = clientRequest(({ emitter }) => {
      incoming = incomingResponse(200);
      emitter.emit('response', incoming);
      incoming.emit('data', Buffer.from('first'));
    });

    const response = await adapter(
      () => harness.request,
      {} as Session,
    )('https://example.test/slow-response');
    const pause = vi.mocked((incoming as IncomingMessage & { pause: () => void }).pause);
    const resume = vi.mocked((incoming as IncomingMessage & { resume: () => void }).resume);
    await vi.waitFor(() => expect(pause).toHaveBeenCalled());
    const resumeCallsBeforeRead = resume.mock.calls.length;

    const reader = response.body?.getReader();
    await expect(reader?.read()).resolves.toMatchObject({ done: false });
    await vi.waitFor(() => expect(resume.mock.calls.length).toBeGreaterThan(resumeCallsBeforeRead));
    incoming?.emit('end');
    await expect(reader?.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('detaches only adapter-owned request and response listeners on close', async () => {
    const incoming = incomingResponse(204);
    const requestSentinel = vi.fn();
    const responseSentinel = vi.fn();
    const harness = clientRequest(({ emitter }) => {
      emitter.emit('response', incoming);
      incoming.emit('end');
      emitter.emit('close');
    });
    harness.emitter.on('error', requestSentinel);
    incoming.on('data', responseSentinel);

    await expect(
      adapter(() => harness.request, {} as Session)('https://example.test/cleanup'),
    ).resolves.toMatchObject({ status: 204 });

    expect(harness.emitter.listenerCount('login')).toBe(0);
    expect(harness.emitter.listenerCount('redirect')).toBe(0);
    expect(harness.emitter.listenerCount('response')).toBe(0);
    expect(harness.emitter.listenerCount('error')).toBe(1);
    expect(incoming.listenerCount('data')).toBe(1);
    expect(incoming.listenerCount('end')).toBe(0);
  });

  it('keeps queued login, redirect, and response events inert after abort', async () => {
    const resolver = vi.fn<ElectronProxyCredentialResolver>(() => ({
      password: 'secret',
      username: 'proxy-user',
    }));
    const callback = vi.fn();
    const harness = clientRequest(() => undefined);
    vi.mocked(harness.request.abort).mockImplementation(() => {
      harness.emitter.emit('abort');
    });
    const controller = new AbortController();
    const abortError = new Error('obsolete request');
    const operation = adapter(
      () => harness.request,
      {} as Session,
      resolver,
    )('https://example.test/', { redirect: 'follow', signal: controller.signal });
    const outcome = operation.then(
      (response) => ({ ok: true as const, response }),
      (error: unknown) => ({ error, ok: false as const }),
    );

    controller.abort(abortError);
    harness.emitter.emit('login', proxyAuth(), callback);
    harness.emitter.emit('redirect', 302, 'GET', 'https://redirected.example.test/', {
      location: ['https://redirected.example.test/'],
    });
    const response = incomingResponse(204);
    harness.emitter.emit('response', response);
    response.emit('end');

    expect(callback).toHaveBeenCalledWith();
    expect(resolver).not.toHaveBeenCalled();
    expect(harness.request.followRedirect).not.toHaveBeenCalled();
    harness.emitter.emit('close');
    await expect(outcome).resolves.toEqual({ error: abortError, ok: false });
  });

  it('waits for an aborted manual redirect request to close before resolving', async () => {
    const harness = clientRequest(() => undefined);
    vi.mocked(harness.request.abort).mockImplementation(() => {
      harness.emitter.emit('abort');
    });
    let settled = false;
    const outcome = adapter(() => harness.request, {} as Session)(
      'https://example.test/manual-cleanup',
      { redirect: 'manual' },
    ).finally(() => {
      settled = true;
    });

    harness.emitter.emit('redirect', 302, 'GET', 'https://example.test/next', {
      location: ['https://example.test/next'],
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    harness.emitter.emit('close');
    await expect(outcome).resolves.toMatchObject({ status: 302 });
  });

  it('runs the main-owned redirect policy synchronously before following', async () => {
    const policyError = new Error('redirect authority denied');
    const authorizeRedirect = vi.fn(() => {
      throw policyError;
    });
    const harness = clientRequest(({ emitter }) => {
      emitter.emit('redirect', 302, 'GET', 'https://denied.example.test/', {
        location: ['https://denied.example.test/'],
      });
    });
    const electronFetch = createElectronSessionFetch({
      authorizeRedirect,
      requestFactory: () => harness.request,
      resolveProxyCredentials: () => undefined,
      session: {} as Session,
    });

    await expect(electronFetch('https://example.test/', { redirect: 'follow' })).rejects.toBe(
      policyError,
    );
    expect(authorizeRedirect).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUrl: new URL('https://example.test/'),
        targetUrl: new URL('https://denied.example.test/'),
      }),
    );
    expect(harness.request.followRedirect).not.toHaveBeenCalled();
  });

  it('preserves a synchronous followRedirect transport failure', async () => {
    const transportError = new Error('followRedirect failed');
    const harness = clientRequest(({ emitter }) => {
      emitter.emit('redirect', 302, 'GET', 'https://example.test/final', {
        location: ['https://example.test/final'],
      });
    });
    vi.mocked(harness.request.followRedirect).mockImplementation(() => {
      throw transportError;
    });

    await expect(
      adapter(() => harness.request, {} as Session)('https://example.test/', {
        redirect: 'follow',
      }),
    ).rejects.toBe(transportError);
    expect(harness.request.abort).toHaveBeenCalledOnce();
  });

  it('aborts the ClientRequest when the response body consumer cancels', async () => {
    const harness = clientRequest(({ emitter }) => {
      emitter.emit('response', incomingResponse(200));
    });

    const response = await adapter(
      () => harness.request,
      {} as Session,
    )('https://example.test/cancel-body');
    await response.body?.cancel(new Error('consumer stopped'));

    expect(harness.request.abort).toHaveBeenCalledOnce();
  });

  it('aborts the request when the upload producer errors', async () => {
    const producerError = new Error('upload producer failed');
    const harness = clientRequest(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw producerError;
      },
    });

    await expect(
      adapter(() => harness.request, {} as Session)('https://example.test/producer-error', {
        body,
        duplex: 'half',
        method: 'POST',
      } as RequestInit),
    ).rejects.toBe(producerError);
    expect(harness.request.abort).toHaveBeenCalledOnce();
  });

  it('binds each proxy challenge to the exact URL currently being requested after redirects', async () => {
    const session = {} as Session;
    const callback = vi.fn();
    const resolver = vi.fn<ElectronProxyCredentialResolver>(({ requestUrl }) =>
      requestUrl.href === 'https://github.com/'
        ? { password: 'candidate-secret', username: 'proxy-user' }
        : undefined,
    );
    const harness = clientRequest(
      ({ emitter }) => {
        emitter.emit('redirect', 302, 'HEAD', 'https://redirected.example/', {
          location: ['https://redirected.example/'],
        });
      },
      ({ emitter }) => {
        emitter.emit('login', proxyAuth(), callback);
        const response = incomingResponse(204);
        emitter.emit('response', response);
        response.emit('end');
        emitter.emit('close');
      },
    );

    const response = await adapter(
      () => harness.request,
      session,
      resolver,
    )('https://github.com/', { method: 'HEAD', redirect: 'follow' });

    expect(response).toMatchObject({ status: 204, url: 'https://redirected.example/' });
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUrl: new URL('https://redirected.example/'),
        session,
      }),
    );
    expect(callback).toHaveBeenCalledWith();
  });

  it('surfaces request errors, response stream errors, and AbortSignal cancellation', async () => {
    const requestFailure = clientRequest(({ emitter }) => {
      emitter.emit('error', new Error('request failed'));
      emitter.emit('close');
    });
    await expect(
      adapter(() => requestFailure.request, {} as Session)('https://example.test/request-error'),
    ).rejects.toThrow('request failed');

    const responseFailure = clientRequest(({ emitter }) => {
      const response = incomingResponse(200);
      emitter.emit('response', response);
      queueMicrotask(() => response.emit('error', new Error('response failed')));
    });
    const response = await adapter(
      () => responseFailure.request,
      {} as Session,
    )('https://example.test/response-error');
    await expect(response.text()).rejects.toThrow('response failed');

    const pending = clientRequest(() => undefined);
    const controller = new AbortController();
    const operation = adapter(() => pending.request, {} as Session)('https://example.test/abort', {
      signal: controller.signal,
    });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(pending.request.abort).toHaveBeenCalledOnce();
  });

  it('fails closed for fetch features the ClientRequest adapter cannot safely represent', async () => {
    const requestFactory = vi.fn();
    await expect(
      adapter(requestFactory, {} as Session)('https://example.test/', {
        integrity: 'sha256-unrepresentable',
      }),
    ).rejects.toThrow('Subresource Integrity');
    expect(requestFactory).not.toHaveBeenCalled();
  });
});

describe('createElectronApplicationRequest', () => {
  it('uses the bound Electron Session fetch for a metadata-only request', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          headers: { 'content-type': 'application/json; charset=utf-8' },
          status: 204,
        }),
    ) as unknown as typeof globalThis.fetch;
    const applicationRequest = createElectronApplicationRequest({ fetch });

    await expect(applicationRequest('https://chatgpt.com/')).resolves.toEqual({
      contentType: 'application/json; charset=utf-8',
      redirects: [],
      status: 204,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'omit',
        method: 'GET',
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('keeps Electron manual redirects unfollowed', async () => {
    const redirectCancelled = new TypeError('Redirect was cancelled');
    const fetch = vi.fn(async () => {
      throw redirectCancelled;
    }) as unknown as typeof globalThis.fetch;
    const applicationRequest = createElectronApplicationRequest({ fetch });

    await expect(
      applicationRequest('https://chatgpt.com/', undefined, {
        allowedDomains: ['auth.openai.com'],
      }),
    ).rejects.toBe(redirectCancelled);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('forwards the authoritative abort reason to the active Session fetch', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('missing signal');
          const abort = (): void => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }),
    ) as unknown as typeof globalThis.fetch;
    const applicationRequest = createElectronApplicationRequest({ fetch });
    const controller = new AbortController();
    const abortError = new Error('obsolete preflight');
    const operation = applicationRequest('https://chatgpt.com/', controller.signal);

    controller.abort(abortError);

    await expect(operation).rejects.toBe(abortError);
  });

  it('removes authoritative abort forwarding after a completed request', async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof globalThis.fetch;
    const applicationRequest = createElectronApplicationRequest({ fetch });
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(
      applicationRequest('https://chatgpt.com/', controller.signal),
    ).resolves.toMatchObject({ status: 204 });

    const forwardingListener = addEventListener.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(forwardingListener).toBeDefined();
    expect(removeEventListener).toHaveBeenCalledWith('abort', forwardingListener);
  });

  it('bounds a Session fetch that never settles', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error('missing signal');
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ) as unknown as typeof globalThis.fetch;
      const applicationRequest = createElectronApplicationRequest({ fetch }, 8_000);
      const operation = applicationRequest('https://chatgpt.com/');
      const assertion = expect(operation).rejects.toThrow('连接超时。');

      await vi.advanceTimersByTimeAsync(8_000);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
