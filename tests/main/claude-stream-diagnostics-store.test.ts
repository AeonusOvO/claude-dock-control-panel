import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeStreamDiagnosticsStore,
  classifyClaudeStreamFailure,
} from '../../src/main/claude/stream-diagnostics-store';

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { force: true, recursive: true });
});

describe('Claude stream diagnostics', () => {
  it('classifies transport failures without storing response or prompt text', () => {
    expect(
      classifyClaudeStreamFailure(
        'API Error: 408 stream disconnected before completion: stream closed before response.completed',
      ),
    ).toBe('request-timeout');
    expect(classifyClaudeStreamFailure('API Error: 429 rate limit exceeded')).toBe('rate-limited');
    expect(classifyClaudeStreamFailure('unexpected EOF')).toBe('unexpected-eof');
  });

  it('retains only bounded, structured observations for 14 days', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-stream-diagnostics-'));
    fixtures.push(root);
    let now = 20 * 24 * 60 * 60 * 1_000;
    const store = new ClaudeStreamDiagnosticsStore(root, () => now);
    store.append({
      backgroundTaskCount: 4,
      cliVersion: '2.1.221',
      gatewayVersion: '7.2.117',
      kind: 'stream-disconnected',
      occurredAt: now,
      sessionRuntimeMs: 7 * 60 * 60 * 1_000,
    });
    expect(store.list()).toEqual([
      {
        backgroundTaskCount: 4,
        cliVersion: '2.1.221',
        gatewayVersion: '7.2.117',
        kind: 'stream-disconnected',
        occurredAt: now,
        sessionRuntimeMs: 25_200_000,
      },
    ]);
    now += 15 * 24 * 60 * 60 * 1_000;
    expect(store.list()).toEqual([]);
  });
});
