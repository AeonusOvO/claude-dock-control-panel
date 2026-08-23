import { isIP } from 'node:net';

const DEFAULT_TOTAL_DEADLINE_MS = 8_000;
const MAX_TOTAL_DEADLINE_MS = 60_000;
const MAX_OS_RESOLVERS = 32;
const MAX_SESSION_ADDRESSES = 64;
const MAX_ADDRESS_LENGTH = 64;
const MIN_OPAQUE_ID_LENGTH = 32;
const MAX_OPAQUE_ID_LENGTH = 192;
const MIN_NONCE_LENGTH = 24;
const MAX_NONCE_LENGTH = 63;
const MIN_SIGNATURE_LENGTH = 43;
const MAX_SIGNATURE_LENGTH = 192;

export type * from './dns-correlation-types';

import type {
  ApprovedDnsCorrelationServicePolicy,
  ApplicationSessionResolverEvidence,
  AuthoritativeDnsCorrelationEvidence,
  CollectDnsEvidenceInput,
  DnsAddressHmacSigner,
  DnsAddressObservation,
  DnsApplicationSessionRequest,
  DnsApplicationSessionRequester,
  DnsApplicationSessionResponse,
  DnsCorrelationCollectorPorts,
  DnsCorrelationResultParsePolicy,
  DnsCorrelationState,
  DnsEvidenceCollection,
  EcsObservation,
  OsResolverConfigurationEvidence,
  ParsedDnsCorrelationResult,
  PersistedDnsAddressEvidence,
  PersistedDnsEvidenceCollection,
  ReadOsResolverFacts,
  RecursiveResolverObservation,
  ResolveApplicationSessionHost,
  SignedDnsCorrelationGrant,
  VerifySignedDnsCorrelationGrant,
} from './dns-correlation-types';

interface ValidatedPolicy extends ApprovedDnsCorrelationServicePolicy {
  readonly controlUrl: string;
  readonly resultUrl: string;
}

interface Deadline {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly stop: () => void;
}

class RejectedRemoteDnsDataError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (record: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(record).every((key) => keys.has(key));

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const abortError = (): Error => {
  const error = new Error('DNS evidence collection was aborted.');
  error.name = 'AbortError';
  return error;
};

const normalizeHostname = (value: string): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 254 ||
    value.trim() !== value
  ) {
    throw new TypeError('Invalid DNS hostname.');
  }
  const normalized = value.endsWith('.') ? value.slice(0, -1).toLowerCase() : value.toLowerCase();
  if (normalized.length === 0 || normalized.length > 253 || isIP(normalized) !== 0) {
    throw new TypeError('Invalid DNS hostname.');
  }
  const labels = normalized.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new TypeError('Invalid DNS hostname.');
  }
  return normalized;
};

const fixedHttpsOrigin = (value: string): string | undefined => {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      value !== parsed.origin
    ) {
      return undefined;
    }
    normalizeHostname(parsed.hostname);
    return parsed.origin;
  } catch {
    return undefined;
  }
};

