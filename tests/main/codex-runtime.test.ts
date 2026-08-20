import { describe, expect, it, vi } from 'vitest';
import type { CodexProjectState } from '../../src/shared/contracts';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import {
  buildCodexLaunchCommand,
  CodexRuntime,
  codexResourceUsage,
  parseCodexAccountRead,
  parseCodexRateLimits,
} from '../../src/main/codex/runtime';
import type { DownloadEngine } from '../../src/main/download/engine';

const createRuntime = () => {
  const onState = vi.fn<(state: CodexProjectState) => void>();
  const writeToTerminal = vi.fn(
    (_sessionId: string, _ptyGeneration: number, _data: string): boolean => true,
  );
  const runtime = new CodexRuntime(
    'D:\\claudedock-test',
    onState,
    writeToTerminal,
    {} as DownloadEngine,
    new BusyRegistry(),
    fetch,
  );
  const state = (sessionId: string, cwd: string): CodexProjectState => ({
    active: runtime.isActive(sessionId),
    cwd,
    installation: {
      executable: 'C:\\OpenAI\\codex.exe',
      installed: true,
      message: 'Codex CLI 已就绪。',
      updateAvailable: false,
    },
    login: { phase: 'idle' },
    requiresOpenaiAuth: false,
    sessionId,
  });
  vi.spyOn(runtime, 'getState').mockImplementation(async (sessionId, cwd) => state(sessionId, cwd));
  return { runtime, writeToTerminal };
};

const markerFromLaunchCommand = (command: string): string => {
  const marker = /\[Console\]::Write\('([^']+)'\)$/.exec(command)?.[1];
  if (!marker) {
    throw new Error('Launch command did not contain its exit marker.');
  }
  return marker;
};

