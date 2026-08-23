import { describe, expect, it, vi } from 'vitest';
import {
  EgressApplicationRequestError,
  type EgressApplicationRequest,
} from '../../src/main/egress-diagnostics/application-request';
import {
  createPublicAddressCollector,
  parsePublicAddressPayload,
} from '../../src/main/egress-diagnostics/collectors/public-address';

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const response = (endpointId: 'public-address-v4' | 'public-address-v6', value: unknown) => ({
  body: bytes(value),
  contentType: 'application/json',
  endpointId,
  rateLimit: {},
  status: 200,
});

describe('public egress address collection', () => {
  it('accepts only an exact { ip } JSON object and canonicalizes the requested family', () => {
    expect(parsePublicAddressPayload(bytes({ ip: '203.0.113.9' }), 'ipv4')).toEqual({
      address: '203.0.113.9',
      family: 'ipv4',
    });
    expect(
      parsePublicAddressPayload(bytes({ ip: '2001:0DB8:0000:0000:0000:0000:0000:0001' }), 'ipv6'),
    ).toEqual({ address: '2001:db8::1', family: 'ipv6' });

    expect(() =>
      parsePublicAddressPayload(bytes({ ip: '203.0.113.9', note: 'extra' }), 'ipv4'),
    ).toThrow('exactly the ip field');
    expect(() => parsePublicAddressPayload(bytes({ ip: 'not-an-address' }), 'ipv4')).toThrow(
      'invalid',
    );
    expect(() => parsePublicAddressPayload(bytes({ ip: '2001:db8::1' }), 'ipv4')).toThrow('family');
    expect(() => parsePublicAddressPayload(bytes(['203.0.113.9']), 'ipv4')).toThrow(
      'documented shape',
    );
  });

  it('keeps IPv6 unavailability independent from a completed IPv4 observation', async () => {
    const request = vi.fn<EgressApplicationRequest>(async (input) => {
      if (input.endpointId === 'public-address-v4') {
        return response(input.endpointId, { ip: '203.0.113.10' });
      }
      throw new EgressApplicationRequestError('transport-failed', input.endpointId);
    });
    const collector = createPublicAddressCollector({ now: () => 1_800_000_000_000, request });

    const result = await collector.collect({ leaseCurrent: true });

    expect(request.mock.calls.map(([input]) => input.endpointId)).toEqual([
      'public-address-v4',
      'public-address-v6',
    ]);
    expect(result.state).toBe('partial');
    expect(result.sources[0]).toMatchObject({
      address: { address: '203.0.113.10', family: 'ipv4' },
      family: 'ipv4',
      provider: 'ipify',
      state: 'complete',
    });
    expect(result.sources[1]).toMatchObject({
      family: 'ipv6',
      issue: { code: 'transport-failed' },
      state: 'unavailable',
    });
    expect(result.explanation.facts).toContain(
      'IPv4 and IPv6 availability are assessed independently.',
    );
  });

  it('marks an independently cancelled family without discarding completed evidence', async () => {
    const request = vi.fn<EgressApplicationRequest>(async (input) => {
      if (input.endpointId === 'public-address-v4') {
        return response(input.endpointId, { ip: '203.0.113.11' });
      }
      throw new EgressApplicationRequestError('cancelled', input.endpointId);
    });

    const result = await createPublicAddressCollector({ request }).collect({ leaseCurrent: true });

    expect(result.state).toBe('partial');
    expect(result.sources[0].state).toBe('complete');
    expect(result.sources[1]).toMatchObject({ state: 'cancelled', issue: { code: 'cancelled' } });
  });

  it('marks both families cancelled when neither source produced evidence', async () => {
    const request = vi.fn<EgressApplicationRequest>(async (input) => {
      throw new EgressApplicationRequestError('cancelled', input.endpointId);
    });

    const result = await createPublicAddressCollector({ request }).collect({ leaseCurrent: true });

    expect(result.state).toBe('cancelled');
    expect(result.sources.every((source) => source.state === 'cancelled')).toBe(true);
  });
});
