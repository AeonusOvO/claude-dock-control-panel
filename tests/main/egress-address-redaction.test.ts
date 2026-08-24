import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EgressAddressRedactionError,
  isIpv4MappedIpv6Address,
  normalizeEgressAddressBinary,
  normalizePersistedRedactedEgressAddress,
  redactEgressAddress,
  redactEgressAddresses,
  transientEgressAddressPrefix,
} from '../../src/main/egress-diagnostics/address-redactor';

const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);

describe('egress address redaction', () => {
  it('normalizes IPv4 and canonical-equivalent IPv6 spellings into network-order bytes', () => {
    expect([...normalizeEgressAddressBinary('203.0.113.77', 'ipv4').bytes]).toEqual([
      203, 0, 113, 77,
    ]);

    const expanded = normalizeEgressAddressBinary(
      '2001:0DB8:0000:0000:0001:0000:0000:0042',
      'ipv6',
    );
    const compressed = normalizeEgressAddressBinary('2001:db8::1:0:0:42', 'ipv6');
    expect([...expanded.bytes]).toEqual([...compressed.bytes]);
    expect(expanded.family).toBe('ipv6');
  });

  it('creates canonical /24 and /64 prefixes with opaque keyed fingerprints', () => {
    const ipv4 = redactEgressAddress('203.0.113.77', 'ipv4', KEY_A);
    const ipv6 = redactEgressAddress('2001:0db8:1234:5678:abcd:ef00:1:2', 'ipv6', KEY_A);

    expect(ipv4).toEqual({
      family: 'ipv4',
      fingerprint: expect.stringMatching(/^eaf1_[A-Za-z0-9_-]{43}$/),
      prefix: '203.0.113.0/24',
    });
    expect(ipv6).toEqual({
      family: 'ipv6',
      fingerprint: expect.stringMatching(/^eaf1_[A-Za-z0-9_-]{43}$/),
      prefix: '2001:db8:1234:5678::/64',
    });
    expect(redactEgressAddress('2001:db8:1234:5678::abcd', 'ipv6', KEY_A).fingerprint).not.toBe(
      ipv6.fingerprint,
    );
    expect(transientEgressAddressPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(transientEgressAddressPrefix('2001:db8::1')).toBe('2001:db8::/64');
  });

  it('rejects invalid input and family mismatches without reflecting exact input in errors', () => {
    expect(() => redactEgressAddress('not-an-address', 'ipv4', KEY_A)).toThrow(
      EgressAddressRedactionError,
    );
    const exact = '2001:db8::55';
    let error: unknown;
    try {
      redactEgressAddress(exact, 'ipv4', KEY_A);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'family-mismatch' });
    expect(String(error)).not.toContain(exact);
    expect(() => redactEgressAddress('203.0.113.10', 'ipv4', Buffer.alloc(31))).toThrow(
      /fingerprint key/i,
    );
  });

  it('rejects IPv4-mapped IPv6 spellings instead of creating a misleading IPv6 prefix', () => {
    for (const mapped of ['::ffff:203.0.113.47', '0:0:0:0:0:ffff:cb00:712f']) {
      expect(isIpv4MappedIpv6Address(mapped)).toBe(true);
      expect(() => transientEgressAddressPrefix(mapped)).toThrow(EgressAddressRedactionError);
      expect(() => transientEgressAddressPrefix(mapped, 'ipv6')).toThrow(
        EgressAddressRedactionError,
      );
      expect(() => normalizeEgressAddressBinary(mapped, 'ipv6')).toThrow(
        EgressAddressRedactionError,
      );
      expect(() => redactEgressAddress(mapped, 'ipv6', KEY_A)).toThrow(EgressAddressRedactionError);
    }
  });

  it('redacts private and public addresses identically and deduplicates canonical equivalents', () => {
    const result = redactEgressAddresses(
      [
        { address: '10.20.30.44', family: 'ipv4' },
        { address: '203.0.113.77', family: 'ipv4' },
        { address: '2001:db8::1', family: 'ipv6' },
        { address: '2001:0db8:0:0:0:0:0:1', family: 'ipv6' },
      ],
      KEY_A,
    );

    expect(result).toHaveLength(3);
    expect(result.map((address) => Object.keys(address).sort())).toEqual([
      ['family', 'fingerprint', 'prefix'],
      ['family', 'fingerprint', 'prefix'],
      ['family', 'fingerprint', 'prefix'],
    ]);
    expect(result.map((address) => address.prefix)).toEqual([
      '10.20.30.0/24',
      '203.0.113.0/24',
      '2001:db8::/64',
    ]);
  });

  it('separates installations and the versioned fingerprint domain from an unkeyed-style digest', () => {
    const exact = '198.51.100.42';
    const normalized = normalizeEgressAddressBinary(exact, 'ipv4');
    const first = redactEgressAddress(exact, 'ipv4', KEY_A).fingerprint;
    const second = redactEgressAddress(exact, 'ipv4', KEY_B).fingerprint;
    const withoutDomain = createHmac('sha256', KEY_A)
      .update(Buffer.from([1, 4]))
      .update(normalized.bytes)
      .digest('base64url');
    const otherDomain = createHmac('sha256', KEY_A)
      .update('claudedock-other-purpose\0')
      .update(Buffer.from([1, 4]))
      .update(normalized.bytes)
      .digest('base64url');

    expect(first).not.toBe(second);
    expect(first).not.toBe(`eaf1_${withoutDomain}`);
    expect(first).not.toBe(`eaf1_${otherDomain}`);
  });

  it('strictly validates persisted redacted shapes and serialization contains no exact address', () => {
    const exactV4 = '198.51.100.42';
    const exactV6 = '2001:db8:abcd:1:2222:3333:4444:5555';
    const persisted = redactEgressAddresses(
      [
        { address: exactV4, family: 'ipv4' },
        { address: exactV6, family: 'ipv6' },
      ],
      KEY_A,
    );
    const serialized = JSON.stringify({ addresses: persisted });

    expect(serialized).not.toContain(exactV4);
    expect(serialized).not.toContain(exactV6);
    expect(() =>
      normalizePersistedRedactedEgressAddress({ ...persisted[0], address: exactV4 }),
    ).toThrow(/invalid/i);
    expect(() =>
      normalizePersistedRedactedEgressAddress({ ...persisted[0], prefix: '198.51.100.42/24' }),
    ).toThrow(/invalid/i);
  });
});
