import { describe, expect, it } from 'vitest';
import {
  classifyModelSpeed,
  MINIMUM_CLAUDE_FAST_VERSION,
  MINIMUM_MANAGED_GPT_FAST_GATEWAY_VERSION,
  modelSpeedSignature,
  modelSpeedTargetKey,
} from '../../src/main/claude/model-speed-capabilities';

const official = {
  authMode: 'existing' as const,
  baseUrl: '',
  preset: 'anthropic' as const,
  provider: 'anthropic' as const,
};

const managed = {
  authMode: 'authToken' as const,
  baseUrl: 'http://127.0.0.1:8317',
  preset: 'chatgpt-subscription' as const,
  provider: 'gateway' as const,
};

describe('model speed capabilities', () => {
  it.each(['opus', 'opus[1m]', 'claude-opus-5', 'claude-opus-5-20260701', 'claude-opus-4-8'])(
    'offers native Claude fast for %s',
    (model) => {
      expect(
        classifyModelSpeed({
          claudeVersion: MINIMUM_CLAUDE_FAST_VERSION,
          config: official,
          model,
        }),
      ).toMatchObject({
        availability: 'available',
        canSelectFast: true,
        mechanism: 'claude-native-fast',
      });
    },
  );

  it.each(['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-7'])(
    'rejects unsupported Claude model %s',
    (model) => {
      expect(
        classifyModelSpeed({
          claudeVersion: MINIMUM_CLAUDE_FAST_VERSION,
          config: official,
          model,
        }),
      ).toMatchObject({ availability: 'unsupported', canSelectFast: false, mechanism: 'none' });
    },
  );

  it('keeps unresolved defaults unverified instead of switching models implicitly', () => {
    expect(
      classifyModelSpeed({
        claudeVersion: MINIMUM_CLAUDE_FAST_VERSION,
        config: official,
        model: 'default',
      }),
    ).toMatchObject({ availability: 'unverified', canSelectFast: false });
  });

  it('requires a recent Claude Code only for the speed feature', () => {
    expect(
      classifyModelSpeed({ claudeVersion: '2.1.218', config: official, model: 'claude-opus-5' }),
    ).toMatchObject({ availability: 'update-required', canSelectFast: false });
  });

  it.each(['gpt-5.4', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'offers managed GPT fast for %s',
    (model) => {
      expect(
        classifyModelSpeed({
          claudeVersion: MINIMUM_CLAUDE_FAST_VERSION,
          config: managed,
          managedGatewayVersion: MINIMUM_MANAGED_GPT_FAST_GATEWAY_VERSION,
          model,
        }),
      ).toMatchObject({
        availability: 'available',
        canSelectFast: true,
        mechanism: 'gpt-service-tier',
      });
    },
  );

  it('rejects the alternate mini model and requires the translating gateway version', () => {
    expect(
      classifyModelSpeed({
        claudeVersion: MINIMUM_CLAUDE_FAST_VERSION,
        config: managed,
        managedGatewayVersion: MINIMUM_MANAGED_GPT_FAST_GATEWAY_VERSION,
        model: 'gpt-5.4-mini',
      }),
    ).toMatchObject({ availability: 'unsupported', canSelectFast: false });
    expect(
      classifyModelSpeed({
        claudeVersion: MINIMUM_CLAUDE_FAST_VERSION,
        config: managed,
        managedGatewayVersion: '7.2.116',
        model: 'gpt-5.6-sol',
      }),
    ).toMatchObject({ availability: 'update-required', canSelectFast: false });
  });

  it('does not offer native Claude fast through an unverified third-party route', () => {
    expect(
      classifyModelSpeed({
        claudeVersion: MINIMUM_CLAUDE_FAST_VERSION,
        config: {
          authMode: 'authToken',
          baseUrl: 'https://relay.example/v1',
          preset: 'custom',
          provider: 'gateway',
        },
        model: 'claude-opus-5',
      }),
    ).toMatchObject({ availability: 'unsupported', canSelectFast: false });
  });

  it('keeps target keys stable across managed loopback ports and separate across models', () => {
    const first = modelSpeedTargetKey({ ...managed, model: 'gpt-5.6-sol' });
    const moved = modelSpeedTargetKey({
      ...managed,
      baseUrl: 'http://127.0.0.1:8327',
      model: 'gpt-5.6-sol',
    });
    const otherModel = modelSpeedTargetKey({ ...managed, model: 'gpt-5.4' });
    expect(first).toBe(moved);
    expect(first).not.toBe(otherModel);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('only produces a fast launch signature for a supported explicit preference', () => {
    const capability = classifyModelSpeed({
      claudeVersion: MINIMUM_CLAUDE_FAST_VERSION,
      config: official,
      model: 'claude-opus-5',
    });
    expect(modelSpeedSignature(capability, 'fast')).toBe('claude-native-fast:fast');
    expect(modelSpeedSignature(capability, 'standard')).toBe('standard');
  });
});
