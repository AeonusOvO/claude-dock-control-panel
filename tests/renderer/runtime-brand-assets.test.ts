import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const assetsDirectory = path.join(__dirname, '..', '..', 'src', 'renderer', 'assets', 'brands');

interface BrandAssetExpectation {
  fileName: string;
  fill: string;
  normalizedSourceHash: string;
  sourceHash: string;
  sourceUrl: string;
}

const assets: BrandAssetExpectation[] = [
  {
    fileName: 'claude-spark-clay.svg',
    fill: '#D97757',
    normalizedSourceHash: '1E3C6BD43F5B0598FF4452769410D0597AD0BE3FBDD043930DA664AF9E1FD39F',
    sourceHash: '6D53DB4BE375E899C937C26CF16684A80D6E869B1928D72B37748BEF2560E219',
    sourceUrl: 'https://www.anthropic.com/press-kit',
  },
  {
    fileName: 'openai-blossom-black.svg',
    fill: 'black',
    normalizedSourceHash: 'CC448BF8E40F2B83E6E559EA8BE816657740BC8305269E88EEC27FF710356941',
    sourceHash: '7BE72F1FEA831D3BA81A545CEE79B7E0AE69449D5D7837C9571CCBFB4AA1E00B',
    sourceUrl: 'https://openai.com/brand/',
  },
  {
    fileName: 'openai-blossom-white.svg',
    fill: 'white',
    normalizedSourceHash: '834590F050BFC2F170BEAE54D432CDD2096C74AECEB8FD4D482DB76493EA4F02',
    sourceHash: 'B94EA61D860FAE6F82F43571F36F17111FCF5D348E8E9CC22AE4B441C7560011',
    sourceUrl: 'https://openai.com/brand/',
  },
];

const sourceBody = (asset: string): string => asset.replace(/^<!--[\s\S]*?-->\s*/u, '').trimEnd();

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex').toUpperCase();

describe('runtime brand assets', () => {
  it.each(assets)('preserves official geometry and provenance for $fileName', (expected) => {
    const asset = readFileSync(path.join(assetsDirectory, expected.fileName), 'utf8');

    expect(asset).toContain(`Source: ${expected.sourceUrl}`);
    expect(asset).toContain('Retrieved: 2026-08-24');
    expect(asset).toContain(`Source SVG SHA-256: ${expected.sourceHash}`);
    expect(asset).toContain(`fill="${expected.fill}"`);
    expect(sha256(sourceBody(asset))).toBe(expected.normalizedSourceHash);
    expect(asset).not.toMatch(/<(?:image|script)\b|\son\w+=|\shref=/iu);
  });
});
