import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  type EgressAtomicFileOperations,
  isMissingFileError,
  readEgressBoundedUtf8File,
  replaceEgressFileAtomically,
} from './atomic-store';

export const EGRESS_SECRET_STORE_SCHEMA_VERSION = 1 as const;
export const EGRESS_SECRET_STORE_MAX_BYTES = 64 * 1024;
export const EGRESS_SECRET_CREDENTIAL_TYPES = ['ipinfo-max-token', 'abuseipdb-key'] as const;

export type EgressSecretCredentialType = (typeof EGRESS_SECRET_CREDENTIAL_TYPES)[number];

export interface EgressSafeStoragePort {
  decryptString(encrypted: Buffer): string;
  encryptString(plainText: string): Buffer;
  getSelectedStorageBackend?(): string;
  isEncryptionAvailable(): boolean;
}

export interface EgressSecretStoreOptions {
  readonly atomicOperations?: Partial<EgressAtomicFileOperations>;
  readonly platform?: NodeJS.Platform;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export class EgressSecretStoreError extends Error {
  public constructor(message = 'ClaudeDock cannot safely access the local egress secret store.') {
    super(message);
    this.name = 'EgressSecretStoreError';
  }
}

export class EgressSecretStoreUnsupportedVersionError extends EgressSecretStoreError {
  public constructor() {
    super('The local egress secret store was created by a newer ClaudeDock version.');
    this.name = 'EgressSecretStoreUnsupportedVersionError';
  }
}

interface StoredCredentials {
  readonly abuseIpDbKey?: string;
  readonly ipinfoMaxToken?: string;
}

interface StoredSecretFile {
  readonly credentials: StoredCredentials;
  readonly hmacKey?: string;
  readonly version: typeof EGRESS_SECRET_STORE_SCHEMA_VERSION;
}

interface MissingCandidate {
  readonly kind: 'missing';
}

interface InvalidCandidate {
  readonly kind: 'invalid';
}

interface FutureCandidate {
  readonly kind: 'future';
}

interface ValidCandidate {
  readonly kind: 'valid';
  readonly value: StoredSecretFile;
}

type StoredCandidate = MissingCandidate | InvalidCandidate | FutureCandidate | ValidCandidate;

type StoredCredentialField = keyof StoredCredentials;

const CREDENTIAL_FIELDS: Readonly<Record<EgressSecretCredentialType, StoredCredentialField>> = {
  'abuseipdb-key': 'abuseIpDbKey',
  'ipinfo-max-token': 'ipinfoMaxToken',
};
const HMAC_KEY_BYTES = 32;
const HMAC_PLAINTEXT_LENGTH = 43;
const MAX_CREDENTIAL_BYTES = 4 * 1024;
const MAX_ENCRYPTED_BLOB_BYTES = 16 * 1024;
const STORAGE_FILE_NAME = 'secrets.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
};

interface SecretJsonCursor {
  index: number;
}

type SecretJsonObjectState = 'colon' | 'comma-or-end' | 'key-or-end' | 'value';
type SecretJsonArrayState = 'comma-or-end' | 'value-or-end';

type SecretJsonFrame =
  | { readonly keys: Set<string>; readonly kind: 'object'; state: SecretJsonObjectState }
  | { readonly kind: 'array'; state: SecretJsonArrayState };

const SECRET_JSON_WHITESPACE = new Set([' ', '\t', '\r', '\n']);

const skipSecretJsonWhitespace = (raw: string, cursor: SecretJsonCursor): void => {
  while (SECRET_JSON_WHITESPACE.has(raw[cursor.index] ?? '')) cursor.index += 1;
};

const scanSecretJsonString = (
  raw: string,
  cursor: SecretJsonCursor,
  decode: boolean,
): string | undefined => {
  const start = cursor.index;
  cursor.index += 1;
  let escaped = false;
  while (cursor.index < raw.length) {
    const character = raw[cursor.index]!;
    cursor.index += 1;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      if (!decode) return undefined;
      const value: unknown = JSON.parse(raw.slice(start, cursor.index));
      if (typeof value !== 'string') throw new EgressSecretStoreError();
      return value;
    }
  }
  throw new EgressSecretStoreError();
};