const fixedPathUrl = (origin: string, path: string): string | undefined => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return undefined;
  try {
    const parsed = new URL(path, origin);
    if (
      parsed.origin !== origin ||
      parsed.pathname !== path ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
};

const boundedInteger = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const validatePolicy = (
  policy: ApprovedDnsCorrelationServicePolicy | undefined,
): ValidatedPolicy | undefined => {
  if (!policy || policy.approval !== 'main-owned-dns-correlation-service') return undefined;
  const controlOrigin = fixedHttpsOrigin(policy.controlOrigin);
  const resultOrigin = fixedHttpsOrigin(policy.resultOrigin);
  if (!controlOrigin || !resultOrigin) return undefined;
  const controlUrl = fixedPathUrl(controlOrigin, policy.controlPath);
  const resultUrl = fixedPathUrl(resultOrigin, policy.resultPath);
  let suffix: string;
  try {
    suffix = normalizeHostname(policy.correlationSuffix);
  } catch {
    return undefined;
  }
  if (suffix !== policy.correlationSuffix || suffix.split('.').length < 2) return undefined;
  const limitsAreValid =
    boundedInteger(policy.totalDeadlineMs, 1, MAX_TOTAL_DEADLINE_MS) &&
    boundedInteger(policy.requestTimeoutMs, 1, policy.totalDeadlineMs) &&
    boundedInteger(policy.maxControlResponseBytes, 128, 65_536) &&
    boundedInteger(policy.maxResultResponseBytes, 128, 65_536) &&
    boundedInteger(policy.maxProbeResponseBytes, 0, 65_536) &&
    boundedInteger(policy.maxPollAttempts, 1, 20) &&
    boundedInteger(policy.pollIntervalMs, 0, 5_000) &&
    boundedInteger(policy.maxResolverAddresses, 1, 32) &&
    boundedInteger(policy.maxTokenLifetimeMs, 1_000, 10 * 60_000) &&
    boundedInteger(policy.maxClockSkewMs, 0, 5 * 60_000) &&
    typeof policy.allowExactEcsSubnet === 'boolean';
  if (!controlUrl || !resultUrl || !limitsAreValid) return undefined;
  return {
    ...policy,
    controlOrigin,
    controlUrl,
    correlationSuffix: suffix,
    resultOrigin,
    resultUrl,
  };
};

const parseBoundedJsonObject = (body: string, maxBytes: number): Record<string, unknown> => {
  if (typeof body !== 'string' || byteLength(body) > maxBytes) {
    throw new TypeError('DNS service response exceeded its fixed limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TypeError('DNS service returned invalid JSON.');
  }
  if (!isRecord(parsed)) throw new TypeError('DNS service returned an invalid object.');
  return parsed;
};

const looksUnpredictable = (
  value: unknown,
  alphabet: RegExp,
  minimum: number,
  maximum: number,
): value is string =>
  typeof value === 'string' &&
  value.length >= minimum &&
  value.length <= maximum &&
  alphabet.test(value) &&
  new Set(value).size >= 8;

const CONTROL_KEYS = new Set(['expiresAt', 'hostname', 'id', 'nonce', 'signature']);

const parseControlGrant = (
  body: string,
  policy: ValidatedPolicy,
  now: number,
): SignedDnsCorrelationGrant => {
  const parsed = parseBoundedJsonObject(body, policy.maxControlResponseBytes);
  if (!hasOnlyKeys(parsed, CONTROL_KEYS)) throw new TypeError('Unexpected DNS control field.');
  if (
    !looksUnpredictable(
      parsed.id,
      /^[A-Za-z0-9_-]+$/,
      MIN_OPAQUE_ID_LENGTH,
      MAX_OPAQUE_ID_LENGTH,
    ) ||
    !looksUnpredictable(
      parsed.nonce,
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      MIN_NONCE_LENGTH,
      MAX_NONCE_LENGTH,
    ) ||
    !looksUnpredictable(
      parsed.signature,
      /^[A-Za-z0-9_-]+$/,
      MIN_SIGNATURE_LENGTH,
      MAX_SIGNATURE_LENGTH,
    ) ||
    !boundedInteger(parsed.expiresAt as number, now + 1, now + policy.maxTokenLifetimeMs)
  ) {
    throw new TypeError('Invalid signed DNS control grant.');
  }
  const hostname = `${parsed.nonce}.${policy.correlationSuffix}`;
  if (normalizeHostname(hostname) !== hostname || hostname.length > 253) {
    throw new TypeError('Invalid correlation hostname.');
  }
  if (parsed.hostname !== undefined && normalizeHostname(String(parsed.hostname)) !== hostname) {
    throw new TypeError('Correlation hostname is outside the approved suffix.');
  }
  return {
    expiresAt: parsed.expiresAt as number,
    hostname,
    id: parsed.id,
    nonce: parsed.nonce,
    signature: parsed.signature,
  };
};

const parseAddress = (value: unknown, family?: unknown): DnsAddressObservation => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ADDRESS_LENGTH ||
    value.trim() !== value ||
    value.includes('%')
  ) {
    throw new TypeError('Invalid DNS address.');
  }
  const version = isIP(value);
  const actualFamily = version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : undefined;
  if (!actualFamily || (family !== undefined && family !== actualFamily)) {
    throw new TypeError('DNS address family mismatch.');
  }
  return { address: value, family: actualFamily };
};

