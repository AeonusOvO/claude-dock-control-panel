import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEgressProcessPolicyHmacSigner,
  EgressProcessPolicyStore,
} from '../../src/main/egress-diagnostics/process-policy-store';
import {
  defaultEgressProcessPolicy,
  type EgressProcessPolicyEdits,
} from '../../src/main/egress-diagnostics/process-policy-types';
import { EgressRepairPlanner } from '../../src/main/egress-diagnostics/repair-planner';

const parents: string[] = [];
const createHarness = () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'claudedock-egress-plan-'));
  parents.push(parent);
  const root = path.join(parent, 'egress-diagnostics');
  const store = new EgressProcessPolicyStore(
    root,
    createEgressProcessPolicyHmacSigner(Buffer.alloc(32, 0x51)),
  );
  return { parent, planner: new EgressRepairPlanner(store), root, store };
};

afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { force: true, recursive: true });
});

describe('EgressRepairPlanner dry run', () => {
  it('computes exact before/after, changes, activations, and opaque revisions', () => {
    const { planner } = createHarness();
    const plan = planner.plan({
      applicationLanguages: { operation: 'set', value: ['EN-us', 'fr-fr'] },
      requestLanguages: { operation: 'remove' },
      timezone: { operation: 'set', value: 'Asia/Tokyo' },
      webRtc: { operation: 'set', value: 'public-interface-only' },
    });

    expect(plan.before).toEqual(defaultEgressProcessPolicy());
    expect(plan.after).toEqual({
      applicationLanguages: { mode: 'set', value: ['en-US', 'fr-FR'] },
      requestLanguages: { mode: 'remove' },
      timezone: { mode: 'set', value: 'Asia/Tokyo' },
      version: 1,
      webRtc: { mode: 'set', value: 'public-interface-only' },
    });
    expect(plan.changes.map((change) => change.field)).toEqual([
      'timezone',
      'request-languages',
      'application-languages',
      'web-rtc',
    ]);
    expect(plan.changes.map((change) => change.activationRequirements)).toEqual([
      ['future-process-starts'],
      ['diagnostic-window-only'],
      ['application-restart', 'future-process-starts'],
      ['future-web-contents'],
    ]);
    expect(plan.activationRequirements).toEqual([
      'future-process-starts',
      'application-restart',
      'future-web-contents',
      'diagnostic-window-only',
    ]);
    expect(plan.expectedRevision).toMatch(/^epr1_/);
    expect(plan.resultingRevision).toMatch(/^epr1_/);
    expect(plan.resultingRevision).not.toBe(plan.expectedRevision);
  });

  it('performs zero writes, journal changes, process mutation, or service invocation', () => {
    const { root, store } = createHarness();
    const write = vi.spyOn(store, 'write');
    const service = vi.fn();
    const beforeTimezone = process.env.TZ;
    const beforeLanguages = process.env.CLAUDEDOCK_APPLICATION_LANGUAGES;

    const plan = new EgressRepairPlanner(store).plan({
      timezone: { operation: 'set', value: 'Europe/Berlin' },
    });

    expect(plan.changes).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
    expect(process.env.TZ).toBe(beforeTimezone);
    expect(process.env.CLAUDEDOCK_APPLICATION_LANGUAGES).toBe(beforeLanguages);
    expect(existsSync(root)).toBe(false);
  });

  it('returns an exact no-op plan without inventing a transaction or activation', () => {
    const { planner } = createHarness();
    const plan = planner.plan({});

    expect(plan.before).toEqual(plan.after);
    expect(plan.expectedRevision).toBe(plan.resultingRevision);
    expect(plan.changes).toEqual([]);
    expect(plan.activationRequirements).toEqual([]);
  });

  it('emits only the three closed future-process inputs', () => {
    const { planner } = createHarness();
    const plan = planner.plan({
      applicationLanguages: { operation: 'set', value: ['de-DE'] },
      requestLanguages: { operation: 'inherit' },
      timezone: { operation: 'remove' },
    });

    expect(plan.processEnvironment).toEqual({
      applicationLanguages: {
        input: 'CLAUDEDOCK_APPLICATION_LANGUAGES',
        mode: 'set',
        value: ['de-DE'],
      },
      requestLanguages: { input: 'CLAUDEDOCK_REQUEST_LANGUAGES', mode: 'inherit' },
      timezone: { input: 'TZ', mode: 'remove' },
    });
    const serialized = JSON.stringify(plan);
    for (const forbidden of [
      'publicIp',
      'HTTP_PROXY',
      'registry',
      'firewall',
      'adapter',
      'electronSwitch',
      'filePath',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('rejects renderer-shaped write lists, paths, arbitrary env keys, and switches', () => {
    const { planner } = createHarness();
    for (const edits of [
      { writeList: [] },
      { filePath: 'C:\\outside.json' },
      { environment: { API_TOKEN: 'secret' } },
      { electronSwitch: '--proxy-server=x' },
      { timezone: { operation: 'set', value: 'UTC', key: 'TZ' } },
    ]) {
      expect(() => planner.plan(edits as unknown as EgressProcessPolicyEdits)).toThrow();
    }
  });
});
