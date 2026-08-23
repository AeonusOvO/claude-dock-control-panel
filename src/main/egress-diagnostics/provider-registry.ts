import type { EgressEndpointId, EgressProviderId } from '../../shared/contracts/egress-diagnostics';

export type EgressCredentialKind = 'none' | 'bearer' | 'key';

export interface EgressEndpointDefinition {
  readonly credentialKind: EgressCredentialKind;
  readonly expectedMediaTypes: readonly string[];
  readonly id: EgressEndpointId;
  readonly maxDecodedBytes: number;
  readonly maxRedirects: number;
  readonly provider: EgressProviderId;
  readonly url: string;
}

const endpoint = (definition: EgressEndpointDefinition): EgressEndpointDefinition =>
  Object.freeze({
    ...definition,
    expectedMediaTypes: Object.freeze([...definition.expectedMediaTypes]),
  });

export const EGRESS_ENDPOINTS: Readonly<Record<EgressEndpointId, EgressEndpointDefinition>> =
  Object.freeze({
    'public-address-v4': endpoint({
      credentialKind: 'none',
      expectedMediaTypes: ['application/json'],
      id: 'public-address-v4',
      maxDecodedBytes: 4 * 1024,
      maxRedirects: 2,
      provider: 'ipify',
      url: 'https://api.ipify.org?format=json',
    }),
    'public-address-v6': endpoint({
      credentialKind: 'none',
      expectedMediaTypes: ['application/json'],
      id: 'public-address-v6',
      maxDecodedBytes: 4 * 1024,
      maxRedirects: 2,
      provider: 'ipify',
      url: 'https://api6.ipify.org?format=json',
    }),
    'ipinfo-max-v4': endpoint({
      credentialKind: 'bearer',
      expectedMediaTypes: ['application/json'],
      id: 'ipinfo-max-v4',
      maxDecodedBytes: 128 * 1024,
      maxRedirects: 0,
      provider: 'ipinfo-max',
      url: 'https://v4.api.ipinfo.io/lookup/me',
    }),
    'ipinfo-max-v6': endpoint({
      credentialKind: 'bearer',
      expectedMediaTypes: ['application/json'],
      id: 'ipinfo-max-v6',
      maxDecodedBytes: 128 * 1024,
      maxRedirects: 0,
      provider: 'ipinfo-max',
      url: 'https://v6.api.ipinfo.io/lookup/me',
    }),
    'abuseipdb-check': endpoint({
      credentialKind: 'key',
      expectedMediaTypes: ['application/json'],
      id: 'abuseipdb-check',
      maxDecodedBytes: 64 * 1024,
      maxRedirects: 0,
      provider: 'abuseipdb',
      url: 'https://api.abuseipdb.com/api/v2/check',
    }),
  });

export const isEgressEndpointId = (value: unknown): value is EgressEndpointId =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(EGRESS_ENDPOINTS, value);

export const getEgressEndpoint = (id: EgressEndpointId): EgressEndpointDefinition =>
  EGRESS_ENDPOINTS[id];
