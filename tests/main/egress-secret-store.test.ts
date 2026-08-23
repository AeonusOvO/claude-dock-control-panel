import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EGRESS_SECRET_STORE_MAX_BYTES,
  EgressSecretStore,
  EgressSecretStoreError,
  EgressSecretStoreUnsupportedVersionError,
  type EgressSafeStoragePort,
} from '../../src/main/egress-diagnostics/secret-store';

const fixtureRoots: string[] = [];

interface SafeStorageFixture {
  readonly port: EgressSafeStoragePort;
  readonly state: { available: boolean; backend: string; decryptFails: boolean };
}

const xor = (bytes: Uint8Array): Buffer => Buffer.from(bytes.map((value) => value ^ 0xa5));
const protectedBlob = (value: string): string => xor(Buffer.from(value, 'utf8')).toString('base64');

const createSafeStorage = (): SafeStorageFixture => {
  const state = { available: true, backend: 'gnome_libsecret', decryptFails: false };
  return {
    port: {
      decryptString: vi.fn((encrypted: Buffer) => {
        if (state.decryptFails) throw new Error('protected storage failed');
        return xor(encrypted).toString('utf8');
      }),
      encryptString: vi.fn((plainText: string) => xor(Buffer.from(plainText, 'utf8'))),
      getSelectedStorageBackend: vi.fn(() => state.backend),
      isEncryptionAvailable: vi.fn(() => state.available),
    },
    state,
  };
};

