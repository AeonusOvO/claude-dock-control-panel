import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SaveClaudeConfigInput } from '../src/shared/contracts';
import {
  buildClaudeEnvironment,
  buildClaudeLaunchCommand,
  buildClaudeSettingsEnvironment,
  buildRuntimeSignalCommand,
  buildWebSearchGuardCommand,
  evaluateClaudeInstallation,
  managedChatGptContextProfile,
  normalizeClaudeConfig,
  shouldDisableInheritedApiKeyHelper,
} from '../src/main/claude-configuration';
import { CLAUDEDOCK_WEB_RESEARCH_AGENTS } from '../src/main/claude-web-research';
import { parseClaudePermissionMode } from '../src/shared/claude-permission-mode';

const gatewayInput: SaveClaudeConfigInput = {
  authMode: 'apiKey',
  baseUrl: 'https://gateway.example.com/',
  credential: 'secret',
  credentialAction: 'replace',
  model: 'deepseek-chat',
  preset: 'deepseek',
  provider: 'gateway',
};

describe('Claude Code configuration', () => {
  it('normalizes an Anthropic-compatible gateway without accepting insecure remote HTTP', () => {
    expect(normalizeClaudeConfig(gatewayInput)).toEqual({
      apiKeyHelperPolicy: 'prefer-claudedock',
      authMode: 'apiKey',
      baseUrl: 'https://gateway.example.com',
      model: 'deepseek-chat',
      modelFast: 'deepseek-chat',
      preset: 'deepseek',
      provider: 'gateway',
    });

    expect(() =>
      normalizeClaudeConfig({
        ...gatewayInput,
        baseUrl: 'http://gateway.example.com',
      }),
    ).toThrow('必须使用 HTTPS');
    expect(
      normalizeClaudeConfig({
        ...gatewayInput,
        baseUrl: 'http://127.0.0.1:4000',
      }).baseUrl,
    ).toBe('http://127.0.0.1:4000');
    expect(
      normalizeClaudeConfig({
        ...gatewayInput,
        baseUrl: 'https://gateway.example.com/team/v1/messages',
      }).baseUrl,
    ).toBe('https://gateway.example.com/team');
    expect(() =>
      normalizeClaudeConfig({
        ...gatewayInput,
        baseUrl: 'https://gateway.example.com/v1/chat/completions',
      }),
    ).toThrow('不能直接用于 Claude Code');
  });

  it('accepts the ChatGPT subscription preset only through a loopback gateway', () => {
    const subscriptionInput: SaveClaudeConfigInput = {
      ...gatewayInput,
      authMode: 'authToken',
      baseUrl: 'http://localhost:8317/',
      model: 'gpt-5.6-sol',
      modelFast: 'gpt-5.4-mini',
      preset: 'chatgpt-subscription',
    };

    expect(normalizeClaudeConfig(subscriptionInput)).toMatchObject({
      authMode: 'authToken',
      baseUrl: 'http://localhost:8317',
      model: 'gpt-5.6-sol',
      modelFast: 'gpt-5.4-mini',
      preset: 'chatgpt-subscription',
      provider: 'gateway',
    });
    const normalized = normalizeClaudeConfig(subscriptionInput);
    expect(managedChatGptContextProfile(normalized)?.autoCompactAtTokens).toBe(206_720);
    expect(buildClaudeEnvironment(normalized, 'local-gateway-token')).toMatchObject({
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '258400',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '272000',
      DISABLE_AUTO_COMPACT: null,
      DISABLE_COMPACT: null,
    });
    expect(buildClaudeSettingsEnvironment(normalized)).toMatchObject({
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '258400',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '272000',
      DISABLE_AUTO_COMPACT: '',
      DISABLE_COMPACT: '',
    });
    expect(buildClaudeSettingsEnvironment(normalized, 'extended')).toMatchObject({
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '997500',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1050000',
    });
    const otherModel = normalizeClaudeConfig({ ...subscriptionInput, model: 'gpt-5.4-mini' });
    expect(buildClaudeSettingsEnvironment(otherModel, 'extended')).toMatchObject({
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '',
    });
    expect(() =>
      normalizeClaudeConfig({
        ...subscriptionInput,
        baseUrl: 'https://gateway.example.com',
      }),
    ).toThrow('只接受本机回环网关地址');
    expect(() =>
      normalizeClaudeConfig({
        ...subscriptionInput,
        authMode: 'apiKey',
      }),
    ).toThrow('必须使用本地网关 Bearer Token');
  });

  /*
   * Claude Code appends `/v1/messages` to whatever it is given, so a relay documented as ending in
   * `/v1` breaks the moment that segment is normalized away.
   */
  it.each([
    ['https://relay.example.com/v1', 'https://relay.example.com/v1'],
    ['https://relay.example.com/relay/v1', 'https://relay.example.com/relay/v1'],
    ['https://relay.example.com/proxy/anthropic', 'https://relay.example.com/proxy/anthropic'],
    ['relay.example.com/v1', 'https://relay.example.com/v1'],
  ])('stores the relay base URL %s as published', (baseUrl, expected) => {
    expect(normalizeClaudeConfig({ ...gatewayInput, baseUrl }).baseUrl).toBe(expected);
  });

  it('pins every Claude model alias to the selected gateway model', () => {
    const config = normalizeClaudeConfig({ ...gatewayInput, modelFast: 'deepseek-fast' });
    const environment = buildClaudeEnvironment(config, 'encrypted-at-rest-secret');

    expect(environment).toMatchObject({
      ANTHROPIC_API_KEY: 'encrypted-at-rest-secret',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-fast',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-chat',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat',
      ANTHROPIC_MODEL: 'deepseek-chat',
      ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-fast',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_FEEDBACK_COMMAND: '1',
      DISABLE_TELEMETRY: '1',
    });
  });

  it('defaults the fast model to the main model and validates both identifiers', () => {
    expect(normalizeClaudeConfig(gatewayInput).modelFast).toBe('deepseek-chat');
    expect(() =>
      normalizeClaudeConfig({ ...gatewayInput, modelFast: 'invalid model name' }),
    ).toThrow('快速模型标识');
  });

  it('overrides inherited CCR route aliases without writing credentials to temporary settings', () => {
    const config = normalizeClaudeConfig(gatewayInput);
    const environment = buildClaudeSettingsEnvironment(config);

    expect(environment).toMatchObject({
      ANTHROPIC_API_BASE_URL: '',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_MODEL: 'deepseek-chat',
      CCR_CLAUDE_CODE_MODEL: '',
      CLAUDE_AGENT_API_BASE_URL: '',
      CLAUDE_CODE_DISABLE_THINKING: '',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '',
      CLAUDE_CODE_EFFORT_LEVEL: '',
      CODEXL_CLAUDE_CODE_MODEL: '',
      MAX_THINKING_TOKENS: '',
    });
    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(JSON.stringify(environment)).not.toContain('encrypted-at-rest-secret');
  });

  it('clears inherited thinking overrides so the live effort control owns the session', () => {
    const config = normalizeClaudeConfig(gatewayInput);
    const environment = buildClaudeSettingsEnvironment(config);
    const launchEnvironment = buildClaudeEnvironment(config, 'encrypted-at-rest-secret');

    expect(environment).toMatchObject({
      CLAUDE_CODE_DISABLE_THINKING: '',
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
    });
    expect(launchEnvironment).toMatchObject({
      CLAUDE_CODE_DISABLE_THINKING: null,
      CLAUDE_CODE_EFFORT_LEVEL: null,
      MAX_THINKING_TOKENS: null,
      DISABLE_AUTO_COMPACT: null,
      DISABLE_COMPACT: null,
    });
  });

  it('disables an inherited apiKeyHelper only for an explicit ClaudeDock credential', () => {
    const preferred = normalizeClaudeConfig(gatewayInput);

    expect(shouldDisableInheritedApiKeyHelper(preferred)).toBe(true);
    expect(
      shouldDisableInheritedApiKeyHelper(
        normalizeClaudeConfig({ ...gatewayInput, authMode: 'authToken' }),
      ),
    ).toBe(true);
    expect(
      shouldDisableInheritedApiKeyHelper(
        normalizeClaudeConfig({ ...gatewayInput, apiKeyHelperPolicy: 'inherit' }),
      ),
    ).toBe(false);
    expect(
      shouldDisableInheritedApiKeyHelper({
        ...preferred,
        authMode: 'existing',
      }),
    ).toBe(false);
  });

  it('classifies official advisory and below-baseline versions', () => {
    expect(evaluateClaudeInstallation('2.1.91 (Claude Code)').security).toBe('blocked-version');
    expect(evaluateClaudeInstallation('2.1.196 (Claude Code)').security).toBe('update-required');
    expect(evaluateClaudeInstallation('2.1.197 (Claude Code)').security).toBe('ready');
    expect(evaluateClaudeInstallation('2.1.220 (Claude Code)').security).toBe('ready');
    expect(evaluateClaudeInstallation('unparseable').security).toBe('unknown');
  });

  it('preserves the detected installation method during updates', () => {
    expect(
      evaluateClaudeInstallation('2.1.220', 'C:\\Program Files\\Claude\\claude.exe')
        .installationKind,
    ).toBe('native');
    expect(
      evaluateClaudeInstallation('2.1.220', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
        .installationKind,
    ).toBe('npm');
  });

  it('quotes launch inputs and hides the exit marker from the visible command', () => {
    const marker = '\u001b]9;claudedock-exit:session-1\u0007';
    const command = buildClaudeLaunchCommand(
      "C:\\Users\\O'Brien\\settings.json",
      'deepseek-chat',
      'continue',
      marker,
    );

    expect(command).toContain("'C:\\Users\\O''Brien\\settings.json'");
    expect(command).toContain("--model 'deepseek-chat'");
    expect(command).toContain('--continue');
    expect(command).not.toContain(marker);
    expect(command).toContain('FromBase64String');
    expect(command).toContain('Env:ANTHROPIC_API_BASE_URL');
    expect(command).toContain('Env:CCR_CLAUDE_CODE_MODEL');
    expect(command).toContain('Env:CODEXL_CLAUDE_CODE_MODEL');
  });

  it('quotes a specific resume session while preserving environment cleanup', () => {
    const marker = '\u001b]9;claudedock-exit:session-2\u0007';
    const command = buildClaudeLaunchCommand(
      'C:\\Users\\Tester\\settings.json',
      'claude-model',
      'resume',
      marker,
      "a'quoted-session",
    );

    expect(command).toContain("--resume 'a''quoted-session'");
    expect(command).toContain('--no-chrome');
    expect(command).toContain('Remove-Item Env:ANTHROPIC_API_KEY');
    expect(command).not.toContain(marker);
  });

  it('adds session-local web research agent configuration without replacing Claude Code', () => {
    const command = buildClaudeLaunchCommand(
      'C:\\Users\\Tester\\settings.json',
      'claude-model',
      'continue',
      '\u001b]9;claudedock-exit:session-web\u0007',
      undefined,
      { allowBypass: false },
      {
        agents: {
          'claudedock-web-research': {
            effort: 'high',
            tools: ['WebSearch', 'WebFetch'],
          },
        },
        appendSystemPrompt: "Delegate today's web research.",
      },
    );

    expect(command).toContain('--agents');
    expect(command).toContain('claudedock-web-research');
    expect(command).toContain('\\"effort\\":\\"high\\"');
    expect(command).toContain('\\"WebSearch\\",\\"WebFetch\\"');
    expect(command).toContain('--append-system-prompt');
    expect(command).toContain("Delegate today''s web research.");
    expect(command).not.toContain('--agent ');
  });

  /*
   * The isolation workaround is opt-in, so a session launched without it must look like a plain
   * Claude Code session — no injected subagent, no appended system prompt.
   */
  it('launches without web research extensions when the workaround is off', () => {
    const command = buildClaudeLaunchCommand(
      'C:\\Users\\Tester\\settings.json',
      'claude-model',
      'continue',
      '\u001b]9;claudedock-exit:session-plain\u0007',
      undefined,
      { allowBypass: false },
      {},
    );

    expect(command).not.toContain('--agents');
    expect(command).not.toContain('--append-system-prompt');
    expect(command).not.toContain('claudedock-web-research');
    expect(command).toContain('& claude ');
  });

  const itWindows = process.platform === 'win32' ? it : it.skip;

  /*
   * This is the guard that replaces probing a live session by hand. Whether PowerShell 5 mangles a
   * native argument depends on the payload, so the shipped definition is the one under test: an
   * invented fixture survived the old escaping while the real agent arrived as 75 separate argv
   * entries and Claude Code reported `Agent type 'claudedock-web-research' not found`.
   */
  itWindows.each([
    ['the shipped web research definition', CLAUDEDOCK_WEB_RESEARCH_AGENTS],
    [
      'quotes and trailing backslashes',
      {
        'claudedock-web-research': {
          effort: 'high',
          prompt: 'Inspect C:\\research\\ and preserve "quoted evidence".',
          tools: ['WebSearch', 'WebFetch'],
        },
      },
    ],
  ])(
    'preserves --agents through Windows PowerShell native argv handling: %s',
    (_name, agents: Readonly<Record<string, unknown>>) => {
      const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'claudedock-argv-'));
      const probePath = path.join(temporaryDirectory, 'argv-probe.cjs');

      try {
        writeFileSync(
          probePath,
          'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
          'utf8',
        );
        const launchCommand = buildClaudeLaunchCommand(
          'C:\\Users\\Tester\\settings.json',
          'claude-model',
          'continue',
          '',
          undefined,
          { allowBypass: false },
          { agents },
        );
        const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;
        const probeCommand = launchCommand.replace(
          '& claude ',
          `& ${quotePowerShell(process.execPath)} ${quotePowerShell(probePath)} `,
        );
        const output = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', probeCommand],
          { encoding: 'utf8' },
        );
        const argv = JSON.parse(output) as string[];
        const agentsIndex = argv.indexOf('--agents');

        // One argument, not a spray of whitespace-split fragments.
        expect(argv.filter((value) => value.includes('claudedock-web-research'))).toHaveLength(1);
        expect(agentsIndex).toBeGreaterThan(-1);
        expect(JSON.parse(argv[agentsIndex + 1] ?? '')).toEqual(agents);
      } finally {
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
    // A cold Windows runner can spend more than Vitest's default five seconds starting PowerShell.
    45_000,
  );

  it('arms the bypass cycle without starting in it', () => {
    const command = buildClaudeLaunchCommand(
      'C:\\Users\\Tester\\settings.json',
      'claude-model',
      'continue',
      '\u001b]9;claudedock-exit:session-3\u0007',
      undefined,
      { allowBypass: true },
    );

    expect(command).toContain('--allow-dangerously-skip-permissions');
    expect(command).not.toContain('--permission-mode');
  });

  it('starts in an explicit permission mode with the value quoted', () => {
    const command = buildClaudeLaunchCommand(
      'C:\\Users\\Tester\\settings.json',
      'claude-model',
      'continue',
      '\u001b]9;claudedock-exit:session-4\u0007',
      undefined,
      { allowBypass: true, startMode: 'dontAsk' },
    );

    expect(command).toContain("--permission-mode 'dontAsk'");
    expect(command).toContain('--allow-dangerously-skip-permissions');
  });

  it('never pairs the arming flag with a bypass start, and omits both when disarmed', () => {
    const armedStart = buildClaudeLaunchCommand(
      'C:\\Users\\Tester\\settings.json',
      'claude-model',
      'continue',
      '\u001b]9;claudedock-exit:session-5\u0007',
      undefined,
      { allowBypass: true, startMode: 'bypassPermissions' },
    );

    expect(armedStart).toContain("--permission-mode 'bypassPermissions'");
    expect(armedStart).not.toContain('--allow-dangerously-skip-permissions');

    const disarmed = buildClaudeLaunchCommand(
      'C:\\Users\\Tester\\settings.json',
      'claude-model',
      'continue',
      '\u001b]9;claudedock-exit:session-6\u0007',
      undefined,
      { allowBypass: false },
    );

    expect(disarmed).not.toContain('--allow-dangerously-skip-permissions');
    expect(disarmed).not.toContain('--permission-mode');
  });

  it('quotes the runtime signal helper paths and event for the hook shell', () => {
    const command = buildRuntimeSignalCommand(
      'C:\\Program Files\\ClaudeDock\\assets\\runtime\\claude-runtime-signal.ps1',
      'C:\\Users\\Tester\\AppData\\claude\\runtime\\session-1\\signal.json',
      'PostCompact',
    );

    expect(command).toContain('-NoProfile');
    expect(command).toContain('-NonInteractive');
    expect(command).toContain('-ExecutionPolicy Bypass');
    expect(command).toContain('claude-runtime-signal.ps1"');
    expect(command).toContain('-Event "PostCompact"');
    expect(command).not.toContain('\\');
  });

  it('quotes the web-search guard helper and allowed session agent', () => {
    const command = buildWebSearchGuardCommand(
      'C:\\Program Files\\ClaudeDock\\assets\\runtime\\claude-web-search-guard.ps1',
      'claudedock-web-research',
    );

    expect(command).toContain('-NoProfile');
    expect(command).toContain('claude-web-search-guard.ps1"');
    expect(command).toContain('-AllowedAgent "claudedock-web-research"');
  });
});