const scanSecretJsonPrimitive = (raw: string, cursor: SecretJsonCursor): void => {
  const start = cursor.index;
  while (cursor.index < raw.length) {
    const character = raw[cursor.index]!;
    if (
      SECRET_JSON_WHITESPACE.has(character) ||
      character === ',' ||
      character === ']' ||
      character === '}'
    ) {
      break;
    }
    cursor.index += 1;
  }
  if (cursor.index === start) throw new EgressSecretStoreError();
};

const startSecretJsonValue = (
  raw: string,
  cursor: SecretJsonCursor,
  frames: SecretJsonFrame[],
): void => {
  skipSecretJsonWhitespace(raw, cursor);
  const character = raw[cursor.index];
  if (character === '{') {
    cursor.index += 1;
    frames.push({ keys: new Set(), kind: 'object', state: 'key-or-end' });
  } else if (character === '[') {
    cursor.index += 1;
    frames.push({ kind: 'array', state: 'value-or-end' });
  } else if (character === '"') {
    scanSecretJsonString(raw, cursor, false);
  } else {
    scanSecretJsonPrimitive(raw, cursor);
  }
};

const scanSecretJsonObject = (
  raw: string,
  cursor: SecretJsonCursor,
  frames: SecretJsonFrame[],
  frame: Extract<SecretJsonFrame, { kind: 'object' }>,
): void => {
  skipSecretJsonWhitespace(raw, cursor);
  if (frame.state === 'key-or-end') {
    if (raw[cursor.index] === '}') {
      cursor.index += 1;
      frames.pop();
      return;
    }
    if (raw[cursor.index] !== '"') throw new EgressSecretStoreError();
    const key = scanSecretJsonString(raw, cursor, true)!;
    if (frame.keys.has(key)) throw new EgressSecretStoreError();
    frame.keys.add(key);
    frame.state = 'colon';
    return;
  }
  if (frame.state === 'colon') {
    if (raw[cursor.index] !== ':') throw new EgressSecretStoreError();
    cursor.index += 1;
    frame.state = 'value';
    return;
  }
  if (frame.state === 'value') {
    frame.state = 'comma-or-end';
    startSecretJsonValue(raw, cursor, frames);
    return;
  }
  const delimiter = raw[cursor.index];
  cursor.index += 1;
  if (delimiter === '}') {
    frames.pop();
  } else if (delimiter === ',') {
    frame.state = 'key-or-end';
  } else {
    throw new EgressSecretStoreError();
  }
};

const scanSecretJsonArray = (
  raw: string,
  cursor: SecretJsonCursor,
  frames: SecretJsonFrame[],
  frame: Extract<SecretJsonFrame, { kind: 'array' }>,
): void => {
  skipSecretJsonWhitespace(raw, cursor);
  if (frame.state === 'value-or-end') {
    if (raw[cursor.index] === ']') {
      cursor.index += 1;
      frames.pop();
      return;
    }
    frame.state = 'comma-or-end';
    startSecretJsonValue(raw, cursor, frames);
    return;
  }
  const delimiter = raw[cursor.index];
  cursor.index += 1;
  if (delimiter === ']') {
    frames.pop();
  } else if (delimiter === ',') {
    frame.state = 'value-or-end';
  } else {
    throw new EgressSecretStoreError();
  }
};

/** Iterative and bounded by the already-capped raw file size, including nesting and key count. */
const assertNoDuplicateSecretJsonKeys = (raw: string): void => {
  const cursor = { index: 0 };
  const frames: SecretJsonFrame[] = [];
  let rootPending = true;
  for (;;) {
    if (frames.length === 0) {
      if (rootPending) {
        rootPending = false;
        startSecretJsonValue(raw, cursor, frames);
        continue;
      }
      skipSecretJsonWhitespace(raw, cursor);
      if (cursor.index === raw.length) return;
      throw new EgressSecretStoreError();
    }
    const frame = frames.at(-1)!;
    if (frame.kind === 'object') {
      scanSecretJsonObject(raw, cursor, frames, frame);
    } else {
      scanSecretJsonArray(raw, cursor, frames, frame);
    }
  }
};

