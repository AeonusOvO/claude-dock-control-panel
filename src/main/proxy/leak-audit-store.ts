import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyAuditRecord, ProxyLeakAuditReport } from '../../shared/contracts';

interface StoredAudits {
  records: ProxyAuditRecord[];
  version: 1;
}

const MAX_RECORDS = 50;

export class LeakAuditStore {
  private readonly directory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'proxy');
    this.storagePath = path.join(this.directory, 'audits.json');
  }

  public add(report: ProxyLeakAuditReport): ProxyAuditRecord {
    const store = this.load();
    const record: ProxyAuditRecord = { id: randomUUID(), report: structuredClone(report) };
    store.records.unshift(record);
    store.records = store.records.slice(0, MAX_RECORDS);
    this.persist(store);
    return structuredClone(record);
  }

  public accept(recordId: string, acceptedAt = Date.now()): ProxyAuditRecord {
    const store = this.load();
    const record = store.records.find(({ id }) => id === recordId);
    if (!record) {
      throw new Error('代理体检记录不存在。');
    }
    record.acceptedAt = acceptedAt;
    this.persist(store);
    return structuredClone(record);
  }

  public list(): ProxyAuditRecord[] {
    return structuredClone(this.load().records);
  }

  public delete(recordId: string): void {
    const store = this.load();
    const next = store.records.filter(({ id }) => id !== recordId);
    if (next.length === store.records.length) throw new Error('代理体检记录不存在。');
    store.records = next;
    this.persist(store);
  }

  public latestForFingerprint(fingerprint: string): ProxyAuditRecord | undefined {
    const record = this.load().records.find(({ report }) => report.nodeFingerprint === fingerprint);
    return record ? structuredClone(record) : undefined;
  }

  private load(): StoredAudits {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as StoredAudits;
      return parsed.version === 1 && Array.isArray(parsed.records)
        ? parsed
        : { records: [], version: 1 };
    } catch {
      return { records: [], version: 1 };
    }
  }

  private persist(store: StoredAudits): void {
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }
}
