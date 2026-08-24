import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetworkPreflightResult } from '../../src/shared/contracts';
import {
  NetworkDiagnosticsStore,
  redactDiagnosticText,
} from '../../src/main/network/diagnostics-store';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const resultAt = (checkedAt: number): NetworkPreflightResult => {
  const paths = [
    {
      detail: 'application path 203.0.113.47 and 2001:db8:1:2::47',
      dnsServers: ['10.2.3.4', '2001:db8:3:4::53'],
      globalIpv6Available: false,
      ipv4Available: true,
      ipv6Available: false,
      networkScope: 'application' as const,
      process: 'application' as const,
      proxyConfigured: false,
      proxyKind: 'direct' as const,
      target:
        'https://diagnostic-user:diagnostic-password@203.0.113.47/v1?api_key=diagnostic-query-secret#diagnostic-fragment',
      virtualInterfaces: ['虚拟网络接口'],
    },
  ];
  const probes = [
    {
      checkedAt,
      detail: 'Authorization: Bearer secret-token-value',
      id: 'probe',
      kind: 'https' as const,
      label: 'probe',
      process: 'application' as const,
      required: true,
      status: 'failed' as const,
      target: 'https://example.com/?token=secret',
    },
  ];
  const providerConnectivity = {
    featureAccess: [],
    probes,
    reasons: ['sk-proj-this-is-a-secret-key'],
    signals: [],
    status: 'blocked' as const,
    summary: 'blocked',
  };
  const environment = {
    checkedAt,
    dnsDetail: 'DNS evidence',
    dnsStatus: 'consistent' as const,
    evidenceStatus: 'complete' as const,
    issues: [],
    localLanguage: 'zh-CN',
    localTimezone: 'Asia/Shanghai',
    publicAddressObservations: [
      {
        addressFamily: 'ipv6' as const,
        addressPrefix: '2001:0db8:0000:0000::/64',
        checkedAt,
        confidence: 'high' as const,
        detail: 'IPv6 observation',
        endpoint: 'https://api6.ipify.org',
        freshness: 'live' as const,
        networkScope: 'application' as const,
        observationProvider: 'ipify',
        process: 'network-diagnostics' as const,
        sourceAgreement: 'single-source' as const,
        state: 'complete' as const,
        statement: 'Destination-scoped observation',
        transport: 'curl-cli' as const,
      },
    ],
    riskLevel: 'low' as const,
    summary: 'Environment evidence',
  };
  const advisoryEvidence = {
    environment,
    paths,
    reasons: ['observed 203.0.113.47'],
    riskLevel: 'high' as const,
    riskScore: 90,
    signals: [],
    summary: 'advisory 203.0.113.47',
  };
  return {
    action: 'background',
    advisoryEvidence,
    canonicalCwd: 'C:\\Users\\alice\\private-project',
    checkedAt,
    configurationRevision: '1:1',
    environment,
    featureAccess: providerConnectivity.featureAccess,
    generation: 0,
    mainRunId: 1,
    networkScope: 'application',
    paths,
    probes,
    provider: 'openai-codex',
    providerConnectivity,
    providerLabel: 'OpenAI Codex',
    reasons: providerConnectivity.reasons,
    riskLevel: advisoryEvidence.riskLevel,
    riskScore: advisoryEvidence.riskScore,
    schemaVersion: 2,
    signals: [],
    startedAt: checkedAt,
    status: providerConnectivity.status,
    summary: providerConnectivity.summary,
  };
};