const encryptedBlobIsValid = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 24 * 1024) return false;
  try {
    const decoded = Buffer.from(value, 'base64');
    return (
      decoded.byteLength > 0 &&
      decoded.byteLength <= MAX_ENCRYPTED_BLOB_BYTES &&
      decoded.toString('base64') === value
    );
  } catch {
    return false;
  }
};

const credentialsAreValid = (value: unknown): value is StoredCredentials => {
  if (!isRecord(value)) return false;
  const allowed = ['abuseIpDbKey', 'ipinfoMaxToken'] as const;
  if (Object.keys(value).some((key) => !allowed.includes(key as (typeof allowed)[number]))) {
    return false;
  }
  return (
    (value.abuseIpDbKey === undefined || encryptedBlobIsValid(value.abuseIpDbKey)) &&
    (value.ipinfoMaxToken === undefined || encryptedBlobIsValid(value.ipinfoMaxToken))
  );
};

const inspectSecretFile = (raw: string): StoredCandidate => {
  try {
    const value: unknown = JSON.parse(raw);
    assertNoDuplicateSecretJsonKeys(raw);
    if (
      isRecord(value) &&
      typeof value.version === 'number' &&
      Number.isSafeInteger(value.version) &&
      value.version > EGRESS_SECRET_STORE_SCHEMA_VERSION
    ) {
      return { kind: 'future' };
    }
    if (!isRecord(value)) return { kind: 'invalid' };
    const expected =
      value.hmacKey === undefined
        ? ['credentials', 'version']
        : ['credentials', 'hmacKey', 'version'];
    if (
      !hasExactKeys(value, expected) ||
      value.version !== EGRESS_SECRET_STORE_SCHEMA_VERSION ||
      !credentialsAreValid(value.credentials) ||
      (value.hmacKey !== undefined && !encryptedBlobIsValid(value.hmacKey))
    ) {
      return { kind: 'invalid' };
    }
    return {
      kind: 'valid',
      value: {
        credentials: {
          ...(value.credentials.abuseIpDbKey
            ? { abuseIpDbKey: value.credentials.abuseIpDbKey }
            : {}),
          ...(value.credentials.ipinfoMaxToken
            ? { ipinfoMaxToken: value.credentials.ipinfoMaxToken }
            : {}),
        },
        ...(typeof value.hmacKey === 'string' ? { hmacKey: value.hmacKey } : {}),
        version: EGRESS_SECRET_STORE_SCHEMA_VERSION,
      },
    };
  } catch {
    return { kind: 'invalid' };
  }
};

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });

const credentialIsValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= MAX_CREDENTIAL_BYTES &&
  !/\s/u.test(value) &&
  !hasControlCharacter(value);
const decodeHmacKey = (value: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value) || value.length !== HMAC_PLAINTEXT_LENGTH)
    return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === HMAC_KEY_BYTES ? Uint8Array.from(decoded) : undefined;
};

const pathIsContainedBy = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const cloneStoredFile = (value: StoredSecretFile): StoredSecretFile => ({
  credentials: { ...value.credentials },
  ...(value.hmacKey ? { hmacKey: value.hmacKey } : {}),
  version: EGRESS_SECRET_STORE_SCHEMA_VERSION,
});

/** Main-process-only safeStorage-backed credentials and installation key. */
export class EgressSecretStore {
  private readonly atomicOperations: Partial<EgressAtomicFileOperations>;
  private readonly platform: NodeJS.Platform;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly storageDirectory: string;
  private readonly userDataPath: string;

  public constructor(
    userDataPath: string,
    private readonly safeStorage: EgressSafeStoragePort,
    options: EgressSecretStoreOptions = {},
  ) {
    if (!path.isAbsolute(userDataPath)) throw new EgressSecretStoreError();
    this.userDataPath = path.resolve(userDataPath);
    this.storageDirectory = path.join(this.userDataPath, 'egress-diagnostics');
    this.atomicOperations = options.atomicOperations ?? {};
    this.platform = options.platform ?? process.platform;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
  }

