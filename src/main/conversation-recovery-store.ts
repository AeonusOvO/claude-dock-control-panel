import { createHash } from 'node:crypto';
import {
  copyFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ConversationOwnerKind, ConversationRuntime } from '../shared/native-conversation';

export type RecoverySubmissionState =
  | 'prepared'
  | 'dispatched'
  | 'hook-durable'
  | 'allow-sent'
  | 'transcript-confirmed'
  | 'interrupted-draft'
  | 'result-unknown';

export interface RecoveryLaunchSnapshot {
  capabilityRevision?: number;
  cliVersion?: string;
  configFingerprint: string;
  effort?: string;
  endpointIdentity?: string;
  model?: string;
  permissionMode?: string;
  speed?: string;
}

export interface RecoverySubmissionView {
  clientSubmissionId: string;
  createdAt: number;
  promptDigest: string;
  sequence: number;
  state: RecoverySubmissionState;
  updatedAt: number;
}

export interface ConversationRecoveryView {
  clean: boolean;
  conversationId: string;
  launch: RecoveryLaunchSnapshot;
  ownerKind: ConversationOwnerKind;
  projectPath: string;
  runtime: ConversationRuntime;
  submissions: RecoverySubmissionView[];
  updatedAt: number;
}

interface RecoverySubmissionRecord extends RecoverySubmissionView {
  encryptedPrompt?: string;
}

interface ConversationRecoveryRecord extends Omit<ConversationRecoveryView, 'submissions'> {
  submissions: RecoverySubmissionRecord[];
}

interface RecoveryJournal {
  records: ConversationRecoveryRecord[];
  version: 1;
}

export interface RecoveryEncryption {
  decryptString(encrypted: Buffer): string;
  encryptString(plainText: string): Buffer;
  isEncryptionAvailable(): boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isRuntime = (value: unknown): value is ConversationRuntime =>
  value === 'claude' || value === 'codex';
const isOwnerKind = (value: unknown): value is ConversationOwnerKind =>
  value === 'native' || value === 'terminal';
const isSubmissionState = (value: unknown): value is RecoverySubmissionState =>
  typeof value === 'string' &&
  [
    'prepared',
    'dispatched',
    'hook-durable',
    'allow-sent',
    'transcript-confirmed',
    'interrupted-draft',
    'result-unknown',
  ].includes(value);
const finiteTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const parseSubmission = (value: unknown): RecoverySubmissionRecord | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.clientSubmissionId !== 'string' ||
    !value.clientSubmissionId ||
    value.clientSubmissionId.length > 200 ||
    !finiteTimestamp(value.createdAt) ||
    !finiteTimestamp(value.updatedAt) ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence <= 0 ||
    typeof value.promptDigest !== 'string' ||
    !DIGEST.test(value.promptDigest) ||
    !isSubmissionState(value.state) ||
    (value.encryptedPrompt !== undefined &&
      (typeof value.encryptedPrompt !== 'string' ||
        value.encryptedPrompt.length > MAX_PROMPT_BYTES * 2))
  ) {
    return undefined;
  }
  return {
    clientSubmissionId: value.clientSubmissionId,
    createdAt: value.createdAt,
    encryptedPrompt: value.encryptedPrompt,
    promptDigest: value.promptDigest,
    sequence: value.sequence,
    state: value.state,
    updatedAt: value.updatedAt,
  };
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 500 ? value : undefined;

const parseRecord = (value: unknown): ConversationRecoveryRecord | undefined => {
  if (!isRecord(value) || !isRecord(value.launch) || !Array.isArray(value.submissions))
    return undefined;
  if (
    typeof value.conversationId !== 'string' ||
    !UUID.test(value.conversationId) ||
    typeof value.projectPath !== 'string' ||
    !path.isAbsolute(value.projectPath) ||
    value.projectPath.length > 1_000 ||
    !isRuntime(value.runtime) ||
    !isOwnerKind(value.ownerKind) ||
    typeof value.clean !== 'boolean' ||
    !finiteTimestamp(value.updatedAt) ||
    typeof value.launch.configFingerprint !== 'string' ||
    !DIGEST.test(value.launch.configFingerprint)
  ) {
    return undefined;
  }
  const submissions = value.submissions.map(parseSubmission);
  if (submissions.some((submission) => !submission)) return undefined;
  return {
    clean: value.clean,
    conversationId: value.conversationId.toLowerCase(),
    launch: {
      capabilityRevision:
        typeof value.launch.capabilityRevision === 'number' &&
        Number.isSafeInteger(value.launch.capabilityRevision)
          ? value.launch.capabilityRevision
          : undefined,
      configFingerprint: value.launch.configFingerprint,
      effort: optionalString(value.launch.effort),
      endpointIdentity: optionalString(value.launch.endpointIdentity),
      model: optionalString(value.launch.model),
      permissionMode: optionalString(value.launch.permissionMode),
      speed: optionalString(value.launch.speed),
    },
    ownerKind: value.ownerKind,
    projectPath: path.resolve(value.projectPath),
    runtime: value.runtime,
    submissions: submissions as RecoverySubmissionRecord[],
    updatedAt: value.updatedAt,
  };
};

