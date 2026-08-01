import { describe, expect, it } from 'vitest';
import {
  parseClashProxies,
  parseProxyImportText,
  parseProxyShareLink,
} from '../src/main/proxy/proxy-parser';

const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

describe('proxy import parser', () => {
  it('parses vmess, vless, trojan, and shadowsocks synthetic links', () => {
    const vmess = parseProxyShareLink(
      `vmess://${base64(JSON.stringify({ add: 'vm.example', id: '00000000-0000-4000-8000-000000000001', net: 'ws', path: '/socket', port: 443, ps: 'VM', tls: 'tls', v: '2' }))}`,
    );
    expect(vmess).toMatchObject({ address: 'vm.example', port: 443, protocol: 'vmess', tls: true });
    expect(
      parseProxyShareLink(
        'vless://00000000-0000-4000-8000-000000000002@vl.example:443?security=tls&type=grpc#VL',
      ),
    ).toMatchObject({ protocol: 'vless', transport: 'grpc' });
    expect(
      parseProxyShareLink('trojan://synthetic-password@tr.example:443?security=tls#TR'),
    ).toMatchObject({ protocol: 'trojan', tls: true });
    expect(
      parseProxyShareLink(`ss://${base64('aes-256-gcm:synthetic@ss.example:8388')}#SS`),
    ).toMatchObject({ protocol: 'shadowsocks', port: 8388 });
  });

  it('parses only the Clash proxies section and reports malformed entries', () => {
    const preview = parseClashProxies(`
proxies:
  - name: Valid
    type: trojan
    server: proxy.example
    port: 443
    password: synthetic
    sni: proxy.example
  - { name: Broken, type: vless, server: bad.example, port: 443 }
proxy-groups:
  - name: ignored
`);
    expect(preview.profiles).toHaveLength(1);
    expect(preview.issues).toEqual([
      expect.objectContaining({ index: 2, message: expect.stringContaining('UUID') }),
    ]);
  });

  it('decodes a base64 subscription and keeps valid lines when one is malformed', () => {
    const subscription = base64(
      ['http://alice:secret@http.example:8080#HTTP', 'vless://missing-fields'].join('\n'),
    );
    const preview = parseProxyImportText(subscription);
    expect(preview.profiles).toHaveLength(1);
    expect(preview.issues[0]?.message).toContain('第 2 个节点');
  });
});
