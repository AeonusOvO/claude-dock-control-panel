import { describe, expect, it } from 'vitest';
import { parseClaudeCurl } from '../../src/shared/claude/curl';

describe('Claude cURL onboarding', () => {
  it('identifies an OpenAI-compatible relay and extracts only the useful fields', () => {
    const result = parseClaudeCurl(`curl https://relay.example.com/v1/chat/completions \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer sk-example-not-real" \\
      -d '{"model":"claude-fable-5","messages":[{"role":"user","content":"Hi"}]}'`);

    expect(result).toMatchObject({
      authMode: 'authToken',
      baseUrl: 'https://relay.example.com',
      credential: 'sk-example-not-real',
      credentialDetected: true,
      endpoint: 'https://relay.example.com/v1/chat/completions',
      model: 'claude-fable-5',
      protocol: 'openai',
      suggestedPreset: 'gateway',
    });
  });

  it('identifies a directly compatible Anthropic Messages endpoint', () => {
    const result = parseClaudeCurl(`curl 'https://gateway.example.com/team/v1/messages' \\
      -H 'x-api-key: key-example' \\
      -d '{"model":"team-sonnet","max_tokens":1,"messages":[]}'`);

    expect(result).toMatchObject({
      authMode: 'apiKey',
      baseUrl: 'https://gateway.example.com/team',
      credential: 'key-example',
      endpoint: 'https://gateway.example.com/team/v1/messages',
      model: 'team-sonnet',
      protocol: 'anthropic',
      suggestedPreset: 'custom',
    });
  });

  it('removes query parameters before showing or applying an endpoint', () => {
    const result = parseClaudeCurl(
      'curl "https://gateway.example.com/v1/messages?api_key=do-not-show"',
    );

    expect(result.endpoint).toBe('https://gateway.example.com/v1/messages');
    expect(result.baseUrl).toBe('https://gateway.example.com');
  });
});
