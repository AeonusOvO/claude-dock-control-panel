import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateWebRtcCandidates, extractIceCandidates } from '../src/main/proxy/webrtc-audit';

describe('proxy WebRTC audit', () => {
  it('extracts host and server-reflexive ICE candidates', () => {
    expect(
      extractIceCandidates([
        'candidate:1 1 udp 2122260223 192.168.1.8 50000 typ host generation 0',
        'candidate:2 1 udp 1686052607 203.0.113.8 62000 typ srflx raddr 0.0.0.0 rport 0',
      ]),
    ).toEqual([
      { address: '192.168.1.8', type: 'host' },
      { address: '203.0.113.8', type: 'srflx' },
    ]);
  });

  it('treats a mismatched reflected address as a leak risk', () => {
    expect(
      evaluateWebRtcCandidates([{ address: '198.51.100.2', type: 'srflx' }], '203.0.113.8').verdict,
    ).toBe('risk');
  });

  it('enforces the non-proxied UDP policy for every Electron WebContents', () => {
    const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    expect(mainSource).toContain("contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');");
  });
});
