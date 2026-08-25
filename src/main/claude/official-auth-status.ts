import type { ClaudeOfficialAuthState } from '../../shared/contracts';
import { AsyncRefreshCache } from '../infra/async-refresh-cache';
import { runWindowsCommand, type WindowsCommandOptions } from '../infra/windows-command';

const AUTH_STATUS_CACHE_TTL_MS = 30_000;
const AUTH_STATUS_TIMEOUT_MS = 8_000;

const containsControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

export type ClaudeAuthStatusCommandRunner = (
  command: string,
  argumentsList: string[],
  options: WindowsCommandOptions,
) => Promise<string>;

const safeText = (value: unknown, maximumLength: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || containsControlCharacter(normalized)) {
    return undefined;
  }
  return normalized;
};

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const boundedFailureStdout = (error: unknown): string | undefined => {
  const failure = recordValue(error);
  if (failure?.code !== 1) return undefined;
  const stdout = failure.stdout;
  return typeof stdout === 'string' && Buffer.byteLength(stdout, 'utf8') <= 64 * 1024
    ? stdout
    : undefined;
};

export const parseClaudeOfficialAuthStatus = (
  stdout: string,
  checkedAt = Date.now(),
): ClaudeOfficialAuthState => {
  const parsed = recordValue(JSON.parse(stdout) as unknown);
  if (!parsed || typeof parsed.loggedIn !== 'boolean') {
    throw new Error('Claude Code 登录状态格式无效。');
  }
  const account = recordValue(parsed.account);
  const accountIdentity =
    safeText(parsed.email, 320) ??
    safeText(parsed.accountEmail, 320) ??
    safeText(account?.email, 320);
  const authMethod = safeText(parsed.authMethod, 80);
  return Object.freeze({
    ...(parsed.loggedIn && accountIdentity ? { accountIdentity } : {}),
    ...(authMethod ? { authMethod } : {}),
    available: true,
    checkedAt,
    loggedIn: parsed.loggedIn,
  });
};

export class CachedClaudeOfficialAuthProvider {
  private readonly cache: AsyncRefreshCache<ClaudeOfficialAuthState>;

  public constructor(
    private readonly commandRunner: ClaudeAuthStatusCommandRunner = runWindowsCommand,
    cacheTtlMs = AUTH_STATUS_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.cache = new AsyncRefreshCache(cacheTtlMs, now);
  }

  public getState(): Promise<ClaudeOfficialAuthState> {
    return this.cache.get(() => this.detect());
  }

  public invalidate(): void {
    this.cache.clear();
  }

  private async detect(): Promise<ClaudeOfficialAuthState> {
    const checkedAt = this.now();
    try {
      const stdout = await this.commandRunner('claude', ['auth', 'status', '--json'], {
        env: {
          ANTHROPIC_API_KEY: null,
          ANTHROPIC_AUTH_TOKEN: null,
          ANTHROPIC_BASE_URL: null,
          CLAUDE_CODE_USE_BEDROCK: null,
          CLAUDE_CODE_USE_FOUNDRY: null,
          CLAUDE_CODE_USE_VERTEX: null,
        },
        maxBuffer: 64 * 1024,
        timeout: AUTH_STATUS_TIMEOUT_MS,
      });
      return parseClaudeOfficialAuthStatus(stdout, checkedAt);
    } catch (error) {
      // Claude Code deliberately exits with code 1 when logged out, while still writing its valid
      // JSON status to stdout. `runWindowsCommand` preserves that bounded stdout on the error.
      const stdout = boundedFailureStdout(error);
      if (stdout) {
        try {
          const state = parseClaudeOfficialAuthStatus(stdout, checkedAt);
          if (!state.loggedIn) return state;
        } catch {
          // Malformed failure output follows the same unavailable fallback as every command error.
        }
      }
      return Object.freeze({ available: false, checkedAt, loggedIn: false });
    }
  }
}

export const claudeOfficialAuthProvider = new CachedClaudeOfficialAuthProvider();
