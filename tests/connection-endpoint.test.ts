import { describe, expect, it } from 'vitest';
import {
  completeConnectionEndpoint,
  routerProtocolForOpenAiEndpoint,
} from '../src/shared/connection-endpoint';

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
    '',
    '/',
    'https://user:secret@example.com',
    'https://api.example.com/v1?token=secret',
    'http://api.example.com',
  ])('rejects unsafe or incomplete input %s', (input) => {
    expect(() => completeConnectionEndpoint(input, 'anthropic')).toThrow();
  });
});
