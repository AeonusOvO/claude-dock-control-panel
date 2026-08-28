import { describe, expect, it } from 'vitest';
import {
  completeConnectionEndpoint,
  normalizeConnectionBaseUrl,
  openAiModelsEndpoint,
  routerProtocolForOpenAiEndpoint,
} from '../../src/shared/router/connection-endpoint';

describe('connection endpoint completion', () => {
  it.each([
    ['api.example.com', 'https://api.example.com/v1/messages'],
    ['api.example.com/', 'https://api.example.com/v1/messages'],
    ['/api.example.com/v1', 'https://api.example.com/v1/messages'],
    ['https://api.example.com/v1/messages', 'https://api.example.com/v1/messages'],
    ['https:\\api.example.com\\v1\\messages', 'https://api.example.com/v1/messages'],
    ['localhost:3456', 'http://localhost:3456/v1/messages'],
    ['[::1]:3456', 'http://[::1]:3456/v1/messages'],
  ])('completes Anthropic input %s', (input, expected) => {
    expect(completeConnectionEndpoint(input, 'anthropic')).toBe(expected);
  });

  it.each([
    ['api.example.com', 'https://api.example.com/v1/chat/completions'],
    ['//api.example.com/', 'https://api.example.com/v1/chat/completions'],
    ['//localhost:3456/', 'http://localhost:3456/v1/chat/completions'],
    ['api.example.com/v1', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1/responses', 'https://api.example.com/v1/responses'],
  ])('completes OpenAI input %s', (input, expected) => {
    expect(completeConnectionEndpoint(input, 'openai')).toBe(expected);
  });

  it('replaces a known endpoint when the selected protocol changes', () => {
    expect(completeConnectionEndpoint('https://api.example.com/v1/messages', 'openai')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
    expect(
      completeConnectionEndpoint('https://api.example.com/v1/chat/completions', 'anthropic'),
    ).toBe('https://api.example.com/v1/messages');
  });

  it('detects OpenAI Responses without making it a second UI protocol', () => {
    expect(routerProtocolForOpenAiEndpoint('https://api.example.com/v1/responses')).toBe(
      'openai_responses',
    );
    expect(routerProtocolForOpenAiEndpoint('https://api.example.com/v1/chat/completions')).toBe(
      'openai_chat_completions',
    );
  });

  it.each([
    ['api.example.com', 'https://api.example.com/v1/models'],
    ['api.example.com/v1', 'https://api.example.com/v1/models'],
    ['api.example.com/openai/v1/chat/completions', 'https://api.example.com/openai/v1/models'],
    ['open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/models'],
    ['qianfan.baidubce.com/v2/chat/completions', 'https://qianfan.baidubce.com/v2/models'],
    ['http://127.0.0.1:8317/v1/models', 'http://127.0.0.1:8317/v1/models'],
  ])('derives the model catalog for %s', (input, expected) => {
    expect(openAiModelsEndpoint(input)).toBe(expected);
  });

  it.each([
    '',
    '/',
    'https://user:secret@example.com',
    'https://api.example.com/v1?token=secret',
    'http://api.example.com',
  ])('rejects unsafe or incomplete input %s', (input) => {
    expect(() => completeConnectionEndpoint(input, 'anthropic')).toThrow();
  });
});

/*
 * Claude Code appends `/v1/messages` to `ANTHROPIC_BASE_URL` itself. Collapsing a relay's own path
 * here is what made working relays unreachable, so the base URL is left exactly as published.
 */
describe('connection base URL normalization', () => {
  it.each([
    ['api.example.com', 'https://api.example.com'],
    ['api.example.com/', 'https://api.example.com'],
    ['api.example.com/v1', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1'],
    ['api.example.com/relay/v1', 'https://api.example.com/relay/v1'],
    ['api.example.com/proxy/anthropic', 'https://api.example.com/proxy/anthropic'],
    ['api.example.com/openai/v1', 'https://api.example.com/openai/v1'],
    ['https:\\api.example.com\\relay\\v1', 'https://api.example.com/relay/v1'],
    ['localhost:3456', 'http://localhost:3456'],
    ['[::1]:3456', 'http://[::1]:3456'],
  ])('keeps the published path of %s', (input, expected) => {
    expect(normalizeConnectionBaseUrl(input)).toBe(expected);
  });

  it('reduces a pasted Messages endpoint back to the base it belongs to', () => {
    expect(normalizeConnectionBaseUrl('https://api.example.com/v1/messages')).toBe(
      'https://api.example.com',
    );
    expect(normalizeConnectionBaseUrl('https://api.example.com/relay/v1/messages')).toBe(
      'https://api.example.com/relay',
    );
  });

  it('points an OpenAI endpoint at the protocol switch instead of silently accepting it', () => {
    expect(() => normalizeConnectionBaseUrl('https://api.example.com/v1/chat/completions')).toThrow(
      /OpenAI 协议/,
    );
    expect(() => normalizeConnectionBaseUrl('https://api.example.com/v1/responses')).toThrow(
      /OpenAI 协议/,
    );
  });

  it.each([
    '',
    '/',
    'https://user:secret@example.com',
    'https://api.example.com/v1?token=secret',
    'http://api.example.com',
  ])('rejects unsafe or incomplete input %s', (input) => {
    expect(() => normalizeConnectionBaseUrl(input)).toThrow();
  });
});
