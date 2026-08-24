import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import type {
  NetworkAdvisoryEvidenceAssessment,
  NetworkEnvironmentAssessment,
  NetworkEnvironmentCheck,
  NetworkPreflightHistoryEntry,
  NetworkPreflightHistoryEntryV1,
  NetworkPreflightHistoryEntryV2,
  NetworkPreflightHistoryView,
  NetworkPreflightResult,
  NetworkProviderConnectivityAssessment,
} from '../../shared/contracts';
import { transientEgressAddressPrefix } from '../egress-diagnostics/address-redactor';

const RETENTION_DAYS = 7;
const MAX_ENTRIES = 40;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1_000;

const maskNetworkAddress = (value: string): string => {
  try {
    return transientEgressAddressPrefix(value);
  } catch {
    return '[REDACTED_ADDRESS]';
  }
};

const redactEmbeddedAddresses = (value: string): string =>
  value
    .replace(
      /(?<![A-Za-z0-9])\[?((?:[0-9A-Fa-f]{0,4}:){2,7}(?:\d{1,3}\.){3}\d{1,3})\]?(?:\/\d{1,3})?(?![A-Za-z0-9])/g,
      (candidate, address: string) =>
        isIP(address) === 6 ? maskNetworkAddress(address) : candidate,
    )
    .replace(/\b((?:\d{1,3}\.){3}\d{1,3})(?:\/\d{1,3})?\b/g, (candidate, address: string) =>
      isIP(address) === 4 ? maskNetworkAddress(address) : candidate,
    )
    .replace(
      /(?<![A-Za-z0-9])\[?([0-9A-Fa-f:]{2,})\]?(?:\/\d{1,3})?(?![A-Za-z0-9])/g,
      (candidate, address: string) =>
        isIP(address) === 6 ? maskNetworkAddress(address) : candidate,
    );

export const redactDiagnosticText = (value: string): string =>
  redactEmbeddedAddresses(
    value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/gi, '[REDACTED_CREDENTIAL]')
      .replace(/([?&](?:api[_-]?key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\\\s]+)*/gi, '[REDACTED_PATH]')
      .replace(/\/(?:home|Users)\/[^/\s]+(?:\/[^/\s]+)*/g, '[REDACTED_PATH]'),
  ).slice(0, 1_024);

const sanitizeDiagnosticTarget = (value: string): string => {
  try {
    const target = new URL(value);
    const rawHostname = target.hostname.replace(/^\[|\]$/g, '');
    const hostname =
      isIP(rawHostname) === 0 ? redactDiagnosticText(rawHostname) : maskNetworkAddress(rawHostname);
    const port = target.port ? `:${target.port}` : '';
    return `${target.protocol}//${hostname}${port}${redactDiagnosticText(target.pathname)}`.slice(
      0,
      1_024,
    );
  } catch {
    return redactDiagnosticText(value);
  }
};

const sanitizeEnvironment = (
  environment: NetworkEnvironmentAssessment,
): NetworkEnvironmentAssessment => ({
  ...environment,
  checks: environment.checks?.map((check) => ({
    ...check,
    detail: redactDiagnosticText(check.detail),
    freshness: 'cached',
    label: redactDiagnosticText(check.label),
    source: redactDiagnosticText(check.source),
    target: sanitizeDiagnosticTarget(check.target),
  })),
  cliLanguages: environment.cliLanguages?.map(redactDiagnosticText),
  cliTimezone: environment.cliTimezone ? redactDiagnosticText(environment.cliTimezone) : undefined,
  dnsDetail: redactDiagnosticText(environment.dnsDetail),
  issues: environment.issues.map((issue) => ({
    ...issue,
    detail: redactDiagnosticText(issue.detail),
    suggestedLanguages: issue.suggestedLanguages?.map(redactDiagnosticText),
    suggestedTimezone: issue.suggestedTimezone
      ? redactDiagnosticText(issue.suggestedTimezone)
      : undefined,
    title: redactDiagnosticText(issue.title),
  })),
  localLanguage: redactDiagnosticText(environment.localLanguage),
  localTimezone: redactDiagnosticText(environment.localTimezone),
  publicAddressObservations: environment.publicAddressObservations.map((observation) => ({
    ...observation,
    addressPrefix: observation.addressPrefix
      ? redactDiagnosticText(observation.addressPrefix)
      : undefined,
    countryCode: observation.countryCode
      ? redactDiagnosticText(observation.countryCode)
      : undefined,
    countryName: observation.countryName
      ? redactDiagnosticText(observation.countryName)
      : undefined,
    detail: redactDiagnosticText(observation.detail),
    endpoint: redactDiagnosticText(observation.endpoint),
    freshness: 'cached',
    networkProvider: observation.networkProvider
      ? redactDiagnosticText(observation.networkProvider)
      : undefined,
    observationProvider: redactDiagnosticText(observation.observationProvider),
    statement: redactDiagnosticText(observation.statement),
    timezone: observation.timezone ? redactDiagnosticText(observation.timezone) : undefined,
  })),
  summary: redactDiagnosticText(environment.summary),
});