  /** Returns one immutable string value, or undefined when protected storage cannot be trusted. */
  public readCredential(type: EgressSecretCredentialType): string | undefined {
    const field = this.credentialField(type);
    if (!this.encryptionAvailable()) return undefined;
    const candidate = this.readCandidate();
    if (candidate.kind !== 'valid') return undefined;
    try {
      this.assertAllSecretsDecrypt(candidate.value);
    } catch {
      return undefined;
    }
    const encrypted = candidate.value.credentials[field];
    if (!encrypted) return undefined;
    return this.decryptCredential(encrypted);
  }

  public setCredential(type: EgressSecretCredentialType, value: string): void {
    const field = this.credentialField(type);
    if (!credentialIsValid(value)) {
      throw new EgressSecretStoreError('The egress service credential is invalid or too long.');
    }
    this.assertEncryptionAvailable();
    const candidate = this.readCandidate();
    const current = this.valueForWrite(candidate);
    const decrypted = current.credentials[field]
      ? this.decryptCredential(current.credentials[field]!)
      : undefined;
    this.assertAllSecretsDecrypt(current);
    if (decrypted === value) return;
    this.persist({
      ...current,
      credentials: { ...current.credentials, [field]: this.encrypt(value) },
    });
  }

  public clearCredential(type: EgressSecretCredentialType): void {
    const field = this.credentialField(type);
    const candidate = this.readCandidate();
    if (candidate.kind === 'missing') return;
    this.assertEncryptionAvailable();
    const current = this.valueForWrite(candidate);
    this.assertAllSecretsDecrypt(current);
    if (!current.credentials[field]) return;
    const credentials = { ...current.credentials };
    delete credentials[field];
    this.persist({ ...current, credentials });
  }

  /** Reads the protected installation key without creating storage. */
  public readHmacKey(): Uint8Array | undefined {
    if (!this.encryptionAvailable()) return undefined;
    const candidate = this.readCandidate();
    if (candidate.kind !== 'valid' || !candidate.value.hmacKey) return undefined;
    try {
      this.assertAllSecretsDecrypt(candidate.value);
    } catch {
      return undefined;
    }
    const key = this.decryptHmacKey(candidate.value.hmacKey);
    return key ? Uint8Array.from(key) : undefined;
  }

  /** Creates the 32-byte installation key only on an explicit diagnostic/history request. */
  public getOrCreateHmacKey(): Uint8Array {
    this.assertEncryptionAvailable();
    const candidate = this.readCandidate();
    const current = this.valueForWrite(candidate);
    this.assertAllSecretsDecrypt(current);
    if (current.hmacKey) {
      const existing = this.decryptHmacKey(current.hmacKey);
      if (!existing) throw new EgressSecretStoreError();
      return Uint8Array.from(existing);
    }

    let generated: Uint8Array;
    try {
      generated = Uint8Array.from(this.randomBytes(HMAC_KEY_BYTES));
    } catch {
      throw new EgressSecretStoreError('The egress installation key could not be generated.');
    }
    if (generated.byteLength !== HMAC_KEY_BYTES) {
      generated.fill(0);
      throw new EgressSecretStoreError('The egress installation key could not be generated.');
    }
    const returned = Uint8Array.from(generated);
    try {
      const encoded = Buffer.from(generated).toString('base64url');
      this.persist({ ...current, hmacKey: this.encrypt(encoded) });
      return returned;
    } finally {
      generated.fill(0);
    }
  }

  private assertAllSecretsDecrypt(value: StoredSecretFile): void {
    for (const encrypted of Object.values(value.credentials)) {
      if (!encrypted || this.decryptCredential(encrypted) === undefined) {
        throw new EgressSecretStoreError();
      }
    }
    if (value.hmacKey) {
      const key = this.decryptHmacKey(value.hmacKey);
      if (!key) throw new EgressSecretStoreError();
      key.fill(0);
    }
  }

  private assertEncryptionAvailable(): void {
    if (!this.encryptionAvailable()) {
      throw new EgressSecretStoreError('Protected operating-system storage is unavailable.');
    }
  }

  private credentialField(type: EgressSecretCredentialType): StoredCredentialField {
    if (!EGRESS_SECRET_CREDENTIAL_TYPES.includes(type)) throw new EgressSecretStoreError();
    return CREDENTIAL_FIELDS[type];
  }