describe('NetworkDiagnosticsStore', () => {
  it('redacts credentials and trims expired records', () => {
    const now = 10 * 24 * 60 * 60 * 1_000;
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-network-history-'));
    fixtureRoots.push(root);
    const store = new NetworkDiagnosticsStore(root, () => now);

    store.append(resultAt(now - 8 * 24 * 60 * 60 * 1_000));
    store.append(resultAt(now));

    expect(store.getView().entries).toHaveLength(1);
    const raw = readFileSync(path.join(root, 'network-preflight', 'history.json'), 'utf8');
    const persisted = JSON.parse(raw) as {
      entries: Array<Record<string, unknown>>;
      version: number;
    };
    const [entry] = persisted.entries;
    const persistedPaths = (
      entry?.advisoryEvidence as { paths?: Array<{ target?: string }> } | undefined
    )?.paths;
    expect(persisted.version).toBe(2);
    expect(entry).toMatchObject({ schemaVersion: 2 });
    expect(entry).toHaveProperty('providerConnectivity');
    expect(entry).toHaveProperty('advisoryEvidence');
    expect(persistedPaths?.[0]?.target).toBe('https://203.0.113.0/24/v1');
    expect(entry).not.toHaveProperty('status');
    expect(entry).not.toHaveProperty('summary');
    expect(entry).not.toHaveProperty('featureAccess');
    expect(entry).not.toHaveProperty('paths');
    expect(entry).not.toHaveProperty('probes');
    expect(raw).not.toContain('secret-token-value');
    expect(raw).not.toContain('this-is-a-secret-key');
    expect(raw).not.toContain('diagnostic-user');
    expect(raw).not.toContain('diagnostic-password');
    expect(raw).not.toContain('diagnostic-query-secret');
    expect(raw).not.toContain('diagnostic-fragment');
    expect(raw).not.toContain('api_key');
    expect(raw).not.toContain('203.0.113.47');
    expect(raw).not.toContain('2001:db8:1:2::47');
    expect(raw).not.toContain('10.2.3.4');
    expect(raw).not.toContain('2001:db8:3:4::53');
    expect(raw).not.toContain('2001:0db8:0000:0000::/64');
    expect(raw).not.toContain('canonicalCwd');
    expect(raw).not.toContain('private-project');
    expect(store.getView().entries[0]).not.toHaveProperty('canonicalCwd');
    expect(store.getView().entries[0]).not.toHaveProperty('cwd');
    expect(raw).toContain('203.0.113.0/24');
    expect(raw).toContain('2001:db8:1:2::/64');
    expect(raw).toContain('10.2.3.0/24');
    expect(raw).toContain('2001:db8:3:4::/64');
    expect(raw).toContain('"addressPrefix": "2001:db8::/64"');
    expect(raw).toContain('https://203.0.113.0/24/v1');
    expect(raw).toContain('[REDACTED]');
  });

  it('migrates persisted advisory rows to cached freshness and complete provenance', () => {
    const now = 10 * 24 * 60 * 60 * 1_000;
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-network-history-provenance-'));
    fixtureRoots.push(root);
    const store = new NetworkDiagnosticsStore(root, () => now);
    store.append(resultAt(now));

    const storagePath = path.join(root, 'network-preflight', 'history.json');
    const persisted = JSON.parse(readFileSync(storagePath, 'utf8')) as {
      entries: Array<{
        advisoryEvidence: {
          environment: {
            checkedAt: number;
            checks?: Array<Record<string, unknown>>;
            publicAddressObservations: Array<Record<string, unknown>>;
          };
        };
      }>;
      version: number;
    };
    const environment = persisted.entries[0]?.advisoryEvidence.environment;
    expect(environment).toBeDefined();
    environment!.checks = [
      {
        detail: 'legacy DNS evidence',
        id: 'dns-authoritative',
        label: '权威 DNS 观察',
        source: 'dnscheck.tools',
        status: 'passed',
      },
    ];
    environment!.publicAddressObservations[0]!.freshness = 'live';
    writeFileSync(storagePath, JSON.stringify(persisted), 'utf8');

    const [entry] = store.getView().entries;
    expect(entry?.schemaVersion).toBe(2);
    if (entry?.schemaVersion !== 2) throw new Error('expected v2 history entry');
    expect(entry.advisoryEvidence.environment?.checks?.[0]).toMatchObject({
      authority: 'advisory-only',
      checkedAt: now,
      confidence: 'unknown',
      freshness: 'cached',
      networkScope: 'application',
      process: 'network-diagnostics',
      target: '*.test.dnscheck.tools TXT',
      transport: 'system-dns',
    });
    expect(entry.advisoryEvidence.environment?.publicAddressObservations[0]?.freshness).toBe(
      'cached',
    );
    expect(readFileSync(storagePath, 'utf8')).not.toContain('"freshness": "live"');
  });

  it('keeps already-redacted address prefixes canonical across repeated sanitization', () => {
    const diagnostic =
      'IPv4 203.0.113.47 and 203.0.113.0/24; IPv6 2001:0db8:0001:0002::47, 2001:db8:1:2::/64, and 2001:db8:0:0::/64';
    const once = redactDiagnosticText(diagnostic);
    const twice = redactDiagnosticText(once);

    expect(once).toBe(twice);
    expect(twice).toContain('203.0.113.0/24');
    expect(twice).toContain('2001:db8:1:2::/64');
    expect(twice).toContain('2001:db8::/64');
    expect(twice).not.toContain('0db8');
    expect(twice).not.toContain('/24/24');
    expect(twice).not.toContain('/64/64');
  });

  it('redacts IPv4-mapped IPv6 diagnostics without inventing an IPv6 /64', () => {
    const dotted = redactDiagnosticText('mapped [::ffff:203.0.113.47]');
    const hexadecimal = redactDiagnosticText('mapped 0:0:0:0:0:ffff:cb00:712f');

    expect(dotted).toBe('mapped [REDACTED_ADDRESS]');
    expect(hexadecimal).toBe('mapped [REDACTED_ADDRESS]');
    expect(dotted).not.toContain('::/64');
    expect(hexadecimal).not.toContain('::/64');
  });

  it('removes project paths from legacy history rows before exposing them', () => {
    const now = 10 * 24 * 60 * 60 * 1_000;
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-network-history-legacy-'));
    fixtureRoots.push(root);
    const directory = path.join(root, 'network-preflight');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'history.json'),
      JSON.stringify({
        entries: [
          {
            action: 'background',
            canonicalCwd: 'C:\\Users\\alice\\canonical-project',
            checkedAt: now,
            cwd: 'C:\\Users\\alice\\raw-project',
            probes: [
              {
                detail: 'Bearer legacy-secret',
                id: 'legacy-probe',
                status: 'passed',
              },
            ],
            provider: 'openai-codex',
            reasons: ['legacy composite reason'],
            startedAt: now - 1,
            status: 'allowed_with_notice',
            summary: 'legacy flat summary',
          },
          {
            canonicalCwd: 'C:\\Users\\alice\\expired-project',
            checkedAt: now - 8 * 24 * 60 * 60 * 1_000,
            probes: [],
            provider: 'openai-codex',
            startedAt: now - 8 * 24 * 60 * 60 * 1_000,
            status: 'blocked',
          },
        ],
        version: 1,
      }),
      'utf8',
    );

    const [entry] = new NetworkDiagnosticsStore(root, () => now).getView().entries;
    expect(entry).toMatchObject({
      legacyComposite: {
        provider: 'openai-codex',
        status: 'allowed_with_notice',
        summary: 'legacy flat summary',
      },
      schemaVersion: 1,
    });
    expect(entry).not.toHaveProperty('providerConnectivity');
    expect(entry).not.toHaveProperty('advisoryEvidence');
    expect(entry).not.toHaveProperty('status');
    expect(entry).not.toHaveProperty('canonicalCwd');
    expect(entry).not.toHaveProperty('cwd');
    const migrated = readFileSync(path.join(directory, 'history.json'), 'utf8');
    const persisted = JSON.parse(migrated) as { entries: unknown[]; version: number };
    expect(persisted.version).toBe(2);
    expect(persisted.entries).toHaveLength(1);
    expect(migrated).not.toContain('legacy-secret');
    expect(migrated).toContain('Bearer [REDACTED]');
    expect(migrated).not.toContain('canonicalCwd');
    expect(migrated).not.toContain('canonical-project');
    expect(migrated).not.toMatch(/"cwd"/);
    expect(migrated).not.toContain('raw-project');
    expect(migrated).not.toContain('expired-project');
  });

  it('redacts bearer and query credentials without hiding ordinary diagnostics', () => {
    expect(redactDiagnosticText('Bearer abc.def token=ok?')).toContain('[REDACTED]');
    expect(redactDiagnosticText('failed at C:\\Users\\alice\\project\\config.json')).not.toContain(
      'alice',
    );
    expect(redactDiagnosticText('HTTP 403 from official endpoint')).toBe(
      'HTTP 403 from official endpoint',
    );
  });
});