describe('Codex runtime protocol adapters', () => {
  it('exposes only display-safe ChatGPT account fields', () => {
    expect(
      parseCodexAccountRead({
        account: {
          accessToken: 'must-not-escape',
          email: 'member@example.com',
          planType: 'plus',
          type: 'chatgpt',
        },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({
      account: {
        email: 'member@example.com',
        planType: 'plus',
        type: 'chatgpt',
      },
      requiresOpenaiAuth: true,
    });
  });

  it('handles a signed-out account and normalizes unknown account types', () => {
    expect(parseCodexAccountRead({ account: null, requiresOpenaiAuth: true })).toEqual({
      requiresOpenaiAuth: true,
    });
    expect(
      parseCodexAccountRead({
        account: { type: 'future-login-provider' },
        requiresOpenaiAuth: false,
      }).account?.type,
    ).toBe('other');
  });

  it('clamps usage percentages while preserving official window metadata', () => {
    expect(
      parseCodexRateLimits({
        rateLimits: {
          primary: { resetsAt: 2_000, usedPercent: 130, windowDurationMins: 300 },
          secondary: { usedPercent: -8 },
        },
      }),
    ).toEqual({
      primary: { resetsAt: 2_000, usedPercent: 100, windowDurationMins: 300 },
      secondary: { resetsAt: undefined, usedPercent: 0, windowDurationMins: undefined },
    });
  });

  it('exposes official ChatGPT quota windows with their real durations', () => {
    expect(
      codexResourceUsage(
        { email: 'member@example.com', planType: 'plus', type: 'chatgpt' },
        {
          primary: { usedPercent: 26, windowDurationMins: 300 },
          secondary: { usedPercent: 8, windowDurationMins: 10_080 },
        },
      ),
    ).toMatchObject({
      availability: 'available',
      capabilities: { windows: true },
      windows: [
        { label: '5 小时', usedPercent: 26 },
        { label: '7 天', usedPercent: 8 },
      ],
    });
  });

  it.each([
    ['new', false, false],
    ['continue', true, true],
    ['resume', true, false],
  ] as const)(
    'builds the %s TUI launch with explicit project safety flags',
    (mode, resume, last) => {
      const command = buildCodexLaunchCommand(
        "C:\\OpenAI's Tools\\codex.exe",
        "D:\\Work\\Owner's Project",
        mode,
        '\u001b]9;marker\u0007',
      );

      expect(command).toContain("& 'C:\\OpenAI''s Tools\\codex.exe'");
      expect(command).toContain("'--cd' 'D:\\Work\\Owner''s Project'");
      expect(command).toContain("'--sandbox' 'workspace-write'");
      expect(command).toContain("'--ask-for-approval' 'on-request'");
      expect(command).toContain("'--no-alt-screen'");
      expect(command.includes("'resume'")).toBe(resume);
      expect(command.includes("'--last'")).toBe(last);
      expect(command).toContain("[Console]::Write('\u001b]9;marker\u0007')");
    },
  );
});

describe('Codex runtime PTY ownership', () => {
  it('routes writes only through the exact bound PTY generation', async () => {
    const { runtime, writeToTerminal } = createRuntime();
    try {
      expect(() => runtime.bindPty('session-a', 7)).toThrow(
        'Codex 启动状态已失效，无法绑定新的终端。',
      );

      await runtime.prepareLaunch('session-a', 'D:\\Project', 'new');
      runtime.bindPty('session-a', 7);

      expect(() => runtime.bindPty('session-a', 8)).toThrow(
        'Codex 已绑定到其他终端，这次启动结果已失效。',
      );
      expect(runtime.isBoundToPty('session-a', 7)).toBe(true);
      expect(runtime.writeTerminal('session-a', 7, 'start\r')).toBe(true);
      expect(writeToTerminal).toHaveBeenCalledWith('session-a', 7, 'start\r');

      expect(runtime.writeTerminal('session-a', 6, 'stale\r')).toBe(false);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
    } finally {
      runtime.dispose();
    }
  });

  it('clears stale launch ownership and ignores output or cleanup from the old PTY', async () => {
    const { runtime, writeToTerminal } = createRuntime();
    try {
      const first = await runtime.prepareLaunch('session-a', 'D:\\Project', 'new');
      const firstMarker = markerFromLaunchCommand(first.command);
      expect(first.predecessorPtyGeneration).toBeUndefined();
      runtime.bindPty('session-a', 1);

      const second = await runtime.prepareLaunch('session-a', 'D:\\Project', 'continue');
      const secondMarker = markerFromLaunchCommand(second.command);
      expect(second.predecessorPtyGeneration).toBe(1);
      expect(runtime.isBoundToPty('session-a', 1)).toBe(false);
      runtime.bindPty('session-a', 2);

      expect(runtime.setInactive('session-a', 1)).toBe(false);
      expect(runtime.isActive('session-a')).toBe(true);
      expect(runtime.consumeTerminalOutput('session-a', 1, `old${firstMarker}`)).toBe(
        `old${firstMarker}`,
      );
      expect(runtime.isActive('session-a')).toBe(true);
      expect(runtime.writeTerminal('session-a', 1, 'late\r')).toBe(false);
      expect(writeToTerminal).not.toHaveBeenCalled();

      expect(runtime.consumeTerminalOutput('session-a', 2, `before${secondMarker}after`)).toBe(
        'beforeafter',
      );
      expect(runtime.isActive('session-a')).toBe(false);
      expect(runtime.isBoundToPty('session-a', 2)).toBe(false);
    } finally {
      runtime.dispose();
    }
  });

  it('separates prepared cleanup from exact-generation deactivation', async () => {
    const { runtime } = createRuntime();
    try {
      await runtime.prepareLaunch('session-a', 'D:\\Project', 'new');
      expect(Reflect.apply(runtime.setInactive, runtime, ['session-a'])).toBe(false);
      expect(runtime.isActive('session-a')).toBe(true);
      expect(runtime.cleanupPreparedLaunch('session-a')).toBe(true);
      expect(runtime.isActive('session-a')).toBe(false);

      await runtime.prepareLaunch('session-a', 'D:\\Project', 'new');
      runtime.bindPty('session-a', 5);
      expect(Reflect.apply(runtime.setInactive, runtime, ['session-a'])).toBe(false);
      expect(runtime.cleanupPreparedLaunch('session-a')).toBe(false);
      expect(runtime.setInactive('session-a', 4)).toBe(false);
      expect(runtime.isBoundToPty('session-a', 5)).toBe(true);
      expect(runtime.setInactive('session-a', 5)).toBe(true);
      expect(runtime.isActive('session-a')).toBe(false);
      expect(runtime.isBoundToPty('session-a', 5)).toBe(false);
      expect(runtime.setInactive('session-a', 5)).toBe(false);
    } finally {
      runtime.dispose();
    }
  });
});
