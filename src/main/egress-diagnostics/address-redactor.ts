import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  EgressAddressFamily,
  PersistedRedactedEgressAddress,
} from '../../shared/contracts/egress-diagnostics';

const ADDRESS_FINGERPRINT_DOMAIN = Buffer.from('claudedock-egress-address-fingerprint\0', 'ascii');
const ADDRESS_FINGERPRINT_VERSION = 1;
const ADDRESS_FINGERPRINT_PREFIX = 'eaf1_';
const HMAC_KEY_BYTES = 32;
const MAX_ADDRESS_TEXT_BYTES = 128;

export interface TransientEgressAddress {
  readonly address: string;
  readonly family: EgressAddressFamily;
}

export interface NormalizedEgressAddressBinary {
  readonly bytes: Uint8Array;
  readonly family: EgressAddressFamily;
}

export type EgressAddressRedactionErrorCode = 'family-mismatch' | 'invalid-address' | 'invalid-key';

export class EgressAddressRedactionError extends Error {
  public readonly code: EgressAddressRedactionErrorCode;

  public constructor(code: EgressAddressRedactionErrorCode) {
    const messages: Readonly<Record<EgressAddressRedactionErrorCode, string>> = {
      'family-mismatch': 'The egress address family does not match.',
      'invalid-address': 'The egress address is invalid.',
      'invalid-key': 'The egress address fingerprint key is unavailable.',
    };
    super(messages[code]);
    this.name = 'EgressAddressRedactionError';
    this.code = code;
  }
}

interface ParsedAddress {
  readonly bytes: Buffer;
  readonly family: EgressAddressFamily;
}

const parseIpv4Bytes = (address: string): Buffer => {
  const octets = address.split('.');
  if (octets.length !== 4) throw new EgressAddressRedactionError('invalid-address');
  const bytes = Buffer.allocUnsafe(4);
  for (let index = 0; index < octets.length; index += 1) {
    const octet = octets[index];
    if (!octet || !/^(?:0|[1-9][0-9]{0,2})$/.test(octet)) {
      throw new EgressAddressRedactionError('invalid-address');
    }
    const value = Number(octet);
    if (value > 255) throw new EgressAddressRedactionError('invalid-address');
    bytes[index] = value;
  }
  return bytes;
};

const expandIpv6Tokens = (tokens: readonly string[]): readonly number[] => {
  const values: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) throw new EgressAddressRedactionError('invalid-address');
    if (token.includes('.')) {
      if (index !== tokens.length - 1) throw new EgressAddressRedactionError('invalid-address');
      const ipv4 = parseIpv4Bytes(token);
      values.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(token)) {
      throw new EgressAddressRedactionError('invalid-address');
    }
    values.push(Number.parseInt(token, 16));
  }
  return values;
};

