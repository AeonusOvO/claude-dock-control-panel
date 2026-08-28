import type { NetworkPreflightAction, NetworkPreflightPreferences } from './contracts';

/** Saved preferences control automatic probes; explicit manual checks do not use this policy. */
export const automaticNetworkPreflightEnabled = (
  preferences: NetworkPreflightPreferences | undefined,
  action: NetworkPreflightAction,
): boolean => {
  // The renderer must hydrate the saved settings before admitting any automatic probe.
  if (!preferences) return false;
  switch (action) {
    case 'login':
    case 'provider-switch':
      return preferences.checkOnProviderLogin;
    case 'cli-launch':
    case 'first-request':
    case 'cloud-task':
      return preferences.checkOnNewSession;
    case 'background':
      return preferences.checkOnNewSession || preferences.checkOnProviderLogin;
  }
};
