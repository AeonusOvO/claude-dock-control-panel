import { describe, expect, it } from 'vitest';
import type { SaveClaudeConfigInput } from '../src/shared/contracts';
import {
  buildClaudeEnvironment,
  buildClaudeLaunchCommand,
  evaluateClaudeInstallation,
  normalizeClaudeConfig,
} from '../src/main/claude-configuration';

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
      authMode: 'apiKey',
      baseUrl: 'https://gateway.example.com',
      model: 'deepseek-chat',
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

  it('pins every Claude model alias to the selected gateway model', () => {
    const config = normalizeClaudeConfig(gatewayInput);
    const environment = buildClaudeEnvironment(config, 'encrypted-at-rest-secret');

    expect(environment).toMatchObject({
      ANTHROPIC_API_KEY: 'encrypted-at-rest-secret',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-chat',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat',
      ANTHROPIC_MODEL: 'deepseek-chat',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_FEEDBACK_COMMAND: '1',
      DISABLE_TELEMETRY: '1',
    });
  });

  it('classifies the disclosed tracking versions and protected versions', () => {
    expect(evaluateClaudeInstallation('2.1.91 (Claude Code)').security).toBe('blocked-version');
    expect(evaluateClaudeInstallation('2.1.196 (Claude Code)').security).toBe('blocked-version');
    expect(evaluateClaudeInstallation('2.1.197 (Claude Code)').security).toBe('ready');
    expect(evaluateClaudeInstallation('2.1.220 (Claude Code)').security).toBe('ready');
    expect(evaluateClaudeInstallation('unparseable').security).toBe('unknown');
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
  });
});
