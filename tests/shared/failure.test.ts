import { describe, expect, it } from 'vitest';
import {
  failureDisplayMessage,
  isFailure,
  isFailureKind,
} from '../../src/shared/diagnostics/failure';

describe('shared failure diagnostics', () => {
  it('accepts only complete failures from the fixed classification set', () => {
    const failure = {
      code: 'CD-TERMINAL-ABC-1',
      detail: 'spawn ENOENT',
      kind: 'environment' as const,
      message: '无法启动终端。',
    };

    expect(isFailure(failure)).toBe(true);
    expect(isFailureKind('external-service')).toBe(true);
    expect(isFailureKind('network')).toBe(false);
    expect(isFailure({ ...failure, code: '' })).toBe(false);
    expect(isFailure({ ...failure, detail: undefined })).toBe(false);
  });

  it('keeps the user message and exposes the correlation code', () => {
    expect(failureDisplayMessage({ code: 'CD-TERMINAL-ABC-1', message: '无法启动终端。' })).toBe(
      '无法启动终端。（诊断码：CD-TERMINAL-ABC-1）',
    );
  });
});