const parseOptionalTime = (
  value: unknown,
  now: number,
  maxClockSkewMs: number,
): number | undefined => {
  if (value === undefined) return undefined;
  if (!boundedInteger(value as number, 0, now + maxClockSkewMs)) {
    throw new TypeError('Invalid DNS observation time.');
  }
  return value as number;
};

const subnetHasZeroHostBits = (address: string, prefixLength: number, family: 4 | 6): boolean => {
  const bytes =
    family === 4
      ? address.split('.').map(Number)
      : expandIpv6(address).flatMap((group) => [group >>> 8, group & 0xff]);
  const wholeBytes = Math.floor(prefixLength / 8);
  const remainingBits = prefixLength % 8;
  if (remainingBits > 0 && ((bytes[wholeBytes] ?? 0) & ((1 << (8 - remainingBits)) - 1)) !== 0) {
    return false;
  }
  const firstHostByte = wholeBytes + (remainingBits > 0 ? 1 : 0);
  return bytes.slice(firstHostByte).every((byte) => byte === 0);
};

const parseEcs = (value: unknown, allowExactSubnet: boolean): EcsObservation => {
  if (value === undefined) return { observed: false };
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(['exactSubnet', 'observed', 'prefixLength']))
  ) {
    throw new TypeError('Invalid ECS observation.');
  }
  if (typeof value.observed !== 'boolean') throw new TypeError('Invalid ECS observation.');
  if (!value.observed) {
    if (value.prefixLength !== undefined || value.exactSubnet !== undefined) {
      throw new TypeError('Unobserved ECS cannot include subnet data.');
    }
    return { observed: false };
  }
  let subnetFamily: 4 | 6 | undefined;
  let subnetPrefix: number | undefined;
  if (value.exactSubnet !== undefined) {
    if (!allowExactSubnet || typeof value.exactSubnet !== 'string') {
      throw new TypeError('Exact ECS subnet is not permitted.');
    }
    const separator = value.exactSubnet.lastIndexOf('/');
    if (separator <= 0) throw new TypeError('Invalid ECS subnet.');
    const address = value.exactSubnet.slice(0, separator);
    const candidateFamily = isIP(address);
    if (candidateFamily !== 4 && candidateFamily !== 6) {
      throw new TypeError('Invalid ECS subnet.');
    }
    subnetFamily = candidateFamily;
    subnetPrefix = Number(value.exactSubnet.slice(separator + 1));
    const maximum = subnetFamily === 4 ? 32 : 128;
    if (
      !boundedInteger(subnetPrefix, 0, maximum) ||
      !subnetHasZeroHostBits(address, subnetPrefix, subnetFamily)
    ) {
      throw new TypeError('Invalid ECS subnet.');
    }
  }
  if (value.prefixLength !== undefined) {
    const maximum = subnetFamily === 4 ? 32 : 128;
    if (!boundedInteger(value.prefixLength as number, 0, maximum)) {
      throw new TypeError('Invalid ECS prefix length.');
    }
    if (subnetPrefix !== undefined && value.prefixLength !== subnetPrefix) {
      throw new TypeError('ECS prefix length mismatch.');
    }
  }
  return value.prefixLength === undefined
    ? { observed: true }
    : { observed: true, prefixLength: value.prefixLength as number };
};

const RESULT_KEYS = new Set(['ecs', 'observedAt', 'resolvers', 'sourceTime', 'state']);
const RESOLVER_KEYS = new Set(['address', 'family']);

