import { describe, expect, it } from 'vitest';
import { evaluateEgress, probeEgress } from '../src/main/proxy/leak-audit';

const response = (body: string, contentType = 'text/plain'): Response =>
  new Response(body, { headers: { 'content-type': contentType }, status: 200 });

describe('proxy egress audit', () => {
  it('combines Cloudflare and IPinfo evidence without sending identifiers', async () => {
    const calls: Array<{ init: RequestInit; url: string }> = [];
    const evidence = await probeEgress(async (url, init) => {
      calls.push({ init, url });
      return url.includes('cloudflare')
        ? response('ip=203.0.113.9\nloc=US\nwarp=off\n')
        : response(
            JSON.stringify({ country: 'US', ip: '203.0.113.9', org: 'AS64500 Example Network' }),
            'application/json',
          );
    });
    expect(evidence).toMatchObject({
      asn: 'AS64500',
      countryCode: 'US',
      ip: '203.0.113.9',
      sourcesAgree: true,
    });
    expect(calls.every(({ init }) => init.credentials === 'omit' && init.method === 'GET')).toBe(
      true,
    );
  });

  it('takes the conservative path for unchanged, single-source, datacenter, and IPv6 evidence', () => {
    const items = evaluateEgress(
      { ip: '198.51.100.7', sources: ['direct'], sourcesAgree: true },
      {
        ip: '198.51.100.7',
        organization: 'DigitalOcean LLC',
        sources: ['IPinfo'],
        sourcesAgree: false,
      },
      true,
    );
    expect(items.find(({ name }) => name === '出口 IP 对比')?.verdict).toBe('risk');
    expect(items.find(({ name }) => name === 'IPv6 旁路')?.verdict).toBe('risk');
    expect(items.find(({ name }) => name === 'ASN / 机房启发式')?.verdict).toBe('warning');
  });
});
