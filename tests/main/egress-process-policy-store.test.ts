import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { replaceEgressFileAtomically } from '../../src/main/egress-diagnostics/atomic-store';
import {
  createEgressProcessPolicyHmacSigner,
  EgressProcessPolicyStore,
  EgressProcessPolicyStoreError,
  EgressProcessPolicyUnsupportedVersionError,
} from '../../src/main/egress-diagnostics/process-policy-store';
import {
  applyEgressProcessPolicyEdits,
  defaultEgressProcessPolicy,
  EGRESS_PROCESS_POLICY_MAX_BYTES,
  type EgressProcessPolicy,
} from '../../src/main/egress-diagnostics/process-policy-types';

const roots: string[] = [];
const createFixture = () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'claudedock-egress-policy-'));
  roots.push(parent);
  return { parent, root: path.join(parent, 'egress-diagnostics') };
};

const signer = createEgressProcessPolicyHmacSigner(Buffer.alloc(32, 0xa5));
const policyWith = (
  edits: Parameters<typeof applyEgressProcessPolicyEdits>[1],
  base: EgressProcessPolicy = defaultEgressProcessPolicy(),
): EgressProcessPolicy => applyEgressProcessPolicyEdits(base, edits);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('EgressProcessPolicyStore', () => {
  it('hydrates defaults without creating its root or any policy file', () => {
    const { root } = createFixture();
    const store = new EgressProcessPolicyStore(root, signer);

    expect(store.read().policy).toEqual(defaultEgressProcessPolicy());
    expect(existsSync(root)).toBe(false);
  });

  it('writes schema v1 only at the caller-supplied root', () => {
    const { parent, root } = createFixture();
    const sentinel = path.join(parent, 'outside.txt');
    writeFileSync(sentinel, 'untouched', 'utf8');
    const store = new EgressProcessPolicyStore(root, signer);
    const policy = policyWith({
      applicationLanguages: { operation: 'set', value: ['en-US', 'fr'] },
      timezone: { operation: 'set', value: 'Europe/Paris' },
      webRtc: { operation: 'set', value: 'disable-non-proxied-udp' },
    });

    store.write(policy);

    expect(JSON.parse(readFileSync(path.join(root, 'process-policy.json'), 'utf8'))).toEqual(
      policy,
    );
    expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
    expect(readdirSync(root).sort()).toEqual(['process-policy.json']);
    expect(readdirSync(parent).sort()).toEqual(['egress-diagnostics', 'outside.txt']);
  });

  it('refuses and preserves an unknown future primary version', () => {
    const { root } = createFixture();
    mkdirSync(root, { recursive: true });
    const storagePath = path.join(root, 'process-policy.json');
    const future = '{"version":2,"futurePolicy":"must survive"}\n';
    writeFileSync(storagePath, future, 'utf8');
    const store = new EgressProcessPolicyStore(root, signer);

    expect(() => store.read()).toThrow(EgressProcessPolicyUnsupportedVersionError);
    expect(() => store.write(defaultEgressProcessPolicy())).toThrow(
      EgressProcessPolicyUnsupportedVersionError,
    );
    expect(readFileSync(storagePath, 'utf8')).toBe(future);
  });

  it('preserves an oversized future-like primary when a valid backup permits safe reads', () => {
    const { root } = createFixture();
    const store = new EgressProcessPolicyStore(root, signer);
    const first = policyWith({ timezone: { operation: 'set', value: 'UTC' } });
    const second = policyWith({ timezone: { operation: 'set', value: 'Europe/Paris' } });
    store.write(first);
    store.write(second);
    const storagePath = path.join(root, 'process-policy.json');
    const backupPath = `${storagePath}.bak`;
    const validBackup = readFileSync(backupPath, 'utf8');
    const oversizedFuture = `{"version":2,"futurePolicy":"${'x'.repeat(
      EGRESS_PROCESS_POLICY_MAX_BYTES,
    )}"}\n`;
    writeFileSync(storagePath, oversizedFuture, 'utf8');

    expect(store.read().policy).toEqual(first);
    expect(() => store.write(defaultEgressProcessPolicy())).toThrow(EgressProcessPolicyStoreError);
    expect(readFileSync(storagePath, 'utf8')).toBe(oversizedFuture);
    expect(readFileSync(backupPath, 'utf8')).toBe(validBackup);
  });

  it('uses a valid backup and never copies a corrupt primary over it', () => {
    const { root } = createFixture();
    const store = new EgressProcessPolicyStore(root, signer);
    const first = policyWith({ timezone: { operation: 'set', value: 'UTC' } });
    const second = policyWith({ timezone: { operation: 'set', value: 'Europe/Paris' } });
    const third = policyWith({ timezone: { operation: 'remove' } });
    store.write(first);
    store.write(second);
    const storagePath = path.join(root, 'process-policy.json');
    const backupPath = `${storagePath}.bak`;
    const validBackup = readFileSync(backupPath, 'utf8');

    writeFileSync(storagePath, '{broken', 'utf8');
    expect(new EgressProcessPolicyStore(root, signer).read().policy).toEqual(first);
    store.write(third);

    expect(readFileSync(backupPath, 'utf8')).toBe(validBackup);
    expect(new EgressProcessPolicyStore(root, signer).read().policy).toEqual(third);
    expect(readFileSync(backupPath, 'utf8')).not.toContain('{broken');
  });

  it('refuses malformed or oversized primary content when no valid backup exists', () => {
    const { root } = createFixture();
    mkdirSync(root, { recursive: true });
    const storagePath = path.join(root, 'process-policy.json');
    const store = new EgressProcessPolicyStore(root, signer);

    writeFileSync(storagePath, '{bad json', 'utf8');
    expect(() => store.read()).toThrow(EgressProcessPolicyStoreError);
    expect(() => store.write(defaultEgressProcessPolicy())).toThrow(EgressProcessPolicyStoreError);
    expect(readFileSync(storagePath, 'utf8')).toBe('{bad json');

    writeFileSync(storagePath, 'x'.repeat(EGRESS_PROCESS_POLICY_MAX_BYTES + 1), 'utf8');
    expect(() => store.read()).toThrow(EgressProcessPolicyStoreError);
  });

  it('uses unique exclusive temporary files, fsync, and rename ordering', () => {
    const events: string[] = [];
    const openExclusiveFile = vi.fn((filePath: string) => {
      events.push(`open:${filePath}`);
      return 41;
    });
    const writeFile = vi.fn(() => events.push('write'));
    const flushFile = vi.fn(() => events.push('fsync'));
    const closeFile = vi.fn(() => events.push('close'));
    const renameFile = vi.fn((source: string, destination: string) => {
      events.push(`rename:${source}->${destination}`);
    });
    const destination = 'C:\\safe-root\\process-policy.json';

    replaceEgressFileAtomically(destination, 'policy', {
      closeFile,
      createTemporaryId: () => 'opaque-one',
      flushFile,
      openExclusiveFile,
      renameFile,
      writeFile,
    });

    const temporary = `${destination}.tmp-${process.pid}-opaque-one`;
    expect(openExclusiveFile).toHaveBeenCalledWith(temporary, 0o600);
    expect(events).toEqual([
      `open:${temporary}`,
      'write',
      'fsync',
      'close',
      `rename:${temporary}->${destination}`,
    ]);
  });

  it('bounds Windows rename retries and cleans only its operation-owned temporary file', () => {
    const destination = 'C:\\safe-root\\process-policy.json';
    const temporary = `${destination}.tmp-${process.pid}-owned-temp`;
    const renameFile = vi.fn(() => {
      throw Object.assign(new Error('busy'), { code: 'EPERM' });
    });
    const sleep = vi.fn();
    const unlinkFile = vi.fn();

    expect(() =>
      replaceEgressFileAtomically(destination, 'policy', {
        closeFile: () => undefined,
        createTemporaryId: () => 'owned-temp',
        flushFile: () => undefined,
        openExclusiveFile: () => 42,
        renameFile,
        sleep,
        unlinkFile,
        writeFile: () => undefined,
      }),
    ).toThrow('busy');

    expect(renameFile).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([5, 10, 20, 40, 80]);
    expect(unlinkFile).toHaveBeenCalledOnce();
    expect(unlinkFile).toHaveBeenCalledWith(temporary);
  });

  it('never deletes an exclusive temporary-name collision it did not create', () => {
    const unlinkFile = vi.fn();
    expect(() =>
      replaceEgressFileAtomically('C:\\safe-root\\process-policy.json', 'policy', {
        createTemporaryId: () => 'collision',
        openExclusiveFile: () => {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        },
        unlinkFile,
      }),
    ).toThrow('exists');
    expect(unlinkFile).not.toHaveBeenCalled();
  });

  it('creates keyed opaque revisions that reveal no policy values or paths', () => {
    const { root } = createFixture();
    const store = new EgressProcessPolicyStore(root, signer);
    const policy = policyWith({
      applicationLanguages: { operation: 'set', value: ['de-DE'] },
      timezone: { operation: 'set', value: 'America/New_York' },
    });
    const first = store.revisionFor(policy);
    const second = store.revisionFor(policy);
    const changed = store.revisionFor(
      policyWith({ timezone: { operation: 'set', value: 'Asia/Tokyo' } }),
    );
    const unkeyed = createHash('sha256').update(JSON.stringify(policy)).digest('base64url');

    expect(first).toBe(second);
    expect(first).not.toBe(changed);
    expect(first).toMatch(/^epr1_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain('America');
    expect(first).not.toContain('de-DE');
    expect(first).not.toContain(root);
    expect(first).not.toContain(unkeyed);
    expect(Buffer.from(first.slice(5), 'base64url').toString('utf8')).not.toContain('America');

    store.write(policy);
    expect(store.isCurrent(first)).toBe(true);
    expect(store.isCurrent(changed)).toBe(false);
  });

  it('requires protected signer key material with no plaintext fallback file', () => {
    expect(() => createEgressProcessPolicyHmacSigner(Buffer.alloc(16))).toThrow(/签名/);
    const { root } = createFixture();
    new EgressProcessPolicyStore(root, signer).write(defaultEgressProcessPolicy());
    expect(readdirSync(root)).toEqual(['process-policy.json']);
    expect(readFileSync(path.join(root, 'process-policy.json'), 'utf8')).not.toContain(
      Buffer.alloc(32, 0xa5).toString('hex'),
    );
  });
});
