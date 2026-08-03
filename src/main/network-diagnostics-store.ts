import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import type { NetworkPreflightHistoryView, NetworkPreflightResult } from '../shared/contracts';

const RETENTION_DAYS = 7;
const MAX_ENTRIES = 40;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1_000;

export const redactDiagnosticText = (value: string): string =>
  value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/gi, '[REDACTED_CREDENTIAL]')
    .replace(/([?&](?:api[_-]?key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\\\s]+)*/gi, '[REDACTED_PATH]')
    .replace(/\/(?:home|Users)\/[^/\s]+(?:\/[^/\s]+)*/g, '[REDACTED_PATH]')
    .slice(0, 1_024);

const maskNetworkAddress = (value: string): string => {
  const version = isIP(value);
  if (version === 4) {
    return `${value.split('.').slice(0, 3).join('.')}.0/24`;
  }
  if (version === 6) {
    const [leftRaw = '', rightRaw = ''] = value.split('::');
    const left = leftRaw ? leftRaw.split(':') : [];
    const right = rightRaw ? rightRaw.split(':') : [];
    const pieces = [
      ...left,
      ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'),
      ...right,
    ];
    return `${pieces.slice(0, 4).join(':')}::/64`;
  }
  return '[REDACTED_ADDRESS]';
};

const sanitizeResult = (result: NetworkPreflightResult): NetworkPreflightResult => ({
  ...result,
  paths: result.paths.map((item) => ({
    ...item,
    detail: redactDiagnosticText(item.detail),
    dnsServers: item.dnsServers.slice(0, 8).map(maskNetworkAddress),
    virtualInterfaces: item.virtualInterfaces.slice(0, 12),
  })),
  probes: result.probes.map((item) => ({
    ...item,
    detail: redactDiagnosticText(item.detail),
    target: item.target ? redactDiagnosticText(item.target) : undefined,
  })),
  reasons: result.reasons.map(redactDiagnosticText),
  signals: result.signals.map((item) => ({
    ...item,
    detail: redactDiagnosticText(item.detail),
  })),
  summary: redactDiagnosticText(result.summary),
});

export class NetworkDiagnosticsStore {
  private readonly directory: string;
  private readonly storagePath: string;

  public constructor(
    userDataPath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = path.join(userDataPath, 'network-preflight');
    this.storagePath = path.join(this.directory, 'history.json');
  }

  public append(result: NetworkPreflightResult): void {
    const entries = [sanitizeResult(result), ...this.load()]
      .filter((entry) => (entry.checkedAt ?? entry.startedAt) >= this.now() - RETENTION_MS)
      .slice(0, MAX_ENTRIES);
    this.persist(entries);
  }

  public clear(): NetworkPreflightHistoryView {
    this.persist([]);
    return this.getView();
  }

  public getView(): NetworkPreflightHistoryView {
    return {
      entries: this.load()
        .filter((entry) => (entry.checkedAt ?? entry.startedAt) >= this.now() - RETENTION_MS)
        .slice(0, MAX_ENTRIES),
      retentionDays: RETENTION_DAYS,
    };
  }

  private load(): NetworkPreflightResult[] {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        entries?: unknown;
        version?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        return [];
      }
      return parsed.entries.filter((entry): entry is NetworkPreflightResult =>
        Boolean(
          entry &&
          typeof entry === 'object' &&
          typeof (entry as NetworkPreflightResult).provider === 'string' &&
          typeof (entry as NetworkPreflightResult).status === 'string' &&
          Array.isArray((entry as NetworkPreflightResult).probes),
        ),
      );
    } catch {
      return [];
    }
  }

  private persist(entries: NetworkPreflightResult[]): void {
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ entries, version: 1 }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }
}
