import { describe, expect, it, vi } from 'vitest';
import { NetworkEnvironmentRiskProbe } from '../../src/main/network/environment-risk-probe';

const preferences = () => ({
  checkOnNewSession: true,
  checkOnProviderLogin: true,
});

describe('NetworkEnvironmentRiskProbe', () => {
  it('reports IP hygiene, DNS, timezone and language signals without exposing a full address', async () => {
    const requestJson = vi.fn(async (url: string) => {
      if (url.includes('proxycheck.io')) {
        return { '203.0.113.47': { proxy: 'no', risk: 0 }, status: 'ok' };
      }
      if (url.includes('stopforumspam.org')) {
        return { ip: { appears: 0, frequency: 0 }, success: 1 };
      }
      return {
        isp: { isp: 'Example Hosting' },
        ip: '203.0.113.47',
        location: {
          country: 'United States',
          country_code: 'US',
          timezone: 'America/Los_Angeles',
        },
        risk: { is_datacenter: true, is_proxy: false, is_tor: false, is_vpn: false },
        success: true,
      };
    });
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      now: () => 1234,
      readDnsServers: () => ['8.8.8.8'],
      requestJson,
      requestText: async () => 'Current IP: 203.0.113.47',
      resolveTxt: async () => [['FROM: 8.8.8.8#53000 Google LLC (US)']],
      settings: preferences,
      systemLanguages: () => ['zh-CN'],
      timezone: () => 'Asia/Shanghai',
    });

    const result = await probe.run();

    expect(result).toMatchObject({
      checkedAt: 1234,
      dnsStatus: 'review',
      exitAddressPrefix: '203.0.*.*',
      exitCountryCode: 'US',
      riskLevel: 'high',
    });
    expect(result.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(['dns-egress', 'ip-hygiene', 'timezone-mismatch']),
    );
    expect(result.issues.map((issue) => issue.kind)).not.toContain('language-mismatch');
    expect(result.checks?.find((check) => check.id === 'language')).toMatchObject({
      detail: expect.stringContaining('仅供参考'),
      label: '系统语言参考',
      status: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain('203.0.113.47');
  });

  it('does not let a CLI-only language override hide the Windows preferred language', async () => {
    const requestJson = async (url: string) => {
      if (url.includes('proxycheck.io')) {
        return { '203.0.113.20': { proxy: 'no', risk: 0 }, status: 'ok' };
      }
      if (url.includes('stopforumspam.org')) {
        return { ip: { appears: 0, frequency: 0 }, success: 1 };
      }
      return {
        ip: '203.0.113.20',
        location: {
          country: 'United States',
          country_code: 'US',
          timezone: 'America/Los_Angeles',
        },
        risk: {},
        success: true,
      };
    };
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson,
      requestText: async () => 'Current IP: 203.0.113.20',
      resolveTxt: async () => [['FROM: 1.1.1.1#53000 Cloudflare (US)']],
      settings: () => ({
        ...preferences(),
        cliLanguages: ['en-US'],
        cliTimezone: 'America/Los_Angeles',
      }),
      systemLanguages: () => ['zh-CN'],
      timezone: () => 'Asia/Shanghai',
    });

    const result = await probe.run();

    expect(result.dnsStatus).toBe('consistent');
    expect(result.issues).toEqual([]);
    expect(result.riskLevel).toBe('low');
    expect(result.evidenceStatus).toBe('complete');
    expect(result.exitAddressPrefix).toBe('203.0.*.*');
    expect(result.localLanguage).toBe('zh-CN');
    expect(result.cliLanguages).toEqual(['en-US']);
    expect(result.checks?.find((check) => check.id === 'language')).toMatchObject({
      detail: expect.stringContaining('Windows 首选语言 zh-CN'),
      status: 'unknown',
    });
  });

  it('accepts a match from any Windows preferred system language', async () => {
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson: async (url) => {
        if (url.includes('proxycheck.io')) {
          return { '203.0.113.20': { proxy: 'no', risk: 0 }, status: 'ok' };
        }
        if (url.includes('stopforumspam.org')) {
          return { ip: { appears: 0, frequency: 0 }, success: 1 };
        }
        return {
          ip: '203.0.113.20',
          location: {
            country: 'United States',
            country_code: 'US',
            timezone: 'America/Los_Angeles',
          },
          risk: {},
          success: true,
        };
      },
      requestText: async () => 'Current IP: 203.0.113.20',
      resolveTxt: async () => [['FROM: 1.1.1.1#53000 Cloudflare (US)']],
      settings: preferences,
      systemLanguages: () => ['zh-CN', 'en-US'],
      timezone: () => 'America/Los_Angeles',
    });

    const result = await probe.run();

    expect(result.localLanguage).toBe('zh-CN');
    expect(result.evidenceStatus).toBe('complete');
    expect(result.riskLevel).toBe('low');
    expect(result.issues).toEqual([]);
    expect(result.checks?.find((check) => check.id === 'language')).toMatchObject({
      detail: expect.stringContaining('zh-CN、en-US 中至少一项'),
      status: 'passed',
    });
  });

  it('keeps an unknown country-language mapping out of critical evidence and risk', async () => {
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson: async (url) => {
        if (url.includes('proxycheck.io')) {
          return { '203.0.113.20': { proxy: 'no', risk: 0 }, status: 'ok' };
        }
        if (url.includes('stopforumspam.org')) {
          return { ip: { appears: 0, frequency: 0 }, success: 1 };
        }
        return {
          ip: '203.0.113.20',
          location: {
            country: 'Example Country',
            country_code: 'ZZ',
            timezone: 'America/Los_Angeles',
          },
          risk: {},
          success: true,
        };
      },
      requestText: async () => 'Current IP: 203.0.113.20',
      resolveTxt: async () => [['FROM: 1.1.1.1#53000 Cloudflare (ZZ)']],
      settings: preferences,
      systemLanguages: () => ['en-US'],
      timezone: () => 'America/Los_Angeles',
    });

    const result = await probe.run();

    expect(result.evidenceStatus).toBe('complete');
    expect(result.riskLevel).toBe('low');
    expect(result.issues).toEqual([]);
    expect(result.checks?.find((check) => check.id === 'language')).toMatchObject({
      detail: expect.stringContaining('不影响网络可用性判定'),
      status: 'unknown',
    });
  });

  it('does not fall back to the application locale when Windows returns no preferred language', async () => {
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson: async (url) => {
        if (url.includes('proxycheck.io')) {
          return { '203.0.113.20': { proxy: 'no', risk: 0 }, status: 'ok' };
        }
        if (url.includes('stopforumspam.org')) {
          return { ip: { appears: 0, frequency: 0 }, success: 1 };
        }
        return {
          ip: '203.0.113.20',
          location: {
            country: 'United States',
            country_code: 'US',
            timezone: 'America/Los_Angeles',
          },
          risk: {},
          success: true,
        };
      },
      requestText: async () => 'Current IP: 203.0.113.20',
      resolveTxt: async () => [['FROM: 1.1.1.1#53000 Cloudflare (US)']],
      settings: preferences,
      systemLanguages: () => [],
      timezone: () => 'America/Los_Angeles',
    });

    const result = await probe.run();

    expect(result.localLanguage).toBe('unknown');
    expect(result.evidenceStatus).toBe('complete');
    expect(result.riskLevel).toBe('low');
    expect(result.issues).toEqual([]);
    expect(result.checks?.find((check) => check.id === 'language')).toMatchObject({
      detail: expect.stringContaining('Windows 未返回首选语言'),
      status: 'unknown',
    });
  });

  it('returns an advisory unknown result when third-party intelligence is unavailable', async () => {
    const probe = new NetworkEnvironmentRiskProbe({
      readDnsServers: () => [],
      requestJson: async () => {
        throw new Error('offline');
      },
      settings: preferences,
      systemLanguages: () => ['en-US'],
      timezone: () => 'UTC',
    });

    await expect(probe.run()).resolves.toMatchObject({
      dnsStatus: 'unknown',
      riskLevel: 'unknown',
      summary: expect.stringContaining('不能判断'),
    });
  });

  it('reports authoritative DNS country mismatch and split-route exit as high risk', async () => {
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson: async (url) => {
        if (url.includes('proxycheck.io')) {
          return { '108.83.33.9': { proxy: 'no', risk: 0 }, status: 'ok' };
        }
        if (url.includes('stopforumspam.org')) {
          return { ip: { appears: 0, frequency: 0 }, success: 1 };
        }
        return {
          ip: '108.83.33.9',
          location: {
            country: 'United States',
            country_code: 'US',
            timezone: 'America/Los_Angeles',
          },
          risk: {},
          success: true,
        };
      },
      requestText: async () => 'Current IP: 114.92.145.142',
      resolveTxt: async () => [['FROM: 180.153.91.57#44058 China Telecom (Group) (CN)']],
      settings: preferences,
      systemLanguages: () => ['en-US'],
      timezone: () => 'America/Los_Angeles',
    });

    const result = await probe.run();

    expect(result.riskLevel).toBe('high');
    expect(result.dnsStatus).toBe('review');
    expect(result.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(['dns-egress', 'direct-route-mismatch']),
    );
    expect(JSON.stringify(result)).not.toContain('114.92.145.142');
    expect(JSON.stringify(result)).not.toContain('180.153.91.57');
  });

  it('keeps same-country DNS inconclusive when resolver ownership cannot be verified', async () => {
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson: async (url) => {
        if (url.includes('proxycheck.io')) {
          return { '203.0.113.20': { proxy: 'no', risk: 0 }, status: 'ok' };
        }
        if (url.includes('stopforumspam.org')) {
          return { ip: { appears: 0, frequency: 0 }, success: 1 };
        }
        return {
          ip: '203.0.113.20',
          isp: { isp: 'Example Exit Network' },
          location: {
            country: 'United States',
            country_code: 'US',
            timezone: 'America/Los_Angeles',
          },
          risk: {},
          success: true,
        };
      },
      requestText: async () => 'Current IP: 203.0.113.20',
      resolveTxt: async () => [['FROM: 192.0.2.53#53000 Unrelated ISP Resolver (US)']],
      settings: preferences,
      systemLanguages: () => ['en-US'],
      timezone: () => 'America/Los_Angeles',
    });

    const result = await probe.run();

    expect(result.evidenceStatus).toBe('partial');
    expect(result.riskLevel).toBe('unknown');
    expect(result.summary).toContain('不能判断为低风险');
    expect(result.checks?.find((check) => check.id === 'dns-authoritative')?.status).toBe(
      'unknown',
    );
  });
});