const parseJournal = (raw: string): RecoveryJournal | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) return undefined;
    const records = value.records.map(parseRecord);
    if (records.some((record) => !record)) return undefined;
    return { records: records as ConversationRecoveryRecord[], version: 1 };
  } catch {
    return undefined;
  }
};

const digestPrompt = (prompt: string): string => createHash('sha256').update(prompt).digest('hex');
const keyOf = (runtime: ConversationRuntime, projectPath: string, conversationId: string): string =>
  `${runtime}\u0000${path.resolve(projectPath).toLocaleLowerCase('en-US')}\u0000${conversationId.toLowerCase()}`;

export class ConversationRecoveryStore {
  private readonly backupPath: string;
  private journal: RecoveryJournal;
  private nextTemporaryId = 1;
  private readonly storagePath: string;

  public constructor(
    userDataPath: string,
    private readonly encryption: RecoveryEncryption,
    private readonly now: () => number = Date.now,
  ) {
    const directory = path.join(userDataPath, 'claude');
    mkdirSync(directory, { recursive: true });
    this.storagePath = path.join(directory, 'recovery-journal.json');
    this.backupPath = `${this.storagePath}.bak`;
    this.journal = this.load();
  }

  public reserve(input: {
    conversationId: string;
    launch: RecoveryLaunchSnapshot;
    ownerKind: ConversationOwnerKind;
    projectPath: string;
    runtime: ConversationRuntime;
  }): ConversationRecoveryView {
    if (!UUID.test(input.conversationId) || !path.isAbsolute(input.projectPath)) {
      throw new Error('恢复日志的会话身份无效。');
    }
    if (!DIGEST.test(input.launch.configFingerprint)) {
      throw new Error('恢复日志的配置指纹无效。');
    }
    const key = keyOf(input.runtime, input.projectPath, input.conversationId);
    const now = this.now();
    const existing = this.journal.records.findIndex(
      (record) => keyOf(record.runtime, record.projectPath, record.conversationId) === key,
    );
    const record: ConversationRecoveryRecord = {
      clean: false,
      conversationId: input.conversationId.toLowerCase(),
      launch: { ...input.launch },
      ownerKind: input.ownerKind,
      projectPath: path.resolve(input.projectPath),
      runtime: input.runtime,
      submissions: existing >= 0 ? this.journal.records[existing]!.submissions : [],
      updatedAt: now,
    };
    if (existing >= 0) this.journal.records[existing] = record;
    else this.journal.records.push(record);
    this.persist();
    return this.publicRecord(record);
  }

