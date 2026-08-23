import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type {
  EgressCollectionState,
  EgressHistoryEntry,
  EgressLiveReport,
} from '../../src/shared/contracts/egress-diagnostics';
import {
  deriveEvidenceAssessment,
  deriveSourceFreshness,
} from '../../src/main/egress-diagnostics/evidence-policy';
import { createEgressExplanation } from '../../src/main/egress-diagnostics/explanation';

const NOW = Date.UTC(2026, 7, 20, 12);

const assessment = (overrides: Partial<Parameters<typeof deriveEvidenceAssessment>[0]> = {}) =>
  deriveEvidenceAssessment({
    collectionState: 'complete',
    comparisonKeys: ['same', 'same'],
    leaseCurrent: true,
    sourceFreshness: 'recent',
    strictParse: true,
    transport: 'electron-net:application-session',
    ...overrides,
  });

describe('egress evidence policy', () => {
  it('derives non-numeric agreement only from comparable observations', () => {
    expect(assessment().agreement).toBe('corroborated');
    expect(assessment({ comparisonKeys: ['one', 'two'] }).agreement).toBe('mixed');
    expect(assessment({ comparisonKeys: ['one'] }).agreement).toBe('single-source');
    expect(assessment({ comparisonKeys: undefined }).agreement).toBe('not-comparable');
  });

  it('derives freshness from live markers or bounded provider source times', () => {
    expect(deriveSourceFreshness({ liveObservation: true, now: NOW, sourceTimestamps: [] })).toBe(
      'live',
    );
    expect(
      deriveSourceFreshness({ now: NOW, sourceTimestamps: [NOW - 2 * 24 * 60 * 60 * 1_000] }),
    ).toBe('recent');
    expect(
      deriveSourceFreshness({ now: NOW, sourceTimestamps: [NOW - 60 * 24 * 60 * 60 * 1_000] }),
    ).toBe('dated');
    expect(deriveSourceFreshness({ now: NOW, sourceTimestamps: [] })).toBe('unknown');
    expect(
      deriveSourceFreshness({ now: NOW, sourceTimestamps: [NOW + 2 * 24 * 60 * 60 * 1_000] }),
    ).toBe('unknown');
  });

  it('uses strict parsing, lease currentness, completeness, freshness, and corroboration for confidence', () => {
    expect(assessment()).toEqual({
      agreement: 'corroborated',
      confidence: 'high',
      freshness: 'recent',
    });
    expect(assessment({ collectionState: 'partial' }).confidence).toBe('moderate');
    expect(assessment({ comparisonKeys: ['one', 'two'] }).confidence).toBe('limited');
    expect(assessment({ strictParse: false }).confidence).toBe('limited');
    expect(assessment({ sourceFreshness: 'dated' }).confidence).toBe('limited');
    expect(assessment({ leaseCurrent: false })).toMatchObject({
      confidence: 'limited',
      freshness: 'dated',
    });
    expect(assessment({ collectionState: 'unavailable' })).toMatchObject({
      confidence: 'unknown',
      freshness: 'unknown',
    });
  });

  it('supports every collection state without introducing a decision state', () => {
    const states: readonly EgressCollectionState[] = [
      'complete',
      'partial',
      'unavailable',
      'cancelled',
      'collecting',
    ];

    expect(
      states.map(
        (collectionState) => assessment({ collectionState, comparisonKeys: undefined }).confidence,
      ),
    ).toEqual(['moderate', 'limited', 'unknown', 'unknown', 'unknown']);
  });

  it('generates deterministic local explanations from enums rather than remote response text', () => {
    const input = {
      assessment: assessment({ comparisonKeys: ['one', 'two'] }),
      family: 'ipv6' as const,
      issueCode: 'rate-limited' as const,
      provider: 'abuseipdb' as const,
      state: 'unavailable' as const,
    };

    const first = createEgressExplanation(input);
    const second = createEgressExplanation(input);

    expect(first).toEqual(second);
    expect(first.summary).toBe('AbuseIPDB IPv6 evidence is unavailable.');
    expect(first.recommendations.join(' ')).toContain('rate-limit window');
    expect(first.recommendations.join(' ')).toContain('IPv6');
  });

  it('keeps invalid-configuration advice specific to the affected source', () => {
    const unavailable = assessment({ collectionState: 'unavailable' });
    const abuse = createEgressExplanation({
      assessment: unavailable,
      family: 'ipv4',
      issueCode: 'invalid-configuration',
      provider: 'abuseipdb',
      state: 'unavailable',
    });
    const maxmind = createEgressExplanation({
      assessment: unavailable,
      family: 'ipv4',
      issueCode: 'invalid-configuration',
      provider: 'maxmind-anonymous-plus',
      state: 'unavailable',
    });

    expect(abuse.recommendations.join(' ')).toContain('AbuseIPDB lookback and request');
    expect(abuse.recommendations.join(' ')).not.toContain('database');
    expect(maxmind.recommendations.join(' ')).toContain('MaxMind database path');
    expect(maxmind.recommendations.join(' ')).not.toContain('AbuseIPDB');
  });

  it('keeps exact addresses in live shapes and only redacted prefix/fingerprint shapes in history', () => {
    const live: EgressLiveReport = {
      assessment: assessment(),
      collectedAt: NOW,
      explanation: { facts: [], recommendations: [], summary: 'Live advisory facts.' },
      kind: 'live-report',
      sources: [
        {
          address: { address: '203.0.113.50', family: 'ipv4' },
          assessment: assessment({ comparisonKeys: ['203.0.113.50'] }),
          explanation: { facts: [], recommendations: [], summary: 'Live source.' },
          family: 'ipv4',
          kind: 'live-source',
          provenance: {
            collectedAt: NOW,
            endpointId: 'public-address-v4',
            provider: 'ipify',
            sourceTimes: [],
            transport: 'electron-net:application-session',
          },
          state: 'complete',
        },
      ],
      state: 'complete',
    };
    const history: EgressHistoryEntry = {
      addresses: [
        { family: 'ipv4', fingerprint: 'sha256:non-reversible', prefix: '203.0.113.0/24' },
      ],
      collectedAt: NOW,
      kind: 'history',
      providers: [{ assessment: assessment(), provider: 'ipify', state: 'complete' }],
      state: 'complete',
    };

    expect(JSON.stringify(live)).toContain('203.0.113.50');
    expect(JSON.stringify(history)).not.toContain('203.0.113.50');
    expect(history.addresses[0]).toEqual({
      family: 'ipv4',
      fingerprint: 'sha256:non-reversible',
      prefix: '203.0.113.0/24',
    });
  });

  it('serializes no launch, access, preflight, suspension probability, or aggregate score fields', async () => {
    const report = {
      assessment: assessment(),
      issue: { code: 'missing-credential', message: 'Optional source unavailable.' },
      provider: 'ipinfo-max',
      state: 'unavailable',
    };
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(
      /"(?:allowed|eligibility|featureAccess|preflight|riskScore|score)"/i,
    );
    expect(serialized).not.toMatch(/suspensionProbability/i);

    const contractSource = await readFile(
      new URL('../../src/shared/contracts/egress-diagnostics.ts', import.meta.url),
      'utf8',
    );
    expect(contractSource).not.toMatch(/NetworkFeatureAccess|NetworkPreflight|launch eligibility/i);
    expect(contractSource).not.toMatch(/suspensionProbability|riskScore|aggregateScore/i);
  });
});