const sanitizeProviderConnectivity = (
  assessment: NetworkProviderConnectivityAssessment,
): NetworkProviderConnectivityAssessment => ({
  ...assessment,
  featureAccess: assessment.featureAccess.map((access) => ({
    ...access,
    reason: access.reason ? redactDiagnosticText(access.reason) : undefined,
  })),
  probes: assessment.probes.map((probe) => ({
    ...probe,
    detail: redactDiagnosticText(probe.detail),
    label: redactDiagnosticText(probe.label),
    target: probe.target ? redactDiagnosticText(probe.target) : undefined,
  })),
  reasons: assessment.reasons.map(redactDiagnosticText),
  signals: assessment.signals.map((signal) => ({
    ...signal,
    detail: redactDiagnosticText(signal.detail),
    label: redactDiagnosticText(signal.label),
    source: redactDiagnosticText(signal.source),
  })),
  summary: redactDiagnosticText(assessment.summary),
});

const sanitizeAdvisoryEvidence = (
  assessment: NetworkAdvisoryEvidenceAssessment,
): NetworkAdvisoryEvidenceAssessment => ({
  ...assessment,
  ...(assessment.environment ? { environment: sanitizeEnvironment(assessment.environment) } : {}),
  paths: assessment.paths.map((item) => ({
    ...item,
    detail: redactDiagnosticText(item.detail),
    dnsServers: item.dnsServers.slice(0, 8).map(maskNetworkAddress),
    target: sanitizeDiagnosticTarget(item.target),
    virtualInterfaces: item.virtualInterfaces.slice(0, 12).map(redactDiagnosticText),
  })),
  reasons: assessment.reasons.map(redactDiagnosticText),
  signals: assessment.signals.map((signal) => ({
    ...signal,
    detail: redactDiagnosticText(signal.detail),
    label: redactDiagnosticText(signal.label),
    source: redactDiagnosticText(signal.source),
  })),
  summary: redactDiagnosticText(assessment.summary),
});

const sanitizeResult = (result: NetworkPreflightResult): NetworkPreflightHistoryEntryV2 => {
  const {
    canonicalCwd: omittedCanonicalCwd,
    environment: omittedEnvironment,
    featureAccess: omittedFeatureAccess,
    paths: omittedPaths,
    probes: omittedProbes,
    reasons: omittedReasons,
    riskLevel: omittedRiskLevel,
    riskScore: omittedRiskScore,
    signals: omittedSignals,
    status: omittedStatus,
    summary: omittedSummary,
    ...historyEntry
  } = result;
  void omittedCanonicalCwd;
  void omittedEnvironment;
  void omittedFeatureAccess;
  void omittedPaths;
  void omittedProbes;
  void omittedReasons;
  void omittedRiskLevel;
  void omittedRiskScore;
  void omittedSignals;
  void omittedStatus;
  void omittedSummary;
  return {
    ...historyEntry,
    advisoryEvidence: sanitizeAdvisoryEvidence(result.advisoryEvidence),
    providerConnectivity: sanitizeProviderConnectivity(result.providerConnectivity),
    providerLabel: redactDiagnosticText(result.providerLabel),
  };
};

const sanitizeLegacyValue = (value: unknown, key = '', depth = 0): unknown => {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') {
    if (key === 'dnsServers' && isIP(value) !== 0) return maskNetworkAddress(value);
    return redactDiagnosticText(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 256).map((item) => sanitizeLegacyValue(item, key, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([entryKey]) => entryKey !== 'canonicalCwd' && entryKey !== 'cwd')
      .map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeLegacyValue(entryValue, entryKey, depth + 1),
      ]),
  );
};

