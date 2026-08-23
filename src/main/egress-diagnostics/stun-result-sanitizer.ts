import type { StunDiagnosticCandidate } from './webrtc/stun-collector';
import { normalizeEgressAddress } from './address';
import { normalizeEgressAddressBinary } from './address-redactor';
import { isUnknownRecord } from './parsing';

const MAX_STUN_RESULT_CANDIDATES = 32;
const MAX_IP_LITERAL_LENGTH = 64;

const ipv4Number = (bytes: Uint8Array): number =>
  (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>>
  0;

const matchesIpv4Range = (value: number, base: number, mask: number): boolean =>
  (value & mask) >>> 0 === (base & mask) >>> 0;

const isPublicIpv4 = (bytes: Uint8Array): boolean => {
  const value = ipv4Number(bytes);
  if (value === 0xc0000009 || value === 0xc000000a) return true;
  const blockedRanges = [
    [0x00000000, 0xff000000],
    [0x0a000000, 0xff000000],
    [0x64400000, 0xffc00000],
    [0x7f000000, 0xff000000],
    [0xa9fe0000, 0xffff0000],
    [0xac100000, 0xfff00000],
    [0xc0000000, 0xffffff00],
    [0xc0000200, 0xffffff00],
    [0xc0a80000, 0xffff0000],
    [0xc0586300, 0xffffff00],
    [0xc6120000, 0xfffe0000],
    [0xc6336400, 0xffffff00],
    [0xcb007100, 0xffffff00],
    [0xe0000000, 0xf0000000],
    [0xf0000000, 0xf0000000],
  ] as const;
  return !blockedRanges.some(([base, mask]) => matchesIpv4Range(value, base, mask));
};

const matchesAddressPrefix = (
  bytes: Uint8Array,
  prefix: readonly number[],
  prefixLength: number,
): boolean => {
  const wholeBytes = Math.floor(prefixLength / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remainingBits = prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((bytes[wholeBytes] ?? 0) & mask) === ((prefix[wholeBytes] ?? 0) & mask);
};

const REACHABLE_RESERVED_IPV6_PREFIXES = Object.freeze([
  Object.freeze({
    prefix: Object.freeze([0x20, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
    prefixLength: 128,
  }),
  Object.freeze({
    prefix: Object.freeze([0x20, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
    prefixLength: 128,
  }),
  Object.freeze({
    prefix: Object.freeze([0x20, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
    prefixLength: 128,
  }),
  Object.freeze({ prefix: Object.freeze([0x20, 0x01, 0x00, 0x03]), prefixLength: 32 }),
  Object.freeze({ prefix: Object.freeze([0x20, 0x01, 0x00, 0x04, 0x01, 0x12]), prefixLength: 48 }),
  Object.freeze({ prefix: Object.freeze([0x20, 0x01, 0x00, 0x20]), prefixLength: 28 }),
  Object.freeze({ prefix: Object.freeze([0x20, 0x01, 0x00, 0x30]), prefixLength: 28 }),
]);

const isPublicIpv6 = (bytes: Uint8Array): boolean => {
  if (!matchesAddressPrefix(bytes, [0x20], 3)) return false;
  const insideReservedBlock = matchesAddressPrefix(bytes, [0x20, 0x01, 0x00], 23);
  if (
    insideReservedBlock &&
    !REACHABLE_RESERVED_IPV6_PREFIXES.some(({ prefix, prefixLength }) =>
      matchesAddressPrefix(bytes, prefix, prefixLength),
    )
  ) {
    return false;
  }
  return (
    !matchesAddressPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32) &&
    !matchesAddressPrefix(bytes, [0x20, 0x02], 16) &&
    !matchesAddressPrefix(bytes, [0x3f, 0xff, 0x00], 20)
  );
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isUnknownRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

/** Revalidates the typed collector result at the orchestration boundary without page-result coupling. */
export const sanitizeStunResultCandidates = (
  value: readonly unknown[],
): readonly StunDiagnosticCandidate[] => {
  try {
    const candidates: StunDiagnosticCandidate[] = [];
    const seen = new Set<string>();
    const inputLimit = Math.min(value.length, MAX_STUN_RESULT_CANDIDATES);
    for (let index = 0; index < inputLimit; index += 1) {
      const raw = value[index];
      try {
        if (!isPlainRecord(raw)) continue;
        if (
          !Object.prototype.hasOwnProperty.call(raw, 'address') ||
          !Object.prototype.hasOwnProperty.call(raw, 'family') ||
          !Object.prototype.hasOwnProperty.call(raw, 'transport') ||
          (raw.family !== 'ipv4' && raw.family !== 'ipv6') ||
          (raw.transport !== 'tcp' && raw.transport !== 'udp') ||
          typeof raw.address !== 'string' ||
          raw.address.length === 0 ||
          raw.address.length > MAX_IP_LITERAL_LENGTH ||
          raw.address !== raw.address.trim() ||
          raw.address.includes('%')
        ) {
          continue;
        }
        const address = normalizeEgressAddress(raw.address, raw.family);
        const binary = normalizeEgressAddressBinary(address.address, address.family);
        const isPublic =
          address.family === 'ipv4' ? isPublicIpv4(binary.bytes) : isPublicIpv6(binary.bytes);
        if (!isPublic) continue;
        const identity = `${address.family}:${address.address}:${raw.transport}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidates.push(Object.freeze({ ...address, transport: raw.transport }));
      } catch {
        // One malformed candidate cannot bypass validation or hide other valid result tuples.
      }
    }
    return Object.freeze(candidates);
  } catch {
    return Object.freeze([]);
  }
};
