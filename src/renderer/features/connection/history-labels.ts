import { findClaudeProvider } from '../../../shared/claude/providers';
import type { ClaudeConnectionHistoryEntry, ClaudePreset } from '../../../shared/contracts';

export const presetLabel = (preset: ClaudePreset): string =>
  findClaudeProvider(preset)?.label ?? '自定义中转站接口';

export const GATEWAY_STATE_LABELS: Record<ClaudeConnectionHistoryEntry['gatewayState'], string> = {
  error: '网关出错',
  running: '网关运行中',
  starting: '网关启动中',
  stopped: '网关未运行',
  unknown: '网关状态未知',
};

export const formatHistoryTimestamp = (savedAt: number): string =>
  new Date(savedAt).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  });

export const historyAuthModeLabel = (
  authMode: ClaudeConnectionHistoryEntry['authMode'],
): string => {
  switch (authMode) {
    case 'apiKey':
      return 'API Key';
    case 'authToken':
      return 'Bearer';
    case 'existing':
      return '现有登录';
    case 'none':
      return '无认证';
  }
};

export const historyDisplayName = (entry: ClaudeConnectionHistoryEntry): string => {
  if (entry.name) {
    return entry.name;
  }
  if (entry.preset === 'custom' || entry.preset === 'gateway') {
    try {
      return (
        new URL(entry.sourceBaseUrl || entry.baseUrl || entry.gatewayEndpoint || '').host ||
        presetLabel(entry.preset)
      );
    } catch {
      return presetLabel(entry.preset);
    }
  }
  return presetLabel(entry.preset);
};

export const historyProtocolLabel = (
  protocol: ClaudeConnectionHistoryEntry['protocol'],
): string => {
  switch (protocol) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'unknown':
      return '协议待确认';
  }
};

export const historyRouteLabel = (entry: ClaudeConnectionHistoryEntry): string => {
  if (entry.preset === 'anthropic') {
    return '官方直连';
  }
  if (entry.protocol === 'openai') {
    return 'Router 转换';
  }
  if (entry.preset === 'gateway') {
    return '本机转换器';
  }
  if (findClaudeProvider(entry.preset)?.group === 'local') {
    return '本地直连';
  }
  return '中转直连';
};