/** Strictly parses a bounded service result and deliberately drops any accepted exact ECS subnet. */
export const parseDnsCorrelationResult = (
  body: string,
  policy: DnsCorrelationResultParsePolicy,
): ParsedDnsCorrelationResult => {
  if (
    !boundedInteger(policy.maxResponseBytes, 1, 65_536) ||
    !boundedInteger(policy.maxResolverAddresses, 1, 32) ||
    !boundedInteger(policy.maxClockSkewMs, 0, 5 * 60_000) ||
    !boundedInteger(policy.now, 0, Number.MAX_SAFE_INTEGER)
  ) {
    throw new TypeError('Invalid DNS result parsing policy.');
  }
  const parsed = parseBoundedJsonObject(body, policy.maxResponseBytes);
  if (!hasOnlyKeys(parsed, RESULT_KEYS)) throw new TypeError('Unexpected DNS result field.');
  if (
    !['complete', 'correlated', 'partial', 'pending', 'unavailable'].includes(String(parsed.state))
  ) {
    throw new TypeError('Invalid DNS correlation state.');
  }
  if (!Array.isArray(parsed.resolvers) && parsed.resolvers !== undefined) {
    throw new TypeError('Invalid recursive resolver list.');
  }
  const rawResolvers = parsed.resolvers ?? [];
  if (rawResolvers.length > policy.maxResolverAddresses) {
    throw new TypeError('Recursive resolver count exceeded its fixed limit.');
  }
  const recursiveResolvers: RecursiveResolverObservation[] = [];
  const seen = new Set<string>();
  for (const candidate of rawResolvers) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, RESOLVER_KEYS)) {
      throw new TypeError('Invalid recursive resolver entry.');
    }
    const address = parseAddress(candidate.address, candidate.family);
    const key = `${address.family}:${address.address.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      recursiveResolvers.push(address);
    }
  }
  const ecs = parseEcs(parsed.ecs, policy.allowExactEcsSubnet);
  const observedAt = parseOptionalTime(parsed.observedAt, policy.now, policy.maxClockSkewMs);
  const sourceTime = parseOptionalTime(parsed.sourceTime, policy.now, policy.maxClockSkewMs);
  const rawState = String(parsed.state);
  if (rawState === 'pending' && (recursiveResolvers.length > 0 || ecs.observed)) {
    throw new TypeError('Pending DNS result contained attributed evidence.');
  }
  const state: ParsedDnsCorrelationResult['state'] =
    rawState === 'unavailable'
      ? 'unavailable'
      : rawState === 'pending'
        ? 'pending'
        : (rawState === 'complete' || rawState === 'correlated') && recursiveResolvers.length > 0
          ? 'correlated'
          : 'partial';
  return {
    ecs,
    ...(observedAt === undefined ? {} : { observedAt }),
    recursiveResolvers,
    ...(sourceTime === undefined ? {} : { sourceTime }),
    state,
  };
};

const createDeadline = (
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  now: () => number,
): Deadline => {
  const controller = new AbortController();
  const deadlineAt = now() + timeoutMs;
  const onParentAbort = (): void => controller.abort(abortError());
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(abortError()), timeoutMs);
  timer.unref?.();
  return {
    deadlineAt,
    signal: controller.signal,
    stop: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
};

const raceWithAbort = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};

const defaultDelay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  raceWithAbort(
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref?.();
    }),
    signal,
  );

const safeDrain = (response: DnsApplicationSessionResponse): void => {
  try {
    response.drain();
  } catch {
    // The transport already owns the response; diagnostics never log body or transport errors.
  }
};

const assertBoundedTransportResponse = (
  response: DnsApplicationSessionResponse,
  maxResponseBytes: number,
): void => {
  if (
    typeof response.body !== 'string' ||
    byteLength(response.body) > maxResponseBytes ||
    typeof response.contentType !== 'string' ||
    response.contentType.length > 256 ||
    !boundedInteger(response.status, 100, 599)
  ) {
    throw new TypeError('Application-Session DNS transport returned an invalid bounded response.');
  }
};

const requestAndConsume = async <T>(
  requester: DnsApplicationSessionRequester,
  request: Omit<DnsApplicationSessionRequest, 'deadlineAt' | 'privacy' | 'signal'>,
  parent: Deadline,
  timeoutMs: number,
  now: () => number,
  consume: (response: DnsApplicationSessionResponse) => T,
): Promise<T> => {
  const remaining = Math.max(1, parent.deadlineAt - now());
  const stage = createDeadline(Math.min(timeoutMs, remaining), parent.signal, now);
  const pending = Promise.resolve()
    .then(() =>
      requester({
        ...request,
        deadlineAt: Math.min(parent.deadlineAt, stage.deadlineAt),
        privacy: 'never-log-url-body-or-addresses',
        signal: stage.signal,
      }),
    )
    .then((response) => {
      if (stage.signal.aborted) {
        safeDrain(response);
        throw abortError();
      }
      return response;
    });
  try {
    const response = await raceWithAbort(pending, stage.signal);
    try {
      assertBoundedTransportResponse(response, request.maxResponseBytes);
      return consume(response);
    } finally {
      safeDrain(response);
    }
  } finally {
    stage.stop();
  }
};

const unavailableOsEvidence = (observedAt: number): OsResolverConfigurationEvidence => ({
  applicationRequestCorrelationEstablished: false,
  dnsOverHttps: 'unknown',
  electronSessionResolutionEstablished: false,
  lane: 'os-resolver-configuration',
  observedAt,
  proxyDestinationDnsRoutingEstablished: false,
  resolverAddresses: [],
  state: 'unavailable',
  weight: 'supporting-only',
});

const collectOsEvidence = async (
  reader: ReadOsResolverFacts | undefined,
  deadline: Deadline,
  now: () => number,
): Promise<OsResolverConfigurationEvidence> => {
  const observedAt = now();
  if (!reader) return unavailableOsEvidence(observedAt);
  try {
    const facts = await raceWithAbort(
      Promise.resolve().then(() => reader(deadline.signal)),
      deadline.signal,
    );
    let partial = facts.resolverAddresses.length > MAX_OS_RESOLVERS;
    const addresses: DnsAddressObservation[] = [];
    const seen = new Set<string>();
    for (const value of facts.resolverAddresses.slice(0, MAX_OS_RESOLVERS)) {
      try {
        const address = parseAddress(value);
        const key = `${address.family}:${address.address.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          addresses.push(address);
        }
      } catch {
        partial = true;
      }
    }
    const factTime = parseOptionalTime(facts.observedAt, now(), 5 * 60_000);
    const dnsOverHttps = facts.dnsOverHttps ?? 'unknown';
    if (!['automatic', 'disabled', 'enabled', 'mixed', 'unknown'].includes(dnsOverHttps)) {
      partial = true;
    }
    return {
      applicationRequestCorrelationEstablished: false,
      dnsOverHttps: ['automatic', 'disabled', 'enabled', 'mixed', 'unknown'].includes(dnsOverHttps)
        ? dnsOverHttps
        : 'unknown',
      electronSessionResolutionEstablished: false,
      lane: 'os-resolver-configuration',
      observedAt: factTime ?? observedAt,
      proxyDestinationDnsRoutingEstablished: false,
      resolverAddresses: addresses,
      state: partial ? 'partial' : 'observed',
      weight: 'supporting-only',
    };
  } catch {
    return unavailableOsEvidence(observedAt);
  }
};

