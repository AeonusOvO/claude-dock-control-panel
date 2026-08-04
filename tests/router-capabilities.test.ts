import { describe, expect, it } from 'vitest';
import { CLAUDE_PROVIDERS } from '../src/shared/claude-providers';
import { ROUTER_CAPABILITIES } from '../src/shared/router-capabilities';

describe('router capability matrix', () => {
  it('has one current, user-facing decision for every provider', () => {
    expect(Object.keys(ROUTER_CAPABILITIES).sort()).toEqual(
      CLAUDE_PROVIDERS.map(({ id }) => id).sort(),
    );
    for (const provider of CLAUDE_PROVIDERS) {
      const capability = ROUTER_CAPABILITIES[provider.id];
      expect(capability.reason.length).toBeGreaterThan(10);
      expect(capability.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('records DeepSeek as direct and the local gateway as router-required', () => {
    expect(ROUTER_CAPABILITIES.deepseek.mode).toBe('direct');
    expect(ROUTER_CAPABILITIES.gateway.mode).toBe('router-required');
    expect(ROUTER_CAPABILITIES['chatgpt-subscription']).toMatchObject({
      mode: 'direct',
      verifiedAt: '2026-08-04',
    });
    expect(ROUTER_CAPABILITIES['chatgpt-subscription'].reason).toContain('本地订阅网关');
  });
});
