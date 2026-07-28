import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-signal-'));
const scriptPath = path.resolve('assets/runtime/claude-runtime-signal.ps1');

afterAll(() => {
  const safePrefix = path.join(tmpdir(), 'claudedock-signal-');
  if (!fixtureRoot.startsWith(safePrefix)) {
    throw new Error(`Refusing to remove unexpected test fixture: ${fixtureRoot}`);
  }
  rmSync(fixtureRoot, { force: true, recursive: true });
});

const runSignal = (outputPath: string, event: string, input: string) =>
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-OutputPath',
      outputPath,
      '-Event',
      event,
    ],
    {
      encoding: 'utf8',
      input,
      timeout: 30_000,
    },
  );

/** Windows PowerShell writes UTF-8 with a BOM; JSON.parse rejects it, exactly as the main process handles. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const readSignal = (outputPath: string): Record<string, unknown> => {
  const raw = readFileSync(outputPath, 'utf8');
  return JSON.parse(
    raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw,
  ) as Record<string, unknown>;
};

describe('ClaudeDock runtime signal helper', () => {
  it('records the compaction event after draining the hook payload from stdin', () => {
    const outputPath = path.join(fixtureRoot, 'signal.json');
    const before = Date.now();
    const result = runSignal(
      outputPath,
      'PostCompact',
      JSON.stringify({ hook_event_name: 'PostCompact', trigger: 'manual' }),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const signal = readSignal(outputPath);
    expect(signal.event).toBe('PostCompact');
    expect(typeof signal.signaledAt).toBe('number');
    // Milliseconds since the epoch, stamped inside the window this test spans.
    expect(signal.signaledAt as number).toBeGreaterThanOrEqual(before - 5_000);
    expect(signal.signaledAt as number).toBeLessThanOrEqual(Date.now() + 5_000);
    // Nothing from the hook payload may leak into the file the main process reads back.
    expect(JSON.stringify(signal)).not.toContain('trigger');
  });

  it('creates the session directory and replaces an earlier signal with a newer stamp', () => {
    const outputPath = path.join(fixtureRoot, 'nested', 'session-1', 'signal.json');
    expect(runSignal(outputPath, 'PostCompact', '{}').status).toBe(0);
    const first = readSignal(outputPath).signaledAt as number;

    // The main process only acts on a stamp it has not consumed yet, so a second compaction has to
    // move the value forward rather than leave the previous one in place.
    const wait = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Start-Sleep -Milliseconds 30',
    ]);
    expect(wait.status).toBe(0);
    expect(runSignal(outputPath, 'PostCompact', '{}').status).toBe(0);

    expect(readSignal(outputPath).signaledAt as number).toBeGreaterThan(first);
    // The atomic staging file must never survive a successful write.
    expect(existsSync(`${outputPath}.tmp`)).toBe(false);
  });
});