const unavailableSessionEvidence = (
  hostname: string,
  observedAt: number,
): ApplicationSessionResolverEvidence => ({
  addresses: [],
  applicationRequestCorrelationEstablished: false,
  hostname,
  lane: 'electron-application-session-resolver',
  observedAt,
  proxyDestinationDnsRoutingEstablished: false,
  state: 'unavailable',
  weight: 'session-resolver-observation-only',
});

const collectSessionEvidence = async (
  hostname: string,
  resolver: ResolveApplicationSessionHost,
  deadline: Deadline,
  now: () => number,
): Promise<ApplicationSessionResolverEvidence> => {
  const observedAt = now();
  const query = async (queryType: 'A' | 'AAAA') => {
    try {
      const result = await raceWithAbort(
        Promise.resolve().then(() =>
          resolver(hostname, {
            cacheUsage: 'disallowed',
            queryType,
            secureDnsPolicy: 'allow',
          }),
        ),
        deadline.signal,
      );
      let invalid = result.endpoints.length > MAX_SESSION_ADDRESSES;
      const expectedFamily = queryType === 'A' ? 'ipv4' : 'ipv6';
      const addresses: DnsAddressObservation[] = [];
      for (const endpoint of result.endpoints.slice(0, MAX_SESSION_ADDRESSES)) {
        try {
          const address = parseAddress(
            endpoint.address,
            endpoint.family === 'unspec' ? expectedFamily : endpoint.family,
          );
          if (address.family !== expectedFamily) throw new TypeError('Unexpected query family.');
          addresses.push(address);
        } catch {
          invalid = true;
        }
      }
      return { addresses, failed: false, invalid };
    } catch {
      return { addresses: [] as DnsAddressObservation[], failed: true, invalid: false };
    }
  };
  const [a, aaaa] = await Promise.all([query('A'), query('AAAA')]);
  const seen = new Set<string>();
  const addresses = [...a.addresses, ...aaaa.addresses].filter((address) => {
    const key = `${address.family}:${address.address.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (a.failed && aaaa.failed && addresses.length === 0) {
    return unavailableSessionEvidence(hostname, observedAt);
  }
  return {
    addresses,
    applicationRequestCorrelationEstablished: false,
    hostname,
    lane: 'electron-application-session-resolver',
    observedAt,
    proxyDestinationDnsRoutingEstablished: false,
    state: a.failed || aaaa.failed || a.invalid || aaaa.invalid ? 'partial' : 'observed',
    weight: 'session-resolver-observation-only',
  };
};

const correlationEvidence = (
  state: DnsCorrelationState,
  parsed?: ParsedDnsCorrelationResult,
): AuthoritativeDnsCorrelationEvidence => ({
  attribution: 'application-session-request-correlation-only',
  ecs: parsed?.ecs ?? { observed: false },
  lane: 'authoritative-application-request-correlation',
  ...(parsed?.observedAt === undefined ? {} : { observedAt: parsed.observedAt }),
  proxyDestinationDnsRoutingEstablished: false,
  recursiveResolvers: parsed?.recursiveResolvers ?? [],
  ...(parsed?.sourceTime === undefined ? {} : { sourceTime: parsed.sourceTime }),
  state,
});

const controlResponse = (
  response: DnsApplicationSessionResponse,
  policy: ValidatedPolicy,
  now: number,
): SignedDnsCorrelationGrant => {
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.contentType)) {
    throw new TypeError('DNS control endpoint was unavailable.');
  }
  return parseControlGrant(response.body, policy, now);
};

const resultResponse = (
  response: DnsApplicationSessionResponse,
  policy: ValidatedPolicy,
  now: number,
): ParsedDnsCorrelationResult | undefined => {
  if (response.status === 202 || response.status === 404) return undefined;
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.contentType)) {
    throw new RejectedRemoteDnsDataError('DNS result endpoint returned an invalid response.');
  }
  try {
    return parseDnsCorrelationResult(response.body, {
      allowExactEcsSubnet: policy.allowExactEcsSubnet,
      maxClockSkewMs: policy.maxClockSkewMs,
      maxResolverAddresses: policy.maxResolverAddresses,
      maxResponseBytes: policy.maxResultResponseBytes,
      now,
    });
  } catch {
    throw new RejectedRemoteDnsDataError('DNS result endpoint returned invalid data.');
  }
};

const collectAuthoritativeCorrelation = async (
  suppliedPolicy: ApprovedDnsCorrelationServicePolicy | undefined,
  requester: DnsApplicationSessionRequester | undefined,
  verifier: VerifySignedDnsCorrelationGrant | undefined,
  deadline: Deadline,
  now: () => number,
  delay: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): Promise<AuthoritativeDnsCorrelationEvidence> => {
  if (!suppliedPolicy) return correlationEvidence('disabled');
  const policy = validatePolicy(suppliedPolicy);
  if (!policy || !requester || !verifier) return correlationEvidence('unavailable');
  try {
    const grant = await requestAndConsume(
      requester,
      {
        cache: 'no-store',
        credentials: 'omit',
        maxResponseBytes: policy.maxControlResponseBytes,
        method: 'GET',
        purpose: 'control',
        redirect: 'error',
        url: policy.controlUrl,
      },
      deadline,
      policy.requestTimeoutMs,
      now,
      (response) => controlResponse(response, policy, now()),
    );
    const verified = await raceWithAbort(
      Promise.resolve(verifier(grant, deadline.signal)),
      deadline.signal,
    );
    if (!verified || grant.expiresAt <= now()) return correlationEvidence('unavailable');

    try {
      await requestAndConsume(
        requester,
        {
          cache: 'no-store',
          credentials: 'omit',
          maxResponseBytes: policy.maxProbeResponseBytes,
          method: 'GET',
          purpose: 'correlation-host',
          redirect: 'error',
          url: `https://${grant.hostname}/`,
        },
        deadline,
        Math.min(policy.requestTimeoutMs, Math.max(1, grant.expiresAt - now())),
        now,
        () => undefined,
      );
    } catch {
      if (deadline.signal.aborted || grant.expiresAt <= now()) {
        return correlationEvidence('partial');
      }
    }

    const resultUrl = new URL(policy.resultUrl);
    resultUrl.searchParams.set('id', grant.id);
    let bestPartial: ParsedDnsCorrelationResult | undefined;
    for (let attempt = 0; attempt < policy.maxPollAttempts; attempt += 1) {
      if (deadline.signal.aborted || grant.expiresAt <= now()) break;
      let parsed: ParsedDnsCorrelationResult | undefined;
      try {
        parsed = await requestAndConsume(
          requester,
          {
            cache: 'no-store',
            credentials: 'omit',
            maxResponseBytes: policy.maxResultResponseBytes,
            method: 'GET',
            purpose: 'result',
            redirect: 'error',
            url: resultUrl.href,
          },
          deadline,
          Math.min(policy.requestTimeoutMs, Math.max(1, grant.expiresAt - now())),
          now,
          (response) => resultResponse(response, policy, now()),
        );
      } catch (error) {
        if (error instanceof RejectedRemoteDnsDataError) {
          return correlationEvidence('unavailable');
        }
        if (deadline.signal.aborted) break;
      }
      if (parsed?.state === 'correlated') return correlationEvidence('correlated', parsed);
      if (parsed?.state === 'unavailable') return correlationEvidence('unavailable', parsed);
      if (parsed?.state === 'partial') bestPartial = parsed;
      if (attempt + 1 < policy.maxPollAttempts && policy.pollIntervalMs > 0) {
        try {
          await raceWithAbort(delay(policy.pollIntervalMs, deadline.signal), deadline.signal);
        } catch {
          break;
        }
      }
    }
    return correlationEvidence('partial', bestPartial);
  } catch {
    return correlationEvidence('unavailable');
  }
};

