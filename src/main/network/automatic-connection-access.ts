import { normalizeConnectionAddress } from '../../shared/router/connection-endpoint';
import type { ProviderAccessGuard } from './provider-access-guard';
import { AutomaticConnectionAccessError } from './automatic-connection';
import { officialProviderForHostname } from './provider-model-discovery';

/** Authorize each exact request, including discovered catalog paths and protocol fallbacks. */
export const guardedAutomaticConnectionFetch =
  (
    withAccess: ProviderAccessGuard['withAllowed'],
    fetchImplementation: typeof fetch = fetch,
    networkScope: 'application' | 'conversation' = 'application',
  ): typeof fetch =>
  async (input, init) => {
    const address =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(normalizeConnectionAddress(address));
    const provider = officialProviderForHostname(url.hostname.toLowerCase());
    if (!provider) return fetchImplementation(url.href, init);
    let admitted = false;
    try {
      return await withAccess(
        {
          action: 'first-request',
          networkScope,
          provider,
          target: { process: 'application', url: url.href },
        },
        () => {
          admitted = true;
          return fetchImplementation(url.href, init);
        },
        init?.signal ?? undefined,
      );
    } catch (error) {
      if (admitted) throw error;
      throw new AutomaticConnectionAccessError('网络检查未通过，请检查网络设置后重试。');
    }
  };
