import { describe, expect, it, vi } from 'vitest';
import {
  CachedClaudeOfficialAuthProvider,
  parseClaudeOfficialAuthStatus,
} from '../../src/main/claude/official-auth-status';

describe('Claude official auth status', () => {
  it('projects only the safe account identity from the CLI JSON', () => {
    expect(
      parseClaudeOfficialAuthStatus(
        JSON.stringify({
          accessToken: 'must-never-cross-the-boundary',
          account: { email: 'member@example.test', organizationId: 'private-org-id' },
          apiProvider: 'firstParty',
          authMethod: 'claude.ai',
          loggedIn: true,
        }),
        42,
      ),
    ).toEqual({
      accountIdentity: 'member@example.test',
      authMethod: 'claude.ai',
      available: true,
      checkedAt: 42,
      loggedIn: true,
    });
  });

  it('keeps logged-out state explicit without retaining an identity', () => {
    expect(
      parseClaudeOfficialAuthStatus(
        JSON.stringify({ authMethod: 'none', email: 'stale@example.test', loggedIn: false }),
        7,
      ),
    ).toEqual({ authMethod: 'none', available: true, checkedAt: 7, loggedIn: false });
  });

  it('clears provider environment overrides and caches the bounded command result', async () => {
    const runner = vi.fn(async () =>
      JSON.stringify({ authMethod: 'claude.ai', email: 'member@example.test', loggedIn: true }),
    );
    const provider = new CachedClaudeOfficialAuthProvider(runner, 60_000, () => 11);

    await expect(provider.getState()).resolves.toMatchObject({
      accountIdentity: 'member@example.test',
      loggedIn: true,
    });
    await provider.getState();
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], {
      env: {
        ANTHROPIC_API_KEY: null,
        ANTHROPIC_AUTH_TOKEN: null,
        ANTHROPIC_BASE_URL: null,
        CLAUDE_CODE_USE_BEDROCK: null,
        CLAUDE_CODE_USE_FOUNDRY: null,
        CLAUDE_CODE_USE_VERTEX: null,
      },
      maxBuffer: 64 * 1024,
      timeout: 8_000,
    });
  });

  it('returns an unavailable state without exposing command or parse failures', async () => {
    const provider = new CachedClaudeOfficialAuthProvider(
      vi.fn(async () => {
        throw new Error('token=secret-value');
      }),
      0,
      () => 99,
    );

    await expect(provider.getState()).resolves.toEqual({
      available: false,
      checkedAt: 99,
      loggedIn: false,
    });
  });

  it('keeps the CLI logged-out JSON authoritative when the command exits with code 1', async () => {
    const provider = new CachedClaudeOfficialAuthProvider(
      vi.fn(async () => {
        throw Object.assign(new Error('命令执行失败（退出代码 1）。'), {
          code: 1,
          stdout: JSON.stringify({ authMethod: 'none', loggedIn: false }),
        });
      }),
      0,
      () => 123,
    );

    await expect(provider.getState()).resolves.toEqual({
      authMethod: 'none',
      available: true,
      checkedAt: 123,
      loggedIn: false,
    });
  });

  it('does not treat a failed command payload as a successful login', async () => {
    const provider = new CachedClaudeOfficialAuthProvider(
      vi.fn(async () => {
        throw Object.assign(new Error('命令执行失败（退出代码 1）。'), {
          code: 1,
          stdout: JSON.stringify({ email: 'stale@example.test', loggedIn: true }),
        });
      }),
      0,
      () => 124,
    );

    await expect(provider.getState()).resolves.toEqual({
      available: false,
      checkedAt: 124,
      loggedIn: false,
    });
  });
});
