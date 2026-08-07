import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-statusline-'));
const STATUSLINE_PROCESS_TIMEOUT_MS = 30_000;
const STATUSLINE_TEST_TIMEOUT_MS = 45_000;
const statusLineIt = (name: string, test: () => void): void => {
  it(name, test, STATUSLINE_TEST_TIMEOUT_MS);
};

afterAll(() => {
  const safePrefix = path.join(tmpdir(), 'claudedock-statusline-');
  if (!fixtureRoot.startsWith(safePrefix)) {
    throw new Error(`Refusing to remove unexpected test fixture: ${fixtureRoot}`);
  }
  rmSync(fixtureRoot, { force: true, recursive: true });
});

describe('ClaudeDock status-line helper', () => {
  statusLineIt('captures context, token, cost, model, and session metrics', () => {
    const outputPath = path.join(fixtureRoot, 'metrics.json');
    const scriptPath = path.resolve('assets/runtime/claude-statusline.ps1');
    const input = {
      context_window: {
        context_window_size: 200_000,
        current_usage: {
          cache_creation_input_tokens: 5_000,
          cache_read_input_tokens: 40_000,
          input_tokens: 8_000,
          output_tokens: 2_000,
        },
        total_input_tokens: 53_000,
        total_output_tokens: 3_000,
        used_percentage: 27.5,
      },
      cost: {
        total_cost_usd: 0.42,
        total_duration_ms: 90_000,
        total_lines_added: 12,
        total_lines_removed: 3,
      },
      effort: {
        level: 'xhigh',
      },
      fast_mode: true,
      model: {
        display_name: 'DeepSeek Chat',
        id: 'deepseek-chat',
      },
      rate_limits: {
        five_hour: { used_percentage: 18 },
        seven_day: { used_percentage: 7 },
      },
      session_id: 'session-fixture',
      session_name: 'api-visualization',
    };

    const result = spawnSync(
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
      ],
      {
        encoding: 'utf8',
        input: JSON.stringify(input),
        timeout: STATUSLINE_PROCESS_TIMEOUT_MS,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ClaudeDock');
    const metrics = JSON.parse(readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '')) as Record<
      string,
      unknown
    >;
    expect(metrics).toMatchObject({
      contextWindowSize: 200_000,
      contextWindowUsed: 53_000,
      effortLevel: 'xhigh',
      fastMode: true,
      inputTokens: 53_000,
      modelId: 'deepseek-chat',
      outputTokens: 3_000,
      sessionCostUsd: 0.42,
      sessionId: 'session-fixture',
      sessionName: 'api-visualization',
    });
  });

  statusLineIt('uses exact current usage instead of a rounded 100% display value', () => {
    const outputPath = path.join(fixtureRoot, 'metrics-rounded-percent.json');
    const scriptPath = path.resolve('assets/runtime/claude-statusline.ps1');
    const result = spawnSync(
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
      ],
      {
        encoding: 'utf8',
        input: JSON.stringify({
          context_window: {
            context_window_size: 200_000,
            current_usage: {
              cache_creation_input_tokens: 10_000,
              cache_read_input_tokens: 165_000,
              input_tokens: 12_345,
              output_tokens: 2_000,
            },
            used_percentage: 100,
          },
          model: { display_name: 'GPT bridge', id: 'gpt-5.6-sol' },
          session_id: 'session-rounded-percent',
        }),
        timeout: STATUSLINE_PROCESS_TIMEOUT_MS,
      },
    );

    expect(result.status).toBe(0);
    const metrics = JSON.parse(readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '')) as Record<
      string,
      unknown
    >;
    expect(metrics.contextWindowUsed).toBe(187_345);
  });

  statusLineIt('omits the effort level for a model that does not report one', () => {
    // `effort` is absent whenever the active model has no reasoning-effort parameter, so the
    // footer must fall back to the requested level rather than showing a stale one.
    const outputPath = path.join(fixtureRoot, 'metrics-no-effort.json');
    const scriptPath = path.resolve('assets/runtime/claude-statusline.ps1');
    const result = spawnSync(
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
      ],
      {
        encoding: 'utf8',
        input: JSON.stringify({
          model: { display_name: 'Some Gateway Model', id: 'gateway-model' },
          session_id: 'session-no-effort',
        }),
        timeout: STATUSLINE_PROCESS_TIMEOUT_MS,
      },
    );

    expect(result.status).toBe(0);
    const metrics = JSON.parse(readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '')) as Record<
      string,
      unknown
    >;
    expect(metrics.effortLevel).toBeNull();
    expect(metrics.modelId).toBe('gateway-model');
  });

  statusLineIt('decodes UTF-8 session names on non-UTF-8 consoles', () => {
    // On Chinese Windows the console codepage is GBK. Claude Code writes UTF-8, so reading stdin
    // through [Console]::In mangled multi-byte titles — a double-byte read could even swallow the
    // closing quote and break the whole JSON, which is why resumed sessions with AI titles
    // produced no metrics at all while brand-new (untitled) sessions worked.
    const outputPath = path.join(fixtureRoot, 'metrics-utf8.json');
    const scriptPath = path.resolve('assets/runtime/claude-statusline.ps1');
    const input = {
      context_window: {
        context_window_size: 200_000,
        total_input_tokens: 117_780,
        total_output_tokens: 1_055,
        used_percentage: 59,
      },
      model: { display_name: 'Fable 5', id: 'claude-fable-5' },
      session_id: '622667ea-db17-486c-9542-3fbb1208faec',
      session_name: '修复对话翻页与标题实时更新',
    };

    const result = spawnSync(
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
      ],
      {
        input: Buffer.from(JSON.stringify(input), 'utf8'),
        timeout: STATUSLINE_PROCESS_TIMEOUT_MS,
      },
    );

    expect(result.status).toBe(0);
    const metrics = JSON.parse(readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '')) as Record<
      string,
      unknown
    >;
    expect(metrics).toMatchObject({
      contextWindowUsed: 118_000,
      modelId: 'claude-fable-5',
      sessionId: '622667ea-db17-486c-9542-3fbb1208faec',
      sessionName: '修复对话翻页与标题实时更新',
    });
  });
});
