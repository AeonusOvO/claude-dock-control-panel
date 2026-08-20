import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFailureReporter,
  Logger,
  redactLogText,
  reportFailure,
} from '../../src/main/infra/logger';

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

describe('main logger', () => {
  it('keeps a bounded newest-first ring and resolves an entry by code', () => {
    let now = 1_000;
    const logger = new Logger({ capacity: 2, now: () => now++ });
    logger.info('bootstrap', 'first');
    const second = logger.warn('network preflight', 'second');
    const third = logger.error('terminal', 'third', new Error('spawn failed'));

    expect(logger.query()).toEqual([third, second]);
    expect(logger.query({ code: second.code })).toEqual([second]);
    expect(logger.query({ domain: 'network preflight' })).toEqual([second]);
  });

  it('redacts secrets in memory and in the optional JSONL sink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-logger-'));
    fixtures.push(root);
    const filePath = path.join(root, 'diagnostics', 'main.jsonl');
    const logger = new Logger({ filePath, now: () => 2_000 });
    const entry = logger.error(
      'network',
      'request failed',
      'Authorization: Bearer secret-token at C:\\Users\\alice\\project?token=secret',
    );

    expect(entry.detail).not.toContain('secret-token');
    expect(entry.detail).not.toContain('alice');
    const persisted = readFileSync(filePath, 'utf8');
    expect(persisted).toContain(entry.code);
    expect(persisted).not.toContain('secret-token');
    expect(persisted).not.toContain('alice');
    expect(redactLogText('HTTP 503 from upstream')).toBe('HTTP 503 from upstream');
  });

  it('returns the same correlation code in a classified failure and its log entry', () => {
    const logger = new Logger({ now: () => 3_000 });
    const failure = reportFailure(
      {
        detail: new Error('gateway unavailable'),
        domain: 'claude',
        kind: 'external-service',
        message: 'Claude 服务暂时不可用。',
      },
      logger,
    );

    expect(failure).toMatchObject({
      detail: expect.stringContaining('gateway unavailable'),
      kind: 'external-service',
      message: 'Claude 服务暂时不可用。',
    });
    expect(logger.query({ code: failure.code })).toEqual([
      expect.objectContaining({ code: failure.code, kind: failure.kind }),
    ]);
  });

  it('binds a failure reporter to one normalized diagnostics domain', () => {
    const logger = new Logger({ now: () => 4_000 });
    const reportTerminalFailure = createFailureReporter('Terminal Runtime', logger);
    const failure = reportTerminalFailure(
      'environment',
      '无法启动终端。',
      new Error('spawn ENOENT'),
    );

    expect(logger.query({ code: failure.code })).toEqual([
      expect.objectContaining({
        code: failure.code,
        domain: 'terminal-runtime',
        kind: failure.kind,
        message: failure.message,
      }),
    ]);
  });
});
