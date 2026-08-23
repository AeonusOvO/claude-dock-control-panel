import type {
  EgressDiagnosticIssue,
  EgressLiveSourceEvidence,
  EgressSourceTime,
  LiveExactEgressAddress,
} from '../../../shared/contracts/egress-diagnostics';
import { EgressAddressError, normalizeEgressAddress } from '../address';
import {
  EgressApplicationRequestError,
  type EgressApplicationRequest,
} from '../application-request';
import { deriveEvidenceAssessment, deriveSourceFreshness } from '../evidence-policy';
import { createEgressExplanation } from '../explanation';
import {
  dateOnlyEpoch,
  EgressParseError,
  optionalBoolean,
  optionalNumber,
  optionalObject,
  optionalString,
  parseJsonObject,
  requiredString,
  type UnknownRecord,
} from '../parsing';

export interface IpinfoMaxGeoFacts {
  readonly city?: string;
  readonly continent?: string;
  readonly continentCode?: string;
  readonly country?: string;
  readonly countryCode?: string;
  readonly lastChanged?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly postalCode?: string;
  readonly radiusKilometres?: number;
  readonly region?: string;
  readonly regionCode?: string;
  readonly timezone?: string;
}

export interface IpinfoMaxAsFacts {
  readonly asn?: string;
  readonly domain?: string;
  readonly lastChanged?: string;
  readonly name?: string;
  readonly type?: string;
}

export interface IpinfoMaxAnonymousFacts {
  readonly isProxy?: boolean;
  readonly isRelay?: boolean;
  readonly isResidentialProxy?: boolean;
  readonly isTor?: boolean;
  readonly isVpn?: boolean;
  readonly lastSeen?: string;
  readonly name?: string;
  readonly percentDaysSeen?: number;
}

export interface IpinfoMaxFacts {
  readonly anonymous?: IpinfoMaxAnonymousFacts;
  readonly as?: IpinfoMaxAsFacts;
  readonly geo?: IpinfoMaxGeoFacts;
}

export interface IpinfoMaxEvidence extends EgressLiveSourceEvidence {
  readonly facts?: IpinfoMaxFacts;
  readonly provider: 'ipinfo-max';
}

export interface IpinfoMaxAdapterOptions {
  readonly now?: () => number;
  readonly request: EgressApplicationRequest;
  readonly token: () => string | undefined;
}

export interface IpinfoMaxCollectInput {
  readonly baseline: LiveExactEgressAddress;
  readonly leaseCurrent: boolean;
  readonly signal?: AbortSignal;
}

export interface ParsedIpinfoMax {
  readonly address: LiveExactEgressAddress;
  readonly facts: IpinfoMaxFacts;
  readonly sourceTimes: readonly EgressSourceTime[];
}

const datedSourceTime = (
  object: UnknownRecord,
  key: string,
  label: EgressSourceTime['label'],
): { sourceTime?: EgressSourceTime; value?: string } => {
  const value = optionalString(object, key, 10);
  if (!value) return {};
  const epochMs = dateOnlyEpoch(value);
  if (epochMs === undefined) throw new EgressParseError();
  return { sourceTime: { epochMs, label, value }, value };
};

const parseGeo = (
  object: UnknownRecord | undefined,
): { facts?: IpinfoMaxGeoFacts; sourceTime?: EgressSourceTime } => {
  if (!object) return {};
  const changed = datedSourceTime(object, 'last_changed', 'geo.last_changed');
  return {
    facts: {
      city: optionalString(object, 'city', 160),
      continent: optionalString(object, 'continent', 80),
      continentCode: optionalString(object, 'continent_code', 8),
      country: optionalString(object, 'country', 80),
      countryCode: optionalString(object, 'country_code', 8),
      lastChanged: changed.value,
      latitude: optionalNumber(object, 'latitude', -90, 90),
      longitude: optionalNumber(object, 'longitude', -180, 180),
      postalCode: optionalString(object, 'postal_code', 32),
      radiusKilometres: optionalNumber(object, 'radius', 0, 20_000),
      region: optionalString(object, 'region', 160),
      regionCode: optionalString(object, 'region_code', 32),
      timezone: optionalString(object, 'timezone', 80),
    },
    sourceTime: changed.sourceTime,
  };
};

const parseAs = (
  object: UnknownRecord | undefined,
): { facts?: IpinfoMaxAsFacts; sourceTime?: EgressSourceTime } => {
  if (!object) return {};
  const changed = datedSourceTime(object, 'last_changed', 'as.last_changed');
  return {
    facts: {
      asn: optionalString(object, 'asn', 32),
      domain: optionalString(object, 'domain', 253),
      lastChanged: changed.value,
      name: optionalString(object, 'name', 240),
      type: optionalString(object, 'type', 32),
    },
    sourceTime: changed.sourceTime,
  };
};

