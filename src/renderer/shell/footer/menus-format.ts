import type { ClaudeProjectState } from '../../../shared/contracts';

export interface FooterMenusFormatActions {
  formatResourceAmount: (amount: number, currency: string) => string;
  formatResetTime: (resetsAt: number | undefined) => string;
  resourceSourceLabel: (
    source: NonNullable<ClaudeProjectState['resourceUsage']>['source'],
  ) => string;
}

export const createFooterMenusFormatActions = (): FooterMenusFormatActions => {
  const formatResourceAmount = (amount: number, currency: string): string =>
    currency.toUpperCase() === 'USD'
      ? `$${amount.toFixed(amount < 10 ? 2 : 0)}`
      : `${amount.toFixed(amount < 10 ? 2 : 0)} ${currency}`;

  const formatResetTime = (resetsAt: number | undefined): string => {
    if (resetsAt === undefined) return '重置时间未提供';
    const milliseconds = resetsAt < 10_000_000_000 ? resetsAt * 1000 : resetsAt;
    const remaining = milliseconds - Date.now();
    if (remaining <= 0) return '正在重置';
    const minutes = Math.ceil(remaining / 60_000);
    return minutes >= 1440
      ? `${Math.ceil(minutes / 1440)} 天后重置`
      : minutes >= 60
        ? `${Math.ceil(minutes / 60)} 小时后重置`
        : `${minutes} 分钟后重置`;
  };

  const resourceSourceLabel = (
    source: NonNullable<ClaudeProjectState['resourceUsage']>['source'],
  ): string =>
    ({
      'claude-agent-sdk': 'Claude Agent SDK',
      'claude-configured-target': 'ClaudeDock 配置目标（未验证）',
      'claude-statusline': 'Claude Code 状态行',
      'codex-app-server': 'Codex 官方 App Server',
      'deepseek-balance': 'DeepSeek 官方余额接口',
      'managed-chatgpt-gateway': '受管 ChatGPT 本地网关',
      'openrouter-key': 'OpenRouter 官方密钥接口',
    })[source];

  return {
    formatResourceAmount,
    formatResetTime,
    resourceSourceLabel,
  };
};
