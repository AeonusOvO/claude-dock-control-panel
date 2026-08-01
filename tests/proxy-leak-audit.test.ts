import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LeakAuditService,
  proxyNodeFingerprint,
  summarizeAudit,
} from '../src/main/proxy/leak-audit';
import { LeakAuditStore } from '../src/main/proxy/leak-audit-store';

const profile = {
  address: 'proxy.example',
  hasCredentials: true,
  id: 'profile-one',
  port: 443,
  protocol: 'trojan' as const,
  remark: 'Synthetic',
  tls: true,
  transport: 'tcp' as const,
  updatedAt: 1,
};

describe('proxy leak-audit decision semantics', () => {
  it('summarizes conservatively and fingerprints no credentials', () => {
    expect(
      summarizeAudit([
        { advice: '', evidence: [], explanation: '', name: 'a', verdict: 'passed' },
        { advice: '', evidence: [], explanation: '', name: 'b', verdict: 'risk' },
      ]),
    ).toBe('risk');
    expect(proxyNodeFingerprint(profile)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('blocks risky access until the user explicitly accepts the exact report', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-audit-'));
    const store = new LeakAuditStore(userDataPath);
    const report = {
      checkedAt: 100,
      items: [
        {
          advice: 'adjust',
          evidence: ['synthetic'],
          explanation: 'risk',
          name: 'IP',
          verdict: 'risk' as const,
        },
      ],
      nodeFingerprint: proxyNodeFingerprint(profile),
      summary: 'risk' as const,
    };
    const record = store.add(report);
    const service = new LeakAuditService({
      auditStore: store,
      directFetch: fetch,
      proxiedFetch: () => fetch,
      webRtcAudit: async () => report.items[0]!,
    });
    expect(() => service.assertAccessAccepted(profile)).toThrow(/接入已暂停/);
    service.accept(record.id);
    expect(() => service.assertAccessAccepted(profile)).not.toThrow();
    const disk = readFileSync(path.join(userDataPath, 'proxy', 'audits.json'), 'utf8');
    expect(disk).not.toContain('password');
  });
});
