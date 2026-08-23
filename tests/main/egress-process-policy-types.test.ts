import { describe, expect, it } from 'vitest';
import {
  applyEgressProcessPolicyEdits,
  buildEgressProcessEnvironmentPlan,
  defaultEgressProcessPolicy,
  EGRESS_PROCESS_POLICY_MAX_LANGUAGES,
  EGRESS_REPAIR_ACTIVATIONS,
  EGRESS_WEB_RTC_HANDLING_VALUES,
  egressRepairActivationsForField,
  normalizeEgressProcessLanguages,
  normalizeEgressProcessPolicy,
  normalizeEgressProcessPolicyEdits,
  normalizeEgressProcessTimezone,
} from '../../src/main/egress-diagnostics/process-policy-types';

describe('egress process policy schema', () => {
  it('validates IANA timezones without changing TZ or the process locale', () => {
    const beforeTimezone = process.env.TZ;
    const beforeLocale = Intl.DateTimeFormat().resolvedOptions().locale;

    expect(normalizeEgressProcessTimezone('Europe/Paris')).toBe('Europe/Paris');
    expect(() => normalizeEgressProcessTimezone('Not/A_Timezone')).toThrow(/IANA/);

    expect(process.env.TZ).toBe(beforeTimezone);
    expect(Intl.DateTimeFormat().resolvedOptions().locale).toBe(beforeLocale);
  });

  it('canonicalizes ordered BCP-47 languages without changing global locale state', () => {
    const beforeLocale = Intl.DateTimeFormat().resolvedOptions().locale;

    expect(normalizeEgressProcessLanguages(['EN-us', 'zh-hans-cn', 'fr'])).toEqual([
      'en-US',
      'zh-Hans-CN',
      'fr',
    ]);
    expect(Intl.DateTimeFormat().resolvedOptions().locale).toBe(beforeLocale);
  });

  it('enforces language count, validity, uniqueness, and byte bounds', () => {
    expect(() => normalizeEgressProcessLanguages([])).toThrow(/数量/);
    expect(() =>
      normalizeEgressProcessLanguages(
        Array.from({ length: EGRESS_PROCESS_POLICY_MAX_LANGUAGES + 1 }, (_, index) => `x-${index}`),
      ),
    ).toThrow(/数量/);
    expect(() => normalizeEgressProcessLanguages(['en-US', 'EN-us'])).toThrow(/重复/);
    expect(() => normalizeEgressProcessLanguages(['not_a_locale'])).toThrow(/BCP-47/);
    expect(() => normalizeEgressProcessLanguages([`en-${'a'.repeat(200)}`])).toThrow();
  });

  it('uses strict exact schema keys and explicit WebRTC product values', () => {
    const valid = defaultEgressProcessPolicy();
    expect(normalizeEgressProcessPolicy(valid)).toEqual(valid);
    expect(EGRESS_WEB_RTC_HANDLING_VALUES).toEqual([
      'platform-default',
      'public-interface-only',
      'disable-non-proxied-udp',
    ]);
    expect(() => normalizeEgressProcessPolicy({ ...valid, environment: {} })).toThrow(/格式/);
    expect(() => normalizeEgressProcessPolicy({ ...valid, version: 2 })).toThrow(/版本/);
    expect(() =>
      normalizeEgressProcessPolicy({
        ...valid,
        webRtc: { mode: 'set', value: 'disable-all-udp' },
      }),
    ).toThrow(/WebRTC/);
  });

  it('retains inherit separately from explicit removal in a closed environment plan', () => {
    const policy = applyEgressProcessPolicyEdits(defaultEgressProcessPolicy(), {
      applicationLanguages: { operation: 'set', value: ['EN-us', 'ja-jp'] },
      requestLanguages: { operation: 'remove' },
      timezone: { operation: 'inherit' },
    });
    const environment = buildEgressProcessEnvironmentPlan(policy);

    expect(environment).toEqual({
      applicationLanguages: {
        input: 'CLAUDEDOCK_APPLICATION_LANGUAGES',
        mode: 'set',
        value: ['en-US', 'ja-JP'],
      },
      requestLanguages: { input: 'CLAUDEDOCK_REQUEST_LANGUAGES', mode: 'remove' },
      timezone: { input: 'TZ', mode: 'inherit' },
    });
    expect(Object.keys(environment).sort()).toEqual([
      'applicationLanguages',
      'requestLanguages',
      'timezone',
    ]);
    expect(JSON.stringify(environment)).not.toContain('PATH');
    expect(JSON.stringify(environment)).not.toContain('HTTP_PROXY');
  });

  it('rejects generic environment maps, file paths, switches, and unknown edit keys', () => {
    for (const edits of [
      { environment: { TZ: 'UTC' } },
      { filePath: 'C:\\outside.json' },
      { switches: ['--lang=en-US'] },
      { writeList: [{ path: 'anything', value: 'anything' }] },
      { timezone: { operation: 'set', value: 'UTC', extra: true } },
      { webRtc: { operation: 'remove' } },
    ]) {
      expect(() => normalizeEgressProcessPolicyEdits(edits)).toThrow();
    }
  });

  it('assigns explicit activation semantics to each policy field', () => {
    expect(EGRESS_REPAIR_ACTIVATIONS).toEqual([
      'future-process-starts',
      'application-restart',
      'future-web-contents',
      'diagnostic-window-only',
    ]);
    expect(egressRepairActivationsForField('timezone')).toEqual(['future-process-starts']);
    expect(egressRepairActivationsForField('request-languages')).toEqual([
      'diagnostic-window-only',
    ]);
    expect(egressRepairActivationsForField('application-languages')).toEqual([
      'application-restart',
      'future-process-starts',
    ]);
    expect(egressRepairActivationsForField('web-rtc')).toEqual(['future-web-contents']);
  });
});