const legacyEntry = (value: Record<string, unknown>): NetworkPreflightHistoryEntryV1 => ({
  ...(typeof value.checkedAt === 'number' ? { checkedAt: value.checkedAt } : {}),
  legacyComposite: sanitizeLegacyValue(value) as Record<string, unknown>,
  schemaVersion: 1,
  startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
});

interface LoadedHistory {
  entries: NetworkPreflightHistoryEntry[];
  needsMigration: boolean;
}

const entryTimestamp = (entry: NetworkPreflightHistoryEntry): number =>
  entry.checkedAt ?? entry.startedAt;

const isVersion2Entry = (entry: unknown): entry is NetworkPreflightHistoryEntryV2 => {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<NetworkPreflightHistoryEntryV2>;
  return (
    candidate.schemaVersion === 2 &&
    typeof candidate.provider === 'string' &&
    Boolean(candidate.providerConnectivity) &&
    Array.isArray(candidate.providerConnectivity?.probes) &&
    Boolean(candidate.advisoryEvidence) &&
    Array.isArray(candidate.advisoryEvidence?.paths) &&
    typeof candidate.startedAt === 'number'
  );
};

const ENVIRONMENT_CHECK_CONFIDENCE = new Set(['high', 'low', 'medium', 'unknown']);
const ENVIRONMENT_CHECK_PROCESSES = new Set([
  'application',
  'claude-cli',
  'codex-cli',
  'network-diagnostics',
  'oauth-browser',
  'renderer',
  'terminal',
]);
const ENVIRONMENT_CHECK_TRANSPORTS = new Set([
  'curl-cli',
  'derived',
  'local-system',
  'not-collected',
  'system-dns',
]);

const historicalEnvironmentCheckTransport = (
  check: NetworkEnvironmentCheck,
): NetworkEnvironmentCheck['transport'] => {
  if (ENVIRONMENT_CHECK_TRANSPORTS.has(check.transport)) return check.transport;
  switch (check.id) {
    case 'dns-authoritative':
      return 'system-dns';
    case 'ipv6-public-address':
      return /Windows/i.test(check.source) ? 'local-system' : 'curl-cli';
    case 'stun-public-address':
      return 'not-collected';
    case 'language':
    case 'timezone':
      return 'derived';
    case 'ip-reputation':
    case 'public-address-ipip':
    case 'public-address-ipquery':
      return 'curl-cli';
  }
};

const historicalEnvironmentCheckTarget = (check: NetworkEnvironmentCheck): string => {
  if (typeof check.target === 'string' && check.target.trim()) return check.target;
  switch (check.id) {
    case 'dns-authoritative':
      return '*.test.dnscheck.tools TXT';
    case 'ip-reputation':
      return 'https://proxycheck.io/v2/{redacted-address} + https://api.stopforumspam.org/api';
    case 'ipv6-public-address':
      return /Windows/i.test(check.source)
        ? 'Windows network interfaces'
        : 'https://api6.ipify.org?format=json';
    case 'language':
      return 'Windows preferred languages + https://api.ipquery.io/?format=json';
    case 'public-address-ipip':
      return 'https://myip.ipip.net';
    case 'public-address-ipquery':
      return 'https://api.ipquery.io/?format=json';
    case 'stun-public-address':
      return 'WebRTC STUN public-address collection';
    case 'timezone':
      return 'local Intl timezone + https://api.ipquery.io/?format=json';
  }
};

const environmentHistoryNeedsMigration = (
  environment: NetworkEnvironmentAssessment | undefined,
): boolean =>
  Boolean(
    environment &&
    (environment.publicAddressObservations.some(
      (observation) => observation.freshness !== 'cached',
    ) ||
      environment.checks?.some(
        (check) =>
          check.authority !== 'advisory-only' ||
          !Number.isFinite(check.checkedAt) ||
          !ENVIRONMENT_CHECK_CONFIDENCE.has(check.confidence) ||
          check.freshness !== 'cached' ||
          check.networkScope === undefined ||
          !ENVIRONMENT_CHECK_PROCESSES.has(check.process) ||
          typeof check.target !== 'string' ||
          !ENVIRONMENT_CHECK_TRANSPORTS.has(check.transport),
      )),
  );

