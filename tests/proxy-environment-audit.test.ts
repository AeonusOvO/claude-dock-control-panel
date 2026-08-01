import { describe, expect, it } from 'vitest';
import { evaluateEnvironment } from '../src/main/proxy/environment-audit';

describe('proxy environment audit', () => {
  it('reports inherited proxy conflicts, virtual interfaces, and timezone mismatch as heuristics', () => {
    const items = evaluateEnvironment({
      builtInProxyUrl: 'http://127.0.0.1:43123',
      countryCode: 'US',
      environment: { HTTPS_PROXY: 'http://external.example:8080' },
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai',
      virtualInterfaces: ['VPN / 隧道接口'],
    });
    expect(items.find(({ name }) => name === '代理环境变量残留')?.verdict).toBe('warning');
    expect(items.find(({ name }) => name === '虚拟网络接口')?.verdict).toBe('warning');
    expect(items.find(({ name }) => name === '时区 / 语言一致性')?.verdict).toBe('warning');
  });

  it('always states the residual Anthropic endpoint fact', () => {
    const item = evaluateEnvironment({ environment: {}, virtualInterfaces: [] }).find(
      ({ name }) => name === 'Anthropic 官方域名访问',
    );
    expect(item?.explanation).toContain('api.anthropic.com');
  });
});
