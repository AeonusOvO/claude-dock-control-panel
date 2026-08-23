import { describe, expect, it } from 'vitest';
import {
  assignRegistryIds,
  canonicalRegistryContent,
  registryContentDigest,
} from '../../src/main/mcp/registry-id';

const source = { type: 'positional', value: 'source' };
const destination = { type: 'positional', value: 'destination' };

describe('MCP Registry content IDs', () => {
  it('preserves array order while canonicalizing object-key order', () => {
    const forward = {
      identifier: '@example/copy',
      registryType: 'npm',
      runtimeArguments: [source, destination],
    };
    const sameContentDifferentKeyOrder = {
      runtimeArguments: [
        { value: 'source', type: 'positional' },
        { value: 'destination', type: 'positional' },
      ],
      registryType: 'npm',
      identifier: '@example/copy',
    };
    const reversed = {
      identifier: '@example/copy',
      registryType: 'npm',
      runtimeArguments: [destination, source],
    };

    expect(canonicalRegistryContent(forward)).toBe(
      canonicalRegistryContent(sameContentDifferentKeyOrder),
    );
    expect(registryContentDigest(forward)).toBe(
      registryContentDigest(sameContentDifferentKeyOrder),
    );
    expect(registryContentDigest(forward)).not.toBe(registryContentDigest(reversed));
    expect(registryContentDigest([source, destination])).not.toBe(
      registryContentDigest([destination, source]),
    );
  });

  it.each(['packageArguments', 'runtimeArguments'] as const)(
    'changes package IDs when %s order changes',
    (field) => {
      const forward = {
        [field]: [source, destination],
        identifier: '@example/copy',
        registryType: 'npm',
      };
      const reversed = {
        [field]: [destination, source],
        identifier: '@example/copy',
        registryType: 'npm',
      };
      const [forwardPackage] = assignRegistryIds('package', [forward]);
      const [reversedPackage] = assignRegistryIds('package', [reversed]);

      expect(forwardPackage?.id).toMatch(/^package:[a-f0-9]{64}:1$/);
      expect(reversedPackage?.id).toMatch(/^package:[a-f0-9]{64}:1$/);
      expect(forwardPackage?.id).not.toBe(reversedPackage?.id);
    },
  );
});
