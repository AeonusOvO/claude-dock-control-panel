import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  type EgressAtomicFileOperations,
  readEgressBoundedUtf8File,
  replaceEgressFileAtomically,
} from './atomic-store';
import {
  cloneEgressProcessPolicy,
  defaultEgressProcessPolicy,
  EGRESS_PROCESS_POLICY_MAX_BYTES,
  EGRESS_PROCESS_POLICY_SCHEMA_VERSION,
  type EgressProcessPolicy,
  normalizeEgressProcessPolicy,
  serializeEgressProcessPolicyCanonical,
} from './process-policy-types';

export type EgressProcessPolicyRevision = string & {
  readonly __egressProcessPolicyRevision: unique symbol;
};

/**
 * Must be backed by a stable per-install secret protected outside this module (for example through
 * Electron safeStorage). Implementations must produce a keyed 32-byte authenticator, never a raw
 * or unkeyed hash of the low-entropy policy document.
 */
export interface EgressProcessPolicyRevisionSigner {
  sign(material: Uint8Array): Uint8Array;
}

export interface EgressProcessPolicySnapshot {
  readonly policy: EgressProcessPolicy;
  readonly revision: EgressProcessPolicyRevision;
}

export interface EgressProcessPolicyStorePort {
  read(): EgressProcessPolicySnapshot;
  revisionFor(policy: EgressProcessPolicy): EgressProcessPolicyRevision;
  write(policy: EgressProcessPolicy): EgressProcessPolicySnapshot;
}

export interface EgressProcessPolicyStoreOptions {
  readonly atomicOperations?: Partial<EgressAtomicFileOperations>;
}

export class EgressProcessPolicyStoreError extends Error {
  public constructor(message = 'ClaudeDock 无法安全读取或保存进程策略。') {
    super(message);
    this.name = 'EgressProcessPolicyStoreError';
  }
}

export class EgressProcessPolicyUnsupportedVersionError extends EgressProcessPolicyStoreError {
  public constructor() {
    super('进程策略由更新版本的 ClaudeDock 创建，当前版本不会覆盖它。');
    this.name = 'EgressProcessPolicyUnsupportedVersionError';
  }
}

export class EgressProcessPolicyRevisionError extends EgressProcessPolicyStoreError {
  public constructor() {
    super('进程策略修订签名不可用。');
    this.name = 'EgressProcessPolicyRevisionError';
  }
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

interface UnclassifiableCandidate {
  readonly kind: 'unclassifiable';
}

interface ValidCandidate {
  readonly kind: 'valid';
  readonly policy: EgressProcessPolicy;
  readonly raw: string;
}

type StoredCandidate =
  MissingCandidate | InvalidCandidate | FutureCandidate | UnclassifiableCandidate | ValidCandidate;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const inspectCandidate = (raw: string): StoredCandidate => {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value.version === 'number' &&
      Number.isSafeInteger(value.version) &&
      value.version > EGRESS_PROCESS_POLICY_SCHEMA_VERSION
    ) {
      return { kind: 'future' };
    }
    return { kind: 'valid', policy: normalizeEgressProcessPolicy(value), raw };
  } catch {
    return { kind: 'invalid' };
  }
};

const serializeForStorage = (policy: EgressProcessPolicy): string =>
  `${JSON.stringify(normalizeEgressProcessPolicy(policy), null, 2)}\n`;

const assertAbsoluteRoot = (root: string): string => {
  if (!path.isAbsolute(root)) {
    throw new EgressProcessPolicyStoreError('进程策略存储根目录无效。');
  }
  return path.resolve(root);
};

/** Creates a signer from already-protected key material; this helper never persists the key. */
export const createEgressProcessPolicyHmacSigner = (
  protectedSecret: Uint8Array,
): EgressProcessPolicyRevisionSigner => {
  if (protectedSecret.byteLength < 32) throw new EgressProcessPolicyRevisionError();
  const secret = Buffer.from(protectedSecret);
  return Object.freeze({
    sign: (material: Uint8Array): Uint8Array =>
      createHmac('sha256', secret).update(material).digest(),
  });
};

/** Standalone policy store rooted exactly at the caller-owned egress-diagnostics directory. */
export class EgressProcessPolicyStore implements EgressProcessPolicyStorePort {
  private readonly atomicOperations: Partial<EgressAtomicFileOperations>;
  private readonly backupPath: string;
  private readonly root: string;
  private readonly storagePath: string;

