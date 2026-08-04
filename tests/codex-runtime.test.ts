import { describe, expect, it } from 'vitest';
import {
  buildCodexLaunchCommand,
  codexResourceUsage,
  parseCodexAccountRead,
  parseCodexRateLimits,
} from '../src/main/codex-runtime';

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