  private decrypt(encrypted: string): string | undefined {
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return undefined;
    }
  }

  private decryptCredential(encrypted: string): string | undefined {
    const value = this.decrypt(encrypted);
    return credentialIsValid(value) ? value : undefined;
  }

  private decryptHmacKey(encrypted: string): Uint8Array | undefined {
    const value = this.decrypt(encrypted);
    return value === undefined ? undefined : decodeHmacKey(value);
  }

  private encryptionAvailable(): boolean {
    try {
      if (this.safeStorage.isEncryptionAvailable() !== true) return false;
      if (
        this.platform === 'linux' &&
        this.safeStorage.getSelectedStorageBackend &&
        this.safeStorage.getSelectedStorageBackend().trim().toLowerCase() === 'basic_text'
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private encrypt(value: string): string {
    try {
      const encrypted = Buffer.from(this.safeStorage.encryptString(value));
      if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_ENCRYPTED_BLOB_BYTES) {
        throw new Error('invalid protected value');
      }
      return encrypted.toString('base64');
    } catch {
      throw new EgressSecretStoreError('Protected operating-system storage failed.');
    }
  }

  private readCandidate(): StoredCandidate {
    let storagePath: string | undefined;
    try {
      storagePath = this.existingStoragePath();
      if (!storagePath) return { kind: 'missing' };
      const leaf = lstatSync(storagePath);
      if (!leaf.isFile() || leaf.isSymbolicLink()) return { kind: 'invalid' };
      const raw = readEgressBoundedUtf8File(storagePath, EGRESS_SECRET_STORE_MAX_BYTES);
      return raw === undefined ? { kind: 'missing' } : inspectSecretFile(raw);
    } catch (error) {
      if (isMissingFileError(error)) return { kind: 'missing' };
      return { kind: 'invalid' };
    }
  }

  private existingStoragePath(): string | undefined {
    let directory;
    try {
      directory = lstatSync(this.storageDirectory);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new EgressSecretStoreError();
    const userDataReal = realpathSync.native(this.userDataPath);
    const directoryReal = realpathSync.native(this.storageDirectory);
    if (!pathIsContainedBy(userDataReal, directoryReal)) throw new EgressSecretStoreError();
    return path.join(directoryReal, STORAGE_FILE_NAME);
  }

  private prepareStoragePath(): string {
    let userDataReal: string;
    try {
      const userData = lstatSync(this.userDataPath);
      if (!userData.isDirectory()) throw new EgressSecretStoreError();
      userDataReal = realpathSync.native(this.userDataPath);
      try {
        mkdirSync(this.storageDirectory, { mode: 0o700, recursive: false });
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
          throw error;
        }
      }
      const directory = lstatSync(this.storageDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new EgressSecretStoreError();
      const directoryReal = realpathSync.native(this.storageDirectory);
      if (!pathIsContainedBy(userDataReal, directoryReal)) throw new EgressSecretStoreError();
      try {
        chmodSync(directoryReal, 0o700);
      } catch {
        // Windows and some filesystems do not expose meaningful POSIX directory modes.
      }
      return path.join(directoryReal, STORAGE_FILE_NAME);
    } catch (error) {
      if (error instanceof EgressSecretStoreError) throw error;
      throw new EgressSecretStoreError();
    }
  }

  private persist(value: StoredSecretFile): void {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > EGRESS_SECRET_STORE_MAX_BYTES) {
      throw new EgressSecretStoreError();
    }
    try {
      const storagePath = this.prepareStoragePath();
      replaceEgressFileAtomically(storagePath, serialized, this.atomicOperations);
      try {
        chmodSync(storagePath, 0o600);
      } catch {
        // The exclusive temporary file was already created as 0600; this is extra hardening.
      }
    } catch (error) {
      if (error instanceof EgressSecretStoreError) throw error;
      throw new EgressSecretStoreError();
    }
  }

  private valueForWrite(candidate: StoredCandidate): StoredSecretFile {
    if (candidate.kind === 'future') throw new EgressSecretStoreUnsupportedVersionError();
    if (candidate.kind === 'invalid') throw new EgressSecretStoreError();
    return candidate.kind === 'missing'
      ? { credentials: {}, version: EGRESS_SECRET_STORE_SCHEMA_VERSION }
      : cloneStoredFile(candidate.value);
  }
}
