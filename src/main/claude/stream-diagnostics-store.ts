import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeStreamDiagnostic, ClaudeStreamFailureKind } from '../../shared/contracts';

const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;

export const classifyClaudeStreamFailure = (
  message: string,
): ClaudeStreamFailureKind | undefined => {
  if (/\b408\b|request timeout|timed out/i.test(message)) return 'request-timeout';
  if (/\b429\b|rate.?limit/i.test(message)) return 'rate-limited';
  if (/\b5\d\d\b|bad gateway|service unavailable|gateway timeout/i.test(message)) {
    return 'upstream-5xx';
  }
  if (/stream disconnected before completion|stream closed before/i.test(message)) {
    return 'stream-disconnected';
  }
  if (/response\.completed|missing completion/i.test(message)) return 'missing-completion';
  if (/unexpected eof|premature eof|socket hang up/i.test(message)) return 'unexpected-eof';
  return undefined;
};

const sanitize = (entry: ClaudeStreamDiagnostic): ClaudeStreamDiagnostic => ({
  backgroundTaskCount: Math.max(0, Math.min(10_000, Math.trunc(entry.backgroundTaskCount))),
  ...(entry.cliVersion ? { cliVersion: entry.cliVersion.slice(0, 40) } : {}),
  ...(entry.gatewayVersion ? { gatewayVersion: entry.gatewayVersion.slice(0, 40) } : {}),
  kind: entry.kind,
  occurredAt: entry.occurredAt,
  sessionRuntimeMs: Math.max(0, Math.trunc(entry.sessionRuntimeMs)),
});

export class ClaudeStreamDiagnosticsStore {
  private readonly directory: string;
  private readonly storagePath: string;

  public constructor(
    userDataPath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = path.join(userDataPath, 'claude', 'diagnostics');
    this.storagePath = path.join(this.directory, 'stream-failures.json');
  }

  public append(entry: ClaudeStreamDiagnostic): void {
    const entries = [sanitize(entry), ...this.load()]
      .filter((candidate) => candidate.occurredAt >= this.now() - RETENTION_MS)
      .slice(0, MAX_ENTRIES);
    this.persist(entries);
  }

  public list(): ClaudeStreamDiagnostic[] {
    return this.load()
      .filter((entry) => entry.occurredAt >= this.now() - RETENTION_MS)
      .slice(0, MAX_ENTRIES);
  }

  private load(): ClaudeStreamDiagnostic[] {
    try {
      if (statSync(this.storagePath).size > MAX_FILE_BYTES) return [];
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        entries?: unknown;
        version?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter((entry): entry is ClaudeStreamDiagnostic =>
        Boolean(
          entry &&
          typeof entry === 'object' &&
          typeof (entry as ClaudeStreamDiagnostic).kind === 'string' &&
          typeof (entry as ClaudeStreamDiagnostic).occurredAt === 'number' &&
          typeof (entry as ClaudeStreamDiagnostic).sessionRuntimeMs === 'number' &&
          typeof (entry as ClaudeStreamDiagnostic).backgroundTaskCount === 'number',
        ),
      );
    } catch {
      return [];
    }
  }

  private persist(entries: ClaudeStreamDiagnostic[]): void {
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    let retained = [...entries];
    let payload = `${JSON.stringify({ entries: retained, version: 1 }, null, 2)}\n`;
    while (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES && retained.length > 0) {
      retained = retained.slice(0, -1);
      payload = `${JSON.stringify({ entries: retained, version: 1 }, null, 2)}\n`;
    }
    writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.storagePath);
  }
}
