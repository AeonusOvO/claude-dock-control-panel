import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetworkPreflightResult } from '../src/shared/contracts';
import {
  NetworkDiagnosticsStore,
  redactDiagnosticText,
} from '../src/main/network-diagnostics-store';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const resultAt = (checkedAt: number): NetworkPreflightResult => ({
  checkedAt,
  featureAccess: [],
  paths: [
    {
      detail: 'application path',
      dnsServers: ['10.2.3.4'],
      ipv4Available: true,
      ipv6Available: false,
      process: 'application',
      proxyConfigured: false,
      proxyKind: 'direct',
      virtualInterfaces: ['VPN / 隧道接口'],
    },
  ],
  probes: [
    {
      checkedAt,
      detail: 'Authorization: Bearer secret-token-value',
      id: 'probe',
      kind: 'https',
      label: 'probe',
      process: 'application',
      required: true,
      status: 'failed',
      target: 'https://example.com/?token=secret',
    },
  ],
  provider: 'openai-codex',
  providerLabel: 'OpenAI Codex',
  reasons: ['sk-proj-this-is-a-secret-key'],
  riskLevel: 'high',
  riskScore: 90,
  signals: [],
  startedAt: checkedAt,
  status: 'blocked',
  summary: 'blocked',
});

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
    expect(raw).not.toContain('secret-token-value');
    expect(raw).not.toContain('this-is-a-secret-key');
    expect(raw).not.toContain('10.2.3.4');
    expect(raw).toContain('10.2.3.0/24');
    expect(raw).toContain('[REDACTED]');
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
