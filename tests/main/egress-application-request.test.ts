import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import type {
  ClientRequest,
  ClientRequestConstructorOptions,
  IncomingMessage,
  Session,
} from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  createEgressApplicationRequest,
  EgressApplicationRequestError,
} from '../../src/main/egress-diagnostics/application-request';
import { EGRESS_ENDPOINTS } from '../../src/main/egress-diagnostics/provider-registry';

const incomingResponse = (
  statusCode: number,
  headers: Record<string, string | string[]> = { 'content-type': 'application/json' },
): IncomingMessage =>
  Object.assign(new EventEmitter(), {
    headers,
    pause: vi.fn(),
    rawHeaders: Object.entries(headers).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).flatMap((item) => [name, item]),
    ),
    resume: vi.fn(),
    statusCode,
    statusMessage: statusCode === 200 ? 'OK' : '',
  }) as unknown as IncomingMessage;

interface RequestHarness {
  readonly emitter: EventEmitter;
  readonly request: ClientRequest;
}

const clientRequest = (onEnd: (harness: RequestHarness) => void): RequestHarness => {
  const emitter = new EventEmitter();
  const harness = {} as RequestHarness;
  const request = Object.assign(emitter, {
    abort: vi.fn(() => {
      emitter.emit('abort');
      emitter.emit('close');
    }),
    chunkedEncoding: false,
    end: vi.fn(() => onEnd(harness)),
    followRedirect: vi.fn(),
    write: vi.fn(),
  }) as unknown as ClientRequest;
  Object.assign(harness, { emitter, request });
  return harness;
};

const respondJson = (harness: RequestHarness, body = '{}', status = 200): void => {
  const response = incomingResponse(status);
  harness.emitter.emit('response', response);
  response.emit('data', Buffer.from(body));
  response.emit('end');
};

const createRequest = (
  requestFactory: (options: ClientRequestConstructorOptions) => ClientRequest,
  session: Session = {} as Session,
  deadlineMs = 1_000,
  monotonicNow?: () => number,
) =>
  createEgressApplicationRequest({
    deadlineMs,
    monotonicNow,
    requestFactory,
    resolveProxyCredentials: () => undefined,
    session,
  });

const headersRecord = (options: ClientRequestConstructorOptions): Record<string, string> =>
  (options.headers ?? {}) as Record<string, string>;