const createFixture = () => {
  const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-egress-secrets-'));
  fixtureRoots.push(userDataPath);
  const safeStorage = createSafeStorage();
  return {
    safeStorage,
    storagePath: path.join(userDataPath, 'egress-diagnostics', 'secrets.json'),
    store: new EgressSecretStore(userDataPath, safeStorage.port, {
      randomBytes: () => Buffer.alloc(32, 0x5a),
    }),
    userDataPath,
  };
};

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('EgressSecretStore', () => {
  it('does not create storage until an explicit credential or HMAC-key request', () => {
    const { storagePath, store } = createFixture();

    expect(store.readCredential('ipinfo-max-token')).toBeUndefined();
    expect(store.readCredential('abuseipdb-key')).toBeUndefined();
    expect(store.readHmacKey()).toBeUndefined();
    expect(existsSync(storagePath)).toBe(false);
  });

  it('round-trips only typed encrypted credentials and clears them independently', () => {
    const { safeStorage, storagePath, store, userDataPath } = createFixture();
    const ipinfoToken = 'ipinfo-Max-secret-value';
    const abuseKey = 'AbuseIPDB-secret-value';

    store.setCredential('ipinfo-max-token', ipinfoToken);
    store.setCredential('abuseipdb-key', abuseKey);

    const serialized = readFileSync(storagePath, 'utf8');
    expect(serialized).not.toContain(ipinfoToken);
    expect(serialized).not.toContain(abuseKey);
    expect(JSON.parse(serialized)).toMatchObject({ version: 1 });
    expect(
      new EgressSecretStore(userDataPath, safeStorage.port).readCredential('ipinfo-max-token'),
    ).toBe(ipinfoToken);
    expect(store.readCredential('abuseipdb-key')).toBe(abuseKey);

    store.clearCredential('ipinfo-max-token');
    expect(store.readCredential('ipinfo-max-token')).toBeUndefined();
    expect(store.readCredential('abuseipdb-key')).toBe(abuseKey);
    expect(readFileSync(storagePath, 'utf8')).not.toContain(ipinfoToken);
  });

  it('creates one stable installation HMAC key lazily and returns fresh copies', () => {
    const { safeStorage, storagePath, store, userDataPath } = createFixture();
    store.setCredential('ipinfo-max-token', 'credential-before-key');
    const before = readFileSync(storagePath, 'utf8');
    expect(JSON.parse(before)).not.toHaveProperty('hmacKey');

    const first = store.getOrCreateHmacKey();
    const second = store.getOrCreateHmacKey();
    first[0] = 0xff;
    const third = new EgressSecretStore(userDataPath, safeStorage.port).getOrCreateHmacKey();

    expect([...second]).toEqual([...Buffer.alloc(32, 0x5a)]);
    expect([...third]).toEqual([...Buffer.alloc(32, 0x5a)]);
    expect(first).not.toBe(second);
    const serialized = readFileSync(storagePath, 'utf8');
    expect(serialized).not.toContain(Buffer.alloc(32, 0x5a).toString('base64url'));
    expect(serialized).not.toContain('credential-before-key');
  });

  it('avoids rewriting an unchanged credential', () => {
    const { safeStorage, storagePath, store } = createFixture();
    store.setCredential('ipinfo-max-token', 'same-token');
    const before = readFileSync(storagePath, 'utf8');
    const encrypt = vi.mocked(safeStorage.port.encryptString);
    const callsBefore = encrypt.mock.calls.length;

    store.setCredential('ipinfo-max-token', 'same-token');

    expect(readFileSync(storagePath, 'utf8')).toBe(before);
    expect(encrypt).toHaveBeenCalledTimes(callsBefore);
  });

  it('never falls back to plaintext when operating-system encryption is unavailable', () => {
    const { safeStorage, storagePath, store } = createFixture();
    const secret = 'must-remain-protected';
    store.setCredential('abuseipdb-key', secret);
    const before = readFileSync(storagePath, 'utf8');
    safeStorage.state.available = false;

    expect(store.readCredential('abuseipdb-key')).toBeUndefined();
    expect(store.readHmacKey()).toBeUndefined();
    expect(() => store.setCredential('abuseipdb-key', 'replacement')).toThrow(
      EgressSecretStoreError,
    );
    expect(() => store.clearCredential('abuseipdb-key')).toThrow(EgressSecretStoreError);
    expect(() => store.getOrCreateHmacKey()).toThrow(EgressSecretStoreError);
    expect(readFileSync(storagePath, 'utf8')).toBe(before);
    expect(before).not.toContain(secret);
  });

  it('fails closed on Linux basic_text while preserving existing protected bytes', () => {
    const { safeStorage, storagePath, store, userDataPath } = createFixture();
    store.setCredential('ipinfo-max-token', 'linux-protected-token');
    store.getOrCreateHmacKey();
    const before = readFileSync(storagePath, 'utf8');
    safeStorage.state.backend = 'basic_text';
    const linuxStore = new EgressSecretStore(userDataPath, safeStorage.port, {
      platform: 'linux',
      randomBytes: () => Buffer.alloc(32, 0x44),
    });

    expect(linuxStore.readCredential('ipinfo-max-token')).toBeUndefined();
    expect(linuxStore.readHmacKey()).toBeUndefined();
    expect(() => linuxStore.setCredential('ipinfo-max-token', 'replacement')).toThrow(
      EgressSecretStoreError,
    );
    expect(() => linuxStore.clearCredential('ipinfo-max-token')).toThrow(EgressSecretStoreError);
    expect(() => linuxStore.getOrCreateHmacKey()).toThrow(EgressSecretStoreError);
    expect(readFileSync(storagePath, 'utf8')).toBe(before);
    expect(before).not.toContain('linux-protected-token');
  });

  it('does not apply the Linux backend guard on Windows', () => {
    const { safeStorage, storagePath, userDataPath } = createFixture();
    safeStorage.state.backend = 'basic_text';
    const windowsStore = new EgressSecretStore(userDataPath, safeStorage.port, {
      platform: 'win32',
      randomBytes: () => Buffer.alloc(32, 0x45),
    });

    windowsStore.setCredential('abuseipdb-key', 'windows-protected-key');
    expect(windowsStore.readCredential('abuseipdb-key')).toBe('windows-protected-key');
    expect([...windowsStore.getOrCreateHmacKey()]).toEqual([...Buffer.alloc(32, 0x45)]);
    expect(vi.mocked(safeStorage.port.getSelectedStorageBackend!)).not.toHaveBeenCalled();
    expect(readFileSync(storagePath, 'utf8')).not.toContain('windows-protected-key');
  });

  it('makes all secrets unavailable and preserves bytes after decryption failure or corruption', () => {
    const { safeStorage, storagePath, store } = createFixture();
    store.setCredential('ipinfo-max-token', 'first-secret');
    store.setCredential('abuseipdb-key', 'second-secret');
    store.getOrCreateHmacKey();
    const before = readFileSync(storagePath, 'utf8');
    safeStorage.state.decryptFails = true;

    expect(store.readCredential('ipinfo-max-token')).toBeUndefined();
    expect(store.readCredential('abuseipdb-key')).toBeUndefined();
    expect(store.readHmacKey()).toBeUndefined();
    expect(() => store.setCredential('ipinfo-max-token', 'new-value')).toThrow(
      EgressSecretStoreError,
    );
    expect(readFileSync(storagePath, 'utf8')).toBe(before);

    safeStorage.state.decryptFails = false;
    writeFileSync(storagePath, '{"version":1,"credentials":{"unexpected":"blob"}}\n', 'utf8');
    const corrupt = readFileSync(storagePath, 'utf8');
    expect(store.readCredential('ipinfo-max-token')).toBeUndefined();
    expect(() => store.getOrCreateHmacKey()).toThrow(EgressSecretStoreError);
    expect(readFileSync(storagePath, 'utf8')).toBe(corrupt);
  });

  it('rejects every ambiguous duplicate root version ordering and preserves exact bytes', () => {
    const variants = [
      '{"version":99,"version":1,"credentials":{}}\r\n',
      '{"version":1,"version":99,"credentials":{}}\n',
      '{"version":99,"\\u0076ersion":1,"credentials":{}}\r\n',
    ];
    for (const raw of variants) {
      const { storagePath, store } = createFixture();
      mkdirSync(path.dirname(storagePath), { recursive: true });
      writeFileSync(storagePath, raw, 'utf8');

      expect(store.readCredential('ipinfo-max-token')).toBeUndefined();
      expect(store.readHmacKey()).toBeUndefined();
      expect(() => store.setCredential('ipinfo-max-token', 'replacement-secret')).toThrow(
        EgressSecretStoreError,
      );
      expect(() => store.clearCredential('abuseipdb-key')).toThrow(EgressSecretStoreError);
      expect(() => store.getOrCreateHmacKey()).toThrow(EgressSecretStoreError);
      expect(readFileSync(storagePath, 'utf8')).toBe(raw);
    }
  });

  it('rejects escaped-equivalent nested credential keys without decrypting or rewriting', () => {
    const { safeStorage, storagePath, store } = createFixture();
    mkdirSync(path.dirname(storagePath), { recursive: true });
    const hidden = protectedBlob('hidden-duplicate-token');
    const retained = protectedBlob('retained-duplicate-token');
    const duplicate =
      `{"credentials":{"ipinfoMaxToken":"${hidden}",` +
      `"\\u0069pinfoMaxToken":"${retained}"},"version":1}\r\n`;
    writeFileSync(storagePath, duplicate, 'utf8');

    expect(store.readCredential('ipinfo-max-token')).toBeUndefined();
    expect(vi.mocked(safeStorage.port.decryptString)).not.toHaveBeenCalled();
    let error: unknown;
    try {
      store.setCredential('ipinfo-max-token', 'replacement-token');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EgressSecretStoreError);
    expect(String(error)).not.toContain('hidden-duplicate-token');
    expect(String(error)).not.toContain('retained-duplicate-token');
    expect(() => store.clearCredential('ipinfo-max-token')).toThrow(EgressSecretStoreError);
    expect(readFileSync(storagePath, 'utf8')).toBe(duplicate);
  });

  it('recognizes a deeply nested unique future version and never falls back to a v1 backup', () => {
    const { safeStorage, storagePath, store, userDataPath } = createFixture();
    store.setCredential('ipinfo-max-token', 'v1-backup-token');
    store.getOrCreateHmacKey();
    const backupPath = `${storagePath}.bak`;
    const backup = readFileSync(storagePath, 'utf8');
    writeFileSync(backupPath, backup, 'utf8');
    let futurePayload: unknown = { leaf: 'future-protected-field' };
    for (let depth = 0; depth < 128; depth += 1) futurePayload = { nested: futurePayload };
    const future = `${JSON.stringify({ futurePayload, version: 99 })}\r\n`;
    writeFileSync(storagePath, future, 'utf8');
    const futureStore = new EgressSecretStore(userDataPath, safeStorage.port, {
      platform: 'linux',
      randomBytes: () => Buffer.alloc(32, 0x77),
    });

    expect(futureStore.readCredential('ipinfo-max-token')).toBeUndefined();
    expect(futureStore.readCredential('abuseipdb-key')).toBeUndefined();
    expect(futureStore.readHmacKey()).toBeUndefined();
    expect(() => futureStore.setCredential('ipinfo-max-token', 'replacement')).toThrow(
      EgressSecretStoreUnsupportedVersionError,
    );
    expect(() => futureStore.clearCredential('ipinfo-max-token')).toThrow(
      EgressSecretStoreUnsupportedVersionError,
    );
    expect(() => futureStore.getOrCreateHmacKey()).toThrow(
      EgressSecretStoreUnsupportedVersionError,
    );
    expect(readFileSync(storagePath, 'utf8')).toBe(future);
    expect(readFileSync(backupPath, 'utf8')).toBe(backup);
  });

  it('preserves unknown future versions byte-for-byte and blocks every write API', () => {
    const { storagePath, store } = createFixture();
    mkdirSync(path.dirname(storagePath), { recursive: true });
    const future = '{"version":99,"futureProtectedFields":"preserve exactly"}\r\n';
    writeFileSync(storagePath, future, 'utf8');

    expect(store.readCredential('ipinfo-max-token')).toBeUndefined();
    expect(store.readHmacKey()).toBeUndefined();
    expect(() => store.setCredential('ipinfo-max-token', 'token')).toThrow(
      EgressSecretStoreUnsupportedVersionError,
    );
    expect(() => store.clearCredential('abuseipdb-key')).toThrow(
      EgressSecretStoreUnsupportedVersionError,
    );
    expect(() => store.getOrCreateHmacKey()).toThrow(EgressSecretStoreUnsupportedVersionError);
    expect(readFileSync(storagePath, 'utf8')).toBe(future);
  });

  it('bounds files and credential strings without reflecting secret input in errors', () => {
    const { storagePath, store } = createFixture();
    const invalid = `secret-with-control\n${'x'.repeat(30)}`;
    let error: unknown;
    try {
      store.setCredential('ipinfo-max-token', invalid);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EgressSecretStoreError);
    expect(String(error)).not.toContain(invalid);
    expect(existsSync(storagePath)).toBe(false);

    mkdirSync(path.dirname(storagePath), { recursive: true });
    writeFileSync(storagePath, 'x'.repeat(EGRESS_SECRET_STORE_MAX_BYTES + 1), 'utf8');
    const before = readFileSync(storagePath, 'utf8');
    expect(store.readCredential('abuseipdb-key')).toBeUndefined();
    expect(() => store.setCredential('abuseipdb-key', 'bounded-key')).toThrow(
      EgressSecretStoreError,
    );
    expect(readFileSync(storagePath, 'utf8')).toBe(before);
  });
});