const parseAnonymous = (
  object: UnknownRecord | undefined,
): { facts?: IpinfoMaxAnonymousFacts; sourceTime?: EgressSourceTime } => {
  if (!object) return {};
  const lastSeen = datedSourceTime(object, 'last_seen', 'anonymous.last_seen');
  return {
    facts: {
      isProxy: optionalBoolean(object, 'is_proxy'),
      isRelay: optionalBoolean(object, 'is_relay'),
      isResidentialProxy: optionalBoolean(object, 'is_res_proxy'),
      isTor: optionalBoolean(object, 'is_tor'),
      isVpn: optionalBoolean(object, 'is_vpn'),
      lastSeen: lastSeen.value,
      name: optionalString(object, 'name', 160),
      percentDaysSeen: optionalNumber(object, 'percent_days_seen', 0, 100),
    },
    sourceTime: lastSeen.sourceTime,
  };
};

export const parseIpinfoMaxPayload = (
  bytes: Uint8Array,
  family: LiveExactEgressAddress['family'],
): ParsedIpinfoMax => {
  const object = parseJsonObject(bytes);
  const address = normalizeEgressAddress(requiredString(object, 'ip', 64), family);
  const geo = parseGeo(optionalObject(object, 'geo'));
  const asFacts = parseAs(optionalObject(object, 'as'));
  const anonymous = parseAnonymous(optionalObject(object, 'anonymous'));
  return {
    address,
    facts: { anonymous: anonymous.facts, as: asFacts.facts, geo: geo.facts },
    sourceTimes: [geo.sourceTime, asFacts.sourceTime, anonymous.sourceTime].filter(
      (value): value is EgressSourceTime => value !== undefined,
    ),
  };
};

const safeIssue = (error: unknown): EgressDiagnosticIssue => {
  if (error instanceof EgressApplicationRequestError) {
    return { code: error.code, message: error.message, retryAt: error.rateLimit.resetAt };
  }
  if (error instanceof EgressAddressError) return { code: error.code, message: error.message };
  if (error instanceof EgressParseError)
    return { code: 'malformed-response', message: error.message };
  return { code: 'transport-failed', message: 'IPinfo Max evidence collection failed.' };
};

const unavailableEvidence = (
  baseline: LiveExactEgressAddress,
  collectedAt: number,
  leaseCurrent: boolean,
  issue: EgressDiagnosticIssue,
): IpinfoMaxEvidence => {
  const endpointId = baseline.family === 'ipv4' ? 'ipinfo-max-v4' : 'ipinfo-max-v6';
  const state = issue.code === 'cancelled' ? 'cancelled' : 'unavailable';
  const assessment = deriveEvidenceAssessment({
    collectionState: state,
    leaseCurrent,
    sourceFreshness: 'unknown',
    strictParse: false,
    transport: 'electron-net:application-session',
  });
  return {
    assessment,
    explanation: createEgressExplanation({
      assessment,
      family: baseline.family,
      issueCode: issue.code,
      provider: 'ipinfo-max',
      state,
    }),
    family: baseline.family,
    issue,
    kind: 'live-source',
    provider: 'ipinfo-max',
    provenance: {
      collectedAt,
      endpointId,
      provider: 'ipinfo-max',
      sourceTimes: [],
      transport: 'electron-net:application-session',
    },
    state,
  };
};

export const createIpinfoMaxAdapter = ({
  now = Date.now,
  request,
  token,
}: IpinfoMaxAdapterOptions): {
  collect: (input: IpinfoMaxCollectInput) => Promise<IpinfoMaxEvidence>;
} => ({
  collect: async (input) => {
    const collectedAt = now();
    const baseline = normalizeEgressAddress(input.baseline.address, input.baseline.family);
    let credential: string | undefined;
    try {
      credential = token();
    } catch {
      credential = undefined;
    }
    if (!credential) {
      return unavailableEvidence(baseline, collectedAt, input.leaseCurrent, {
        code: 'missing-credential',
        message: 'The optional IPinfo Max credential is not configured.',
      });
    }
    const endpointId = baseline.family === 'ipv4' ? 'ipinfo-max-v4' : 'ipinfo-max-v6';
    try {
      const response = await request({ credential, endpointId, signal: input.signal });
      const parsed = parseIpinfoMaxPayload(response.body, baseline.family);
      const sourceFreshness = deriveSourceFreshness({
        now: collectedAt,
        sourceTimestamps: parsed.sourceTimes.flatMap((time) =>
          time.epochMs === undefined ? [] : [time.epochMs],
        ),
      });
      const assessment = deriveEvidenceAssessment({
        collectionState: 'complete',
        comparisonKeys: [baseline.address, parsed.address.address],
        leaseCurrent: input.leaseCurrent,
        sourceFreshness,
        strictParse: true,
        transport: 'electron-net:application-session',
      });
      return {
        address: parsed.address,
        assessment,
        explanation: createEgressExplanation({
          assessment,
          family: baseline.family,
          provider: 'ipinfo-max',
          state: 'complete',
        }),
        facts: parsed.facts,
        family: baseline.family,
        kind: 'live-source',
        provider: 'ipinfo-max',
        provenance: {
          collectedAt,
          endpointId,
          provider: 'ipinfo-max',
          sourceTimes: parsed.sourceTimes,
          transport: 'electron-net:application-session',
        },
        state: 'complete',
      };
    } catch (error) {
      return unavailableEvidence(baseline, collectedAt, input.leaseCurrent, safeIssue(error));
    }
  },
});