describe('egress application request', () => {
  it('owns a frozen registry of only the five exact HTTPS endpoints and decoded-byte ceilings', () => {
    expect(Object.isFrozen(EGRESS_ENDPOINTS)).toBe(true);
    expect(
      Object.fromEntries(
        Object.entries(EGRESS_ENDPOINTS).map(([id, endpoint]) => [
          id,
          { bytes: endpoint.maxDecodedBytes, frozen: Object.isFrozen(endpoint), url: endpoint.url },
        ]),
      ),
    ).toEqual({
      'abuseipdb-check': {
        bytes: 64 * 1024,
        frozen: true,
        url: 'https://api.abuseipdb.com/api/v2/check',
      },
      'ipinfo-max-v4': {
        bytes: 128 * 1024,
        frozen: true,
        url: 'https://v4.api.ipinfo.io/lookup/me',
      },
      'ipinfo-max-v6': {
        bytes: 128 * 1024,
        frozen: true,
        url: 'https://v6.api.ipinfo.io/lookup/me',
      },
      'public-address-v4': {
        bytes: 4 * 1024,
        frozen: true,
        url: 'https://api.ipify.org?format=json',
      },
      'public-address-v6': {
        bytes: 4 * 1024,
        frozen: true,
        url: 'https://api6.ipify.org?format=json',
      },
    });
  });

  it('rejects an unregistered endpoint token without treating it as a URL or echoing it', async () => {
    const requestFactory = vi.fn();
    const request = createRequest(requestFactory);
    const untrustedEndpoint = 'https://credential@example.invalid/private';
    let failure: unknown;
    try {
      await request({ endpointId: untrustedEndpoint } as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'invalid-configuration' });
    expect(JSON.stringify(failure)).not.toContain(untrustedEndpoint);
    expect(requestFactory).not.toHaveBeenCalled();
  });

  it('contains no global, Session, net, Node HTTP, DNS, or subprocess transport fallback', async () => {
    const source = await readFile(
      new URL('../../src/main/egress-diagnostics/application-request.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('createElectronSessionFetch');
    expect(source).not.toMatch(/(?:globalThis\.)?fetch\s*\(/);
    expect(source).not.toMatch(/Session\.fetch|net\.fetch|node:(?:http|https|dns|child_process)/);
    expect(source).not.toMatch(/\b(?:spawn|exec)\s*\(/);
  });

  it('uses only the injected request factory with the exact application Session and fixed endpoint', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const session = {} as Session;
    const harnesses: RequestHarness[] = [];
    const requestFactory = vi.fn((options: ClientRequestConstructorOptions) => {
      const harness = clientRequest((current) => respondJson(current, '{"ip":"203.0.113.7"}'));
      harnesses.push(harness);
      expect(options).toMatchObject({
        method: 'GET',
        redirect: 'manual',
        session,
        url: 'https://api.ipify.org/?format=json',
      });
      return harness.request;
    });

    const response = await createRequest(
      requestFactory,
      session,
    )({ endpointId: 'public-address-v4' });

    expect(new TextDecoder().decode(response.body)).toBe('{"ip":"203.0.113.7"}');
    expect(requestFactory).toHaveBeenCalledOnce();
    expect(harnesses[0]?.request.abort).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('fails through the injected transport without falling back to any global transport', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const requestFactory = vi.fn(() => {
      throw new Error('factory failed with internal details');
    });

    await expect(
      createRequest(requestFactory)({ endpointId: 'public-address-v4' }),
    ).rejects.toMatchObject({
      code: 'transport-failed',
      message: 'The Electron application-session request failed.',
    });
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('keeps credentials in fixed headers and builds only the bounded AbuseIPDB query', async () => {
    const secret = 'top-secret-key';
    const seen: ClientRequestConstructorOptions[] = [];
    const requestFactory = vi.fn((options: ClientRequestConstructorOptions) => {
      seen.push(options);
      return clientRequest((harness) => respondJson(harness)).request;
    });
    const request = createRequest(requestFactory);

    await request({ credential: secret, endpointId: 'ipinfo-max-v4' });
    await request({
      address: '2001:db8::1',
      credential: secret,
      endpointId: 'abuseipdb-check',
      maxAgeInDays: 90,
    });

    expect(seen[0]?.url).toBe('https://v4.api.ipinfo.io/lookup/me');
    expect(headersRecord(seen[0]!).authorization).toBe(`Bearer ${secret}`);
    expect(seen[1]?.url).toBe(
      'https://api.abuseipdb.com/api/v2/check?ipAddress=2001%3Adb8%3A%3A1&maxAgeInDays=90',
    );
    expect(seen[1]?.url).not.toContain('verbose');
    expect(seen[1]?.url).not.toContain(secret);
    expect(headersRecord(seen[1]!).key).toBe(secret);
  });

  it('rejects credential redirects and unsafe public redirects before another request', async () => {
    const credentialHarness = clientRequest(({ emitter }) => {
      emitter.emit('redirect', 302, 'GET', 'https://other.example/result', {
        location: ['https://other.example/result'],
      });
    });
    const credentialFactory = vi.fn(() => credentialHarness.request);

    await expect(
      createRequest(credentialFactory)({
        credential: 'secret',
        endpointId: 'ipinfo-max-v4',
      }),
    ).rejects.toMatchObject({ code: 'redirect-rejected' });
    expect(credentialFactory).toHaveBeenCalledOnce();
    expect(credentialHarness.request.abort).toHaveBeenCalledOnce();

    for (const location of [
      'http://api.ipify.org/result',
      'https://other.example/result',
      'http://[bad',
    ]) {
      const harness = clientRequest(({ emitter }) => {
        emitter.emit('redirect', 302, 'GET', location, { location: [location] });
      });
      await expect(
        createRequest(() => harness.request)({ endpointId: 'public-address-v4' }),
      ).rejects.toMatchObject({ code: 'redirect-rejected' });
      expect(harness.request.abort).toHaveBeenCalledOnce();
    }
  });

  it('follows only bounded same-origin HTTPS redirects under one request deadline', async () => {
    const seen: string[] = [];
    const requestFactory = vi.fn((options: ClientRequestConstructorOptions) => {
      seen.push(String(options.url));
      if (seen.length === 1) {
        return clientRequest(({ emitter }) => {
          emitter.emit('redirect', 302, 'GET', 'https://api.ipify.org/result', {
            location: ['/result'],
          });
        }).request;
      }
      return clientRequest((harness) => respondJson(harness, '{"ip":"203.0.113.8"}')).request;
    });

    await expect(
      createRequest(requestFactory)({ endpointId: 'public-address-v4' }),
    ).resolves.toMatchObject({ status: 200 });
    expect(seen).toEqual(['https://api.ipify.org/?format=json', 'https://api.ipify.org/result']);

    let hop = 0;
    const overflowFactory = vi.fn(
      () =>
        clientRequest(({ emitter }) => {
          hop += 1;
          emitter.emit('redirect', 302, 'GET', `https://api.ipify.org/hop-${hop}`, {
            location: [`/hop-${hop}`],
          });
        }).request,
    );
    await expect(
      createRequest(overflowFactory)({ endpointId: 'public-address-v4' }),
    ).rejects.toMatchObject({ code: 'redirect-rejected' });
    expect(overflowFactory).toHaveBeenCalledTimes(3);
  });

  it('cancels response bodies on status and content-type mismatches without exposing secrets', async () => {
    const secret = 'credential-must-not-leak';
    const harnesses: RequestHarness[] = [];
    const requestFactory = vi.fn((options: ClientRequestConstructorOptions) => {
      const status = harnesses.length === 0 ? 429 : 200;
      const headers: Record<string, string | string[]> =
        status === 429
          ? {
              'content-type': 'application/json',
              'retry-after': '12',
              'x-ratelimit-remaining': '0',
            }
          : { 'content-type': 'text/html' };
      const harness = clientRequest(({ emitter }) => {
        const response = incomingResponse(status, headers);
        emitter.emit('response', response);
      });
      harnesses.push(harness);
      expect(String(options.url)).not.toContain(secret);
      return harness.request;
    });
    const request = createRequest(requestFactory);

    let rateError: unknown;
    try {
      await request({ credential: secret, endpointId: 'ipinfo-max-v4' });
    } catch (error) {
      rateError = error;
    }
    expect(rateError).toBeInstanceOf(EgressApplicationRequestError);
    expect(rateError).toMatchObject({
      code: 'rate-limited',
      rateLimit: { remaining: 0, retryAfterSeconds: 12 },
      status: 429,
    });
    expect(JSON.stringify(rateError)).not.toContain(secret);
    expect(harnesses[0]?.request.abort).toHaveBeenCalledOnce();

    await expect(
      request({ credential: secret, endpointId: 'ipinfo-max-v4' }),
    ).rejects.toMatchObject({ code: 'content-type-mismatch' });
    expect(harnesses[1]?.request.abort).toHaveBeenCalledOnce();
  });

  it('enforces decoded-byte limits and cancels the oversized body', async () => {
    const harness = clientRequest(({ emitter }) => {
      const response = incomingResponse(200);
      emitter.emit('response', response);
      response.emit('data', Buffer.alloc(4 * 1024 + 1, 120));
    });

    await expect(
      createRequest(() => harness.request)({ endpointId: 'public-address-v4' }),
    ).rejects.toMatchObject({ code: 'body-too-large' });
    expect(harness.request.abort).toHaveBeenCalledOnce();
  });

  it('checks monotonic elapsed time when a buffered response outruns its timer callback', async () => {
    let elapsed = 0;
    const harness = clientRequest((current) => {
      elapsed = 21;
      respondJson(current, '{"ip":"203.0.113.9"}');
    });

    await expect(
      createRequest(
        () => harness.request,
        {} as Session,
        20,
        () => elapsed,
      )({ endpointId: 'public-address-v4' }),
    ).rejects.toMatchObject({ code: 'deadline-exceeded' });
  });

  it('uses one total deadline across redirects and body consumption, then propagates cancellation', async () => {
    const deadlineHarnesses: RequestHarness[] = [];
    const deadlineFactory = vi.fn(() => {
      const harness =
        deadlineHarnesses.length === 0
          ? clientRequest(({ emitter }) => {
              emitter.emit('redirect', 302, 'GET', 'https://api.ipify.org/result', {
                location: ['/result'],
              });
            })
          : clientRequest(({ emitter }) => {
              emitter.emit('response', incomingResponse(200));
            });
      deadlineHarnesses.push(harness);
      return harness.request;
    });
    await expect(
      createRequest(deadlineFactory, {} as Session, 20)({ endpointId: 'public-address-v4' }),
    ).rejects.toMatchObject({ code: 'deadline-exceeded' });
    expect(deadlineFactory).toHaveBeenCalledTimes(2);
    expect(
      deadlineHarnesses.every(
        (harness) => vi.mocked(harness.request.abort).mock.calls.length === 1,
      ),
    ).toBe(true);

    const pendingHarness = clientRequest(() => undefined);
    const controller = new AbortController();
    const operation = createRequest(() => pendingHarness.request)({
      endpointId: 'public-address-v4',
      signal: controller.signal,
    });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: 'cancelled' });
    expect(pendingHarness.request.abort).toHaveBeenCalledOnce();
  });
});
