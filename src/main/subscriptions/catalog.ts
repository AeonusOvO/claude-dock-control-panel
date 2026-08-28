import {
  SUBSCRIPTION_UPSTREAM_URLS,
  type SubscriptionProvider,
} from '../../shared/claude/subscriptions';

export interface SubscriptionEndpoint {
  label: string;
  baseUrl: string;
  authBase: string;
  models: readonly string[];
}

export const subscriptionEndpoints: Record<SubscriptionProvider, SubscriptionEndpoint> = {
  'kimi-subscription': {
    label: 'Kimi Code',
    baseUrl: SUBSCRIPTION_UPSTREAM_URLS['kimi-subscription'],
    authBase: 'https://auth.kimi.com',
    models: ['kimi-for-coding'],
  },
  'minimax-subscription-cn': {
    label: 'MiniMax',
    baseUrl: SUBSCRIPTION_UPSTREAM_URLS['minimax-subscription-cn'],
    authBase: 'https://account.minimaxi.com',
    models: ['MiniMax-M3', 'MiniMax-M2.7'],
  },
  'minimax-subscription-global': {
    label: 'MiniMax（国际）',
    baseUrl: SUBSCRIPTION_UPSTREAM_URLS['minimax-subscription-global'],
    authBase: 'https://account.minimax.io',
    models: ['MiniMax-M3', 'MiniMax-M2.7'],
  },
  'glm-subscription-cn': {
    label: '智谱 GLM',
    baseUrl: SUBSCRIPTION_UPSTREAM_URLS['glm-subscription-cn'],
    authBase: 'https://bigmodel.cn',
    models: ['glm-5.2', 'glm-4.7'],
  },
  'glm-subscription-global': {
    label: 'GLM（国际）',
    baseUrl: SUBSCRIPTION_UPSTREAM_URLS['glm-subscription-global'],
    authBase: 'https://zcode.z.ai',
    models: ['glm-5.2', 'glm-4.7'],
  },
};

export interface SubscriptionCredential {
  provider: SubscriptionProvider;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  deviceId?: string;
  accountIdentity?: string;
}

export const kimiHeaders = (deviceId: string): Record<string, string> => ({
  'X-Msh-Platform': 'ClaudeDock',
  'X-Msh-Version': '1',
  'X-Msh-Device-Name': 'ClaudeDock',
  'X-Msh-Device-Model': `Windows ${process.arch}`,
  'X-Msh-Device-Id': deviceId,
});

export const subscriptionHeaders = (
  credential: SubscriptionCredential,
): Record<string, string> => ({
  'anthropic-version': '2023-06-01',
  Authorization: `Bearer ${credential.accessToken}`,
  ...(credential.deviceId ? kimiHeaders(credential.deviceId) : {}),
});