const normalizeHistoryEnvironment = (
  environment: NetworkEnvironmentAssessment,
): NetworkEnvironmentAssessment => ({
  ...environment,
  checks: environment.checks?.map((check): NetworkEnvironmentCheck => ({
    ...check,
    authority: 'advisory-only',
    checkedAt: Number.isFinite(check.checkedAt) ? check.checkedAt : environment.checkedAt,
    confidence: ENVIRONMENT_CHECK_CONFIDENCE.has(check.confidence) ? check.confidence : 'unknown',
    freshness: 'cached',
    networkScope: check.networkScope === 'conversation' ? 'conversation' : 'application',
    process: ENVIRONMENT_CHECK_PROCESSES.has(check.process) ? check.process : 'network-diagnostics',
    target: historicalEnvironmentCheckTarget(check),
    transport: historicalEnvironmentCheckTransport(check),
  })),
  publicAddressObservations: environment.publicAddressObservations.map((observation) => ({
    ...observation,
    freshness: 'cached',
  })),
});

const normalizeHistoryEntry = (
  entry: NetworkPreflightHistoryEntryV2,
): NetworkPreflightHistoryEntryV2 => {
  const environment = entry.advisoryEvidence.environment;
  if (!environment) return entry;
  return {
    ...entry,
    advisoryEvidence: {
      ...entry.advisoryEvidence,
      environment: normalizeHistoryEnvironment(environment),
    },
  };
};

const isVersion1Entry = (entry: unknown): entry is NetworkPreflightHistoryEntryV1 => {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<NetworkPreflightHistoryEntryV1>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.startedAt === 'number' &&
    Boolean(candidate.legacyComposite) &&
    typeof candidate.legacyComposite === 'object'
  );
};

const isLegacyComposite = (entry: unknown): entry is Record<string, unknown> =>
  Boolean(
    entry &&
    typeof entry === 'object' &&
    typeof (entry as Record<string, unknown>).provider === 'string' &&
    typeof (entry as Record<string, unknown>).status === 'string' &&
    Array.isArray((entry as Record<string, unknown>).probes),
  );

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
    const entries = [sanitizeResult(result), ...this.load().entries]
      .filter((entry) => entryTimestamp(entry) >= this.now() - RETENTION_MS)
      .slice(0, MAX_ENTRIES);
    this.persist(entries);
  }

  public clear(): NetworkPreflightHistoryView {
    this.persist([]);
    return this.getView();
  }

  public getView(): NetworkPreflightHistoryView {
    const loaded = this.load();
    const entries = loaded.entries
      .filter((entry) => entryTimestamp(entry) >= this.now() - RETENTION_MS)
      .slice(0, MAX_ENTRIES);
    if (loaded.needsMigration || entries.length !== loaded.entries.length) this.persist(entries);
    return { entries, retentionDays: RETENTION_DAYS };
  }

  private load(): LoadedHistory {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        entries?: unknown;
        version?: unknown;
      };
      if (!Array.isArray(parsed.entries)) return { entries: [], needsMigration: false };
      if (parsed.version === 1) {
        const entries = parsed.entries.filter(isLegacyComposite).map(legacyEntry);
        return { entries, needsMigration: true };
      }
      if (parsed.version !== 2) return { entries: [], needsMigration: false };
      const retainedEntries = parsed.entries.filter(
        (entry): entry is NetworkPreflightHistoryEntry =>
          isVersion2Entry(entry) || isVersion1Entry(entry),
      );
      const needsEvidenceMigration = retainedEntries.some(
        (entry) =>
          isVersion2Entry(entry) &&
          environmentHistoryNeedsMigration(entry.advisoryEvidence.environment),
      );
      const entries = retainedEntries.map((entry) =>
        isVersion2Entry(entry) ? normalizeHistoryEntry(entry) : entry,
      );
      return {
        entries,
        needsMigration: needsEvidenceMigration || retainedEntries.length !== parsed.entries.length,
      };
    } catch {
      return { entries: [], needsMigration: false };
    }
  }

  private persist(entries: NetworkPreflightHistoryEntry[]): void {
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ entries, version: 2 }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }
}
