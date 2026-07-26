import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../src/main/software-updates';

describe('software update version comparison', () => {
  it('compares semantic versions without lexical ordering errors', () => {
    expect(isNewerVersion('2.10.0', '2.9.9')).toBe(true);
    expect(isNewerVersion('3.0.0', '2.99.99')).toBe(true);
    expect(isNewerVersion('2.1.220', '2.1.220')).toBe(false);
    expect(isNewerVersion('2.1.219', '2.1.220')).toBe(false);
  });

  it('does not claim an update when either version cannot be verified', () => {
    expect(isNewerVersion(undefined, '2.1.220')).toBe(false);
    expect(isNewerVersion('latest', '2.1.220')).toBe(false);
  });
});
