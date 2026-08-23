import type { ClientRequest, Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  create: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../../src/main/network/electron-request', () => ({
  createElectronSessionFetch: transport.create,
}));

import { createEgressApplicationRequest } from '../../src/main/egress-diagnostics/application-request';

const responseAt = (url: string, cancel: () => void): Response => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel,
      start: () => undefined,
    }),
    { headers: { 'content-type': 'application/json' }, status: 200 },
  );
  Object.defineProperty(response, 'url', { configurable: true, value: url });
  return response;
};

describe('egress application final-response policy', () => {
  it('rejects and cancels a response whose final URL differs from the fixed requested target', async () => {
    const cancel = vi.fn();
    transport.fetch.mockResolvedValueOnce(responseAt('https://unexpected.example/result', cancel));
    transport.create.mockReturnValueOnce(transport.fetch);
    const requestFactory = vi.fn(() => ({}) as ClientRequest);
    const session = {} as Session;
    const request = createEgressApplicationRequest({
      requestFactory,
      resolveProxyCredentials: () => undefined,
      session,
    });

    await expect(request({ endpointId: 'public-address-v4' })).rejects.toMatchObject({
      code: 'malformed-response',
    });
    expect(transport.create).toHaveBeenCalledWith(
      expect.objectContaining({ requestFactory, session }),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
