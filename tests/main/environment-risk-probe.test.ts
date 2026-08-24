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
      publicAddressObservations: [
        expect.objectContaining({
          addressPrefix: '203.0.113.0/24',
          countryCode: 'US',
          endpoint: 'https://api.ipquery.io/?format=json',
        }),
        expect.objectContaining({
          addressPrefix: '203.0.113.0/24',
          endpoint: 'https://myip.ipip.net',
        }),
      ],
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
    expect(result.checks?.find((check) => check.id === 'stun-public-address')).toMatchObject({
      detail: expect.stringContaining('只描述 WebRTC 路径'),
      status: 'unavailable',
    });
    expect(result.summary).toContain('不授予或拒绝提供商访问');
    expect(result.summary).not.toContain('已通过的提供商端点连接结论');
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
    expect(result.publicAddressObservations[0]?.addressPrefix).toBe('203.0.113.0/24');
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
      detail: expect.stringContaining('不影响提供商网络可用性判定'),
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

    const result = await probe.run();

    expect(result).toMatchObject({
      dnsStatus: 'unknown',
      riskLevel: 'unknown',
      summary: expect.stringContaining('不代表提供商端点不可达'),
    });
    for (const observation of result.publicAddressObservations.filter(
      (candidate) => candidate.state === 'unavailable',
    )) {
      expect(observation).not.toHaveProperty('addressFamily');
    }
  });

  it('keeps destination-split public addresses endpoint-scoped while reporting DNS comparison risk', async () => {
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
    expect(result.issues.map((issue) => issue.kind)).toContain('dns-egress');
    expect(result.issues.map((issue) => issue.kind)).not.toContain('direct-route-mismatch');
    expect(result.publicAddressObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: 'https://api.ipquery.io/?format=json',
          sourceAgreement: 'mixed',
        }),
        expect.objectContaining({
          endpoint: 'https://myip.ipip.net',
          sourceAgreement: 'mixed',
        }),
      ]),
    );
    expect(JSON.stringify(result)).toContain('不代表提供商端点');
    expect(JSON.stringify(result)).not.toContain('114.92.145.142');
    expect(JSON.stringify(result)).not.toContain('180.153.91.57');
  });

  it('does not compare public-address observations from different address families', async () => {
    const ipv6Address = '2001:db8:1234:5678::1';
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson: async (url) => {
        if (url.includes('proxycheck.io')) {
          return { [ipv6Address]: { proxy: 'no', risk: 0 }, status: 'ok' };
        }
        if (url.includes('stopforumspam.org')) {
          return { ip: { appears: 0, frequency: 0 }, success: 1 };
        }
        return {
          ip: ipv6Address,
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
      systemLanguages: () => ['en-US'],
      timezone: () => 'America/Los_Angeles',
    });

    const result = await probe.run();

    expect(result.publicAddressObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          addressFamily: 'ipv6',
          addressPrefix: '2001:db8:1234:5678::/64',
          endpoint: 'https://api.ipquery.io/?format=json',
          sourceAgreement: 'not-comparable',
        }),
        expect.objectContaining({
          addressFamily: 'ipv4',
          addressPrefix: '203.0.113.0/24',
          endpoint: 'https://myip.ipip.net',
          sourceAgreement: 'not-comparable',
        }),
      ]),
    );
    expect(JSON.stringify(result)).toContain('地址族不同');
    expect(JSON.stringify(result)).not.toContain('来源不一致');
    expect(JSON.stringify(result)).not.toContain(ipv6Address);
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
    expect(result.summary).toContain('不代表提供商端点不可达');
    expect(result.checks?.find((check) => check.id === 'dns-authoritative')?.status).toBe(
      'unknown',
    );
  });

  it('keeps independent IPIP, DNS, IPv6 and STUN evidence when IPQuery fails', async () => {
    let timestamp = 100;
    const requestJson = vi.fn(async (url: string) => {
      if (url.includes('api.ipquery.io')) throw new Error('ipquery unavailable');
      if (url.includes('api6.ipify.org')) return { ip: '2001:db8:1234:5678::9' };
      throw new Error(`unexpected request: ${url}`);
    });
    const requestText = vi.fn(async () => 'Current IP: 203.0.113.25');
    const resolveTxt = vi.fn(async () => [['FROM: 1.1.1.1#53000 Cloudflare (US)']]);
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => true,
      now: () => timestamp++,
      readDnsServers: () => ['198.18.0.2'],
      requestJson,
      requestText,
      resolveTxt,
      settings: preferences,
      systemLanguages: () => ['en-US'],
      timezone: () => 'UTC',
    });

    const result = await probe.run();

    expect(requestText).toHaveBeenCalledWith('https://myip.ipip.net', undefined);
    expect(resolveTxt).toHaveBeenCalledOnce();
    expect(requestJson).toHaveBeenCalledWith('https://api6.ipify.org?format=json', undefined);
    expect(result.checkedAt).toBe(100);
    expect(result.publicAddressObservations).toEqual([
      expect.objectContaining({
        checkedAt: 101,
        observationProvider: 'IPQuery',
        process: 'network-diagnostics',
        state: 'unavailable',
      }),
      expect.objectContaining({
        addressPrefix: '203.0.113.0/24',
        checkedAt: 103,
        observationProvider: 'IPIP',
        process: 'network-diagnostics',
        state: 'complete',
      }),
      expect.objectContaining({
        addressPrefix: '2001:db8:1234:5678::/64',
        checkedAt: 105,
        observationProvider: 'ipify',
        process: 'network-diagnostics',
        state: 'complete',
      }),
    ]);
    expect(result.publicAddressObservations[0]).not.toHaveProperty('addressFamily');
    for (const check of result.checks ?? []) {
      expect(check).toMatchObject({
        authority: 'advisory-only',
        checkedAt: expect.any(Number),
        confidence: expect.stringMatching(/^(high|low|medium|unknown)$/),
        freshness: expect.stringMatching(/^(live|unknown)$/),
        networkScope: 'application',
        process: 'network-diagnostics',
        target: expect.any(String),
        transport: expect.stringMatching(
          /^(curl-cli|derived|local-system|not-collected|system-dns)$/,
        ),
      });
      expect(check.target).not.toBe('');
    }
    expect(result.checks?.find((check) => check.id === 'dns-authoritative')).toMatchObject({
      source: 'dnscheck.tools',
      status: 'unknown',
    });
    expect(result.checks?.find((check) => check.id === 'stun-public-address')).toMatchObject({
      source: 'WebRTC STUN（本次未收集）',
      status: 'unavailable',
    });
    expect(result.evidenceStatus).toBe('partial');
  });

  it('attributes reputation evidence only to sources that returned usable records', async () => {
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson: async (url) => {
        if (url.includes('proxycheck.io')) {
          return { '203.0.113.20': {}, status: 'ok' };
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
      systemLanguages: () => ['en-US'],
      timezone: () => 'America/Los_Angeles',
    });

    const result = await probe.run();
    const reputation = result.checks?.find((check) => check.id === 'ip-reputation');

    expect(reputation).toMatchObject({
      confidence: 'unknown',
      source: 'Stop Forum Spam',
      status: 'unknown',
    });
    expect(reputation?.source).not.toContain('IPQuery');
    expect(reputation?.source).not.toContain('ProxyCheck');
  });

  it('does not pass empty reputation payloads as completed evidence', async () => {
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson: async (url) => {
        if (url.includes('proxycheck.io')) {
          return { '203.0.113.20': {}, status: 'ok' };
        }
        if (url.includes('stopforumspam.org')) throw new Error('source unavailable');
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
      systemLanguages: () => ['en-US'],
      timezone: () => 'America/Los_Angeles',
    });

    const reputation = (await probe.run()).checks?.find((check) => check.id === 'ip-reputation');

    expect(reputation).toMatchObject({
      confidence: 'unknown',
      freshness: 'unknown',
      source: '无可用情报源',
      status: 'unknown',
    });
  });

  it('compares same-family observations by their persisted redacted prefix', async () => {
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson: async (url) => {
        if (url.includes('proxycheck.io')) {
          return { '203.0.113.10': { proxy: 'no', risk: 0 }, status: 'ok' };
        }
        if (url.includes('stopforumspam.org')) {
          return { ip: { appears: 0, frequency: 0 }, success: 1 };
        }
        return {
          ip: '203.0.113.10',
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
      systemLanguages: () => ['en-US'],
      timezone: () => 'America/Los_Angeles',
    });

    const result = await probe.run();

    expect(result.publicAddressObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          addressPrefix: '203.0.113.0/24',
          observationProvider: 'IPQuery',
          sourceAgreement: 'corroborated',
        }),
        expect.objectContaining({
          addressPrefix: '203.0.113.0/24',
          detail: expect.stringContaining('脱敏 /24 网段相同'),
          observationProvider: 'IPIP',
          sourceAgreement: 'corroborated',
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('203.0.113.10');
    expect(JSON.stringify(result)).not.toContain('203.0.113.20');
  });

  it.each([
    ['same', '2001:db8:1234:5678::20', 'corroborated'],
    ['different', '2001:db8:1234:9999::20', 'mixed'],
  ] as const)(
    'reconciles %s IPv6 prefixes across IPQuery and ipify while leaving IPv4 incomparable',
    async (_case, ipifyAddress, expectedAgreement) => {
      const ipqueryAddress = '2001:db8:1234:5678::10';
      const probe = new NetworkEnvironmentRiskProbe({
        globalIpv6Available: () => true,
        readDnsServers: () => ['198.18.0.2'],
        requestJson: async (url) => {
          if (url.includes('proxycheck.io')) {
            return { [ipqueryAddress]: { proxy: 'no', risk: 0 }, status: 'ok' };
          }
          if (url.includes('stopforumspam.org')) {
            return { ip: { appears: 0, frequency: 0 }, success: 1 };
          }
          if (url.includes('api6.ipify.org')) return { ip: ipifyAddress };
          return {
            ip: ipqueryAddress,
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
        systemLanguages: () => ['en-US'],
        timezone: () => 'America/Los_Angeles',
      });

      const result = await probe.run();
      const ipquery = result.publicAddressObservations.find(
        (observation) => observation.observationProvider === 'IPQuery',
      );
      const ipip = result.publicAddressObservations.find(
        (observation) => observation.observationProvider === 'IPIP',
      );
      const ipify = result.publicAddressObservations.find(
        (observation) => observation.observationProvider === 'ipify',
      );

      expect(ipquery?.sourceAgreement).toBe(expectedAgreement);
      expect(ipify?.sourceAgreement).toBe(expectedAgreement);
      expect(ipify?.detail).toContain(
        expectedAgreement === 'corroborated' ? '脱敏 /64 网段相同' : '脱敏 /64 网段不同',
      );
      expect(ipip?.sourceAgreement).toBe('not-comparable');
      expect(JSON.stringify(result)).not.toContain(ipqueryAddress);
      expect(JSON.stringify(result)).not.toContain(ipifyAddress);
    },
  );

  it('rejects IPv4-mapped IPv6 values as independent public IPv6 evidence', async () => {
    const mappedAddress = '::ffff:203.0.113.1';
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => true,
      readDnsServers: () => ['198.18.0.2'],
      requestJson: async (url) => {
        if (url.includes('proxycheck.io')) {
          return { '198.51.100.20': { proxy: 'no', risk: 0 }, status: 'ok' };
        }
        if (url.includes('stopforumspam.org')) {
          return { ip: { appears: 0, frequency: 0 }, success: 1 };
        }
        if (url.includes('api6.ipify.org')) return { ip: mappedAddress };
        return {
          ip: '198.51.100.20',
          location: {
            country: 'United States',
            country_code: 'US',
            timezone: 'America/Los_Angeles',
          },
          risk: {},
          success: true,
        };
      },
      requestText: async () => 'Current IP: 198.51.100.20',
      resolveTxt: async () => [['FROM: 1.1.1.1#53000 Cloudflare (US)']],
      settings: preferences,
      systemLanguages: () => ['en-US'],
      timezone: () => 'America/Los_Angeles',
    });

    const result = await probe.run();
    const ipify = result.publicAddressObservations.find(
      (observation) => observation.observationProvider === 'ipify',
    );

    expect(ipify).toMatchObject({
      detail: expect.stringContaining('IPv4 映射 IPv6'),
      state: 'unavailable',
    });
    expect(ipify).not.toHaveProperty('addressFamily');
    expect(ipify).not.toHaveProperty('addressPrefix');
    expect(JSON.stringify(result)).not.toContain(mappedAddress);
    expect(JSON.stringify(result)).not.toContain('::/64');
  });

  it('deduplicates an uncancellable authoritative DNS lookup across timed-out rechecks', async () => {
    let completeFirstLookup!: (records: string[][]) => void;
    const firstLookup = new Promise<string[][]>((resolve) => {
      completeFirstLookup = resolve;
    });
    const resolveTxt = vi
      .fn()
      .mockImplementationOnce(async () => firstLookup)
      .mockResolvedValue([['FROM: 1.1.1.1#53000 Cloudflare (US)']]);
    const requestJson = vi.fn(async (url: string) => {
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
    });
    const probe = new NetworkEnvironmentRiskProbe({
      globalIpv6Available: () => false,
      readDnsServers: () => ['198.18.0.2'],
      requestJson,
      requestText: async () => 'Current IP: 203.0.113.20',
      resolveTxt,
      settings: preferences,
      systemLanguages: () => ['en-US'],
      timezone: () => 'America/Los_Angeles',
    });
    const firstController = new AbortController();
    const firstRun = probe.run(firstController.signal);
    await vi.waitFor(() => expect(resolveTxt).toHaveBeenCalledOnce());

    firstController.abort();
    await expect(firstRun).rejects.toMatchObject({ name: 'AbortError' });

    const secondRun = probe.run();
    await vi.waitFor(() => expect(requestJson.mock.calls.length).toBeGreaterThanOrEqual(6));
    expect(resolveTxt).toHaveBeenCalledOnce();
    completeFirstLookup([['FROM: 1.1.1.1#53000 Cloudflare (US)']]);
    await expect(secondRun).resolves.toMatchObject({
      dnsStatus: 'consistent',
      riskLevel: 'low',
    });
    expect(resolveTxt).toHaveBeenCalledOnce();

    await expect(probe.run()).resolves.toMatchObject({ dnsStatus: 'consistent' });
    expect(resolveTxt).toHaveBeenCalledTimes(2);
  });

  it('sanitizes untrusted third-party metadata before returning the shared assessment', async () => {
    const secrets = [
      '198.51.100.77',
      '198.51.100.78',
      '198.51.100.79',
      '198.51.100.80',
      'metadata-password',
      'sk-proj-metadata-secret',
      'metadata-bearer',
      'metadata-token',
    ];
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
          isp: {
            isp: 'ISP 198.51.100.78 password=metadata-password sk-proj-metadata-secret',
          },
          location: {
            country: 'Country 198.51.100.77 Bearer metadata-bearer',
            country_code: 'US',
            timezone: 'Zone 198.51.100.80 token=metadata-token',
          },
          risk: {},
          success: true,
        };
      },
      requestText: async () => 'Current IP: 203.0.113.20',
      resolveTxt: async () => [
        ['FROM: 1.1.1.1#53000 Resolver 198.51.100.79 Bearer metadata-bearer (US)'],
      ],
      settings: preferences,
      systemLanguages: () => ['en-US'],
      timezone: () => 'UTC',
    });

    const result = await probe.run();
    const serialized = JSON.stringify(result);

    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('[REDACTED_CREDENTIAL]');
    expect(result.publicAddressObservations[0]).toMatchObject({
      countryName: expect.stringContaining('198.51.100.0/24'),
      networkProvider: expect.stringContaining('198.51.100.0/24'),
      timezone: expect.stringContaining('198.51.100.0/24'),
    });
    expect(result.checks?.find((check) => check.id === 'dns-authoritative')?.detail).toContain(
      '198.51.100.0/24',
    );
  });
});