  public constructor(
    root: string,
    private readonly revisionSigner: EgressProcessPolicyRevisionSigner,
    options: EgressProcessPolicyStoreOptions = {},
  ) {
    this.root = assertAbsoluteRoot(root);
    this.storagePath = path.join(this.root, 'process-policy.json');
    this.backupPath = `${this.storagePath}.bak`;
    this.atomicOperations = options.atomicOperations ?? {};
  }

  public read(): EgressProcessPolicySnapshot {
    const primary = this.readCandidate(this.storagePath);
    if (primary.kind === 'future') throw new EgressProcessPolicyUnsupportedVersionError();
    if (primary.kind === 'valid') return this.snapshot(primary.policy);

    const backup = this.readCandidate(this.backupPath);
    if (backup.kind === 'future') throw new EgressProcessPolicyUnsupportedVersionError();
    if (backup.kind === 'valid') return this.snapshot(backup.policy);
    if (primary.kind === 'missing' && backup.kind === 'missing') {
      return this.snapshot(defaultEgressProcessPolicy());
    }
    throw new EgressProcessPolicyStoreError('进程策略文件损坏，ClaudeDock 不会覆盖现有内容。');
  }

  public get(): EgressProcessPolicySnapshot {
    return this.read();
  }

  public revisionFor(policy: EgressProcessPolicy): EgressProcessPolicyRevision {
    const canonical = serializeEgressProcessPolicyCanonical(policy);
    try {
      const authenticator = Buffer.from(
        this.revisionSigner.sign(
          Buffer.from(`claudedock-egress-process-policy-revision-v1\0${canonical}`, 'utf8'),
        ),
      );
      if (authenticator.byteLength !== 32) throw new Error('invalid authenticator');
      return `epr1_${authenticator.toString('base64url')}` as EgressProcessPolicyRevision;
    } catch {
      throw new EgressProcessPolicyRevisionError();
    }
  }

  public isCurrent(revision: EgressProcessPolicyRevision): boolean {
    return this.read().revision === revision;
  }

  public write(policy: EgressProcessPolicy): EgressProcessPolicySnapshot {
    const normalized = normalizeEgressProcessPolicy(policy);
    const serialized = serializeForStorage(normalized);
    if (Buffer.byteLength(serialized, 'utf8') > EGRESS_PROCESS_POLICY_MAX_BYTES) {
      throw new EgressProcessPolicyStoreError('进程策略超过大小上限。');
    }

    const primary = this.readCandidate(this.storagePath);
    const backup = this.readCandidate(this.backupPath);
    this.assertWritable(primary, backup);

    try {
      mkdirSync(this.root, { recursive: true });
      if (primary.kind === 'valid') {
        replaceEgressFileAtomically(this.backupPath, primary.raw, this.atomicOperations);
      }
      replaceEgressFileAtomically(this.storagePath, serialized, this.atomicOperations);
    } catch (error) {
      if (error instanceof EgressProcessPolicyStoreError) throw error;
      throw new EgressProcessPolicyStoreError('ClaudeDock 无法安全保存进程策略。');
    }
    return this.snapshot(normalized);
  }

  private assertWritable(primary: StoredCandidate, backup: StoredCandidate): void {
    if (primary.kind === 'future' || backup.kind === 'future') {
      throw new EgressProcessPolicyUnsupportedVersionError();
    }
    if (primary.kind === 'unclassifiable' || backup.kind === 'unclassifiable') {
      throw new EgressProcessPolicyStoreError(
        '进程策略文件的格式或版本无法安全确认，ClaudeDock 不会覆盖现有内容。',
      );
    }
    if (primary.kind === 'invalid' && backup.kind !== 'valid') {
      throw new EgressProcessPolicyStoreError('进程策略文件损坏，ClaudeDock 不会覆盖现有内容。');
    }
    if (primary.kind === 'missing' && backup.kind === 'invalid') {
      throw new EgressProcessPolicyStoreError('进程策略备份损坏，ClaudeDock 不会覆盖现有内容。');
    }
  }

  private readCandidate(filePath: string): StoredCandidate {
    try {
      const raw = readEgressBoundedUtf8File(filePath, EGRESS_PROCESS_POLICY_MAX_BYTES);
      return raw === undefined ? { kind: 'missing' } : inspectCandidate(raw);
    } catch {
      return { kind: 'unclassifiable' };
    }
  }

  private snapshot(policy: EgressProcessPolicy): EgressProcessPolicySnapshot {
    const cloned = cloneEgressProcessPolicy(policy);
    return Object.freeze({ policy: cloned, revision: this.revisionFor(cloned) });
  }
}
