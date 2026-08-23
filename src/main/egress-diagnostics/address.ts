import { isIP } from 'node:net';
import type {
  EgressAddressFamily,
  EgressDiagnosticIssueCode,
  LiveExactEgressAddress,
} from '../../shared/contracts/egress-diagnostics';

export class EgressAddressError extends Error {
  public readonly code: EgressDiagnosticIssueCode;

  public constructor(code: 'invalid-address' | 'family-mismatch') {
    super(
      code === 'invalid-address'
        ? 'The response address is invalid.'
        : 'The address family differs.',
    );
    this.name = 'EgressAddressError';
    this.code = code;
  }
}

const canonicalIpv6 = (address: string): string => {
  const hostname = new URL(`http://[${address}]/`).hostname;
  return hostname.slice(1, -1);
};

export const normalizeEgressAddress = (
  address: string,
  expectedFamily?: EgressAddressFamily,
): LiveExactEgressAddress => {
  const version = isIP(address);
  if (version !== 4 && version !== 6) {
    throw new EgressAddressError('invalid-address');
  }
  const family: EgressAddressFamily = version === 4 ? 'ipv4' : 'ipv6';
  if (expectedFamily && family !== expectedFamily) {
    throw new EgressAddressError('family-mismatch');
  }
  return {
    address: version === 6 ? canonicalIpv6(address) : address,
    family,
  };
};
