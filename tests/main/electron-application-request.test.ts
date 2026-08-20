import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createElectronApplicationRequest } from '../../src/main/network/electron-request';

describe('createElectronApplicationRequest', () => {
  it('synchronously follows redirects and records only host metadata', async () => {
    const emitter = new EventEmitter();
    const followRedirect = vi.fn();
    const request = Object.assign(emitter, {
      abort: vi.fn(),
      end: vi.fn(() => {
        emitter.emit(
          'redirect',
          302,
          'HEAD',
          'https://auth.openai.com/login?secret=not-recorded',
          {},
        );
        emitter.emit('response', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
          statusCode: 200,
        });
      }),
      followRedirect,
    }) as unknown as ClientRequest;
    const applicationRequest = createElectronApplicationRequest(() => request);

    const result = await applicationRequest('https://chatgpt.com/');

    expect(followRedirect).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      contentType: 'text/html; charset=utf-8',
      redirects: [{ host: 'auth.openai.com', statusCode: 302 }],
      status: 200,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects redirects that downgrade to HTTP', async () => {
    const emitter = new EventEmitter();
    const abort = vi.fn();
    const request = Object.assign(emitter, {
      abort,
      end: vi.fn(() => {
        emitter.emit('redirect', 302, 'HEAD', 'http://portal.example/login', {});
      }),
      followRedirect: vi.fn(),
    }) as unknown as ClientRequest;
    const applicationRequest = createElectronApplicationRequest(() => request);

    await expect(applicationRequest('https://chatgpt.com/')).rejects.toThrow('非 HTTPS 重定向');
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