/** Collects three separately attributed, advisory DNS evidence lanes without any network fallback. */
export const collectDnsCorrelationEvidence = async (
  ports: DnsCorrelationCollectorPorts,
  input: CollectDnsEvidenceInput,
): Promise<DnsEvidenceCollection> => {
  const hostname = normalizeHostname(input.hostname);
  const validatedPolicy = validatePolicy(input.approvedService);
  const requestedDeadline =
    input.totalDeadlineMs ?? validatedPolicy?.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS;
  if (!boundedInteger(requestedDeadline, 1, MAX_TOTAL_DEADLINE_MS)) {
    throw new TypeError('Invalid DNS evidence deadline.');
  }
  const totalDeadline = validatedPolicy
    ? Math.min(requestedDeadline, validatedPolicy.totalDeadlineMs)
    : requestedDeadline;
  const now = ports.now ?? Date.now;
  const deadline = createDeadline(totalDeadline, input.signal, now);
  const collectedAt = now();
  try {
    const [osResolverConfiguration, sessionResolverObservation, authoritativeCorrelation] =
      await Promise.all([
        collectOsEvidence(ports.readOsResolverFacts, deadline, now),
        collectSessionEvidence(hostname, ports.resolveApplicationSessionHost, deadline, now),
        collectAuthoritativeCorrelation(
          input.approvedService,
          ports.requestApplicationSession,
          ports.verifySignedGrant,
          deadline,
          now,
          ports.delay ?? defaultDelay,
        ),
      ]);
    return {
      advisoryOnly: true,
      authoritativeCorrelation,
      collectedAt,
      osResolverConfiguration,
      preflightDisposition: 'unchanged',
      sessionResolverObservation,
    };
  } finally {
    deadline.stop();
  }
};