  public preparePrompt(
    runtime: ConversationRuntime,
    projectPath: string,
    conversationId: string,
    clientSubmissionId: string,
    prompt: string,
  ): RecoverySubmissionView {
    const bytes = Buffer.byteLength(prompt, 'utf8');
    if (!prompt || bytes > MAX_PROMPT_BYTES) throw new Error('待发送内容为空或超过恢复上限。');
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储不可用，本次内容尚未发送。');
    }
    const record = this.requireRecord(runtime, projectPath, conversationId);
    if (
      record.submissions.some((submission) => submission.clientSubmissionId === clientSubmissionId)
    ) {
      throw new Error('提交标识已存在。');
    }
    const now = this.now();
    const submission: RecoverySubmissionRecord = {
      clientSubmissionId,
      createdAt: now,
      encryptedPrompt: this.encryption.encryptString(prompt).toString('base64'),
      promptDigest: digestPrompt(prompt),
      sequence: (record.submissions.at(-1)?.sequence ?? 0) + 1,
      state: 'prepared',
      updatedAt: now,
    };
    record.clean = false;
    record.submissions.push(submission);
    record.updatedAt = now;
    this.persist();
    return this.publicSubmission(submission);
  }

  public markSubmission(
    runtime: ConversationRuntime,
    projectPath: string,
    conversationId: string,
    clientSubmissionId: string,
    state: Exclude<RecoverySubmissionState, 'prepared' | 'interrupted-draft' | 'result-unknown'>,
  ): RecoverySubmissionView {
    const record = this.requireRecord(runtime, projectPath, conversationId);
    const submission = record.submissions.find(
      (candidate) => candidate.clientSubmissionId === clientSubmissionId,
    );
    if (!submission) throw new Error('恢复日志中没有这次提交。');
    submission.state = state;
    submission.updatedAt = this.now();
    if (state === 'transcript-confirmed') delete submission.encryptedPrompt;
    record.updatedAt = submission.updatedAt;
    this.persist();
    return this.publicSubmission(submission);
  }

  public preserveUnsentDraft(
    runtime: ConversationRuntime,
    projectPath: string,
    conversationId: string,
    clientSubmissionId: string,
  ): RecoverySubmissionView {
    const record = this.requireRecord(runtime, projectPath, conversationId);
    const submission = record.submissions.find(
      (candidate) => candidate.clientSubmissionId === clientSubmissionId,
    );
    if (!submission?.encryptedPrompt) throw new Error('没有可保留的加密草稿。');
    submission.state = 'interrupted-draft';
    submission.updatedAt = this.now();
    record.clean = false;
    record.updatedAt = submission.updatedAt;
    this.persist();
    return this.publicSubmission(submission);
  }

  public markInterrupted(): ConversationRecoveryView[] {
    let changed = false;
    for (const record of this.journal.records) {
      if (record.clean) continue;
      for (const submission of record.submissions) {
        if (submission.state === 'prepared') {
          submission.state = 'interrupted-draft';
          submission.updatedAt = this.now();
          changed = true;
        } else if (
          submission.state === 'dispatched' ||
          submission.state === 'hook-durable' ||
          submission.state === 'allow-sent'
        ) {
          submission.state = 'result-unknown';
          submission.updatedAt = this.now();
          changed = true;
        }
      }
    }
    if (changed) this.persist();
    return this.journal.records
      .filter((record) => !record.clean)
      .map((record) => this.publicRecord(record));
  }

  public readDraft(
    runtime: ConversationRuntime,
    projectPath: string,
    conversationId: string,
    clientSubmissionId: string,
  ): string {
    const record = this.requireRecord(runtime, projectPath, conversationId);
    const submission = record.submissions.find(
      (candidate) => candidate.clientSubmissionId === clientSubmissionId,
    );
    if (!submission?.encryptedPrompt) throw new Error('这次提交没有可恢复的草稿。');
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用。');
    const decrypted = this.encryption.decryptString(
      Buffer.from(submission.encryptedPrompt, 'base64'),
    );
    if (digestPrompt(decrypted) !== submission.promptDigest)
      throw new Error('恢复草稿完整性校验失败。');
    return decrypted;
  }

  public markClean(
    runtime: ConversationRuntime,
    projectPath: string,
    conversationId: string,
  ): void {
    const record = this.requireRecord(runtime, projectPath, conversationId);
    const ambiguous = record.submissions.some((submission) =>
      ['dispatched', 'hook-durable', 'allow-sent', 'result-unknown'].includes(submission.state),
    );
    if (ambiguous) throw new Error('仍有发送结果待核对，不能写入 clean marker。');
    record.clean = true;
    record.updatedAt = this.now();
    this.persist();
  }

  public list(): ConversationRecoveryView[] {
    return this.journal.records.map((record) => this.publicRecord(record));
  }

  public discard(
    runtime: ConversationRuntime,
    projectPath: string,
    conversationId: string,
  ): boolean {
    const key = keyOf(runtime, projectPath, conversationId);
    const next = this.journal.records.filter(
      (record) => keyOf(record.runtime, record.projectPath, record.conversationId) !== key,
    );
    if (next.length === this.journal.records.length) return false;
    this.journal.records = next;
    this.persist();
    return true;
  }

  private load(): RecoveryJournal {
    for (const candidate of [this.storagePath, this.backupPath]) {
      try {
        if (!existsSync(candidate)) continue;
        const bytes = readFileSync(candidate);
        if (bytes.length > MAX_JOURNAL_BYTES) continue;
        const parsed = parseJournal(bytes.toString('utf8'));
        if (parsed) return parsed;
      } catch {
        // Try the last known-good backup before starting with an empty journal.
      }
    }
    return { records: [], version: 1 };
  }

  private persist(): void {
    const serialized = `${JSON.stringify(this.journal, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_JOURNAL_BYTES)
      throw new Error('恢复日志超过安全上限。');
    if (existsSync(this.storagePath)) {
      try {
        const current = readFileSync(this.storagePath, 'utf8');
        if (parseJournal(current)) copyFileSync(this.storagePath, this.backupPath);
      } catch {
        // A corrupt primary must not replace the last known-good backup.
      }
    }
    const temporaryPath = `${this.storagePath}.${process.pid}.${this.nextTemporaryId++}.tmp`;
    writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Windows requires a writable handle for FlushFileBuffers (Node's fsync implementation).
    const handle = openSync(temporaryPath, 'r+');
    try {
      fsyncSync(handle);
    } finally {
      // Node closes file descriptors on process exit, but the rename must not leak one each save.
      closeSync(handle);
    }
    renameSync(temporaryPath, this.storagePath);
  }

  private requireRecord(
    runtime: ConversationRuntime,
    projectPath: string,
    conversationId: string,
  ): ConversationRecoveryRecord {
    const key = keyOf(runtime, projectPath, conversationId);
    const record = this.journal.records.find(
      (candidate) =>
        keyOf(candidate.runtime, candidate.projectPath, candidate.conversationId) === key,
    );
    if (!record) throw new Error('会话尚未写入恢复日志。');
    return record;
  }

  private publicSubmission(submission: RecoverySubmissionRecord): RecoverySubmissionView {
    const view = { ...submission };
    delete view.encryptedPrompt;
    return view;
  }

  private publicRecord(record: ConversationRecoveryRecord): ConversationRecoveryView {
    return {
      ...record,
      launch: { ...record.launch },
      submissions: record.submissions.map((submission) => this.publicSubmission(submission)),
    };
  }
}

export const recoveryConfigFingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
