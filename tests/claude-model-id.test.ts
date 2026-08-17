import { describe, expect, it } from 'vitest';
import {
  claudeModelIdsMatch,
  hasClaudeOneMillionContextSuffix,
  resolveClaudeRuntimeModel,
  stripClaudeContextWindowSuffix,
} from '../src/shared/claude-model-id';

describe('Claude runtime model ids', () => {
  it.each([
    ['claude-opus-5', 'claude-opus-5'],
    ['claude-opus-5[1m]', 'claude-opus-5'],
    ['claude-opus-5[1M]', 'claude-opus-5'],
    ['vendor/model[1m]', 'vendor/model'],
    ['vendor/model[1m]-preview', 'vendor/model[1m]-preview'],
  ])('strips only a terminal 1M context marker from %s', (model, expected) => {
    expect(stripClaudeContextWindowSuffix(model)).toBe(expected);
  });

  it.each([
    ['claude-opus-5[1m]', true],
    ['claude-opus-5[1M]', true],
    ['claude-opus-5', false],
    ['claude-opus-5[1m]-preview', false],
  ])('detects whether %s carries a terminal 1M marker', (model, expected) => {
    expect(hasClaudeOneMillionContextSuffix(model)).toBe(expected);
  });

  it.each([
    ['claude-opus-5', 'extended', undefined, 'claude-opus-5[1m]'],
    ['claude-sonnet-5', 'custom', 1_000_000, 'claude-sonnet-5[1m]'],
    ['claude-opus-5[1m]', 'extended', undefined, 'claude-opus-5[1m]'],
    ['claude-opus-5[1m]', 'standard', undefined, 'claude-opus-5'],
    ['claude-opus-5[1m]', 'custom', 256_000, 'claude-opus-5'],
    ['claude-opus-5[1m]', 'custom', 1_050_000, 'claude-opus-5'],
    ['claude-opus-5[1m]', 'auto', undefined, 'claude-opus-5[1m]'],
    ['claude-opus-5', 'auto', undefined, 'claude-opus-5'],
    ['vendor/reasoner-v3', 'extended', undefined, 'vendor/reasoner-v3'],
    ['gpt-5.6-sol', 'custom', 1_000_000, 'gpt-5.6-sol'],
  ] as const)(
    'resolves %s in %s mode with custom tokens %s to %s',
    (model, mode, customTokens, expected) => {
      expect(resolveClaudeRuntimeModel(model, mode, customTokens)).toBe(expected);
    },
  );

  it.each([
    ['claude-opus-5', 'claude-opus-5[1m]', true],
    ['claude-opus-5[1M]', 'CLAUDE-OPUS-5', true],
    ['vendor/reasoner-v3[1m]', 'VENDOR/REASONER-V3', true],
    ['claude-opus-5[1m]', 'claude-sonnet-5', false],
    ['vendor/reasoner-v3', 'vendor/reasoner-v30', false],
  ])('compares %s and %s as suffix-equivalent model ids: %s', (expected, actual, matches) => {
    expect(claudeModelIdsMatch(expected, actual)).toBe(matches);
    expect(claudeModelIdsMatch(actual, expected)).toBe(matches);
  });
});