function expandIpv6(address: string): number[] {
  let value = address.toLowerCase();
  const ipv4Index = value.lastIndexOf(':');
  const ipv4Tail = ipv4Index >= 0 ? value.slice(ipv4Index + 1) : '';
  if (isIP(ipv4Tail) === 4) {
    const octets = ipv4Tail.split('.').map(Number);
    value = `${value.slice(0, ipv4Index)}:${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':').map((part) => Number.parseInt(part, 16)) : [];
  const right = halves[1] ? halves[1].split(':').map((part) => Number.parseInt(part, 16)) : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  return [...left, ...Array.from({ length: zeros }, () => 0), ...right];
}

const compressIpv6 = (groups: readonly number[]): string => {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const text = groups.map((group) => group.toString(16));
  if (bestStart < 0) return text.join(':');
  return `${text.slice(0, bestStart).join(':')}::${text.slice(bestStart + bestLength).join(':')}`;
};

const canonicalAddress = (address: DnsAddressObservation): string =>
  address.family === 'ipv4'
    ? address.address.split('.').map(Number).join('.')
    : compressIpv6(expandIpv6(address.address));

const maskAddress = (address: DnsAddressObservation): string => {
  if (address.family === 'ipv4') {
    const octets = canonicalAddress(address).split('.');
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  const groups = expandIpv6(address.address);
  return `${compressIpv6([...groups.slice(0, 4), 0, 0, 0, 0])}/64`;
};

const redactAddress = (
  address: DnsAddressObservation,
  signer: DnsAddressHmacSigner,
): PersistedDnsAddressEvidence => {
  const normalized = parseAddress(address.address, address.family);
  const canonical = canonicalAddress(normalized);
  const digest = signer(`claudedock:dns-address:v1:${canonical}`);
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
    throw new TypeError('A keyed HMAC-SHA-256 signer is required for DNS persistence.');
  }
  return {
    family: normalized.family,
    fingerprint: `hmac-sha256:${Buffer.from(digest).toString('base64url')}`,
    network: maskAddress(normalized),
  };
};

const persistenceEcs = (ecs: EcsObservation): EcsObservation => ({
  observed: ecs.observed,
  ...(ecs.prefixLength === undefined ? {} : { prefixLength: ecs.prefixLength }),
});

/**
 * Pure persistence projection: every exact address is replaced by a /24 or /64 plus a caller-keyed
 * HMAC fingerprint. There is deliberately no hash or signer fallback.
 */
export const redactDnsEvidenceForPersistence = (
  evidence: DnsEvidenceCollection,
  signer: DnsAddressHmacSigner,
): PersistedDnsEvidenceCollection => ({
  advisoryOnly: true,
  authoritativeCorrelation: {
    attribution: evidence.authoritativeCorrelation.attribution,
    ecs: persistenceEcs(evidence.authoritativeCorrelation.ecs),
    ...(evidence.authoritativeCorrelation.observedAt === undefined
      ? {}
      : { observedAt: evidence.authoritativeCorrelation.observedAt }),
    proxyDestinationDnsRoutingEstablished: false,
    recursiveResolvers: evidence.authoritativeCorrelation.recursiveResolvers.map((address) =>
      redactAddress(address, signer),
    ),
    ...(evidence.authoritativeCorrelation.sourceTime === undefined
      ? {}
      : { sourceTime: evidence.authoritativeCorrelation.sourceTime }),
    state: evidence.authoritativeCorrelation.state,
  },
  collectedAt: evidence.collectedAt,
  osResolverConfiguration: {
    dnsOverHttps: evidence.osResolverConfiguration.dnsOverHttps,
    observedAt: evidence.osResolverConfiguration.observedAt,
    resolverAddresses: evidence.osResolverConfiguration.resolverAddresses.map((address) =>
      redactAddress(address, signer),
    ),
    state: evidence.osResolverConfiguration.state,
    weight: 'supporting-only',
  },
  preflightDisposition: 'unchanged',
  schemaVersion: 1,
  sessionResolverObservation: {
    addresses: evidence.sessionResolverObservation.addresses.map((address) =>
      redactAddress(address, signer),
    ),
    hostname: evidence.sessionResolverObservation.hostname,
    observedAt: evidence.sessionResolverObservation.observedAt,
    state: evidence.sessionResolverObservation.state,
    weight: 'session-resolver-observation-only',
  },
});