const parseIpv6Bytes = (address: string): Buffer => {
  const halves = address.split('::');
  if (halves.length > 2) throw new EgressAddressRedactionError('invalid-address');
  const left = expandIpv6Tokens(halves[0] ? halves[0].split(':') : []);
  const right = expandIpv6Tokens(halves[1] ? halves[1].split(':') : []);
  const compressed = halves.length === 2;
  const omitted = 8 - left.length - right.length;
  if ((!compressed && omitted !== 0) || (compressed && omitted < 1)) {
    throw new EgressAddressRedactionError('invalid-address');
  }
  const words = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (words.length !== 8) throw new EgressAddressRedactionError('invalid-address');
  const bytes = Buffer.allocUnsafe(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
};

const parseAddress = (address: string, expectedFamily?: EgressAddressFamily): ParsedAddress => {
  if (
    typeof address !== 'string' ||
    address.length === 0 ||
    Buffer.byteLength(address, 'utf8') > MAX_ADDRESS_TEXT_BYTES
  ) {
    throw new EgressAddressRedactionError('invalid-address');
  }
  const version = isIP(address);
  if (version !== 4 && version !== 6) throw new EgressAddressRedactionError('invalid-address');
  const family: EgressAddressFamily = version === 4 ? 'ipv4' : 'ipv6';
  if (expectedFamily && family !== expectedFamily) {
    throw new EgressAddressRedactionError('family-mismatch');
  }
  return {
    bytes: version === 4 ? parseIpv4Bytes(address) : parseIpv6Bytes(address),
    family,
  };
};

const canonicalIpv6 = (bytes: Uint8Array): string => {
  const words = Array.from(
    { length: 8 },
    (_, index) => (bytes[index * 2]! << 8) | bytes[index * 2 + 1]!,
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    const length = end - index;
    if (length >= 2 && length > bestLength) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }
  const hexadecimal = words.map((word) => word.toString(16));
  if (bestStart < 0) return hexadecimal.join(':');
  const before = hexadecimal.slice(0, bestStart).join(':');
  const after = hexadecimal.slice(bestStart + bestLength).join(':');
  return `${before}::${after}`;
};

const prefixFor = (address: ParsedAddress): string => {
  if (address.family === 'ipv4') {
    return `${address.bytes[0]}.${address.bytes[1]}.${address.bytes[2]}.0/24`;
  }
  const prefixBytes = Buffer.alloc(16);
  address.bytes.copy(prefixBytes, 0, 0, 8);
  return `${canonicalIpv6(prefixBytes)}/64`;
};

const fingerprintFor = (address: ParsedAddress, hmacKey: Uint8Array): string => {
  if (!(hmacKey instanceof Uint8Array) || hmacKey.byteLength !== HMAC_KEY_BYTES) {
    throw new EgressAddressRedactionError('invalid-key');
  }
  const key = Buffer.from(hmacKey);
  const familyByte = address.family === 'ipv4' ? 4 : 6;
  try {
    const digest = createHmac('sha256', key)
      .update(ADDRESS_FINGERPRINT_DOMAIN)
      .update(Buffer.from([ADDRESS_FINGERPRINT_VERSION, familyByte]))
      .update(address.bytes)
      .digest('base64url');
    return `${ADDRESS_FINGERPRINT_PREFIX}${digest}`;
  } catch {
    throw new EgressAddressRedactionError('invalid-key');
  } finally {
    key.fill(0);
  }
};

/** Parses a transient exact address into deterministic network-order bytes without DNS. */
export const normalizeEgressAddressBinary = (
  address: string,
  expectedFamily?: EgressAddressFamily,
): NormalizedEgressAddressBinary => {
  const parsed = parseAddress(address, expectedFamily);
  return { bytes: Uint8Array.from(parsed.bytes), family: parsed.family };
};

/** Produces the only address shape allowed in durable egress history. */
export const redactEgressAddress = (
  address: string,
  family: EgressAddressFamily,
  hmacKey: Uint8Array,
): PersistedRedactedEgressAddress => {
  const parsed = parseAddress(address, family);
  return Object.freeze({
    family: parsed.family,
    fingerprint: fingerprintFor(parsed, hmacKey),
    prefix: prefixFor(parsed),
  });
};

export const redactEgressAddresses = (
  addresses: readonly TransientEgressAddress[],
  hmacKey: Uint8Array,
): readonly PersistedRedactedEgressAddress[] => {
  const redacted: PersistedRedactedEgressAddress[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const candidate = redactEgressAddress(address.address, address.family, hmacKey);
    const identity = `${candidate.family}:${candidate.fingerprint}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    redacted.push(candidate);
  }
  return Object.freeze(redacted);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
};

/** Strictly validates an already-redacted persisted address; exact addresses are never accepted. */
export const normalizePersistedRedactedEgressAddress = (
  value: unknown,
): PersistedRedactedEgressAddress => {
  if (!isRecord(value) || !hasExactKeys(value, ['family', 'fingerprint', 'prefix'])) {
    throw new EgressAddressRedactionError('invalid-address');
  }
  if (value.family !== 'ipv4' && value.family !== 'ipv6') {
    throw new EgressAddressRedactionError('invalid-address');
  }
  if (
    typeof value.fingerprint !== 'string' ||
    !/^eaf1_[A-Za-z0-9_-]{43}$/.test(value.fingerprint) ||
    typeof value.prefix !== 'string'
  ) {
    throw new EgressAddressRedactionError('invalid-address');
  }
  const suffix = value.family === 'ipv4' ? '/24' : '/64';
  if (!value.prefix.endsWith(suffix)) throw new EgressAddressRedactionError('invalid-address');
  const prefixAddress = value.prefix.slice(0, -suffix.length);
  const parsed = parseAddress(prefixAddress, value.family);
  if (prefixFor(parsed) !== value.prefix) throw new EgressAddressRedactionError('invalid-address');
  return Object.freeze({
    family: value.family,
    fingerprint: value.fingerprint,
    prefix: value.prefix,
  });
};