describe('Claude permission badge parsing', () => {
  it('maps every badge Claude Code paints to a permission mode', () => {
    expect(parseClaudePermissionMode('⏸ manual mode on')).toBe('default');
    expect(parseClaudePermissionMode('⏵⏵ accept edits on')).toBe('acceptEdits');
    expect(parseClaudePermissionMode('⏸ plan mode on')).toBe('plan');
    expect(parseClaudePermissionMode('⏵⏵ auto mode on')).toBe('auto');
    expect(parseClaudePermissionMode("⏵⏵ don't ask on")).toBe('dontAsk');
    expect(parseClaudePermissionMode('⏵⏵ bypass permissions on')).toBe('bypassPermissions');
  });

  it('reads the badge through the ANSI and OSC noise a repaint carries', () => {
    expect(
      parseClaudePermissionMode(
        '\u001b[?25l\u001b[2K\u001b[38;5;208m⏵⏵ accept edits on\u001b[39m\u001b[?25h',
      ),
    ).toBe('acceptEdits');
    expect(
      parseClaudePermissionMode('\u001b]0;Claude Code\u0007\u001b[1m⏸ plan mode on\u001b[22m'),
    ).toBe('plan');
    expect(parseClaudePermissionMode('⏵⏵ bypass \u001b[39mpermissions on')).toBe(
      'bypassPermissions',
    );
  });

  it('rejoins a badge split across a terminal soft wrap', () => {
    expect(parseClaudePermissionMode('⏵⏵ accept\r\n  edits on')).toBe('acceptEdits');
  });

  it('keeps the newest badge when the rolling buffer holds several repaints', () => {
    expect(parseClaudePermissionMode('⏸ plan mode on\r\n⏵⏵ bypass permissions on')).toBe(
      'bypassPermissions',
    );
    expect(parseClaudePermissionMode('⏵⏵ bypass permissions on\r\n⏸ plan mode on')).toBe('plan');
  });

  it('reports nothing when the buffer has not painted a badge yet', () => {
    expect(parseClaudePermissionMode('Welcome to Claude Code')).toBeUndefined();
    expect(parseClaudePermissionMode('')).toBeUndefined();
  });
});
