import { describe, expect, it } from 'vitest';
import type { NetworkPreflightAction } from '../../src/shared/contracts';
import { automaticNetworkPreflightEnabled } from '../../src/shared/network-preflight-policy';

const actions: NetworkPreflightAction[] = [
  'background',
  'cli-launch',
  'cloud-task',
  'first-request',
  'login',
  'provider-switch',
];

describe('automatic network preflight preferences', () => {
  it.each(actions)('does not start %s before settings hydration', (action) => {
    expect(automaticNetworkPreflightEnabled(undefined, action)).toBe(false);
  });

  it.each([
    { checkOnNewSession: false, checkOnProviderLogin: false },
    { checkOnNewSession: false, checkOnProviderLogin: true },
    { checkOnNewSession: true, checkOnProviderLogin: false },
    { checkOnNewSession: true, checkOnProviderLogin: true },
  ])('applies the two saved switches independently: %j', (preferences) => {
    expect(automaticNetworkPreflightEnabled(preferences, 'background')).toBe(
      preferences.checkOnNewSession || preferences.checkOnProviderLogin,
    );
    for (const action of ['cli-launch', 'cloud-task', 'first-request'] as const) {
      expect(automaticNetworkPreflightEnabled(preferences, action)).toBe(
        preferences.checkOnNewSession,
      );
    }
    for (const action of ['login', 'provider-switch'] as const) {
      expect(automaticNetworkPreflightEnabled(preferences, action)).toBe(
        preferences.checkOnProviderLogin,
      );
    }
  });
});
