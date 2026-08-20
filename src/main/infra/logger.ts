import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  DiagnosticLogEntry,
  DiagnosticLogLevel,
  DiagnosticsQuery,
} from '../../shared/contracts';
import type { Failure, FailureKind } from '../../shared/diagnostics/failure';

const DEFAULT_CAPACITY = 500;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DETAIL_LENGTH = 8_000;
const MAX_MESSAGE_LENGTH = 2_000;

export interface LoggerOptions {
  capacity?: number;
  filePath?: string;
  maxFileBytes?: number;
  now?: () => number;
}

export interface FailureReport {
  detail?: unknown;
  domain: string;
  kind: FailureKind;
  message: string;
}

const serializeDetail = (detail: unknown): string => {
  if (detail instanceof Error) {
    return detail.stack ? `${detail.name}: ${detail.message}\n${detail.stack}` : detail.message;
  }
  if (typeof detail === 'string') return detail;
  if (detail === undefined) return '';
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
};

export const redactLogText = (value: string): string =>
  value
    .replace(
      /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
      'Authorization: Bearer [REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/gi, '[REDACTED_CREDENTIAL]')
    .replace(/([?&](?:api[_-]?key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\\\s]+)*/gi, '[REDACTED_PATH]')
    .replace(/\/(?:home|Users)\/[^/\s]+(?:\/[^/\s]+)*/g, '[REDACTED_PATH]');

const normalizeText = (value: string, limit: number): string =>
  redactLogText(value).replaceAll('\0', '').slice(0, limit);

const normalizeDomain = (domain: string): string =>
  domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'main';

export class Logger {
  private readonly capacity: number;
  private readonly entries: DiagnosticLogEntry[] = [];
  private filePath?: string;
  private readonly maxFileBytes: number;
  private readonly now: () => number;
  private sequence = 0;

  public constructor(options: LoggerOptions = {}) {
    this.capacity = Math.max(1, Math.trunc(options.capacity ?? DEFAULT_CAPACITY));
    this.filePath = options.filePath;
    this.maxFileBytes = Math.max(1_024, Math.trunc(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
    this.now = options.now ?? Date.now;
  }

  public configureDisk(filePath?: string): void {
    this.filePath = filePath;
  }

  public debug(domain: string, message: string, detail?: unknown): DiagnosticLogEntry {
    return this.record('debug', domain, message, detail);
  }

  public info(domain: string, message: string, detail?: unknown): DiagnosticLogEntry {
    return this.record('info', domain, message, detail);
  }

  public warn(domain: string, message: string, detail?: unknown): DiagnosticLogEntry {
    return this.record('warn', domain, message, detail);
  }

  public error(
    domain: string,
    message: string,
    detail?: unknown,
    kind?: FailureKind,
  ): DiagnosticLogEntry {
    return this.record('error', domain, message, detail, kind);
  }

  public query(query: DiagnosticsQuery = {}): DiagnosticLogEntry[] {
    const limit = Math.max(1, Math.min(this.capacity, Math.trunc(query.limit ?? 100)));
    const message = query.message?.trim().toLowerCase();
    return this.entries
      .slice()
      .reverse()
      .filter(
        (entry) =>
          (!query.code || entry.code === query.code) &&
          (!query.domain || entry.domain === normalizeDomain(query.domain)) &&
          (!query.level || entry.level === query.level) &&
          (!message || entry.message.toLowerCase().includes(message)),
      )
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  private record(
    level: DiagnosticLogLevel,
    domain: string,
    message: string,
    detail?: unknown,
    kind?: FailureKind,
  ): DiagnosticLogEntry {
    const occurredAt = this.now();
    const normalizedDomain = normalizeDomain(domain);
    const normalizedMessage = normalizeText(message, MAX_MESSAGE_LENGTH) || '未提供日志消息。';
    const normalizedDetail =
      normalizeText(serializeDetail(detail), MAX_DETAIL_LENGTH) || normalizedMessage;
    const entry: DiagnosticLogEntry = {
      code: this.nextCode(normalizedDomain, occurredAt),
      detail: normalizedDetail,
      domain: normalizedDomain,
      ...(kind ? { kind } : {}),
      level,
      message: normalizedMessage,
      occurredAt,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.persist(entry);
    return { ...entry };
  }

  private nextCode(domain: string, occurredAt: number): string {
    this.sequence = (this.sequence + 1) % 1_679_616;
    const domainCode = domain.replace(/-/g, '').slice(0, 12).toUpperCase() || 'MAIN';
    return `CD-${domainCode}-${occurredAt.toString(36).toUpperCase()}-${this.sequence
      .toString(36)
      .toUpperCase()}`;
  }

  private persist(entry: DiagnosticLogEntry): void {
    if (!this.filePath) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (existsSync(this.filePath) && statSync(this.filePath).size >= this.maxFileBytes) {
        renameSync(this.filePath, `${this.filePath}.previous`);
      }
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      // The in-memory entry remains queryable when the optional disk sink is unavailable.
    }
  }
}

export const mainLogger = new Logger();

export type FailureReporter = (kind: FailureKind, message: string, detail?: unknown) => Failure;

export const reportFailure = (report: FailureReport, logger: Logger = mainLogger): Failure => {
  const entry = logger.error(report.domain, report.message, report.detail, report.kind);
  return {
    code: entry.code,
    detail: entry.detail,
    kind: report.kind,
    message: entry.message,
  };
};

export const createFailureReporter =
  (domain: string, logger: Logger = mainLogger): FailureReporter =>
  (kind, message, detail) =>
    reportFailure({ detail, domain, kind, message }, logger);
