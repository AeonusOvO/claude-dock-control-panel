/** Only account flows with an implemented backend belong here. Billing is separate from auth. */
export const SUBSCRIPTION_PROVIDERS = [
  'kimi-subscription',
  'minimax-subscription-cn',
  'minimax-subscription-global',
  'glm-subscription-cn',
  'glm-subscription-global',
] as const;

export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

/** The upstream stays public; the per-account loopback URL is only the local relay entrance. */
export const SUBSCRIPTION_UPSTREAM_URLS: Record<SubscriptionProvider, string> = {
  'kimi-subscription': 'https://api.kimi.com/coding',
  'minimax-subscription-cn': 'https://api.minimaxi.com/anthropic',
  'minimax-subscription-global': 'https://api.minimax.io/anthropic',
  'glm-subscription-cn': 'https://open.bigmodel.cn/api/anthropic',
  'glm-subscription-global': 'https://api.z.ai/api/anthropic',
};

export const isSubscriptionProvider = (value: unknown): value is SubscriptionProvider =>
  typeof value === 'string' && SUBSCRIPTION_PROVIDERS.some((id) => id === value);

/** Local addresses are credentials' immutable account bindings, not user-editable API URLs. */
export const isSubscriptionBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Number(url.port) >= 18520 &&
      Number(url.port) <= 18540 &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/s\/[a-f0-9]{32}$/.test(url.pathname)
    );
  } catch {
    return false;
  }
};
