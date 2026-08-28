import { CLAUDE_PROVIDERS, type ClaudeProviderDefinition } from './providers';
import { normalizeConnectionAddress } from '../router/connection-endpoint';
import { sameConnectionCredentialScope } from '../router/automatic-connection';

/** Chat uses ordinary API access. Plans licensed for coding tools remain on the Claude Code page. */
export const CHAT_PROVIDERS = CLAUDE_PROVIDERS.filter(
  (provider) =>
    !provider.codingPlan &&
    !['anthropic', 'chatgpt-subscription', 'curl', 'gateway'].includes(provider.id),
);

export const findChatProvider = (id: string | undefined): ClaudeProviderDefinition | undefined =>
  CHAT_PROVIDERS.find((provider) => provider.id === id);

export const providerApiAddress = (provider: ClaudeProviderDefinition): string =>
  provider.id === 'anthropic-api' ? 'https://api.anthropic.com' : provider.baseUrl;

export const inferChatProvider = (address: string): string => {
  try {
    return (
      CHAT_PROVIDERS.find(
        (provider) =>
          provider.id !== 'custom' &&
          sameConnectionCredentialScope(address, providerApiAddress(provider)),
      )?.id ?? 'custom'
    );
  } catch {
    return 'custom';
  }
};

/** Do not silently retry a subscription key against a paid API endpoint. */
export const assertChatApiAccess = (address: string, credential?: string): void => {
  const url = new URL(normalizeConnectionAddress(address));
  const hostname = url.hostname.replace(/\.$/, '');
  if (credential?.startsWith('sk-sp-') && /(^|\.)dashscope\.aliyuncs\.com$/.test(hostname)) {
    throw new Error('这是 Coding Plan 密钥，请在“接入”页使用。');
  }
  const codingHosts = new Set([
    'coding.dashscope.aliyuncs.com',
    'coding-intl.dashscope.aliyuncs.com',
  ]);
  const codingPath = CLAUDE_PROVIDERS.some((provider) => {
    if (!provider.codingPlan || provider.id === 'glm-cn' || provider.id === 'glm-global')
      return false;
    const preset = new URL(provider.baseUrl);
    return (
      preset.origin === url.origin &&
      (url.pathname === preset.pathname || url.pathname.startsWith(`${preset.pathname}/`))
    );
  });
  const glmCoding =
    ['open.bigmodel.cn', 'api.z.ai'].includes(hostname) &&
    (url.pathname.startsWith('/api/coding/') || url.pathname.startsWith('/api/anthropic'));
  if (codingHosts.has(hostname) || codingPath || glmCoding) {
    throw new Error('此订阅用于编程工具，请在“接入”页使用。');
  }
};
