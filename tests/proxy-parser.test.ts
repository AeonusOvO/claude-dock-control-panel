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

  it('keeps every REALITY parameter from a self-hosted vless link', () => {
    expect(
      parseProxyShareLink(
        'vless://cdd66f7e-3d8e-4751-c22f-069f198f7539@64.64.253.190:443?flow=xtls-rprx-vision&fp=firefox&pbk=21GGhV4uBlCJ16U3-i8dTvR6S88dhp2qkBKqbR3xLy4&security=reality&sni=iosapps.itunes.apple.com&type=tcp#vless-reality',
      ),
    ).toMatchObject({
      address: '64.64.253.190',
      fingerprint: 'firefox',
      flow: 'xtls-rprx-vision',
      port: 443,
      protocol: 'vless',
      publicKey: '21GGhV4uBlCJ16U3-i8dTvR6S88dhp2qkBKqbR3xLy4',
      remark: 'vless-reality',
      security: 'reality',
      serverName: 'iosapps.itunes.apple.com',
      transport: 'tcp',
    });
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
