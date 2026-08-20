import { describe, expect, it } from 'vitest';
import { compareVersions, parseCodexReleaseInstaller } from '../../src/main/codex/installer';

const digest = `sha256:${'a'.repeat(64)}`;

const release = {
  assets: [
    {
      browser_download_url:
        'https://github.com/openai/codex/releases/download/rust-v0.146.0/install.ps1',
      digest,
      name: 'install.ps1',
      size: 32_768,
    },
  ],
  tag_name: 'rust-v0.146.0',
};

describe('Codex official installer metadata', () => {
  it('accepts a checksummed install.ps1 from the matching official release', () => {
    expect(parseCodexReleaseInstaller(release)).toEqual({
      digest: 'a'.repeat(64),
      downloadUrl: 'https://github.com/openai/codex/releases/download/rust-v0.146.0/install.ps1',
      size: 32_768,
      version: '0.146.0',
    });
  });

  it.each([
    {
      ...release,
      assets: [
        {
          ...release.assets[0],
          browser_download_url:
            'https://example.com/openai/codex/releases/download/rust-v0.146.0/install.ps1',
        },
      ],
    },
    {
      ...release,
      assets: [{ ...release.assets[0], digest: 'sha256:1234' }],
    },
    {
      ...release,
      assets: [{ ...release.assets[0], size: 2 * 1024 * 1024 }],
    },
    {
      ...release,
      tag_name: 'v0.146.0',
    },
  ])('rejects untrusted or unverifiable release metadata', (candidate) => {
    expect(() => parseCodexReleaseInstaller(candidate)).toThrow();
  });

  it('compares the numeric Codex release components', () => {
    expect(compareVersions('0.146.0', '0.145.0')).toBeGreaterThan(0);
    expect(compareVersions('rust-v0.145.0', '0.145.0')).toBe(0);
    expect(compareVersions('0.99.0', '1.0.0')).toBeLessThan(0);
  });
});
