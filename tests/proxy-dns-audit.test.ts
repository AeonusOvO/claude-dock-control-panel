import { describe, expect, it } from 'vitest';
import { evaluateDns, probeDnsLeak } from '../src/main/proxy/leak-audit';

describe('proxy DNS audit', () => {
  it('flags private system resolvers while explaining HTTP CONNECT remote resolution', () => {
    const item = evaluateDns(['192.168.1.1', '1.1.1.1'], true);
    expect(item.verdict).toBe('warning');
    expect(item.evidence.join(' ')).toContain('HTTP CONNECT');
    expect(item.explanation).toContain('远端解析');
  });

  it('does not treat an empty online result as proof of no resolver leak', () => {
    expect(evaluateDns(['1.1.1.1'], true, []).verdict).toBe('warning');
  });

  it('does not claim safety when the optional online probe is unavailable', () => {
    const item = evaluateDns(['1.1.1.1'], true);
    expect(item.verdict).toBe('warning');
    expect(item.evidence).toContain('在线探测不可用，仅采用本地判据');
  });

  it('treats a resolver observed on both direct and proxy paths as a leak risk', () => {
    expect(
      evaluateDns(['1.1.1.1'], true, ['172.68.1.1 · Cloudflare'], ['172.68.1.1 · Cloudflare'])
        .verdict,
    ).toBe('risk');
    expect(
      evaluateDns(['1.1.1.1'], true, ['10.0.0.2 · Proxy DNS'], ['172.68.1.1 · Direct DNS']).verdict,
    ).toBe('passed');
  });

  it('uses unique authoritative test hostnames and returns observed resolver identities', async () => {
    const visited: string[] = [];
    const resolvers = await probeDnsLeak(async (url) => {
      visited.push(url);
      if (url.endsWith('/servers-for-result')) {
        return new Response(
          JSON.stringify([{ country_name: 'Singapore', ip: '172.68.1.2', isp: 'Cloudflare' }]),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        );
      }
      return new Response('', { status: url.startsWith('http://') ? 302 : 200 });
    });
    expect(visited).toContain('https://www.dnsleaktest.com/api/v1/identifiers');
    expect(
      visited.filter((url) => /^[a-z]+:\/\/[0-9a-f-]{36}\.test\.dnsleaktest\.com\/$/.test(url)),
    ).toHaveLength(4);
    expect(resolvers).toEqual(['172.68.1.2 · Cloudflare · Singapore']);
  });
});
