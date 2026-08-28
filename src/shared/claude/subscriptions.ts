/** Only account flows with an implemented backend belong here. Billing is separate from auth. */
export const SUBSCRIPTION_PROVIDERS = [
  'kimi-subscription',
  'minimax-subscription-cn',
  'minimax-subscription-global',
  'glm-subscription-cn',
  'glm-subscription-global',
] as const;

export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

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
