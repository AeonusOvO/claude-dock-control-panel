import { describe, expect, it } from 'vitest';
import { diagnoseClaudeConnection } from '../src/shared/claude-connection-remedy';
import { findClaudeProvider } from '../src/shared/claude-providers';
import type { ClaudeConnectionTestResult } from '../src/shared/contracts';

const failedResult = (
  overrides: Partial<ClaudeConnectionTestResult> = {},
): ClaudeConnectionTestResult => ({
  message: '测试失败',
  ok: false,
  stages: [],
  testedAt: 1,
  tone: 'error',
  ...overrides,
});

describe('Claude connection remedy', () => {
  it('offers authentication switching and official provider links for 401/403 failures', () => {
    const remedy = diagnoseClaudeConnection(
      failedResult({ authMode: 'authToken', failureKind: 'authentication', httpStatus: 401 }),
      { provider: findClaudeProvider('deepseek') },
    );

    expect(remedy?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authMode: 'apiKey', kind: 'switch-auth-mode' }),
        expect.objectContaining({ kind: 'open-console' }),
        expect.objectContaining({ kind: 'open-docs' }),
      ]),
    );
  });

  it('does not suggest reusing the wrong Kimi credential family', () => {
    const remedy = diagnoseClaudeConnection(failedResult({ failureKind: 'authentication' }), {
      provider: findClaudeProvider('kimi-code'),
    });

    expect(remedy?.cause).toContain('不能混用');
  });

  it('routes missing Anthropic endpoints through provider selection or the local router', () => {
    const remedy = diagnoseClaudeConnection(failedResult({ failureKind: 'not-found' }), {
      provider: findClaudeProvider('custom'),
    });

    expect(remedy?.actions.map((action) => action.kind)).toEqual(
      expect.arrayContaining(['switch-provider', 'install-router']),
    );
  });

  it('offers the catalog fast model only for model-level failures', () => {
    const remedy = diagnoseClaudeConnection(failedResult({ failureKind: 'model' }), {
      provider: findClaudeProvider('minimax-cn'),
    });

    expect(remedy?.actions).toContainEqual(expect.objectContaining({ kind: 'use-fast-model' }));
  });

  it('prioritizes environment repair and router lifecycle remedies', () => {
    expect(
      diagnoseClaudeConnection(failedResult(), {
        installationSecurity: 'update-required',
      })?.actions.at(0)?.kind,
    ).toBe('install-claude');
    expect(
      diagnoseClaudeConnection(failedResult(), {
        provider: findClaudeProvider('gateway'),
        routerInstalled: true,
        routerRunning: false,
      })?.actions.at(0)?.kind,
    ).toBe('start-router');
  });
});
